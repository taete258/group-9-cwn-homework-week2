'use strict';

// B11: read-only audit trail and administrator APIs/pages.
const express = require('express');
const { db } = require('../db');
const clock = require('../lib/clock');
const C = require('../lib/constants');

const router = express.Router();
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const api = (req) => req.path.startsWith('/api/');
function guard(role) {
  return (req, res, next) => {
    if (!req.user) return api(req) ? res.apiError(401, 'UNAUTHENTICATED') : res.redirect('/login');
    if (req.user.role !== role) return res.forbidden();
    next();
  };
}
const auditor = guard('auditor');
const admin = guard('admin');

function filters(q) {
  const where = [], args = [];
  if (q.actor) { where.push('username = ?'); args.push(String(q.actor)); }
  if (q.event) { where.push('event = ?'); args.push(String(q.event)); }
  // Timestamps are normalized to the contract's fixed Bangkok offset.
  if (q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) { where.push("time >= ?"); args.push(`${q.from}T00:00:00+07:00`); }
  if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) { where.push("time <= ?"); args.push(`${q.to}T23:59:59+07:00`); }
  return { sql: where.length ? ` WHERE ${where.join(' AND ')}` : '', args };
}
function auditRows(q) {
  const f = filters(q);
  return db.prepare(`SELECT id,time,username,role,event,case_no AS caseNo,from_status AS fromStatus,to_status AS toStatus,detail FROM audit_log${f.sql} ORDER BY time DESC,id DESC`).all(...f.args);
}
function addAudit(req, detail, event = 'ADMIN_CHANGE') {
  db.prepare('INSERT INTO audit_log(time,username,role,event,case_no,from_status,to_status,detail) VALUES(?,?,?,?,NULL,NULL,NULL,?)')
    .run(clock.nowISO(), req.user.username || '', req.user.role, event, detail);
}
function csvCell(value) { return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`; }

router.get('/api/audit', auditor, (req, res) => {
  const items = auditRows(req.query);
  res.json({ count: items.length, items });
});
router.get('/api/audit/export.csv', auditor, (req, res) => {
  const rows = auditRows(req.query);
  addAudit(req, 'audit-csv', 'EXPORT');
  const header = ['time','username','role','event','caseNo','fromStatus','toStatus','detail'];
  const body = [header.join(','), ...rows.map((r) => header.map((k) => csvCell(r[k])).join(','))].join('\r\n') + '\r\n';
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="audit.csv"');
  res.send('\uFEFF' + body);
});
// Explicitly deny all mutation verbs, including nonexistent IDs and admin callers.
router.all(['/api/audit', '/api/audit/:id'], (req, res, next) => {
  if (['PUT','PATCH','DELETE'].includes(req.method)) return res.apiError(405, 'METHOD_NOT_ALLOWED');
  next();
});

router.get('/api/admin/services', admin, (req, res) => {
  const items = db.prepare('SELECT id,fee,fee_per_sqm AS feePerSqm,sla FROM services ORDER BY sort,id').all();
  res.json({ items });
});
router.put('/api/admin/services/:id', admin, (req, res) => {
  const { id } = req.params;
  const row = db.prepare('SELECT * FROM services WHERE id=?').get(id);
  if (!row) return res.notFound();
  const fee = id === 'SV-03' ? req.body.feeBase : req.body.fee;
  const per = id === 'SV-03' ? req.body.feePerSqm : row.fee_per_sqm;
  const sla = req.body.sla;
  if (!Number.isInteger(fee) || fee < 0 || fee > 100000 || (id === 'SV-03' && (!Number.isInteger(per) || per < 0 || per > 100000))) return res.apiError(400, 'INVALID_FEE');
  if (!Number.isInteger(sla) || sla < 1 || sla > 60) return res.apiError(400, 'INVALID_SLA');
  db.prepare('UPDATE services SET fee=?,fee_per_sqm=?,sla=? WHERE id=?').run(fee, per, sla, id);
  // CONTRACT §6.8: บันทึกเฉพาะฟิลด์ที่เปลี่ยน เช่น `SV-01 fee 20 → 25` · `SV-01 sla 3 → 5`
  const changes = [];
  if (row.fee !== fee) changes.push(`${id} fee ${row.fee} → ${fee}`);
  if (id === 'SV-03' && row.fee_per_sqm !== per) changes.push(`${id} feePerSqm ${row.fee_per_sqm} → ${per}`);
  if (row.sla !== sla) changes.push(`${id} sla ${row.sla} → ${sla}`);
  if (changes.length) addAudit(req, changes.join('; '));
  res.json({ id, fee, feePerSqm: per, sla });
});

router.get('/api/admin/holidays', admin, (req, res) => res.json({ items: db.prepare('SELECT date,name FROM holidays ORDER BY date').all() }));
router.post('/api/admin/holidays', admin, (req, res) => {
  const { date, name } = req.body || {};
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !name || typeof name !== 'string') return res.apiError(400, 'INVALID_INPUT');
  if (db.prepare('SELECT 1 FROM holidays WHERE date=?').get(date)) return res.apiError(409, 'DUPLICATE_HOLIDAY');
  db.prepare('INSERT INTO holidays(date,name) VALUES(?,?)').run(date, name);
  addAudit(req, `holiday add ${date}`);
  res.status(201).json({ date, name });
});
router.delete('/api/admin/holidays/:date', admin, (req, res) => {
  const row = db.prepare('SELECT date,name FROM holidays WHERE date=?').get(req.params.date);
  if (!row) return res.notFound();
  db.prepare('DELETE FROM holidays WHERE date=?').run(row.date);
  addAudit(req, `holiday delete ${row.date}`);
  res.json({ ok: true });
});

router.get('/api/admin/users', admin, (req, res) => {
  const items = db.prepare("SELECT username,role,dept,name,active FROM users WHERE username IS NOT NULL ORDER BY username").all();
  res.json({ items });
});
router.put('/api/admin/users/:username', admin, (req, res) => {
  const { username } = req.params;
  if (username === req.user.username) return res.apiError(409, 'SELF_ROLE_CHANGE');
  const row = db.prepare('SELECT username,role,dept,name FROM users WHERE username=?').get(username);
  if (!row) return res.notFound();
  const { role, dept = '' } = req.body || {};
  if (!C.ROLES.includes(role) || !['', 'registry', 'works'].includes(dept) || (role !== 'officer' && role !== 'head' && dept !== '')) return res.apiError(400, 'INVALID_INPUT');
  db.prepare('UPDATE users SET role=?,dept=? WHERE username=?').run(role, dept, username);
  addAudit(req, `${username} role ${row.role} → ${role}`);
  res.json({ username, role, dept });
});

// หน้า server-rendered ใช้ layout กลาง (app-header · action-error/action-success ผ่าน EG ใน /static/js/app.js)
function page(res, title, body) { return res.render('layout', { layout: false, title, body: `<h1>${esc(title)}</h1>${body}` }); }
router.get('/audit', auditor, (req, res) => {
  const q = { actor: String(req.query.actor || '').trim(), event: String(req.query.event || ''), from: String(req.query.from || ''), to: String(req.query.to || '') };
  const items = auditRows(q);
  const rows = items.map((r) => `<tr data-testid="audit-row" data-id="${r.id}" data-event="${esc(r.event)}" data-actor="${esc(r.username)}" data-case-no="${esc(r.caseNo || '')}">
    <td><time data-testid="audit-time" data-iso="${esc(r.time)}">${esc(clock.formatThai(r.time))}</time></td>
    <td data-testid="audit-actor">${esc(r.username)}</td><td data-testid="audit-role">${esc(r.role)}</td>
    <td data-testid="audit-event">${esc(r.event)}</td><td data-testid="audit-case-no">${esc(r.caseNo || '–')}</td>
    <td data-testid="audit-transition">${r.fromStatus || r.toStatus ? `${esc(r.fromStatus || '–')} → ${esc(r.toStatus || '–')}` : '–'}</td>
    <td data-testid="audit-detail">${esc(r.detail)}</td></tr>`).join('');
  const qs = new URLSearchParams(q).toString();
  page(res, 'Audit Trail', `<section class="card"><form method="get" action="/audit" class="filters">
      <label for="f-actor">ผู้ทำรายการ (username)</label> <input id="f-actor" name="actor" data-testid="audit-filter-actor" value="${esc(q.actor)}">
      <label for="f-event">เหตุการณ์</label> <select id="f-event" name="event" data-testid="audit-filter-event"><option value="">ทั้งหมด</option>${C.AUDIT_EVENTS.map((e) => `<option value="${e}" ${q.event === e ? 'selected' : ''}>${e}</option>`).join('')}</select>
      <label for="f-from">ตั้งแต่วันที่</label> <input id="f-from" type="date" name="from" data-testid="audit-filter-from" value="${esc(q.from)}">
      <label for="f-to">ถึงวันที่</label> <input id="f-to" type="date" name="to" data-testid="audit-filter-to" value="${esc(q.to)}">
      <button type="submit" class="btn" data-testid="audit-apply-btn">ค้นหา</button></form>
    <p>จำนวนรายการ: <strong data-testid="audit-count">${items.length}</strong> · <a class="btn btn-small" data-testid="audit-export-csv-btn" href="/api/audit/export.csv${qs ? `?${esc(qs)}` : ''}" download>ส่งออก CSV</a></p></section>
    <section class="card table-wrap"><table><caption class="sr-only">Audit Trail เรียงใหม่ไปเก่า</caption><thead><tr><th scope="col">เวลา</th><th scope="col">ผู้ทำ</th><th scope="col">บทบาท</th><th scope="col">เหตุการณ์</th><th scope="col">คำขอ</th><th scope="col">สถานะก่อน → หลัง</th><th scope="col">รายละเอียด</th></tr></thead><tbody>${rows}</tbody></table></section>`);
});

const ADMIN_JS = `<script>
async function egSave(url, method, body, after) {
  EG.clearMessages();
  const r = await EG.api(method, url, body);
  if (r.ok) { EG.showSuccess('บันทึกสำเร็จ'); if (after) after(r); }
  else EG.showError((r.data && r.data.message) || 'บันทึกไม่สำเร็จ');
  return r;
}
const egNum = (id) => { const v = document.getElementById(id).value.trim(); return v === '' || !/^-?\\d+$/.test(v) ? (v === '' ? null : Number(v)) : parseInt(v, 10); };
</script>`;

router.get('/admin/services', admin, (req, res) => {
  const items = db.prepare('SELECT id,name,fee,fee_per_sqm,sla FROM services ORDER BY sort,id').all();
  const rows = items.map((s) => `<tr data-testid="service-row" data-service-id="${esc(s.id)}"><th scope="row">${esc(s.id)} ${esc(s.name)}</th>
    <td><label for="fee-${esc(s.id)}">${s.id === 'SV-01' ? 'ค่าธรรมเนียม (฿ ต่อฉบับ)' : s.id === 'SV-03' ? 'ค่าธรรมเนียมฐาน (฿ พื้นที่ 1–100 ตร.ม.)' : 'ค่าธรรมเนียม (฿ คงที่)'}</label>
      <input type="number" step="1" id="fee-${esc(s.id)}" data-testid="svc-fee-${esc(s.id)}" value="${s.fee}">
      ${s.id === 'SV-03' ? `<label for="per-SV-03">฿ ต่อ ตร.ม. ส่วนเกิน 100</label> <input type="number" step="1" id="per-SV-03" data-testid="svc-fee-per-sqm-SV-03" value="${s.fee_per_sqm}">` : ''}</td>
    <td><label for="sla-${esc(s.id)}">SLA (วันทำการ)</label> <input type="number" step="1" id="sla-${esc(s.id)}" data-testid="svc-sla-${esc(s.id)}" value="${s.sla}"></td>
    <td><button type="button" class="btn" data-testid="svc-save-${esc(s.id)}" data-svc="${esc(s.id)}">บันทึก</button></td></tr>`).join('');
  page(res, 'จัดการบริการ', `<section class="card table-wrap"><table><caption class="sr-only">ค่าธรรมเนียมและ SLA</caption><thead><tr><th scope="col">บริการ</th><th scope="col">ค่าธรรมเนียม</th><th scope="col">SLA</th><th scope="col">บันทึก</th></tr></thead><tbody>${rows}</tbody></table></section>${ADMIN_JS}
<script>
document.querySelectorAll('[data-svc]').forEach((b) => b.addEventListener('click', () => {
  const id = b.dataset.svc;
  const body = { sla: egNum('sla-' + id) };
  if (id === 'SV-03') { body.feeBase = egNum('fee-SV-03'); body.feePerSqm = egNum('per-SV-03'); } else body.fee = egNum('fee-' + id);
  egSave('/api/admin/services/' + id, 'PUT', body);
}));
</script>`);
});

router.get('/admin/holidays', admin, (req, res) => {
  const items = db.prepare('SELECT date,name FROM holidays ORDER BY date').all();
  const rows = items.map((h) => `<tr data-testid="holiday-row" data-date="${esc(h.date)}"><td><time data-iso="${esc(h.date)}">${esc(clock.formatThaiDate ? clock.formatThaiDate(h.date) : h.date)}</time> (${esc(h.date)})</td><td>${esc(h.name)}</td>
    <td><button type="button" class="btn btn-small btn-danger" data-testid="holiday-delete-btn" data-date="${esc(h.date)}" aria-label="ลบวันหยุด ${esc(h.date)}">ลบ</button></td></tr>`).join('');
  page(res, 'จัดการวันหยุด', `<section class="card"><form id="hol-add" novalidate>
      <label for="h-date">วันที่ (ค.ศ.)</label> <input type="date" id="h-date" data-testid="holiday-date-input">
      <label for="h-name">ชื่อวันหยุด</label> <input id="h-name" data-testid="holiday-name-input">
      <button type="submit" class="btn" data-testid="holiday-add-btn">เพิ่มวันหยุด</button></form></section>
    <section class="card table-wrap"><table><caption class="sr-only">วันหยุดราชการ</caption><thead><tr><th scope="col">วันที่</th><th scope="col">ชื่อ</th><th scope="col">ลบ</th></tr></thead><tbody>${rows}</tbody></table></section>${ADMIN_JS}
<script>
const reloadSoon = () => setTimeout(() => window.location.reload(), 300);
document.getElementById('hol-add').addEventListener('submit', (e) => { e.preventDefault();
  egSave('/api/admin/holidays', 'POST', { date: document.getElementById('h-date').value, name: document.getElementById('h-name').value.trim() }, reloadSoon); });
document.querySelectorAll('[data-testid="holiday-delete-btn"]').forEach((b) => b.addEventListener('click', () => egSave('/api/admin/holidays/' + b.dataset.date, 'DELETE', undefined, reloadSoon)));
</script>`);
});

router.get('/admin/users', admin, (req, res) => {
  const items = db.prepare("SELECT username,role,dept,name FROM users WHERE username IS NOT NULL ORDER BY username").all();
  const rows = items.map((u, i) => `<tr data-testid="user-row" data-username="${esc(u.username)}"><th scope="row">${esc(u.username)}</th><td>${esc(u.name)}</td>
    <td><label class="sr-only" for="role-${i}">บทบาทของ ${esc(u.username)}</label><select id="role-${i}" data-testid="user-role-select">${C.ROLES.map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${esc(C.ROLE_LABEL[r])} (${r})</option>`).join('')}</select></td>
    <td><label class="sr-only" for="dept-${i}">ฝ่ายของ ${esc(u.username)}</label><select id="dept-${i}" data-testid="user-dept-select"><option value="" ${!u.dept ? 'selected' : ''}>–</option>${['registry', 'works'].map((d) => `<option value="${d}" ${u.dept === d ? 'selected' : ''}>${esc(C.DEPT_LABEL[d])} (${d})</option>`).join('')}</select></td>
    <td><button type="button" class="btn btn-small" data-testid="user-save-btn" data-user="${esc(u.username)}" data-i="${i}">บันทึก</button></td></tr>`).join('');
  page(res, 'จัดการผู้ใช้', `<section class="card table-wrap"><table><caption class="sr-only">ผู้ใช้และบทบาท</caption><thead><tr><th scope="col">username</th><th scope="col">ชื่อ</th><th scope="col">บทบาท</th><th scope="col">ฝ่าย</th><th scope="col">บันทึก</th></tr></thead><tbody>${rows}</tbody></table></section>${ADMIN_JS}
<script>
document.querySelectorAll('[data-testid="user-save-btn"]').forEach((b) => b.addEventListener('click', () => {
  const i = b.dataset.i;
  egSave('/api/admin/users/' + encodeURIComponent(b.dataset.user), 'PUT', { role: document.getElementById('role-' + i).value, dept: document.getElementById('dept-' + i).value });
}));
</script>`);
});

module.exports = router;
