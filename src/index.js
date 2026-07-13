const express = require('express');
const session = require('express-session');
const mysql = require('mysql2/promise');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: 'tiktok-admin-secret-2024',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

// ─── Config ───────────────────────────────────────────────────────────────────

const APP_KEY =
  process.env.APP_KEY || '6k8lsv0lprk3l';

const APP_SECRET =
  process.env.APP_SECRET ||
  'c7b249b92ba4aa552a14a6cec1290d521dc659f4';

const REDIRECT_URI =
  process.env.REDIRECT_URI ||
  'https://your-app.zeabur.app/auth/callback';

const ADMIN_USER =
  process.env.ADMIN_USER || 'admin';

const ADMIN_PASS =
  process.env.ADMIN_PASS || 'hengchun2024';

const dbConfig = {
  host: process.env.DB_HOST || '43.134.28.140',
  port: parseInt(process.env.DB_PORT || '30685', 10),
  user: process.env.DB_USER || 'root',
  password:
    process.env.DB_PASSWORD ||
    'go86xHt0YKU97b243NPMOji5V1GnQdcS',
  database: process.env.DB_NAME || 'TK',
};

// ─── DB ───────────────────────────────────────────────────────────────────────

async function getDB() {
  return mysql.createConnection(dbConfig);
}

async function ensureColumn(
  db,
  table,
  column,
  definition,
  expectedDataType
) {
  const [rows] = await db.execute(
    `
      SELECT DATA_TYPE AS dataType
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND column_name = ?
    `,
    [table, column]
  );

  if (rows.length === 0) {
    console.log(
      `[MIGRATION] Adding missing column ${column} to ${table}`
    );

    await db.execute(
      `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`
    );

    return;
  }

  if (
    expectedDataType &&
    rows[0].dataType.toLowerCase() !==
      expectedDataType.toLowerCase()
  ) {
    console.log(
      `[MIGRATION] Fixing column type for ${table}.${column}: ` +
        `${rows[0].dataType} -> ${expectedDataType}`
    );

    await db.execute(
      `ALTER TABLE ${table} MODIFY COLUMN ${column} ${definition}`
    );
  }
}

async function initDB() {
  const db = await getDB();

  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS tiktok_tokens (
        id INT AUTO_INCREMENT PRIMARY KEY,
        shop_id VARCHAR(100) UNIQUE,
        shop_name VARCHAR(200),
        access_token TEXT,
        refresh_token TEXT,
        expire_time BIGINT,
        shop_cipher VARCHAR(200),
        updated_at TIMESTAMP
          DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP
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

    await ensureColumn(
      db,
      'tiktok_orders',
      'shop_id',
      'VARCHAR(100)',
      'varchar'
    );

    await ensureColumn(
      db,
      'tiktok_orders',
      'shop_name',
      'VARCHAR(200)',
      'varchar'
    );

    await ensureColumn(
      db,
      'tiktok_orders',
      'status',
      'VARCHAR(50)',
      'varchar'
    );

    await ensureColumn(
      db,
      'tiktok_orders',
      'total_amount',
      'DECIMAL(10,2)',
      'decimal'
    );

    await ensureColumn(
      db,
      'tiktok_orders',
      'currency',
      'VARCHAR(20)',
      'varchar'
    );

    await ensureColumn(
      db,
      'tiktok_orders',
      'create_time',
      'BIGINT',
      'bigint'
    );

    await ensureColumn(
      db,
      'tiktok_orders',
      'buyer_uid',
      'VARCHAR(100)',
      'varchar'
    );

    await ensureColumn(
      db,
      'tiktok_orders',
      'sku_list',
      'TEXT',
      'text'
    );

    await ensureColumn(
      db,
      'tiktok_tokens',
      'shop_cipher',
      'VARCHAR(200)',
      'varchar'
    );

    console.log('DB tables ready');
  } finally {
    await db.end();
  }
}

// ─── TikTok Sign V2 ───────────────────────────────────────────────────────────

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

  return crypto
    .createHmac('sha256', APP_SECRET)
    .update(str)
    .digest('hex');
}

// ─── TikTok API ───────────────────────────────────────────────────────────────

async function getShopInfo(accessToken) {
  const path = '/authorization/202309/shops';
  const timestamp = Math.floor(Date.now() / 1000);

  const params = {
    app_key: APP_KEY,
    timestamp,
  };

  params.sign = generateSign(path, params);

  const url =
    'https://open-api.tiktokglobalshop.com' + path;

  const response = await axios.get(url, {
    params,
    headers: {
      'x-tts-access-token': accessToken,
    },
  });

  return response.data;
}

