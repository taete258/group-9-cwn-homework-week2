'use strict';

// Citizen case list, tracking, cancellation and correction resubmission (B06).
const express = require('express');
const { db, decrypt } = require('../db');
const clock = require('../lib/clock');
const rules = require('../lib/rules');
const C = require('../lib/constants');
const files = require('../lib/files');
const { isBug } = require('../lib/bugs');

const router = express.Router();
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const api = (req) => req.originalUrl.startsWith('/api/');
function guard(req, res) {
  if (!req.user) { if (api(req)) res.apiError(401, 'UNAUTHENTICATED'); else res.redirect('/login'); return false; }
  if (req.user.role !== 'citizen') { res.forbidden(); return false; }
  if (!req.user.registered) { if (api(req)) res.apiError(403, 'FORBIDDEN'); else res.redirect('/register'); return false; }
  return true;
}
function ownCase(req, res, caseNo) {
  const row = db.prepare(`SELECT c.*, s.name AS service_name, u.name AS applicant_name, u.id_enc,
      d.doc_no, d.verify_code
    FROM cases c JOIN services s ON s.id=c.service_id JOIN users u ON u.id=c.applicant_id
    LEFT JOIN documents d ON d.case_id=c.id WHERE c.case_no=? AND (c.applicant_id=? OR ?)`)
    .get(caseNo, req.user.id, isBug('B06') ? 1 : 0); // B06: IDOR — ไม่ตรวจเจ้าของ
  if (!row) { res.notFound(); return null; }
  // BR-20 automatic expiry is enforced on reads as well as on resubmission.
  if (row.status === 'NEED_FIX' && row.returned_at && rules.fixWindowExpired(row.returned_at, clock.nowISO())) {
    db.transaction(() => {
      const changed = db.prepare(`UPDATE cases SET status='CANCELLED', cancelled_at=?, updated_at=?
        WHERE id=? AND status='NEED_FIX' AND returned_at=?`).run(clock.nowISO(), clock.nowISO(), row.id, row.returned_at);
      if (changed.changes) {
        db.prepare(`INSERT INTO case_events(case_id,at,actor,event,from_status,to_status,note) VALUES(?,?,?,'AUTO_CANCEL','NEED_FIX','CANCELLED','หมดเวลาแก้ไข')`)
          .run(row.id, clock.nowISO(), 'system');
      }
    }).immediate();
    return db.prepare(`SELECT c.*, s.name AS service_name, u.name AS applicant_name, u.id_enc,
      d.doc_no, d.verify_code FROM cases c JOIN services s ON s.id=c.service_id JOIN users u ON u.id=c.applicant_id
      LEFT JOIN documents d ON d.case_id=c.id WHERE c.id=?`).get(row.id);
  }
  return row;
}
function caseJson(row) {
  return {
    caseNo: row.case_no, serviceId: row.service_id, status: row.status,
    step: row.service_id === 'SV-03' ? row.step : null, fee: row.fee,
    paidAt: row.paid_at, dueAt: row.due_at,
    slaLevel: rules.slaLevel(row, clock.nowISO()), owner: row.owner || null,
    returnCount: row.return_count, closedAt: row.closed_at || null,
    applicantName: row.applicant_name, idNo: decrypt(row.id_enc),
    fixDeadline: row.status === 'NEED_FIX' && row.returned_at ? rules.fixDeadline(row.returned_at) : null,
    docNo: row.doc_no || null, verifyCode: row.verify_code || null,
  };
}
function timeline(caseId) {
  return db.prepare('SELECT at,actor,event,from_status,to_status,note FROM case_events WHERE case_id=? ORDER BY at,id').all(caseId);
}
const EVENT_LABEL = { PAID:'ชำระเงินแล้ว · ส่งคำขอ', CLAIM:'เจ้าหน้าที่รับเรื่อง', RETURN:'ส่งกลับให้แก้ไข', RESUBMIT:'ส่งเอกสารแก้ไข', FORWARD:'ส่งต่อ', APPROVE:'อนุมัติ', REJECT:'ไม่อนุมัติ', ISSUE:'ออกเอกสารแล้ว', CANCEL:'ยกเลิกคำขอ', AUTO_CANCEL:'ระบบยกเลิกเมื่อหมดเวลาแก้ไข' };
/** หน้าใช้ layout กลาง (app-header · action-error/action-success ผ่าน EG) */
function renderPage(res, title, body, status = 200) {
  return res.status(status).render('layout', { layout: false, title, body });
}
const SERVICE_NAME = (id) => (db.prepare('SELECT name FROM services WHERE id=?').get(id) || {}).name || id;

