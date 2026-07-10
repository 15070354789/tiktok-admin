const express = require('express');
const session = require('express-session');
const mysql = require('mysql2/promise');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'tiktok-admin-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ─── Config ───────────────────────────────────────────────────────────────────
const APP_KEY    = process.env.APP_KEY    || '6k8lsv0lprk3l';
const APP_SECRET = process.env.APP_SECRET || 'c7b249b92ba4aa552a14a6cec1290d521dc659f4';
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://your-app.zeabur.app/auth/callback';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'hengchun2024';

const dbConfig = {
  host:     process.env.DB_HOST     || '43.134.28.140',
  port:     parseInt(process.env.DB_PORT || '30685'),
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || 'go86xHt0YKU97b243NPMOji5V1GnQdcS',
  database: process.env.DB_NAME     || 'TK',
};

// ─── DB ───────────────────────────────────────────────────────────────────────
async function getDB() {
  return mysql.createConnection(dbConfig);
}

// 检查表中是否存在某字段，不存在则自动ALTER TABLE补上；
// 如果字段已存在但类型对不上（比如老表里create_time是DATETIME，实际需要BIGINT），也自动MODIFY COLUMN修正
async function ensureColumn(db, table, column, definition, expectedDataType) {
  const [rows] = await db.execute(
    `SELECT DATA_TYPE as dataType FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  if (rows.length === 0) {
    console.log(`[MIGRATION] Adding missing column ${column} to ${table}`);
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return;
  }
  if (expectedDataType && rows[0].dataType.toLowerCase() !== expectedDataType.toLowerCase()) {
    console.log(`[MIGRATION] Fixing column type for ${table}.${column}: ${rows[0].dataType} -> ${expectedDataType}`);
    await db.execute(`ALTER TABLE ${table} MODIFY COLUMN ${column} ${definition}`);
  }
}

async function initDB() {
  const db = await getDB();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS tiktok_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      shop_id VARCHAR(100) UNIQUE,
      shop_name VARCHAR(200),
      access_token TEXT,
      refresh_token TEXT,
      expire_time BIGINT,
      shop_cipher VARCHAR(200),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS tiktok_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id VARCHAR(100) UNIQUE,
      shop_id VARCHAR(100),
      shop_name VARCHAR(200),
      status VARCHAR(50),
      total_amount DECIMAL(10,2),
      currency VARCHAR(20),
      create_time BIGINT,
      buyer_uid VARCHAR(100),
      sku_list TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 迁移：补齐旧表可能缺失的字段，并修正类型不匹配的字段（针对表已存在但结构较老的情况）
  await ensureColumn(db, 'tiktok_orders', 'shop_id', 'VARCHAR(100)', 'varchar');
  await ensureColumn(db, 'tiktok_orders', 'shop_name', 'VARCHAR(200)', 'varchar');
  await ensureColumn(db, 'tiktok_orders', 'status', 'VARCHAR(50)', 'varchar');
  await ensureColumn(db, 'tiktok_orders', 'total_amount', 'DECIMAL(10,2)', 'decimal');
  await ensureColumn(db, 'tiktok_orders', 'currency', 'VARCHAR(20)', 'varchar');
  await ensureColumn(db, 'tiktok_orders', 'create_time', 'BIGINT', 'bigint');
  await ensureColumn(db, 'tiktok_orders', 'buyer_uid', 'VARCHAR(100)', 'varchar');
  await ensureColumn(db, 'tiktok_orders', 'sku_list', 'TEXT', 'text');
  await ensureColumn(db, 'tiktok_tokens', 'shop_cipher', 'VARCHAR(200)', 'varchar');

  await db.end();
  console.log('DB tables ready');
}

// ─── TikTok Sign (V2) ─────────────────────────────────────────────────────────
// V2签名规则：secret + path + 排序后的query参数(不含sign/access_token) + body(仅POST且非multipart时需要) + secret，再HMAC-SHA256
// 关键点：POST请求如果Content-Type是application/json，请求体必须参与签名计算，否则会返回106001 Invalid sign
function generateSign(path, params, body = '') {
  const sortedKeys = Object.keys(params).sort();
  let str = path;
  for (const key of sortedKeys) {
    if (key !== 'sign' && key !== 'access_token') {
      str += key + params[key];
    }
  }
  if (body) {
    str += body;
  }
  str = APP_SECRET + str + APP_SECRET;
  return crypto.createHmac('sha256', APP_SECRET).update(str).digest('hex');
}

// ─── TikTok API ───────────────────────────────────────────────────────────────

// 获取店铺信息 + shop_cipher（V2）
async function getShopInfo(accessToken) {
  const path = '/authorization/202309/shops';
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { app_key: APP_KEY, timestamp };
  params.sign = generateSign(path, params); // GET请求，无body
  const url = 'https://open-api.tiktokglobalshop.com' + path;
  const res = await axios.get(url, {
    params,
    headers: { 'x-tts-access-token': accessToken },
  });
  return res.data;
}

// 同步订单（V2, API版本202309）
async function syncOrders(shopId, accessToken, shopName, shopCipher) {
  const db = await getDB();
  const path = '/order/202309/orders/search';
  const timestamp = Math.floor(Date.now() / 1000);
  // last 30 days
  const createTimeFrom = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;

  const params = {
    app_key: APP_KEY,
    timestamp,
    shop_cipher: shopCipher,
    shop_id: shopId,
    version: '202309',
    page_size: 50,
    sort_field: 'create_time',
    sort_order: 'DESC',
  };

  // POST请求且Content-Type为application/json，body必须序列化后参与签名计算
  const requestBody = {
    create_time_ge: createTimeFrom,
    create_time_lt: timestamp,
  };
  const bodyString = JSON.stringify(requestBody);

  params.sign = generateSign(path, params, bodyString);

  try {
    const res = await axios.post(
      'https://open-api.tiktokglobalshop.com' + path,
      requestBody,
      {
        params: { ...params, access_token: accessToken },
        headers: {
          'x-tts-access-token': accessToken,
          'Content-Type': 'application/json',
        },
      }
    );

    // 调试用：打印完整响应，确认TikTok到底返回了什么
    console.log(`[DEBUG] Sync response for shop ${shopId}:`, JSON.stringify(res.data));

    if (res.data?.code !== 0) {
      throw new Error(`TikTok API error: ${JSON.stringify(res.data)}`);
    }

    const orders = res.data?.data?.orders || [];
    console.log(`[DEBUG] Shop ${shopId} matched ${orders.length} orders, time range: ${createTimeFrom} - ${timestamp}`);
    for (const order of orders) {
      await db.execute(
        `INSERT INTO tiktok_orders (order_id, shop_id, shop_name, status, total_amount, currency, create_time, buyer_uid, sku_list)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status=VALUES(status), total_amount=VALUES(total_amount)`,
        [
          order.order_id ?? order.id,
          shopId,
          shopName,
          order.order_status ?? order.status,
          order.payment?.total_amount || 0,
          order.payment?.currency || 'VND',
          order.create_time,
          order.buyer_uid || order.user_id || '',
          JSON.stringify(order.line_items || order.sku_list || []),
        ]
      );
    }
    await db.end();
    return orders.length;
  } catch (e) {
    await db.end();
    throw e;
  }
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireLogin(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect('/login');
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────
const layout = (title, body) => `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — 恒春出海 TikTok Shop</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f14;color:#e2e2e8;min-height:100vh}
  .nav{background:#18181f;border-bottom:1px solid #2a2a35;padding:14px 32px;display:flex;align-items:center;justify-content:space-between}
  .nav .logo{font-weight:700;font-size:16px;color:#fff;letter-spacing:.5px}
  .nav .logo span{color:#fe2c55}
  .nav a{color:#9999aa;text-decoration:none;font-size:14px;margin-left:20px}
  .nav a:hover{color:#fff}
  .container{max-width:1200px;margin:0 auto;padding:32px 24px}
  .page-title{font-size:24px;font-weight:700;margin-bottom:6px}
  .page-sub{color:#6666aa;font-size:14px;margin-bottom:28px}
  .card{background:#18181f;border:1px solid #2a2a35;border-radius:12px;padding:24px;margin-bottom:20px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:28px}
  .stat{background:#18181f;border:1px solid #2a2a35;border-radius:10px;padding:20px}
  .stat .label{font-size:12px;color:#6666aa;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
  .stat .value{font-size:28px;font-weight:700;color:#fff}
  .stat .sub{font-size:12px;color:#9999aa;margin-top:4px}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th{text-align:left;padding:10px 14px;border-bottom:1px solid #2a2a35;color:#6666aa;font-size:12px;text-transform:uppercase;letter-spacing:.5px}
  td{padding:12px 14px;border-bottom:1px solid #1e1e28;color:#ccccd8}
  tr:hover td{background:#1c1c25}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600}
  .badge-green{background:#0d2e1a;color:#3dd68c}
  .badge-yellow{background:#2e2010;color:#f4a523}
  .badge-blue{background:#0d1e35;color:#4da3ff}
  .badge-gray{background:#1e1e28;color:#9999aa}
  .badge-red{background:#2e0d14;color:#ff4d6a}
  .btn{display:inline-block;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;border:none;text-decoration:none}
  .btn-primary{background:#fe2c55;color:#fff}
  .btn-primary:hover{background:#e01f45}
  .btn-ghost{background:transparent;border:1px solid #2a2a35;color:#ccccd8}
  .btn-ghost:hover{border-color:#fe2c55;color:#fe2c55}
  .login-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .login-box{background:#18181f;border:1px solid #2a2a35;border-radius:16px;padding:40px;width:100%;max-width:400px}
  .login-logo{text-align:center;margin-bottom:32px}
  .login-logo .icon{font-size:48px;margin-bottom:12px}
  .login-logo h1{font-size:22px;font-weight:700}
  .login-logo p{color:#6666aa;font-size:14px;margin-top:4px}
  label{display:block;font-size:13px;color:#9999aa;margin-bottom:6px}
  input[type=text],input[type=password]{width:100%;background:#0f0f14;border:1px solid #2a2a35;color:#fff;padding:11px 14px;border-radius:8px;font-size:14px;margin-bottom:16px;outline:none}
  input:focus{border-color:#fe2c55}
  .error{color:#ff4d6a;font-size:13px;margin-bottom:16px;padding:10px 14px;background:#2e0d14;border-radius:8px}
  .alert{padding:12px 16px;border-radius:8px;font-size:14px;margin-bottom:20px}
  .alert-info{background:#0d1e35;border:1px solid #1a3a6a;color:#4da3ff}
  .alert-success{background:#0d2e1a;border:1px solid #1a5c35;color:#3dd68c}
  .section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
  .empty{text-align:center;padding:60px 20px;color:#6666aa}
  .empty .icon{font-size:40px;margin-bottom:12px}
  .shop-tag{font-size:11px;color:#9999aa;background:#1e1e28;padding:2px 8px;border-radius:4px}
</style>
</head>
<body>${body}</body>
</html>`;

function statusBadge(status) {
  const map = {
    UNPAID: ['badge-yellow', '待付款'],
    ON_HOLD: ['badge-yellow', '暂停'],
    PARTIALLY_SHIPPING: ['badge-blue', '部分发货'],
    AWAITING_SHIPMENT: ['badge-blue', '待发货'],
    AWAITING_COLLECTION: ['badge-blue', '待揽收'],
    IN_TRANSIT: ['badge-blue', '运输中'],
    DELIVERED: ['badge-green', '已送达'],
    COMPLETED: ['badge-green', '已完成'],
    CANCELLED: ['badge-red', '已取消'],
  };
  const [cls, label] = map[status] || ['badge-gray', status || '未知'];
  return `<span class="badge ${cls}">${label}</span>`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Login
app.get('/login', (req, res) => {
  res.send(layout('登录', `
    <div class="login-wrap">
      <div class="login-box">
        <div class="login-logo">
          <div class="icon">🛍️</div>
          <h1>恒春出海</h1>
          <p>TikTok Shop 订单管理系统</p>
        </div>
        ${req.query.error ? '<div class="error">账号或密码错误，请重试</div>' : ''}
        <form method="POST" action="/login">
          <label>账号</label>
          <input type="text" name="username" placeholder="请输入账号" autocomplete="username">
          <label>密码</label>
          <input type="password" name="password" placeholder="请输入密码" autocomplete="current-password">
          <button type="submit" class="btn btn-primary" style="width:100%;padding:12px">登录</button>
        </form>
      </div>
    </div>
  `));
});

app.post('/login', (req, res) => {
  if (req.body.username === ADMIN_USER && req.body.password === ADMIN_PASS) {
    req.session.loggedIn = true;
    res.redirect('/dashboard');
  } else {
    res.redirect('/login?error=1');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Dashboard
app.get(['/', '/dashboard'], requireLogin, async (req, res) => {
  const db = await getDB();
  const [orders] = await db.execute('SELECT * FROM tiktok_orders ORDER BY create_time DESC LIMIT 100');
  const [shops] = await db.execute('SELECT * FROM tiktok_tokens');
  const [stats] = await db.execute(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status='AWAITING_SHIPMENT' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status='CANCELLED' THEN 1 ELSE 0 END) as cancelled,
      SUM(total_amount) as revenue
    FROM tiktok_orders
  `);
  await db.end();

  const s = stats[0];
  const hasOrders = orders.length > 0;
  const hasShops = shops.length > 0;

  const authUrl = `https://services.tiktok.com/open/authorize?service_id=${APP_KEY}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

  res.send(layout('控制台', `
    <nav class="nav">
      <div class="logo"><span>TK</span> 恒春出海订单系统</div>
      <div>
        <a href="/dashboard">控制台</a>
        <a href="/orders">订单管理</a>
        <a href="/shops">店铺授权</a>
        <a href="/logout">退出</a>
      </div>
    </nav>
    <div class="container">
      <div class="page-title">控制台</div>
      <div class="page-sub">TikTok Shop 越南站订单数据概览</div>

      ${!hasShops ? `
        <div class="alert alert-info">
          ⚠️ 尚未授权任何店铺。<a href="${authUrl}" style="color:#fff;font-weight:600">点击此处授权你的TikTok Shop店铺</a>，授权后即可同步订单数据。
        </div>
      ` : ''}

      ${req.query.error === 'sync' ? `
        <div class="alert" style="background:#2e0d14;border:1px solid #5c1a2e;color:#ff4d6a">
          ⚠️ 同步过程中发生错误，请查看服务器日志了解详情。
        </div>
      ` : ''}

      <div class="stats">
        <div class="stat">
          <div class="label">总订单数</div>
          <div class="value">${s.total || 0}</div>
          <div class="sub">所有状态</div>
        </div>
        <div class="stat">
          <div class="label">已完成</div>
          <div class="value" style="color:#3dd68c">${s.completed || 0}</div>
          <div class="sub">COMPLETED</div>
        </div>
        <div class="stat">
          <div class="label">待发货</div>
          <div class="value" style="color:#4da3ff">${s.pending || 0}</div>
          <div class="sub">AWAITING SHIPMENT</div>
        </div>
        <div class="stat">
          <div class="label">已取消</div>
          <div class="value" style="color:#ff4d6a">${s.cancelled || 0}</div>
          <div class="sub">CANCELLED</div>
        </div>
        <div class="stat">
          <div class="label">总收入</div>
          <div class="value" style="color:#f4a523">${Number(s.revenue || 0).toLocaleString()}</div>
          <div class="sub">VND</div>
        </div>
      </div>

      <div class="card">
        <div class="section-header">
          <div style="font-weight:600">最近订单</div>
          <div style="display:flex;gap:10px">
            <a href="/api/sync" class="btn btn-ghost" style="font-size:13px">🔄 同步数据</a>
            <a href="/orders" class="btn btn-ghost" style="font-size:13px">查看全部</a>
          </div>
        </div>
        ${hasOrders ? `
        <table>
          <thead>
            <tr>
              <th>订单号</th>
              <th>店铺</th>
              <th>金额</th>
              <th>状态</th>
              <th>下单时间</th>
            </tr>
          </thead>
          <tbody>
            ${orders.slice(0, 20).map(o => `
            <tr>
              <td style="font-family:monospace;font-size:13px">${o.order_id}</td>
              <td><span class="shop-tag">${o.shop_name || o.shop_id}</span></td>
              <td>${Number(o.total_amount).toLocaleString()} ${o.currency}</td>
              <td>${statusBadge(o.status)}</td>
              <td>${o.create_time ? new Date(o.create_time * 1000).toLocaleString('zh-CN') : '-'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        ` : `
        <div class="empty">
          <div class="icon">📦</div>
          <div>暂无订单数据</div>
          <div style="margin-top:8px;font-size:13px">请先授权店铺后点击"同步数据"</div>
        </div>
        `}
      </div>
    </div>
  `));
});

// Orders page
app.get('/orders', requireLogin, async (req, res) => {
  const db = await getDB();
  const status = req.query.status || '';
  const query = status
    ? 'SELECT * FROM tiktok_orders WHERE status=? ORDER BY create_time DESC'
    : 'SELECT * FROM tiktok_orders ORDER BY create_time DESC';
  const [orders] = await db.execute(query, status ? [status] : []);
  await db.end();

  const statuses = ['AWAITING_SHIPMENT','IN_TRANSIT','DELIVERED','COMPLETED','CANCELLED','UNPAID'];

  res.send(layout('订单管理', `
    <nav class="nav">
      <div class="logo"><span>TK</span> 恒春出海订单系统</div>
      <div>
        <a href="/dashboard">控制台</a>
        <a href="/orders">订单管理</a>
        <a href="/shops">店铺授权</a>
        <a href="/logout">退出</a>
      </div>
    </nav>
    <div class="container">
      <div class="page-title">订单管理</div>
      <div class="page-sub">共 ${orders.length} 条订单记录</div>

      <div style="margin-bottom:20px;display:flex;gap:8px;flex-wrap:wrap">
        <a href="/orders" class="btn btn-ghost" style="font-size:13px;padding:7px 14px">全部</a>
        ${statuses.map(s => `<a href="/orders?status=${s}" class="btn btn-ghost" style="font-size:13px;padding:7px 14px">${statusBadge(s)}</a>`).join('')}
      </div>

      <div class="card">
        ${orders.length > 0 ? `
        <table>
          <thead>
            <tr>
              <th>订单号</th>
              <th>店铺</th>
              <th>买家UID</th>
              <th>金额</th>
              <th>状态</th>
              <th>下单时间</th>
            </tr>
          </thead>
          <tbody>
            ${orders.map(o => `
            <tr>
              <td style="font-family:monospace;font-size:13px">${o.order_id}</td>
              <td><span class="shop-tag">${o.shop_name || o.shop_id}</span></td>
              <td style="font-size:12px;color:#9999aa">${o.buyer_uid || '-'}</td>
              <td>${Number(o.total_amount).toLocaleString()} ${o.currency}</td>
              <td>${statusBadge(o.status)}</td>
              <td>${o.create_time ? new Date(o.create_time * 1000).toLocaleString('zh-CN') : '-'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        ` : `
        <div class="empty">
          <div class="icon">📦</div>
          <div>暂无订单数据</div>
        </div>
        `}
      </div>
    </div>
  `));
});

// Shops page
app.get('/shops', requireLogin, async (req, res) => {
  const db = await getDB();
  const [shops] = await db.execute('SELECT * FROM tiktok_tokens');
  await db.end();
  const authUrl = `https://services.tiktok.com/open/authorize?service_id=${APP_KEY}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

  res.send(layout('店铺授权', `
    <nav class="nav">
      <div class="logo"><span>TK</span> 恒春出海订单系统</div>
      <div>
        <a href="/dashboard">控制台</a>
        <a href="/orders">订单管理</a>
        <a href="/shops">店铺授权</a>
        <a href="/logout">退出</a>
      </div>
    </nav>
    <div class="container">
      <div class="page-title">店铺授权</div>
      <div class="page-sub">管理已授权的 TikTok Shop 越南站店铺</div>

      <div style="margin-bottom:20px">
        <a href="${authUrl}" class="btn btn-primary">+ 授权新店铺</a>
      </div>

      <div class="card">
        ${shops.length > 0 ? `
        <table>
          <thead>
            <tr><th>店铺名称</th><th>Shop ID</th><th>Shop Cipher</th><th>Token状态</th><th>更新时间</th></tr>
          </thead>
          <tbody>
            ${shops.map(s => {
              const expired = s.expire_time && s.expire_time < Date.now() / 1000;
              return `
              <tr>
                <td>${s.shop_name || '-'}</td>
                <td style="font-family:monospace;font-size:13px">${s.shop_id}</td>
                <td style="font-family:monospace;font-size:12px">${s.shop_cipher ? '✅ 已获取' : '❌ 缺失'}</td>
                <td>${expired
                  ? '<span class="badge badge-red">已过期</span>'
                  : '<span class="badge badge-green">有效</span>'}</td>
                <td>${s.updated_at ? new Date(s.updated_at).toLocaleString('zh-CN') : '-'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        ` : `
        <div class="empty">
          <div class="icon">🏪</div>
          <div>尚未授权任何店铺</div>
          <div style="margin-top:12px">
            <a href="${authUrl}" class="btn btn-primary">立即授权</a>
          </div>
        </div>
        `}
      </div>
    </div>
  `));
});

// OAuth callback
app.get('/auth/callback', async (req, res) => {
  const { code, shop_id } = req.query;
  if (!code) return res.send('Missing code');

  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const tkPath = '/api/v2/token/get';

    const tokenParams = { app_key: APP_KEY, app_secret: APP_SECRET, auth_code: code, grant_type: 'authorized_code' };

    let tokenRes, data;
    try {
      tokenRes = await axios.get('https://auth.tiktok-shops.com' + tkPath, { params: tokenParams });
      data = tokenRes.data?.data;
    } catch (e1) {
      console.error('Token fetch failed:', e1?.response?.data || e1.message);
      throw e1;
    }

    if (!data?.access_token) {
      return res.send('授权失败: ' + JSON.stringify(tokenRes.data));
    }

    // 拿到access_token后，调用获取店铺信息接口拿shop_cipher
    let shopCipher = '';
    let actualShopId = shop_id || data.open_id || 'unknown';
    let sellerName = data.seller_name || '';

    try {
      const shopInfo = await getShopInfo(data.access_token);
      const authorizedShop = shopInfo?.data?.shops?.[0];
      if (authorizedShop) {
        shopCipher = authorizedShop.cipher || '';
        actualShopId = authorizedShop.id || actualShopId;
        sellerName = authorizedShop.name || sellerName;
      }
    } catch (e2) {
      console.error('getShopInfo failed:', e2?.response?.data || e2.message);
      // 即使拿shop_cipher失败，也继续保存token，后续可以重新授权补齐
    }

    const db = await getDB();
    await db.execute(
      `INSERT INTO tiktok_tokens (shop_id, shop_name, access_token, refresh_token, expire_time, shop_cipher)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE access_token=VALUES(access_token), refresh_token=VALUES(refresh_token), expire_time=VALUES(expire_time), shop_cipher=VALUES(shop_cipher)`,
      [actualShopId, sellerName, data.access_token, data.refresh_token || '', data.access_token_expire_in || 0, shopCipher]
    );
    await db.end();

    res.redirect('/dashboard?auth=success');
  } catch (e) {
    console.error(e?.response?.data || e.message);
    res.send('授权失败: ' + (e?.response?.data ? JSON.stringify(e.response.data) : e.message));
  }
});

// Manual sync
app.get('/api/sync', requireLogin, async (req, res) => {
  try {
    const db = await getDB();
    const [shops] = await db.execute('SELECT * FROM tiktok_tokens');
    await db.end();

    if (shops.length === 0) {
      return res.redirect('/shops');
    }

    let total = 0;
    for (const shop of shops) {
      if (!shop.shop_cipher) {
        console.error(`Sync skipped for shop ${shop.shop_id}: missing shop_cipher, please re-authorize`);
        continue;
      }
      try {
        const count = await syncOrders(shop.shop_id, shop.access_token, shop.shop_name, shop.shop_cipher);
        total += count;
      } catch (e) {
        console.error(`Sync failed for shop ${shop.shop_id}:`, e.message);
        if (e.response) {
          console.error(`Status: ${e.response.status}`);
          console.error(`Response data:`, JSON.stringify(e.response.data));
        }
      }
    }
    res.redirect('/dashboard?synced=' + total);
  } catch (e) {
    console.error('Sync route failed:', e.message);
    res.redirect('/dashboard?error=sync');
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(e => {
  console.error('DB init failed:', e.message);
  process.exit(1);
});
