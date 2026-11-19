'use strict';

// FR-17/18 · BR-23 · เอกสารดิจิทัลและการตรวจสาธารณะ
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const rules = require('../lib/rules');
const clock = require('../lib/clock');
const C = require('../lib/constants');

const router = express.Router();
const SIGN_KEY = process.env.SIGN_KEY || 'egov-eservice-test-sign-key';
const SERVICES = { 'SV-01': 'ขอหนังสือรับรอง', 'SV-02': 'ขออนุญาตก่อสร้าง', 'SV-03': 'ขออนุญาตขุด/ปรับพื้นที่' };
const ROLE_LABEL = C.ROLE_LABEL || { officer: 'เจ้าหน้าที่', head: 'หัวหน้าฝ่าย' };

function signature(d) {
  const payload = [d.doc_no, d.case_no, d.applicant, d.service_id, d.issued_at, d.valid_until, d.signer].join('|');
  return crypto.createHmac('sha256', SIGN_KEY).update(payload).digest('hex');
}
function verify(d) {
  const expected = Buffer.from(signature(d), 'hex');
  const actual = Buffer.from(String(d.signature || ''), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function auth(req, res) {
  if (!req.user) { res.unauthenticated(); return false; }
  if (!['officer', 'head'].includes(req.user.role)) { res.forbidden(); return false; }
  return true;
}
function publicResult(code) {
  const d = db.db.prepare('SELECT * FROM documents WHERE verify_code = ?').get(code);
  if (!d) return null;
  if (!verify(d)) return { result: 'TAMPERED' };
  const base = { docNo: d.doc_no, applicantMasked: rules.maskApplicantName(d.applicant), serviceId: d.service_id,
    issuedAt: d.issued_at, validUntil: d.valid_until, signer: d.signer };
  return { result: rules.docExpired(d.valid_until, clock.nowMs()) ? 'EXPIRED' : 'VALID', ...base };
}

// Issue is deliberately transactional: sequence allocation, document, case close, and audit stay together.
router.post('/api/officer/cases/:caseNo/issue', (req, res) => {
  if (!auth(req, res)) return;
  const issued = db.tx(() => {
    const c = db.db.prepare(`SELECT c.*, u.name AS applicant_name, s.name AS service_name
      FROM cases c JOIN users u ON u.id=c.applicant_id JOIN services s ON s.id=c.service_id WHERE c.case_no=?`).get(req.params.caseNo);
    if (!c) return { error: 'NOT_FOUND', status: 404 };
    if (req.user.role !== 'head' && (req.user.dept !== 'registry' || c.issuer !== req.user.username)) return { error: 'FORBIDDEN', status: 403 };
    if (c.status !== 'APPROVED') return { error: 'INVALID_STATE', status: 409 };
    const now = clock.nowISO();
    const docNo = rules.nextDocNo(now);
    const validUntil = rules.docValidUntil(c.service_id, now);
    const verifyCode = crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 8);
    const signerRow = db.db.prepare('SELECT name FROM users WHERE username=?').get(c.approved_by);
    const signer = signerRow ? signerRow.name : c.approved_by || ROLE_LABEL[req.user.role];
    const d = { doc_no: docNo, case_no: c.case_no, applicant: c.applicant_name, service_id: c.service_id,
      issued_at: now, valid_until: validUntil, signer };
    db.db.prepare(`INSERT INTO documents(doc_no,case_id,case_no,applicant,service_id,issued_at,valid_until,signer,verify_code,signature,issued_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(docNo,c.id,c.case_no,d.applicant,d.service_id,now,validUntil,signer,verifyCode,signature(d),req.user.username);
    db.db.prepare("UPDATE cases SET status='COMPLETED', closed_at=?, updated_at=? WHERE id=?").run(now,now,c.id);
    db.db.prepare("INSERT INTO case_events(case_id,at,actor,event,from_status,to_status,note) VALUES(?,?,?,'ISSUE','APPROVED','COMPLETED',?)")
      .run(c.id,now,req.user.username,docNo);
    db.db.prepare("INSERT INTO audit_log(time,username,role,event,case_no,from_status,to_status,detail) VALUES(?,?,?,'ISSUE',?,'APPROVED','COMPLETED',?)")
      .run(now,req.user.username,req.user.role,c.case_no,docNo);
    return { docNo, verifyCode, status: 'COMPLETED' };
  });
  if (issued.error) return res.apiError(issued.status, issued.error);
  return res.json(issued);
});

router.get('/api/verify/:code', (req, res) => {
  const result = publicResult(req.params.code);
  if (!result) return res.status(404).json({ result: 'NOT_FOUND' });
  return res.json(result);
});

router.get('/verify/:code', (req, res) => {
  const result = publicResult(req.params.code);
  if (!result) return res.status(404).render('layout', { layout: false, title: 'ไม่พบเอกสาร', body: '<h1>ตรวจสอบเอกสารดิจิทัล</h1><section class="card"><p class="alert alert-error" data-testid="verify-result" data-result="NOT_FOUND">ไม่พบเอกสาร</p></section>' });
  const labels = { VALID: 'เอกสารถูกต้อง', EXPIRED: 'เอกสารหมดอายุ', TAMPERED: 'ลายเซ็นไม่ถูกต้อง' };
  let fields = '';
  if (result.result !== 'TAMPERED') {
    fields = `<dl><dt>เลขเอกสาร</dt><dd data-testid="verify-doc-no">${esc(result.docNo)}</dd>`+
      `<dt>ผู้ยื่นคำขอ</dt><dd data-testid="verify-applicant">${esc(result.applicantMasked)}</dd>`+
      `<dt>บริการ</dt><dd data-testid="verify-service">${esc(result.serviceId)} ${esc(SERVICES[result.serviceId] || '')}</dd>`+
      `<dt>วันออกเอกสาร</dt><dd data-testid="verify-issued" data-iso="${esc(result.issuedAt)}">${esc(clock.formatThai(result.issuedAt))}</dd>`+
      `<dt>ใช้ได้ถึง</dt><dd data-testid="verify-expires" data-iso="${esc(result.validUntil)}">${esc(clock.formatThaiDate(result.validUntil))}</dd>`+
      `<dt>ผู้ลงนาม</dt><dd data-testid="verify-signer">${esc(result.signer)}</dd></dl>`;
  }
  return res.status(200).render('layout', { layout: false, title: 'ตรวจเอกสาร', body: `<h1>ตรวจสอบเอกสารดิจิทัล</h1><section class="card"><p class="alert" data-testid="verify-result" data-result="${result.result}">${labels[result.result]}</p>${fields}</section>` });
});

router.get('/api/documents/:docNo/pdf', (req, res) => {
  if (!req.user) return res.unauthenticated();
  const d = db.db.prepare('SELECT d.*, c.applicant_id FROM documents d JOIN cases c ON c.id=d.case_id WHERE d.doc_no=?').get(req.params.docNo);
  if (!d) return res.notFound();
  if (req.user.role === 'citizen' && req.user.id !== d.applicant_id) return res.notFound();
  if (req.user.role !== 'citizen' && !['officer','head'].includes(req.user.role)) return res.forbidden();
  if (req.user.role === 'officer') {
    const allowed = db.db.prepare('SELECT 1 FROM cases WHERE id=? AND (dept=? OR issuer=?)').get(d.case_id,req.user.dept,req.user.username);
    if (!allowed) return res.forbidden();
  }
  const line = `docNo=${d.doc_no} caseNo=${d.case_no} verify=${d.verify_code} validUntil=${d.valid_until}`;
  // A valid minimal PDF with the contract's machine-readable ASCII record embedded.
  const content = `%PDF-1.4\n1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj\n4 0 obj<< /Length ${line.length + 48} >>stream\nBT /F1 10 Tf 30 750 Td (${line}) Tj ET\nendstream endobj\n5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\ntrailer<< /Root 1 0 R >>\n%%EOF`;
  res.set('Content-Type','application/pdf');
  res.set('Content-Disposition',`attachment; filename="${d.doc_no}.pdf"`);
  return res.send(Buffer.from(content,'ascii'));
});

module.exports = router;