router.get('/citizen', (req, res) => {
  if (!guard(req, res)) return;
  const now = clock.nowISO();
  const rows = db.prepare(`SELECT c.*,s.name AS service_name FROM cases c JOIN services s ON s.id=c.service_id
    WHERE c.applicant_id=? AND c.case_no IS NOT NULL ORDER BY c.case_no DESC`).all(req.user.id);
  const drafts = db.prepare(`SELECT c.*,s.name AS service_name FROM cases c JOIN services s ON s.id=c.service_id
    WHERE c.applicant_id=? AND c.case_no IS NULL AND c.draft_id IS NOT NULL AND c.status IN ('DRAFT','PENDING_PAYMENT')
    ORDER BY c.draft_id DESC`).all(req.user.id);
  const services = db.prepare('SELECT id,name FROM services ORDER BY sort,id').all();
  const start = services.map((sv) => `<li><a class="btn" data-testid="start-service-${esc(sv.id)}" href="/citizen/new/${esc(sv.id)}">${esc(sv.id)} ${esc(sv.name)}</a></li>`).join('');
  const caseRows = rows.map((r) => {
    const lv = rules.slaLevel(r, now);
    return `<tr data-testid="my-case-row" data-case-no="${esc(r.case_no)}" data-status="${esc(r.status)}">
      <td data-testid="row-case-no"><a href="/citizen/cases/${encodeURIComponent(r.case_no)}">${esc(r.case_no)}</a></td>
      <td data-testid="row-service">${esc(r.service_id)} ${esc(r.service_name)}</td>
      <td data-testid="row-status" data-status="${esc(r.status)}">${esc(C.STATUS_LABEL[r.status] || r.status)}</td>
      <td><time data-testid="row-due" data-iso="${esc(r.due_at || '')}">${esc(r.due_at ? clock.formatThai(r.due_at) : '–')}</time></td>
      <td><span data-testid="row-sla-level" data-level="${esc(lv || '')}">${esc(rules.slaLabel(lv))}</span></td></tr>`;
  }).join('');
  const draftRows = drafts.map((r) => `<tr data-testid="my-draft-row" data-draft-id="${esc(r.draft_id)}" data-status="${esc(r.status)}">
      <td data-testid="row-draft-id">${esc(r.draft_id)}</td>
      <td data-testid="row-service">${esc(r.service_id)} ${esc(r.service_name)}</td>
      <td data-testid="row-status" data-status="${esc(r.status)}">${esc(C.STATUS_LABEL[r.status] || r.status)}</td>
      <td><a class="btn btn-small" data-testid="open-draft-btn" href="/citizen/new/${encodeURIComponent(r.service_id)}?draft=${encodeURIComponent(r.draft_id)}">เปิดร่าง</a></td></tr>`).join('');
  return renderPage(res, 'คำขอของฉัน', `<h1 data-testid="citizen-welcome">สวัสดี ${esc(req.user.name)}</h1>
    <section class="card"><h2>เริ่มยื่นคำขอ</h2><ul class="service-list">${start}</ul></section>
    <section class="card"><h2>ร่างและรอชำระเงิน</h2>${drafts.length ? `<table><caption class="sr-only">ร่างคำขอ</caption><thead><tr><th scope="col">รหัสร่าง</th><th scope="col">บริการ</th><th scope="col">สถานะ</th><th scope="col">ดำเนินการ</th></tr></thead><tbody>${draftRows}</tbody></table>` : '<p>ไม่มีร่าง</p>'}</section>
    <section class="card"><h2>คำขอของฉัน</h2>${rows.length ? `<table><caption class="sr-only">คำขอของฉัน</caption><thead><tr><th scope="col">เลขคำขอ</th><th scope="col">บริการ</th><th scope="col">สถานะ</th><th scope="col">กำหนดเสร็จ</th><th scope="col">ระดับ</th></tr></thead><tbody>${caseRows}</tbody></table>` : '<p>ยังไม่มีคำขอ</p>'}</section>`);
});

