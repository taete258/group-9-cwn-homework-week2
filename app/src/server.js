'use strict';
// server.js · จุดเริ่มเว็บ (B01)
// ลำดับ middleware (สำคัญ — อ่าน ARCH.md):
//   body parser → /api/health → /api/test/* (TEST_MODE) → /static → session → res helpers
//   → SLA tick (lib/sla-jobs.js ของ B09) → locals (bell-count) → routers ทุกไฟล์ใน src/routes/*.js
//   → GET / → 404 → error handler

const fs = require('fs');
const path = require('path');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');

const store = require('./db');
const clock = require('./lib/clock');
const bugs = require('./lib/bugs');
const session = require('./lib/session');
const C = require('./lib/constants');

const PORT = Number(process.env.PORT || 3000);
const TEST_MODE = clock.testMode();
const ROUTES_DIR = path.join(__dirname, 'routes');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.set('views', path.join(__dirname, '..', 'views'));
app.set('view engine', 'ejs');
app.use(expressLayouts);
app.set('layout', 'layout');

// ---------- body (≥ 6 MB · CONTRACT §0.10 · multipart ให้ multer ของแต่ละ route จัดการ) ----------
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));

if (process.env.LOG_REQUESTS === '1') {
  app.use((req, res, next) => {
    res.on('finish', () => console.log(`${req.method} ${req.path} ${res.statusCode}`));
    next();
  });
}

// ---------- health (ไม่ต้องล็อกอิน · ไม่ขึ้นกับ TEST_MODE) ----------
app.get('/api/health', (req, res) => res.status(200).json({ status: 'ok' }));

// ---------- test hook ----------
if (TEST_MODE) {
  app.use('/api/test', require('./routes/test'));
} else {
  app.use('/api/test', (req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'Not Found' }));
}

// ---------- static ----------
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ---------- session + helper ----------
app.use(session.middleware);

const isApi = (req) => req.originalUrl.startsWith('/api/');

app.use((req, res, next) => {
  /** JSON error ตาม CONTRACT §0.6: {"code","message", ...extra} */
  res.apiError = (status, code, message, extra = {}) =>
    res.status(status).json({ code, message: message || C.MESSAGES[code] || code, ...extra });
  /** 403: API → FORBIDDEN · หน้า → forbidden-msg */
  res.forbidden = () => (isApi(req)
    ? res.apiError(403, 'FORBIDDEN')
    : res.status(403).render('error', { title: 'ไม่มีสิทธิ์', testid: 'forbidden-msg', message: C.MESSAGES.FORBIDDEN_PAGE }));
  /** 404 ของคำขอ: API → NOT_FOUND 'ไม่พบคำขอ' · หน้า → not-found-msg */
  res.notFound = (message = C.MESSAGES.NOT_FOUND) => (isApi(req)
    ? res.apiError(404, 'NOT_FOUND', message)
    : res.status(404).render('error', { title: 'ไม่พบ', testid: 'not-found-msg', message }));
  /** 401: API → UNAUTHENTICATED · หน้า → redirect /login */
  res.unauthenticated = () => (isApi(req) ? res.apiError(401, 'UNAUTHENTICATED') : res.redirect('/login'));
  next();
});

// ---------- SLA tick ทุก request (ยกเว้น /api/test/* ซึ่ง mount ไว้ก่อนแล้ว) · CONTRACT §0.7 ----------
let slaJobs;
function loadSlaJobs() {
  if (slaJobs !== undefined) return slaJobs;
  const p = path.join(__dirname, 'lib', 'sla-jobs.js');
  slaJobs = fs.existsSync(p) ? require(p) : null;
  return slaJobs;
}
app.use((req, res, next) => {
  const jobs = loadSlaJobs();
  if (jobs && typeof jobs.tick === 'function') {
    try { jobs.tick(); } catch (e) { console.error('[sla-jobs] tick error:', e); }
  }
  next();
});

