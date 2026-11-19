'use strict';

// Authentication, first registration, and the shared page/API access guard.
const express = require('express');
const { db, idHash, encrypt } = require('../db');
const session = require('../lib/session');
const clock = require('../lib/clock');
const C = require('../lib/constants');

const router = express.Router();
const LANDING = C.LANDING;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
// หน้าใช้ layout กลาง (app-header) · body เป็น HTML string
const page = (res, title, body, status = 200) => res.status(status).render('layout', { layout: false, title, body });
const LOGIN_BODY = `<section class="card">
  <h1>เข้าสู่ระบบ</h1>
  <div role="tablist" aria-label="เลือกประเภทผู้ใช้">
    <button type="button" role="tab" id="tab-c" aria-controls="pane-c" aria-selected="true" data-testid="login-tab-citizen">ประชาชน</button>
    <button type="button" role="tab" id="tab-s" aria-controls="pane-s" aria-selected="false" data-testid="login-tab-staff">เจ้าหน้าที่</button>
  </div>
  <section id="pane-c" role="tabpanel" aria-labelledby="tab-c">
    <h2>ประชาชน (ThaiD จำลอง)</h2>
    <form id="thaid-form" novalidate>
      <label for="idno">เลขบัตรประชาชน 13 หลัก</label>
      <input id="idno" name="idNo" inputmode="numeric" autocomplete="off" data-testid="thaid-id-input">
      <button type="submit" data-testid="thaid-submit">เข้าสู่ระบบด้วย ThaiD (จำลอง)</button>
    </form>
    <p role="alert" class="alert alert-error" data-testid="thaid-error" hidden></p>
    <div data-testid="otp-step" hidden>
      <form id="otp-form" novalidate>
        <label for="otp">รหัส OTP (จำลอง)</label>
        <input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" data-testid="otp-input">
        <button type="submit" data-testid="otp-submit">ยืนยัน OTP</button>
      </form>
      <p role="alert" class="alert alert-error" data-testid="otp-error" hidden></p>
      <p data-testid="otp-attempts-left" hidden></p>
      <p role="alert" class="alert alert-error" data-testid="lock-message" hidden></p>
      <p hidden id="lock-box">ปลดล็อกเวลา <time data-testid="lock-until" data-iso=""></time></p>
    </div>
  </section>
  <section id="pane-s" role="tabpanel" aria-labelledby="tab-s" hidden>
    <h2>เจ้าหน้าที่ (SSO ภาครัฐ จำลอง)</h2>
    <form id="staff-form" novalidate>
      <label for="username">ชื่อผู้ใช้</label>
      <input id="username" name="username" autocomplete="username" data-testid="staff-username">
      <label for="password">รหัสผ่าน</label>
      <input id="password" type="password" name="password" autocomplete="current-password" data-testid="staff-password">
      <button type="submit" data-testid="staff-submit">เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)</button>
    </form>
    <p role="alert" class="alert alert-error" data-testid="staff-error" hidden></p>
  </section>
</section>
<script>
(function(){
  const $ = (t) => document.querySelector('[data-testid="' + t + '"]');
  const show = (t, msg) => { const e = $(t); e.textContent = msg; e.hidden = false; };
  const hide = (t) => { const e = $(t); e.hidden = true; e.textContent = ''; };
  const fmt = (iso) => { const d = new Date(iso); const m = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
    const b = new Date(d.getTime() + 7 * 3600e3); const p = (n) => String(n).padStart(2, '0');
    return b.getUTCDate() + ' ' + m[b.getUTCMonth()] + ' ' + (b.getUTCFullYear() + 543) + ' ' + p(b.getUTCHours()) + ':' + p(b.getUTCMinutes()); };
  function tab(staff) {
    document.getElementById('pane-c').hidden = staff; document.getElementById('pane-s').hidden = !staff;
    $('login-tab-citizen').setAttribute('aria-selected', String(!staff)); $('login-tab-staff').setAttribute('aria-selected', String(staff));
  }
  $('login-tab-citizen').addEventListener('click', () => tab(false));
  $('login-tab-staff').addEventListener('click', () => tab(true));
  function locked(until) {
    show('lock-message', 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที');
    const t = $('lock-until'); t.setAttribute('data-iso', until || ''); t.textContent = until ? fmt(until) : '';
    document.getElementById('lock-box').hidden = false;
    hide('otp-error'); hide('otp-attempts-left');
  }
  function clearOtp() { hide('otp-error'); hide('otp-attempts-left'); hide('lock-message'); document.getElementById('lock-box').hidden = true; }
  document.getElementById('thaid-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const idNo = $('thaid-id-input').value.trim();
    const r = await EG.api('POST', '/api/auth/thaid/start', { idNo });
    clearOtp();
    if (r.ok) { hide('thaid-error'); $('otp-step').hidden = false; $('otp-input').value = ''; $('otp-input').focus(); return; }
    if (r.status === 423) { hide('thaid-error'); $('otp-step').hidden = false; locked(r.data && r.data.lockedUntil); return; }
    $('otp-step').hidden = true;
    show('thaid-error', (r.data && r.data.message) || 'เลขบัตรประชาชนไม่ถูกต้อง');
  });
  document.getElementById('otp-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const idNo = $('thaid-id-input').value.trim();
    const r = await EG.api('POST', '/api/auth/thaid/verify', { idNo, otp: $('otp-input').value.trim() });
    if (r.ok) { window.location.href = r.data && r.data.registered ? '/citizen' : '/register'; return; }
    clearOtp();
    if (r.status === 423) { locked(r.data && r.data.lockedUntil); return; }
    show('otp-error', (r.data && r.data.message) || 'รหัส OTP ไม่ถูกต้อง');
    if (r.data && typeof r.data.attemptsLeft === 'number') show('otp-attempts-left', 'เหลือ ' + r.data.attemptsLeft + ' ครั้ง');
  });
  document.getElementById('staff-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const r = await EG.api('POST', '/api/auth/staff/login', { username: $('staff-username').value.trim(), password: $('staff-password').value });
    if (r.ok) { window.location.href = (r.data && r.data.landing) || '/'; return; }
    show('staff-error', (r.data && r.data.message) || 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  });
})();
</script>`;
const renderLogin = (res) => page(res, 'เข้าสู่ระบบ', LOGIN_BODY);
const registerBody = (name) => `<section class="card">
  <h1>ลงทะเบียนใช้งานครั้งแรก</h1>
  <form id="reg-form" novalidate>
    <label for="reg-name">ชื่อ-สกุล (จาก ThaiD)</label>
    <input id="reg-name" data-testid="reg-name" value="${esc(name)}" readonly>
    <label for="mobile">เบอร์มือถือ (บังคับ)</label>
    <input id="mobile" name="mobile" inputmode="numeric" autocomplete="tel" data-testid="reg-mobile" aria-describedby="err-mobile">
    <p id="err-mobile" role="alert" class="alert alert-error" data-testid="reg-error-mobile" hidden></p>
    <label for="email">อีเมล (ไม่บังคับ)</label>
    <input id="email" name="email" type="email" autocomplete="email" data-testid="reg-email">
    <p><input type="checkbox" id="consent" name="consent" data-testid="reg-consent" aria-describedby="err-consent">
      <label for="consent">ยินยอมให้ประมวลผลข้อมูลส่วนบุคคลตาม PDPA เพื่อใช้บริการ e-Service</label></p>
    <p id="err-consent" role="alert" class="alert alert-error" data-testid="reg-error-consent" hidden></p>
    <button type="submit" data-testid="reg-submit">ลงทะเบียน</button>
  </form>
</section>
<script>
(function(){
  const $ = (t) => document.querySelector('[data-testid="' + t + '"]');
  document.getElementById('reg-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    ['reg-error-mobile','reg-error-consent'].forEach((t) => { $(t).hidden = true; $(t).textContent = ''; });
    const r = await EG.api('POST', '/api/auth/register', { mobile: $('reg-mobile').value.trim(), email: $('reg-email').value.trim(), consent: $('reg-consent').checked });
    if (r.ok) { window.location.href = (r.data && r.data.landing) || '/citizen'; return; }
    const code = r.data && r.data.code;
    const t = code === 'CONSENT_REQUIRED' ? 'reg-error-consent' : code === 'INVALID_MOBILE' ? 'reg-error-mobile' : null;
    if (t) { $(t).textContent = r.data.message; $(t).hidden = false; } else EG.showError((r.data && r.data.message) || 'เกิดข้อผิดพลาด');
  });
})();
</script>`;