router.get('/api/cases', (req, res) => {
  if (!guard(req, res)) return;
  const rows = db.prepare('SELECT * FROM cases WHERE applicant_id=? AND case_no IS NOT NULL ORDER BY created_at DESC,id DESC').all(req.user.id);
  res.json({ items: rows.map((r) => ({ caseNo:r.case_no, serviceId:r.service_id, status:r.status, dueAt:r.due_at, slaLevel:rules.slaLevel(r, clock.nowISO()) })) });
});

router.get('/citizen/cases/:caseNo', (req, res, next) => {
  if (!guard(req, res)) return;
  const row = ownCase(req, res, req.params.caseNo); if (!row) return;
  const now = clock.nowISO();
  const cno = encodeURIComponent(row.case_no);
  const events = timeline(row.id).map((e) => `<li data-testid="timeline-item" data-iso="${esc(e.at)}" data-event="${esc(e.event)}"><time data-iso="${esc(e.at)}">${esc(clock.formatThai(e.at))}</time> · ${esc(EVENT_LABEL[e.event] || e.event)}${e.note ? ` · ${esc(e.note)}` : ''}</li>`).join('');
  const attachments = db.prepare('SELECT id,name,doc_key FROM files WHERE case_id=? ORDER BY uploaded_at,id').all(row.id).map((f) => `<li data-testid="doc-item" data-name="${esc(f.name)}" data-file-id="${esc(f.id)}" data-doc-key="${esc(f.doc_key)}"><a data-testid="doc-download-link" href="/api/files/${encodeURIComponent(f.id)}">${esc(f.name)}</a></li>`).join('');
  const level = rules.slaLevel(row, now);
  const step = row.service_id === 'SV-03' && row.step ? `<p data-testid="case-step">${esc(C.STEP_LABEL[row.step] || '')}</p>` : '';
  const cancel = row.status === 'SUBMITTED' && !row.owner ? `<section class="card"><button type="button" class="btn btn-danger" data-testid="cancel-case-btn" id="cancel-open">ยกเลิกคำขอ</button>
    <div role="dialog" aria-modal="true" aria-labelledby="cancel-title" id="cancel-dialog" hidden><h2 id="cancel-title">ยืนยันยกเลิกคำขอ</h2><p data-testid="cancel-confirm-text">ค่าธรรมเนียมที่ชำระแล้วไม่คืน</p>
    <button type="button" class="btn btn-danger" data-testid="confirm-cancel-btn" id="cancel-confirm">ยืนยันยกเลิก</button> <button type="button" class="btn btn-ghost" id="cancel-close">ปิด</button></div></section>` : '';
  let fix = '';
  if (row.status === 'NEED_FIX' && row.returned_at) {
    const dl = rules.fixDeadline(row.returned_at);
    fix = `<section class="card"><h2>ต้องแก้ไขเอกสาร</h2><p>เหตุผล: <span data-testid="return-reason-display">${esc(row.return_reason || '')}</span></p>
      <p>กรุณาส่งเอกสารแก้ไขภายใน <time data-testid="fix-deadline" data-iso="${esc(dl)}">${esc(clock.formatThai(dl))}</time></p>
      ${rules.fixWindowOpen(row.returned_at, now) ? `<label for="fix-file">แนบไฟล์ใหม่ (ไม่บังคับ)</label> <input type="file" id="fix-file" data-testid="fix-upload-input" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png">
      <button type="button" class="btn" data-testid="submit-fix-btn" id="submit-fix">ส่งแก้ไข</button>` : ''}</section>`;
  }
  const noRefund = ['REJECTED','CANCELLED'].includes(row.status) ? '<p class="alert" data-testid="no-refund-note">ค่าธรรมเนียมที่ชำระแล้วไม่คืน</p>' : '';
  const due = row.due_at ? `<time data-testid="sla-due" data-iso="${esc(row.due_at)}">${esc(clock.formatThai(row.due_at))}</time>` : '<span data-testid="sla-due" data-iso="">–</span>';
  const closedAt = ['COMPLETED','REJECTED'].includes(row.status) && row.closed_at ? `<p>ปิดงาน: <time data-testid="closed-at" data-iso="${esc(row.closed_at)}">${esc(clock.formatThai(row.closed_at))}</time></p>` : '';
  const base = `${req.protocol}://${req.get('host')}`;
  const documentLink = row.doc_no ? `<section class="card"><h2>เอกสารดิจิทัล</h2><p>เลขเอกสาร <span data-testid="doc-no">${esc(row.doc_no)}</span></p><p>รหัสตรวจสอบ <span data-testid="verify-code">${esc(row.verify_code)}</span></p>
    <p data-testid="doc-qr" data-url="${esc(base)}/verify/${esc(row.verify_code)}">QR ตรวจสอบ: <a href="/verify/${esc(row.verify_code)}">${esc(base)}/verify/${esc(row.verify_code)}</a></p>
    <a class="btn" data-testid="download-doc-btn" href="/api/documents/${encodeURIComponent(row.doc_no)}/pdf" download="${esc(row.doc_no)}.pdf">ดาวน์โหลดเอกสาร</a></section>` : '';
  const idFull = (decrypt(row.id_enc) || '').replace(/^(\d)(\d{4})(\d{5})(\d{2})(\d)$/, '$1-$2-$3-$4-$5');
  return renderPage(res, `คำขอ ${row.case_no}`, `<h1>คำขอ <span data-testid="case-no">${esc(row.case_no)}</span></h1>
    <section class="card"><dl>
      <dt>สถานะ</dt><dd><span data-testid="case-status" data-status="${esc(row.status)}">${esc(C.STATUS_LABEL[row.status])}</span></dd>
      <dt>บริการ</dt><dd data-testid="case-service">${esc(row.service_id)} ${esc(row.service_name)}</dd>
      ${step ? `<dt>ขั้นตอน</dt><dd>${step}</dd>` : ''}
      <dt>ค่าธรรมเนียม</dt><dd data-testid="case-fee">${esc(clock.baht(row.fee))}</dd>
      <dt>กำหนดเสร็จ</dt><dd>${due}</dd>
      <dt>ระดับ SLA</dt><dd><span data-testid="sla-level" data-level="${esc(level || '')}">${esc(rules.slaLabel(level))}</span></dd>
      <dt>เลขบัตรประชาชน</dt><dd data-testid="case-id-full">${esc(idFull)}</dd>
    </dl>${closedAt}${noRefund}</section>
    ${fix}${cancel}${documentLink}
    <section class="card"><h2>เอกสารแนบ</h2><ul>${attachments}</ul></section>
    <section class="card"><h2>ไทม์ไลน์</h2><ol data-testid="case-timeline">${events}</ol></section>
<script>
(function(){
  const no = ${JSON.stringify(row.case_no)};
  const reloadAfter = () => window.location.reload();
  const o = document.getElementById('cancel-open');
  if (o) {
    const dlg = document.getElementById('cancel-dialog');
    o.addEventListener('click', () => { dlg.hidden = false; document.getElementById('cancel-confirm').focus(); });
    document.getElementById('cancel-close').addEventListener('click', () => { dlg.hidden = true; o.focus(); });
    document.getElementById('cancel-confirm').addEventListener('click', async () => {
      const r = await EG.api('POST', '/api/cases/' + encodeURIComponent(no) + '/cancel');
      if (r.ok) return reloadAfter();
      dlg.hidden = true; EG.showError((r.data && r.data.message) || 'เกิดข้อผิดพลาด');
    });
  }
  const f = document.getElementById('submit-fix');
  if (f) f.addEventListener('click', async () => {
    f.disabled = true;
    const inp = document.getElementById('fix-file');
    let body;
    if (inp && inp.files && inp.files.length) { body = new FormData(); body.append('file', inp.files[0]); body.append('docKey', 'extra'); }
    const r = await EG.api('POST', '/api/cases/' + encodeURIComponent(no) + '/resubmit', body);
    if (r.ok) return reloadAfter();
    f.disabled = false;
    if (r.data && r.data.code === 'FIX_WINDOW_EXPIRED') { sessionStorage.setItem('eg-flash-error', r.data.message); return reloadAfter(); }
    EG.showError((r.data && r.data.message) || 'เกิดข้อผิดพลาด');
  });
  const fl = sessionStorage.getItem('eg-flash-error');
  if (fl) { sessionStorage.removeItem('eg-flash-error'); EG.showError(fl); }
})();
</script>`);
});