// ---------- locals สำหรับ views ----------
app.use((req, res, next) => {
  const u = req.user;
  res.locals.C = C;
  res.locals.fmt = {
    date: clock.formatThai,          // '4 ธ.ค. 2569 16:30'
    dateOnly: clock.formatThaiDate,  // '2 ก.พ. 2570'
    iso: clock.toISO,                // '2026-12-04T16:30:00+07:00'
    baht: clock.baht,                // '฿1,010'
  };
  res.locals.nowISO = clock.nowISO();
  res.locals.currentPath = req.path;
  res.locals.testMode = TEST_MODE;
  res.locals.title = res.locals.title || 'e-Service เทศบาลนครตัวอย่าง';
  res.locals.bellCount = 0;
  if (u && (u.role === 'officer' || u.role === 'head') && u.username) {
    res.locals.bellCount = store.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE username = ?').get(u.username).n;
  }
  next();
});

// ---------- routers ของทุกบล็อก: src/routes/*.js (ยกเว้น test.js, *.test.js, _*.js) ----------
function mountRoutes() {
  if (!fs.existsSync(ROUTES_DIR)) return;
  const files = fs.readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.js') && f !== 'test.js' && !f.endsWith('.test.js') && !f.startsWith('_'))
    .sort();
  for (const f of files) {
    try {
      const mod = require(path.join(ROUTES_DIR, f));
      if (typeof mod === 'function' && (mod.stack || mod.handle)) app.use(mod);           // express.Router()
      else if (mod && typeof mod.mount === 'function') mod.mount(app);                    // { mount(app) }
      else if (mod && mod.router) app.use(mod.router);                                    // { router }
      else if (typeof mod === 'function') mod(app);                                       // (app) => {}
      else { console.warn(`[routes] ${f}: ไม่รู้จักรูปแบบ export — ข้าม`); continue; }
      console.log(`[routes] mounted ${f}`);
    } catch (e) {
      console.error(`[routes] โหลด ${f} ไม่สำเร็จ:`, e);
    }
  }
}
mountRoutes();

// ---------- / → หน้าตั้งต้นตามบทบาท (ใช้เมื่อไม่มีบล็อกใด handle '/') ----------
app.get('/', (req, res) => {
  const u = req.user;
  if (!u) return res.redirect('/login');
  if (u.role === 'citizen' && !u.registered) return res.redirect('/register');
  res.redirect(C.LANDING[u.role] || '/login');
});

// ---------- 404 ----------
app.use((req, res) => {
  if (isApi(req)) return res.apiError(404, 'NOT_FOUND', 'Not Found');
  res.status(404).render('error', { title: 'ไม่พบหน้า', testid: 'page-not-found', message: 'ไม่พบหน้าที่ต้องการ' });
});

// ---------- error ----------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ code: 'INVALID_JSON', message: 'รูปแบบ JSON ไม่ถูกต้อง' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ code: 'PAYLOAD_TOO_LARGE', message: 'ข้อมูลใหญ่เกินกำหนด' });
  }
  console.error('[error]', req.method, req.path, err);
  if (res.headersSent) return;
  if (isApi(req)) return res.status(500).json({ code: 'INTERNAL', message: 'เกิดข้อผิดพลาดภายในระบบ' });
  res.status(500).render('error', { title: 'ข้อผิดพลาด', testid: 'server-error', message: 'เกิดข้อผิดพลาดภายในระบบ' });
});

// ---------- start ----------
if (require.main === module) {
  store.ensureSeeded();
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[egov] http://0.0.0.0:${PORT} · TEST_MODE=${TEST_MODE ? '1' : 'off'} · BUG_MODE=${bugs.activeBugs().join(',') || '(none)'}`);
    console.log(`[egov] DB_PATH=${store.DB_PATH} · clock=${clock.nowISO()}${clock.isFrozen() ? ' (frozen)' : ''}`);
  });
  const stop = () => {
    server.close(() => { store.db.close(); process.exit(0); });
    if (server.closeAllConnections) server.closeAllConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = app;