function validThaiId(value) {
  if (!/^\d{13}$/.test(String(value || ''))) return false;
  const digits = [...value].map(Number);
  const sum = digits.slice(0, 12).reduce((n, d, i) => n + d * (13 - i), 0);
  return ((11 - (sum % 11)) % 10) === digits[12];
}
function landing(req, res) {
  const user = req.user;
  if (!user) return res.redirect('/login');
  if (user.role === 'citizen' && !user.registered) return res.redirect('/register');
  return res.redirect(LANDING[user.role] || '/login');
}
function api(req, res) { return req.originalUrl.startsWith('/api/'); }

router.get('/login', (req, res) => req.user ? landing(req, res) : renderLogin(res));
router.get('/register', (req, res) => {
  if (!req.user || req.user.role !== 'citizen' || req.user.registered) return landing(req, res);
  return page(res, 'ลงทะเบียน', registerBody(req.user.name));
});
router.get('/', (req, res) => landing(req, res));

router.post('/api/auth/thaid/start', (req, res) => {
  const idNo = String(req.body.idNo || '');
  if (!validThaiId(idNo)) return res.apiError(400, 'INVALID_ID');
  const hash = idHash(idNo);
  const state = db.prepare('SELECT * FROM otp_state WHERE id_hash=?').get(hash);
  if (state?.locked_until && clock.toMs(state.locked_until) > clock.nowMs()) return res.apiError(423, 'LOCKED', undefined, { lockedUntil: state.locked_until });
  return res.json({ status: 'OTP_SENT' });
});
router.post('/api/auth/thaid/verify', (req, res) => {
  const idNo = String(req.body.idNo || ''), otp = String(req.body.otp || '');
  if (!validThaiId(idNo)) return res.apiError(400, 'INVALID_ID');
  const hash = idHash(idNo);
  let state = db.prepare('SELECT * FROM otp_state WHERE id_hash=?').get(hash);
  if (state?.locked_until && clock.toMs(state.locked_until) > clock.nowMs()) return res.apiError(423, 'LOCKED', undefined, { lockedUntil: state.locked_until });
  if (state?.locked_until && clock.toMs(state.locked_until) <= clock.nowMs()) {
    db.prepare('DELETE FROM otp_state WHERE id_hash=?').run(hash); state = null;
  }
  if (otp !== '123456') {
    const failures = (state?.fail_count || 0) + 1;
    if (failures >= 3) {
      const until = clock.toISO(clock.nowMs() + 15 * clock.MINUTE);
      db.prepare(`INSERT INTO otp_state(id_hash,fail_count,last_fail_at,locked_until) VALUES(?,3,?,?) ON CONFLICT(id_hash) DO UPDATE SET fail_count=3,last_fail_at=excluded.last_fail_at,locked_until=excluded.locked_until`).run(hash, clock.nowISO(), until);
      return res.apiError(423, 'LOCKED', undefined, { lockedUntil: until });
    }
    db.prepare(`INSERT INTO otp_state(id_hash,fail_count,last_fail_at,locked_until) VALUES(?,?,?,NULL) ON CONFLICT(id_hash) DO UPDATE SET fail_count=excluded.fail_count,last_fail_at=excluded.last_fail_at,locked_until=NULL`).run(hash, failures, clock.nowISO());
    return res.apiError(401, 'OTP_INVALID', undefined, { attemptsLeft: 3 - failures });
  }
  db.prepare('DELETE FROM otp_state WHERE id_hash=?').run(hash);
  const user = db.prepare('SELECT * FROM users WHERE id_hash=? AND role=? AND active=1').get(hash, 'citizen');
  if (!user) return res.apiError(404, 'NOT_FOUND', 'ไม่พบข้อมูลประชาชน');
  session.create(res, user, { registered: !!user.registered });
  return res.json({ registered: !!user.registered });
});
router.post('/api/auth/register', (req, res) => {
  if (!req.user || req.user.role !== 'citizen' || req.user.registered) return res.apiError(req.user ? 403 : 401, req.user ? 'FORBIDDEN' : 'UNAUTHENTICATED');
  const mobile = String(req.body.mobile || '');
  if (!/^0\d{9}$/.test(mobile)) return res.apiError(400, 'INVALID_MOBILE');
  if (!(req.body.consent === true || req.body.consent === 'true' || req.body.consent === 'on' || req.body.consent === '1')) return res.apiError(400, 'CONSENT_REQUIRED');
  db.prepare('UPDATE users SET mobile_enc=?,email=?,registered=1,consent_at=? WHERE id=?').run(encrypt(mobile), String(req.body.email || ''), clock.nowISO(), req.user.id);
  session.update(req, { registered: 1 });
  return res.status(201).json({ registered: true, landing: '/citizen' });
});
router.post('/api/auth/staff/login', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username=? AND role<>? AND active=1').get(String(req.body.username || ''), 'citizen');
  if (!user || !session.verifyPassword(String(req.body.password || ''), user.password_hash)) return res.apiError(401, 'INVALID_CREDENTIALS');
  session.create(res, user);
  db.prepare('INSERT INTO audit_log(time,username,role,event,detail) VALUES(?,?,?,?,?)').run(clock.nowISO(), user.username, user.role, 'STAFF_LOGIN', '');
  return res.json({ role: user.role, dept: user.dept || '', landing: LANDING[user.role] });
});
router.post('/api/auth/logout', (req, res) => {
  if (!req.user) return res.apiError(401, 'UNAUTHENTICATED');
  session.destroy(req, res); return res.status(204).end();
});
router.get('/api/me', (req, res) => req.user ? res.json({ username: req.user.username, name: req.user.name, role: req.user.role, dept: req.user.dept }) : res.apiError(401, 'UNAUTHENTICATED'));

// Central route role policy from CONTRACT §1. This runs before routers mounted later.
const rules = [
  [/^\/citizen(?:\/|$)/, ['citizen']], [/^\/officer\/queue(?:\/|$)/, ['officer','head']], [/^\/officer\/cases(?:\/|$)/, ['officer','head']],
  [/^\/head(?:\/|$)/, ['head']], [/^\/dashboard(?:\/|$)/, ['executive']], [/^\/audit(?:\/|$)/, ['auditor']],
  [/^\/admin(?:\/|$)/, ['admin']], [/^\/notifications(?:\/|$)/, ['officer','head']],
];
router.use((req, res, next) => {
  const rule = rules.find(([pattern]) => pattern.test(req.path));
  if (!rule) return next();
  if (!req.user) return api(req, res) ? res.apiError(401, 'UNAUTHENTICATED') : res.redirect('/login');
  if (!rule[1].includes(req.user.role)) return api(req, res) ? res.apiError(403, 'FORBIDDEN') : res.forbidden();
  if (req.path === '/register' && req.user.role === 'citizen' && req.user.registered) return landing(req, res);
  if (req.user.role === 'citizen' && !req.user.registered && req.path !== '/register') return res.redirect('/register');
  next();
});

module.exports = router;