router.get('/api/cases/:caseNo', (req, res, next) => {
  if (!req.user) return res.apiError(401, 'UNAUTHENTICATED');
  if (req.user.role === 'citizen') { if (!req.user.registered) return res.apiError(403, 'FORBIDDEN'); const row = ownCase(req, res, req.params.caseNo); return row ? res.json(caseJson(row)) : undefined; }
  return next(); // officer.js ตอบให้เจ้าหน้าที่/หัวหน้า และ 403 บทบาทอื่น
});

router.post('/api/cases/:caseNo/cancel', (req, res) => {
  if (!guard(req, res)) return;
  const row = db.prepare('SELECT * FROM cases WHERE case_no=? AND applicant_id=?').get(req.params.caseNo, req.user.id);
  if (!row) return res.apiError(404, 'NOT_FOUND');
  const now = clock.nowISO();
  const changed = db.prepare(`UPDATE cases SET status='CANCELLED',cancelled_at=?,updated_at=? WHERE id=? AND status='SUBMITTED' AND owner IS NULL`).run(now, now, row.id);
  if (!changed.changes) return res.apiError(409, 'CANNOT_CANCEL');
  db.prepare(`INSERT INTO case_events(case_id,at,actor,event,from_status,to_status,note) VALUES(?,?,?,'CANCEL','SUBMITTED','CANCELLED','ประชาชนยกเลิกคำขอ')`).run(row.id, now, 'citizen');
  return res.json({ status:'CANCELLED' });
});