async function syncOrders(
  shopId,
  accessToken,
  shopName,
  shopCipher
) {
  const db = await getDB();

  const path = '/order/202309/orders/search';
  const timestamp = Math.floor(Date.now() / 1000);

  const createTimeFrom =
    Math.floor(Date.now() / 1000) -
    30 * 24 * 60 * 60;

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

  const requestBody = {
    create_time_ge: createTimeFrom,
    create_time_lt: timestamp,
  };

  const bodyString = JSON.stringify(requestBody);

  params.sign = generateSign(
    path,
    params,
    bodyString
  );

  try {
    const response = await axios.post(
      'https://open-api.tiktokglobalshop.com' +
        path,
      requestBody,
      {
        params: {
          ...params,
          access_token: accessToken,
        },
        headers: {
          'x-tts-access-token': accessToken,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(
      `[DEBUG] Sync response for shop ${shopId}:`,
      JSON.stringify(response.data)
    );

    if (response.data?.code !== 0) {
      throw new Error(
        `TikTok API error: ${JSON.stringify(
          response.data
        )}`
      );
    }

    const orders =
      response.data?.data?.orders || [];

    console.log(
      `[DEBUG] Shop ${shopId} matched ` +
        `${orders.length} orders, time range: ` +
        `${createTimeFrom} - ${timestamp}`
    );

    for (const order of orders) {
      await db.execute(
        `
          INSERT INTO tiktok_orders (
            order_id,
            shop_id,
            shop_name,
            status,
            total_amount,
            currency,
            create_time,
            buyer_uid,
            sku_list
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            shop_name = VALUES(shop_name),
            status = VALUES(status),
            total_amount = VALUES(total_amount),
            currency = VALUES(currency),
            create_time = VALUES(create_time),
            buyer_uid = VALUES(buyer_uid),
            sku_list = VALUES(sku_list)
        `,
        [
          order.order_id ?? order.id,
          shopId,
          shopName,
          order.order_status ?? order.status,
          order.payment?.total_amount || 0,
          order.payment?.currency || 'VND',
          order.create_time,
          order.buyer_uid ||
            order.user_id ||
            '',
          JSON.stringify(
            order.line_items ||
              order.sku_list ||
              []
          ),
        ]
      );
    }

    return orders.length;
  } finally {
    await db.end();
  }
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────

function requireLogin(req, res, next) {
  if (req.session.loggedIn) {
    return next();
  }

  return res.redirect('/login');
}

// ─── HTML Helpers ─────────────────────────────────────────────────────────────

const layout = (
  title,
  body,
  options = {}
) => {
  const {
    description = 'Hengchun Global enterprise management platform',
  } = options;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >

  <meta
    name="description"
    content="${description}"
  >

  <meta
    name="robots"
    content="noindex, nofollow"
  >

  <title>${title} — Hengchun Global</title>

  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    html {
      min-height: 100%;
    }

    body {
      font-family:
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        Arial,
        sans-serif;

      background: #0f0f14;
      color: #e2e2e8;
      min-height: 100vh;
    }

    a {
      color: inherit;
    }

    .nav {
      background: #18181f;
      border-bottom: 1px solid #2a2a35;
      padding: 14px 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
    }

    .nav .logo {
      font-weight: 700;
      font-size: 16px;
      color: #ffffff;
      letter-spacing: 0.5px;
      white-space: nowrap;
    }

    .nav .logo span {
      color: #fe2c55;
    }

    .nav-links {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 20px;
    }

    .nav a {
      color: #9999aa;
      text-decoration: none;
      font-size: 14px;
    }

    .nav a:hover {
      color: #ffffff;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px 24px;
    }

    .page-title {
      font-size: 24px;
      font-weight: 700;
      margin-bottom: 6px;
    }

    .page-sub {
      color: #888899;
      font-size: 14px;
      margin-bottom: 28px;
    }

    .card {
      background: #18181f;
      border: 1px solid #2a2a35;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 20px;
      overflow-x: auto;
    }

    .stats {
      display: grid;
      grid-template-columns:
        repeat(
          auto-fit,
          minmax(180px, 1fr)
        );
      gap: 16px;
      margin-bottom: 28px;
    }

    .stat {
      background: #18181f;
      border: 1px solid #2a2a35;
      border-radius: 10px;
      padding: 20px;
    }

    .stat .label {
      font-size: 12px;
      color: #888899;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }

    .stat .value {
      font-size: 28px;
      font-weight: 700;
      color: #ffffff;
    }

    .stat .sub {
      font-size: 12px;
      color: #9999aa;
      margin-top: 4px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
      min-width: 760px;
    }

    th {
      text-align: left;
      padding: 10px 14px;
      border-bottom: 1px solid #2a2a35;
      color: #888899;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    td {
      padding: 12px 14px;
      border-bottom: 1px solid #1e1e28;
      color: #ccccd8;
    }

    tr:hover td {
      background: #1c1c25;
    }

    .badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
    }

    .badge-green {
      background: #0d2e1a;
      color: #3dd68c;
    }

    .badge-yellow {
      background: #2e2010;
      color: #f4a523;
    }

    .badge-blue {
      background: #0d1e35;
      color: #4da3ff;
    }

    .badge-gray {
      background: #1e1e28;
      color: #9999aa;
    }

    .badge-red {
      background: #2e0d14;
      color: #ff4d6a;
    }

    .btn {
      display: inline-block;
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      text-decoration: none;
    }

    .btn-primary {
      background: #fe2c55;
      color: #ffffff;
    }

    .btn-primary:hover {
      background: #e01f45;
    }

    .btn-ghost {
      background: transparent;
      border: 1px solid #2a2a35;
      color: #ccccd8;
    }

    .btn-ghost:hover {
      border-color: #fe2c55;
      color: #fe2c55;
    }

    .login-page {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    .login-wrap {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 36px 24px;
    }

    .login-box {
      background: #18181f;
      border: 1px solid #2a2a35;
      border-radius: 16px;
      padding: 40px;
      width: 100%;
      max-width: 420px;
      box-shadow:
        0 20px 70px rgba(0, 0, 0, 0.28);
    }

    .login-logo {
      text-align: center;
      margin-bottom: 32px;
    }

    .brand-mark {
      width: 58px;
      height: 58px;
      margin: 0 auto 16px;
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      background:
        linear-gradient(
          135deg,
          #fe2c55,
          #8f3cff
        );
      color: #ffffff;
      font-size: 20px;
      font-weight: 800;
      letter-spacing: 1px;
    }

    .login-logo h1 {
      font-size: 23px;
      font-weight: 700;
    }

    .login-logo p {
      color: #888899;
      font-size: 14px;
      margin-top: 8px;
    }

    .login-note {
      color: #777788;
      font-size: 12px;
      margin-top: 8px;
      line-height: 1.6;
    }

    label {
      display: block;
      font-size: 13px;
      color: #9999aa;
      margin-bottom: 6px;
    }

    input[type="text"],
    input[type="password"] {
      width: 100%;
      background: #0f0f14;
      border: 1px solid #2a2a35;
      color: #ffffff;
      padding: 11px 14px;
      border-radius: 8px;
      font-size: 14px;
      margin-bottom: 16px;
      outline: none;
    }

    input:focus {
      border-color: #fe2c55;
    }

    .error {
      color: #ff4d6a;
      font-size: 13px;
      margin-bottom: 16px;
      padding: 10px 14px;
      background: #2e0d14;
      border-radius: 8px;
    }

    .alert {
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 14px;
      margin-bottom: 20px;
    }

    .alert-info {
      background: #0d1e35;
      border: 1px solid #1a3a6a;
      color: #4da3ff;
    }

    .alert-success {
      background: #0d2e1a;
      border: 1px solid #1a5c35;
      color: #3dd68c;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
    }

    .section-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .empty {
      text-align: center;
      padding: 60px 20px;
      color: #777788;
    }

    .empty .icon {
      font-size: 40px;
      margin-bottom: 12px;
    }

    .shop-tag {
      font-size: 11px;
      color: #9999aa;
      background: #1e1e28;
      padding: 2px 8px;
      border-radius: 4px;
    }

    .footer {
      padding: 22px 24px;
      border-top: 1px solid #22222d;
      text-align: center;
      color: #777788;
      font-size: 12px;
      line-height: 1.8;
    }

    .footer-links {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-wrap: wrap;
      gap: 14px;
      margin-top: 4px;
    }

    .footer a {
      color: #9999aa;
      text-decoration: none;
    }

    .footer a:hover {
      color: #ffffff;
    }

    .legal-page {
      min-height: 100vh;
    }

    .legal-nav {
      background: #18181f;
      border-bottom: 1px solid #2a2a35;
      padding: 16px 24px;
    }

    .legal-nav-inner {
      max-width: 900px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }

    .legal-brand {
      font-weight: 700;
      color: #ffffff;
    }

    .legal-brand span {
      color: #fe2c55;
    }

    .legal-nav a {
      color: #9999aa;
      text-decoration: none;
      font-size: 14px;
    }

    .legal-nav a:hover {
      color: #ffffff;
    }

    .legal-content {
      max-width: 900px;
      margin: 0 auto;
      padding: 54px 24px 72px;
    }

    .legal-content h1 {
      font-size: 32px;
      margin-bottom: 12px;
    }

    .legal-updated {
      color: #777788;
      font-size: 13px;
      margin-bottom: 34px;
    }

    .legal-section {
      background: #18181f;
      border: 1px solid #2a2a35;
      border-radius: 12px;
      padding: 26px;
      margin-bottom: 18px;
    }

    .legal-section h2 {
      font-size: 18px;
      margin-bottom: 12px;
    }

    .legal-section p,
    .legal-section li {
      color: #b5b5c1;
      font-size: 14px;
      line-height: 1.8;
    }

    .legal-section ul {
      padding-left: 20px;
    }

    .contact-box {
      background: #18181f;
      border: 1px solid #2a2a35;
      border-radius: 12px;
      padding: 28px;
      margin-top: 24px;
    }

    .contact-row {
      padding: 14px 0;
      border-bottom: 1px solid #262631;
    }

    .contact-row:last-child {
      border-bottom: none;
    }

    .contact-label {
      color: #777788;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }

    .contact-value {
      color: #ffffff;
      font-size: 15px;
    }

    @media (max-width: 760px) {
      .nav {
        align-items: flex-start;
        flex-direction: column;
        padding: 16px 20px;
      }

      .nav-links {
        gap: 14px;
      }

      .container {
        padding: 24px 16px;
      }

      .login-box {
        padding: 30px 24px;
      }

      .section-header {
        align-items: flex-start;
        flex-direction: column;
      }

      .legal-content {
        padding-top: 36px;
      }
    }
  </style>
</head>

<body>
  ${body}
</body>
</html>`;
};

function publicFooter() {
  return `
    <footer class="footer">
      <div>
        © 2026 Hengchun Global. All rights reserved.
      </div>

      <div class="footer-links">
        <a href="/privacy">
          Privacy Policy
        </a>

        <a href="/terms">
          Terms of Service
        </a>

        <a href="/contact">
          Contact
        </a>
      </div>
    </footer>
  `;
}

function adminNavigation() {
  return `
    <nav class="nav">
      <div class="logo">
        <span>HG</span>
        Hengchun Global Platform
      </div>

      <div class="nav-links">
        <a href="/dashboard">
          Dashboard
        </a>

        <a href="/orders">
          Order Management
        </a>

        <a href="/shops">
          Shop Authorization
        </a>

        <a href="/logout">
          Log Out
        </a>
      </div>
    </nav>
  `;
}

function legalNavigation() {
  return `
    <nav class="legal-nav">
      <div class="legal-nav-inner">
        <div class="legal-brand">
          <span>HG</span>
          Hengchun Global
        </div>

        <a href="/login">
          Return to Login
        </a>
      </div>
    </nav>
  `;
}

function statusBadge(status) {
  const map = {
    UNPAID: [
      'badge-yellow',
      'Unpaid',
    ],

    ON_HOLD: [
      'badge-yellow',
      'On Hold',
    ],

    PARTIALLY_SHIPPING: [
      'badge-blue',
      'Partially Shipped',
    ],

    AWAITING_SHIPMENT: [
      'badge-blue',
      'Awaiting Shipment',
    ],

    AWAITING_COLLECTION: [
      'badge-blue',
      'Awaiting Collection',
    ],

    IN_TRANSIT: [
      'badge-blue',
      'In Transit',
    ],

    DELIVERED: [
      'badge-green',
      'Delivered',
    ],

    COMPLETED: [
      'badge-green',
      'Completed',
    ],

    CANCELLED: [
      'badge-red',
      'Cancelled',
    ],
  };

  const [className, label] =
    map[status] || [
      'badge-gray',
      status || 'Unknown',
    ];

  return `
    <span class="badge ${className}">
      ${label}
    </span>
  `;
}

// ─── Public Routes ────────────────────────────────────────────────────────────

// Login page
app.get('/login', (req, res) => {
  if (req.session.loggedIn) {
    return res.redirect('/dashboard');
  }

  return res.send(
    layout(
      'Secure Login',
      `
        <div class="login-page">
          <main class="login-wrap">
            <section class="login-box">
              <div class="login-logo">
                <div class="brand-mark">
                  HG
                </div>

                <h1>
                  Hengchun Global
                </h1>

                <p>
                  Internal Management Platform
                </p>

                <div class="login-note">
                  Authorized personnel only.
                </div>
              </div>

              ${
                req.query.error
                  ? `
                    <div class="error">
                      Incorrect username or password.
                      Please try again.
                    </div>
                  `
                  : ''
              }

              <form
                method="POST"
                action="/login"
              >
                <label for="username">
                  Username
                </label>

                <input
                  id="username"
                  type="text"
                  name="username"
                  placeholder="Enter your username"
                  autocomplete="username"
                  required
                >

                <label for="password">
                  Password
                </label>

                <input
                  id="password"
                  type="password"
                  name="password"
                  placeholder="Enter your password"
                  autocomplete="current-password"
                  required
                >

                <button
                  type="submit"
                  class="btn btn-primary"
                  style="
                    width: 100%;
                    padding: 12px;
                  "
                >
                  Log In
                </button>
              </form>
            </section>
          </main>

          ${publicFooter()}
        </div>
      `,
      {
        description:
          'Secure internal management portal for Hengchun Global.',
      }
    )
  );
});

// Login submission
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (
    username === ADMIN_USER &&
    password === ADMIN_PASS
  ) {
    req.session.loggedIn = true;

    return res.redirect('/dashboard');
  }

  return res.redirect('/login?error=1');
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error(
        'Session destroy failed:',
        error.message
      );
    }

    res.redirect('/login');
  });
});

// Privacy Policy
app.get('/privacy', (req, res) => {
  return res.send(
    layout(
      'Privacy Policy',
      `
        <div class="legal-page">
          ${legalNavigation()}

          <main class="legal-content">
            <h1>
              Privacy Policy
            </h1>

            <div class="legal-updated">
              Last updated: July 2026
            </div>

            <section class="legal-section">
              <h2>
                1. Scope
              </h2>

              <p>
                This privacy policy applies to the
                Hengchun Global internal management
                platform and its authorized business
                users.
              </p>
            </section>

            <section class="legal-section">
              <h2>
                2. Information We Process
              </h2>

              <p>
                The platform may process account,
                store, order, operational and technical
                information required to provide
                authorized e-commerce management
                services.
              </p>
            </section>

            <section class="legal-section">
              <h2>
                3. Purpose of Processing
              </h2>

              <ul>
                <li>
                  To authenticate authorized users.
                </li>

                <li>
                  To connect authorized e-commerce
                  stores.
                </li>

                <li>
                  To synchronize and manage order
                  information.
                </li>

                <li>
                  To maintain system security and
                  operational records.
                </li>
              </ul>
            </section>

            <section class="legal-section">
              <h2>
                4. Data Access
              </h2>

              <p>
                Access is limited to authorized
                personnel and approved business
                processes. The platform is not intended
                for public registration or public
                account collection.
              </p>
            </section>

            <section class="legal-section">
              <h2>
                5. Data Retention
              </h2>

              <p>
                Information is retained only for as
                long as reasonably required for
                business operations, legal obligations
                and security purposes.
              </p>
            </section>

            <section class="legal-section">
              <h2>
                6. Contact
              </h2>

              <p>
                Questions regarding privacy may be
                submitted through the contact
                information provided on our contact
                page.
              </p>
            </section>
          </main>

          ${publicFooter()}
        </div>
      `
    )
  );
});

// Terms of Service
app.get('/terms', (req, res) => {
  return res.send(
    layout(
      'Terms of Service',
      `
        <div class="legal-page">
          ${legalNavigation()}

          <main class="legal-content">
            <h1>
              Terms of Service
            </h1>

            <div class="legal-updated">
              Last updated: July 2026
            </div>

            <section class="legal-section">
              <h2>
                1. Authorized Use
              </h2>

              <p>
                This platform is provided for
                authorized internal business use.
                Users must have permission from
                Hengchun Global before accessing the
                system.
              </p>
            </section>

            <section class="legal-section">
              <h2>
                2. Account Security
              </h2>

              <p>
                Users are responsible for keeping
                their credentials confidential and
                must not share access with unauthorized
                individuals.
              </p>
            </section>

            <section class="legal-section">
              <h2>
                3. Acceptable Use
              </h2>

              <ul>
                <li>
                  Do not attempt unauthorized access.
                </li>

                <li>
                  Do not interfere with platform
                  operation or security.
                </li>

                <li>
                  Do not use the platform for illegal,
                  deceptive or fraudulent activities.
                </li>

                <li>
                  Only connect stores and data for
                  which proper authorization has been
                  obtained.
                </li>
              </ul>
            </section>

            <section class="legal-section">
              <h2>
                4. Third-Party Services
              </h2>

              <p>
                The platform may connect to authorized
                third-party e-commerce services.
                Availability and functionality may
                depend on those providers.
              </p>
            </section>

            <section class="legal-section">
              <h2>
                5. Service Availability
              </h2>

              <p>
                Reasonable efforts are made to maintain
                availability, but uninterrupted
                operation is not guaranteed.
              </p>
            </section>

            <section class="legal-section">
              <h2>
                6. Suspension
              </h2>

              <p>
                Access may be restricted or suspended
                when unauthorized, unsafe or improper
                use is identified.
              </p>
            </section>
          </main>

          ${publicFooter()}
        </div>
      `
    )
  );
});

// Contact
app.get('/contact', (req, res) => {
  return res.send(
    layout(
      'Contact',
      `
        <div class="legal-page">
          ${legalNavigation()}

          <main class="legal-content">
            <h1>
              Contact Hengchun Global
            </h1>

            <div class="legal-updated">
              Business and platform support
            </div>

            <section class="legal-section">
              <h2>
                About This Platform
              </h2>

              <p>
                This website is an internal enterprise
                management platform used for
                authorized cross-border e-commerce
                operations, store connections and
                order management.
              </p>
            </section>

            <div class="contact-box">
              <div class="contact-row">
                <div class="contact-label">
                  Organization
                </div>

                <div class="contact-value">
                  Hengchun Global
                </div>
              </div>

              <div class="contact-row">
                <div class="contact-label">
                  Website
                </div>

                <div class="contact-value">
                  hengchunglobal.com
                </div>
              </div>

              <div class="contact-row">
                <div class="contact-label">
                  Service Type
                </div>

                <div class="contact-value">
                  Cross-border e-commerce management
                  and integration services
                </div>
              </div>

              <div class="contact-row">
                <div class="contact-label">
                  Access
                </div>

                <div class="contact-value">
                  Authorized personnel only
                </div>
              </div>
            </div>
          </main>

          ${publicFooter()}
        </div>
      `
    )
  );
});

// ─── Protected Routes ─────────────────────────────────────────────────────────

// Dashboard
app.get(
  ['/', '/dashboard'],
  requireLogin,
  async (req, res) => {
    let db;

    try {
      db = await getDB();

      const [orders] = await db.execute(
        `
          SELECT *
          FROM tiktok_orders
          ORDER BY create_time DESC
          LIMIT 100
        `
      );

      const [shops] = await db.execute(
        `
          SELECT *
          FROM tiktok_tokens
        `
      );

      const [stats] = await db.execute(`
        SELECT
          COUNT(*) AS total,

          SUM(
            CASE
              WHEN status = 'COMPLETED'
              THEN 1
              ELSE 0
            END
          ) AS completed,

          SUM(
            CASE
              WHEN status = 'AWAITING_SHIPMENT'
              THEN 1
              ELSE 0
            END
          ) AS pending,

          SUM(
            CASE
              WHEN status = 'CANCELLED'
              THEN 1
              ELSE 0
            END
          ) AS cancelled,

          SUM(total_amount) AS revenue

        FROM tiktok_orders
      `);

      const statsRow = stats[0] || {};

      const hasOrders =
        orders.length > 0;

      const hasShops =
        shops.length > 0;

      const authUrl =
        'https://services.tiktok.com/open/authorize' +
        `?service_id=${APP_KEY}` +
        `&redirect_uri=${encodeURIComponent(
          REDIRECT_URI
        )}`;

      return res.send(
        layout(
          'Dashboard',
          `
            ${adminNavigation()}

            <main class="container">
              <div class="page-title">
                Dashboard
              </div>

              <div class="page-sub">
                Cross-border e-commerce order data
                overview
              </div>

              ${
                req.query.auth === 'success'
                  ? `
                    <div class="alert alert-success">
                      Shop authorization completed
                      successfully.
                    </div>
                  `
                  : ''
              }

              ${
                !hasShops
                  ? `
                    <div class="alert alert-info">
                      No shops have been authorized yet.

                      <a
                        href="${authUrl}"
                        style="
                          color: #ffffff;
                          font-weight: 600;
                        "
                      >
                        Authorize your TikTok Shop
                      </a>

                      to begin synchronizing order data.
                    </div>
                  `
                  : ''
              }

              ${
                req.query.error === 'sync'
                  ? `
                    <div
                      class="alert"
                      style="
                        background: #2e0d14;
                        border: 1px solid #5c1a2e;
                        color: #ff4d6a;
                      "
                    >
                      An error occurred during
                      synchronization. Please check the
                      server logs.
                    </div>
                  `
                  : ''
              }

              ${
                req.query.synced
                  ? `
                    <div class="alert alert-success">
                      Synchronization completed.
                      ${Number(
                        req.query.synced
                      )} orders were returned.
                    </div>
                  `
                  : ''
              }

              <div class="stats">
                <div class="stat">
                  <div class="label">
                    Total Orders
                  </div>

                  <div class="value">
                    ${statsRow.total || 0}
                  </div>

                  <div class="sub">
                    All Statuses
                  </div>
                </div>

                <div class="stat">
                  <div class="label">
                    Completed
                  </div>

                  <div
                    class="value"
                    style="color: #3dd68c"
                  >
                    ${statsRow.completed || 0}
                  </div>

                  <div class="sub">
                    COMPLETED
                  </div>
                </div>

                <div class="stat">
                  <div class="label">
                    Awaiting Shipment
                  </div>

                  <div
                    class="value"
                    style="color: #4da3ff"
                  >
                    ${statsRow.pending || 0}
                  </div>

                  <div class="sub">
                    AWAITING SHIPMENT
                  </div>
                </div>

                <div class="stat">
                  <div class="label">
                    Cancelled
                  </div>

                  <div
                    class="value"
                    style="color: #ff4d6a"
                  >
                    ${statsRow.cancelled || 0}
                  </div>

                  <div class="sub">
                    CANCELLED
                  </div>
                </div>

                <div class="stat">
                  <div class="label">
                    Total Revenue
                  </div>

                  <div
                    class="value"
                    style="color: #f4a523"
                  >
                    ${Number(
                      statsRow.revenue || 0
                    ).toLocaleString()}
                  </div>

                  <div class="sub">
                    VND
                  </div>
                </div>
              </div>

              <section class="card">
                <div class="section-header">
                  <div style="font-weight: 600">
                    Recent Orders
                  </div>

                  <div class="section-actions">
                    <a
                      href="/api/sync"
                      class="btn btn-ghost"
                      style="font-size: 13px"
                    >
                      Sync Data
                    </a>

                    <a
                      href="/orders"
                      class="btn btn-ghost"
                      style="font-size: 13px"
                    >
                      View All
                    </a>
                  </div>
                </div>

                ${
                  hasOrders
                    ? `
                      <table>
                        <thead>
                          <tr>
                            <th>
                              Order ID
                            </th>

                            <th>
                              Shop
                            </th>

                            <th>
                              Amount
                            </th>

                            <th>
                              Status
                            </th>

                            <th>
                              Order Time
                            </th>
                          </tr>
                        </thead>

                        <tbody>
                          ${orders
                            .slice(0, 20)
                            .map(
                              (order) => `
                                <tr>
                                  <td
                                    style="
                                      font-family: monospace;
                                      font-size: 13px;
                                    "
                                  >
                                    ${order.order_id}
                                  </td>

                                  <td>
                                    <span class="shop-tag">
                                      ${
                                        order.shop_name ||
                                        order.shop_id
                                      }
                                    </span>
                                  </td>

                                  <td>
                                    ${Number(
                                      order.total_amount
                                    ).toLocaleString()}
                                    ${order.currency}
                                  </td>

                                  <td>
                                    ${statusBadge(
                                      order.status
                                    )}
                                  </td>

                                  <td>
                                    ${
                                      order.create_time
                                        ? new Date(
                                            order.create_time *
                                              1000
                                          ).toLocaleString(
                                            'en-US'
                                          )
                                        : '-'
                                    }
                                  </td>
                                </tr>
                              `
                            )
                            .join('')}
                        </tbody>
                      </table>
                    `
                    : `
                      <div class="empty">
                        <div class="icon">
                          📦
                        </div>

                        <div>
                          No order data yet
                        </div>

                        <div
                          style="
                            margin-top: 8px;
                            font-size: 13px;
                          "
                        >
                          Authorize a shop and then
                          click Sync Data.
                        </div>
                      </div>
                    `
                }
              </section>
            </main>
          `
        )
      );
    } catch (error) {
      console.error(
        'Dashboard load failed:',
        error.message
      );

      return res.status(500).send(
        layout(
          'Server Error',
          `
            ${adminNavigation()}

            <main class="container">
              <section class="card">
                <div class="page-title">
                  Unable to load dashboard
                </div>

                <div class="page-sub">
                  Please check the server logs and
                  database connection.
                </div>
              </section>
            </main>
          `
        )
      );
    } finally {
      if (db) {
        await db.end();
      }
    }
  }
);

// Orders page
app.get(
  '/orders',
  requireLogin,
  async (req, res) => {
    let db;

    try {
      db = await getDB();

      const status =
        req.query.status || '';

      const query = status
        ? `
            SELECT *
            FROM tiktok_orders
            WHERE status = ?
            ORDER BY create_time DESC
          `
        : `
            SELECT *
            FROM tiktok_orders
            ORDER BY create_time DESC
          `;

      const [orders] = await db.execute(
        query,
        status ? [status] : []
      );

      const statuses = [
        'AWAITING_SHIPMENT',
        'IN_TRANSIT',
        'DELIVERED',
        'COMPLETED',
        'CANCELLED',
        'UNPAID',
      ];

      return res.send(
        layout(
          'Order Management',
          `
            ${adminNavigation()}

            <main class="container">
              <div class="page-title">
                Order Management
              </div>

              <div class="page-sub">
                ${orders.length} order records total
              </div>

              <div
                style="
                  margin-bottom: 20px;
                  display: flex;
                  gap: 8px;
                  flex-wrap: wrap;
                "
              >
                <a
                  href="/orders"
                  class="btn btn-ghost"
                  style="
                    font-size: 13px;
                    padding: 7px 14px;
                  "
                >
                  All
                </a>

                ${statuses
                  .map(
                    (itemStatus) => `
                      <a
                        href="/orders?status=${itemStatus}"
                        class="btn btn-ghost"
                        style="
                          font-size: 13px;
                          padding: 7px 14px;
                        "
                      >
                        ${statusBadge(itemStatus)}
                      </a>
                    `
                  )
                  .join('')}
              </div>

              <section class="card">
                ${
                  orders.length > 0
                    ? `
                      <table>
                        <thead>
                          <tr>
                            <th>
                              Order ID
                            </th>

                            <th>
                              Shop
                            </th>

                            <th>
                              Buyer UID
                            </th>

                            <th>
                              Amount
                            </th>

                            <th>
                              Status
                            </th>

                            <th>
                              Order Time
                            </th>
                          </tr>
                        </thead>

                        <tbody>
                          ${orders
                            .map(
                              (order) => `
                                <tr>
                                  <td
                                    style="
                                      font-family: monospace;
                                      font-size: 13px;
                                    "
                                  >
                                    ${order.order_id}
                                  </td>

                                  <td>
                                    <span class="shop-tag">
                                      ${
                                        order.shop_name ||
                                        order.shop_id
                                      }
                                    </span>
                                  </td>

                                  <td
                                    style="
                                      font-size: 12px;
                                      color: #9999aa;
                                    "
                                  >
                                    ${
                                      order.buyer_uid ||
                                      '-'
                                    }
                                  </td>

                                  <td>
                                    ${Number(
                                      order.total_amount
                                    ).toLocaleString()}
                                    ${order.currency}
                                  </td>

                                  <td>
                                    ${statusBadge(
                                      order.status
                                    )}
                                  </td>

                                  <td>
                                    ${
                                      order.create_time
                                        ? new Date(
                                            order.create_time *
                                              1000
                                          ).toLocaleString(
                                            'en-US'
                                          )
                                        : '-'
                                    }
                                  </td>
                                </tr>
                              `
                            )
                            .join('')}
                        </tbody>
                      </table>
                    `
                    : `
                      <div class="empty">
                        <div class="icon">
                          📦
                        </div>

                        <div>
                          No order data yet
                        </div>
                      </div>
                    `
                }
              </section>
            </main>
          `
        )
      );
    } catch (error) {
      console.error(
        'Orders page failed:',
        error.message
      );

      return res.status(500).send(
        'Unable to load orders'
      );
    } finally {
      if (db) {
        await db.end();
      }
    }
  }
);

// Shops page
app.get(
  '/shops',
  requireLogin,
  async (req, res) => {
    let db;

    try {
      db = await getDB();

      const [shops] = await db.execute(
        `
          SELECT *
          FROM tiktok_tokens
        `
      );

      const authUrl =
        'https://services.tiktok.com/open/authorize' +
        `?service_id=${APP_KEY}` +
        `&redirect_uri=${encodeURIComponent(
          REDIRECT_URI
        )}`;

      return res.send(
        layout(
          'Shop Authorization',
          `
            ${adminNavigation()}

            <main class="container">
              <div class="page-title">
                Shop Authorization
              </div>

              <div class="page-sub">
                Manage authorized TikTok Shop Vietnam
                stores
              </div>

              <div style="margin-bottom: 20px">
                <a
                  href="${authUrl}"
                  class="btn btn-primary"
                >
                  + Authorize New Shop
                </a>
              </div>

              <section class="card">
                ${
                  shops.length > 0
                    ? `
                      <table>
                        <thead>
                          <tr>
                            <th>
                              Shop Name
                            </th>

                            <th>
                              Shop ID
                            </th>

                            <th>
                              Shop Cipher
                            </th>

                            <th>
                              Token Status
                            </th>

                            <th>
                              Updated At
                            </th>
                          </tr>
                        </thead>

                        <tbody>
                          ${shops
                            .map((shop) => {
                              const expired =
                                shop.expire_time &&
                                shop.expire_time <
                                  Date.now() / 1000;

                              return `
                                <tr>
                                  <td>
                                    ${
                                      shop.shop_name ||
                                      '-'
                                    }
                                  </td>

                                  <td
                                    style="
                                      font-family: monospace;
                                      font-size: 13px;
                                    "
                                  >
                                    ${shop.shop_id}
                                  </td>

                                  <td
                                    style="
                                      font-family: monospace;
                                      font-size: 12px;
                                    "
                                  >
                                    ${
                                      shop.shop_cipher
                                        ? 'Obtained'
                                        : 'Missing'
                                    }
                                  </td>

                                  <td>
                                    ${
                                      expired
                                        ? `
                                          <span
                                            class="badge badge-red"
                                          >
                                            Expired
                                          </span>
                                        `
                                        : `
                                          <span
                                            class="badge badge-green"
                                          >
                                            Valid
                                          </span>
                                        `
                                    }
                                  </td>

                                  <td>
                                    ${
                                      shop.updated_at
                                        ? new Date(
                                            shop.updated_at
                                          ).toLocaleString(
                                            'en-US'
                                          )
                                        : '-'
                                    }
                                  </td>
                                </tr>
                              `;
                            })
                            .join('')}
                        </tbody>
                      </table>
                    `
                    : `
                      <div class="empty">
                        <div class="icon">
                          🏪
                        </div>

                        <div>
                          No shops authorized yet
                        </div>

                        <div style="margin-top: 12px">
                          <a
                            href="${authUrl}"
                            class="btn btn-primary"
                          >
                            Authorize Now
                          </a>
                        </div>
                      </div>
                    `
                }
              </section>
            </main>
          `
        )
      );
    } catch (error) {
      console.error(
        'Shops page failed:',
        error.message
      );

      return res.status(500).send(
        'Unable to load authorized shops'
      );
    } finally {
      if (db) {
        await db.end();
      }
    }
  }
);

// OAuth callback
app.get(
  '/auth/callback',
  async (req, res) => {
    const { code, shop_id: shopId } =
      req.query;

    if (!code) {
      return res
        .status(400)
        .send('Missing authorization code');
    }

    try {
      const tokenPath =
        '/api/v2/token/get';

      const tokenParams = {
        app_key: APP_KEY,
        app_secret: APP_SECRET,
        auth_code: code,
        grant_type: 'authorized_code',
      };

      let tokenResponse;
      let data;

      try {
        tokenResponse = await axios.get(
          'https://auth.tiktok-shops.com' +
            tokenPath,
          {
            params: tokenParams,
          }
        );

        data =
          tokenResponse.data?.data;
      } catch (tokenError) {
        console.error(
          'Token fetch failed:',
          tokenError?.response?.data ||
            tokenError.message
        );

        throw tokenError;
      }

      if (!data?.access_token) {
        return res.send(
          'Authorization failed: ' +
            JSON.stringify(
              tokenResponse.data
            )
        );
      }

      let shopCipher = '';

      let actualShopId =
        shopId ||
        data.open_id ||
        'unknown';

      let sellerName =
        data.seller_name || '';

      try {
        const shopInfo =
          await getShopInfo(
            data.access_token
          );

        const authorizedShop =
          shopInfo?.data?.shops?.[0];

        if (authorizedShop) {
          shopCipher =
            authorizedShop.cipher || '';

          actualShopId =
            authorizedShop.id ||
            actualShopId;

          sellerName =
            authorizedShop.name ||
            sellerName;
        }
      } catch (shopInfoError) {
        console.error(
          'getShopInfo failed:',
          shopInfoError?.response?.data ||
            shopInfoError.message
        );
      }

      const db = await getDB();

      try {
        await db.execute(
          `
            INSERT INTO tiktok_tokens (
              shop_id,
              shop_name,
              access_token,
              refresh_token,
              expire_time,
              shop_cipher
            )
            VALUES (?, ?, ?, ?, ?, ?)

            ON DUPLICATE KEY UPDATE
              shop_name = VALUES(shop_name),
              access_token = VALUES(access_token),
              refresh_token = VALUES(refresh_token),
              expire_time = VALUES(expire_time),
              shop_cipher = VALUES(shop_cipher)
          `,
          [
            actualShopId,
            sellerName,
            data.access_token,
            data.refresh_token || '',
            data.access_token_expire_in ||
              0,
            shopCipher,
          ]
        );
      } finally {
        await db.end();
      }

      return res.redirect(
        '/dashboard?auth=success'
      );
    } catch (error) {
      console.error(
        error?.response?.data ||
          error.message
      );

      return res.status(500).send(
        'Authorization failed: ' +
          (error?.response?.data
            ? JSON.stringify(
                error.response.data
              )
            : error.message)
      );
    }
  }
);

// Manual sync
app.get(
  '/api/sync',
  requireLogin,
  async (req, res) => {
    try {
      const db = await getDB();

      let shops;

      try {
        const [rows] = await db.execute(
          `
            SELECT *
            FROM tiktok_tokens
          `
        );

        shops = rows;
      } finally {
        await db.end();
      }

      if (shops.length === 0) {
        return res.redirect('/shops');
      }

      let total = 0;

      for (const shop of shops) {
        if (!shop.shop_cipher) {
          console.error(
            `Sync skipped for shop ` +
              `${shop.shop_id}: ` +
              'missing shop_cipher, ' +
              'please re-authorize'
          );

          continue;
        }

        try {
          const count = await syncOrders(
            shop.shop_id,
            shop.access_token,
            shop.shop_name,
            shop.shop_cipher
          );

          total += count;
        } catch (error) {
          console.error(
            `Sync failed for shop ` +
              `${shop.shop_id}:`,
            error.message
          );

          if (error.response) {
            console.error(
              `Status: ${error.response.status}`
            );

            console.error(
              'Response data:',
              JSON.stringify(
                error.response.data
              )
            );
          }
        }
      }

      return res.redirect(
        `/dashboard?synced=${total}`
      );
    } catch (error) {
      console.error(
        'Sync route failed:',
        error.message
      );

      return res.redirect(
        '/dashboard?error=sync'
      );
    }
  }
);

// Health check
app.get('/health', (req, res) => {
  return res.json({
    status: 'ok',
    service:
      'hengchun-global-platform',
    time: new Date().toISOString(),
  });
});

// 404
app.use((req, res) => {
  return res.status(404).send(
    layout(
      'Page Not Found',
      `
        <div class="legal-page">
          ${legalNavigation()}

          <main class="legal-content">
            <section class="legal-section">
              <h1 style="font-size: 26px">
                Page Not Found
              </h1>

              <p style="margin-top: 14px">
                The requested page does not exist.
              </p>
            </section>
          </main>

          ${publicFooter()}
        </div>
      `
    )
  );
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT =
  process.env.PORT || 3000;

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        `Server running on port ${PORT}`
      );
    });
  })
  .catch((error) => {
    console.error(
      'DB init failed:',
      error.message
    );

    process.exit(1);
  });