router.post('/api/cases/:caseNo/resubmit', files.receive, (req, res) => {
  if (!guard(req, res)) return;
  const row = db.prepare('SELECT * FROM cases WHERE case_no=? AND applicant_id=?').get(req.params.caseNo, req.user.id);
  if (!row) return res.apiError(404, 'NOT_FOUND');
  const now = clock.nowISO();
  if (row.status === 'NEED_FIX' && row.returned_at && rules.fixWindowExpired(row.returned_at, now)) {
    ownCase(req, res, row.case_no);
    return res.apiError(409, 'FIX_WINDOW_EXPIRED');
  }
  if (row.status !== 'NEED_FIX' || !row.returned_at) return res.apiError(409, 'INVALID_STATE');
  const due = rules.dueAfterResubmit(row.due_at, row.returned_at, now);
  const changed = db.prepare(`UPDATE cases SET status='IN_REVIEW',dept=?,returned_at=NULL,fix_deadline=NULL,return_reason=NULL,due_at=?,updated_at=? WHERE id=? AND status='NEED_FIX' AND returned_at=?`)
    .run(row.dept || 'registry', due.dueAt, now, row.id, row.returned_at);
  if (!changed.changes) return res.apiError(409, 'INVALID_STATE');
  db.prepare(`UPDATE case_returns SET resubmitted_at=?,paused_days=? WHERE case_id=? AND n=? AND resubmitted_at IS NULL`).run(now, due.pausedDays, row.id, row.return_count);
  const f = files.firstFile(req);
  if (f) { try { files.save(row.id, req.body && req.body.docKey ? String(req.body.docKey) : 'extra', f, 'citizen'); } catch (e) { console.error('[resubmit] file', e); } }
  db.prepare(`INSERT INTO case_events(case_id,at,actor,event,from_status,to_status,note) VALUES(?,?,?,'RESUBMIT','NEED_FIX','IN_REVIEW','ประชาชนส่งเอกสารแก้ไข')`).run(row.id, now, 'citizen');
  return res.json({ status:'IN_REVIEW', dueAt:due.dueAt });
});

module.exports = router;
