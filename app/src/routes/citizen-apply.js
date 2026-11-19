'use strict';
// routes/citizen-apply.js · ยื่นคำขอ (B05) — FR-04..FR-08 · BR-04..BR-11 · US-C02a US-C02b US-C03
//
// หน้า
//   GET  /citizen/new                         แคตตาล็อก 3 บริการ (ค่าธรรมเนียมจากตาราง services)
//   GET  /citizen/new/:service[?draft=DR-xxxx] ขั้นตอนยื่น 3 ขั้น (กรอกข้อมูล → แนบเอกสาร → ชำระเงิน)
// API (citizen เท่านั้น · ไม่ล็อกอิน 401 · บทบาทอื่น 403 · ร่างของคนอื่น/ไม่มี 404 NOT_FOUND)
//   GET    /api/fee-quote?serviceId=&qty=&areaSqm=   คำนวณค่าธรรมเนียมทันที (ใช้ rules.calcFee → BUG_MODE B01 มีผล)
//   POST   /api/drafts                    {"serviceId","qty"|"areaSqm"} → 201 {"draftId","fee"}
//   GET    /api/drafts                    → {items:[{draftId,serviceId,status,fee}]} (DRAFT / PENDING_PAYMENT ของฉัน)
//   GET    /api/drafts/:id                → รายละเอียด + files + missing + payment ล่าสุด
//   PUT    /api/drafts/:id                {"qty"|"areaSqm"} แก้ร่าง (เฉพาะ DRAFT)
//   DELETE /api/drafts/:id                → 204 (DRAFT / PENDING_PAYMENT ที่ยังไม่ชำระ · ref ชำระกลายเป็น 404)
//   POST   /api/drafts/:id/files          multipart file + docKey → 201 {"fileId","name","docKey","size"}
//   DELETE /api/drafts/:id/files/:fileId  → 204 (เฉพาะ DRAFT)
//   POST   /api/drafts/:id/payment        → 201 {"ref","amount","qrCreatedAt","qrExpiresAt"} · 409 MISSING_DOCS {missing}
//   GET    /api/payments/:ref             → {"ref","amount","status":PENDING|PAID|EXPIRED,"qrCreatedAt","qrExpiresAt","caseNo","receiptNo","paidAt"}
//   GET    /api/payments/:ref/qr.svg      รูป QR จำลอง
//   POST   /api/payments/:ref/simulate    แอปธนาคารจำลอง (จ่ายยอดเต็มของ ref) — ใช้ payByRef เดียวกับ test hook
//
// กฎ
// - ค่าธรรมเนียมคำนวณด้วย rules.calcFee จากตาราง services ณ ตอนนั้น · ยอด "ล็อก" ตอนร่างเข้า PENDING_PAYMENT
//   (สร้าง QR ครั้งแรก) · QR ใหม่ของร่างเดิมใช้ยอดที่ล็อก (BR-11 · A-42)
// - เลขคำขอ/ใบเสร็จออกตอนชำระสำเร็จใน payByRef (routes/test.js) ผ่าน rules.nextCaseNo (BR-09)
// - อายุ QR: rules.qrExpiresAt / rules.qrExpired (BR-10 · BUG_MODE B05)
// - ไฟล์: lib/files.js (BR-06 BR-07 BR-08 · BUG_MODE B02 ผ่าน rules.fileSizeOk)
// - ร่าง (DRAFT) แก้ข้อมูล/ไฟล์ได้ · PENDING_PAYMENT ล็อกข้อมูลและไฟล์ (สร้าง QR ใหม่ได้อย่างเดียว)

const express = require('express');
const store = require('../db');
const clock = require('../lib/clock');
const rules = require('../lib/rules');
const files = require('../lib/files');
const C = require('../lib/constants');

const { db } = store;
const router = express.Router();

const SERVICE_IDS = Object.keys(C.SERVICES);
const EDITABLE = ['DRAFT'];
const DELETABLE = ['DRAFT', 'PENDING_PAYMENT'];
const PAY_STATUS_LABEL = { PENDING: 'รอชำระ', PAID: 'ชำระแล้ว', EXPIRED: 'QR หมดอายุ' };

let payByRefFn;
function payByRef(ref, amount) {
  if (payByRefFn === undefined) {
    try { payByRefFn = require('./test').payByRef || null; } catch (e) { payByRefFn = null; }
  }
  if (!payByRefFn) return { status: 501, body: { code: 'NOT_AVAILABLE', message: 'ระบบชำระเงินจำลองไม่พร้อมใช้งาน' } };
  return payByRefFn(ref, amount);
}

// ---------- helpers ----------
function apiErr(res, status, code, message, extra = {}) {
  return res.status(status).json({ code, message: message || C.MESSAGES[code] || code, ...extra });
}

/** API: citizen ที่ลงทะเบียนแล้วเท่านั้น */
function citizenApi(req, res, next) {
  if (!req.user) return apiErr(res, 401, 'UNAUTHENTICATED');
  if (req.user.role !== 'citizen' || !req.user.registered) return apiErr(res, 403, 'FORBIDDEN');
  next();
}
/** หน้า: ไม่ล็อกอิน → /login · ยังไม่ลงทะเบียน → /register · บทบาทอื่น → 403 */
function citizenPage(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'citizen') {
    return res.status(403).render('error', { title: 'ไม่มีสิทธิ์', testid: 'forbidden-msg', message: C.MESSAGES.FORBIDDEN_PAGE });
  }
  if (!req.user.registered) return res.redirect('/register');
  next();
}

function serviceRow(serviceId) {
  return db.prepare('SELECT id, name, fee, fee_per_sqm, sla FROM services WHERE id = ?').get(serviceId);
}

/** แปลงค่าจาก JSON/form/query ('' → undefined เพื่อให้ calcFee ตัดสิน) */
function inputOf(serviceId, src = {}) {
  if (serviceId === 'SV-01') {
    const q = src.qty;
    return { qty: q === undefined || q === null ? undefined : (typeof q === 'number' ? q : String(q)) };
  }
  if (serviceId === 'SV-03') {
    const a = src.areaSqm !== undefined ? src.areaSqm : (src.area !== undefined ? src.area : src.area_sqm);
    return { area: a === undefined || a === null ? '' : (typeof a === 'number' ? a : String(a)) };
  }
  return {};
}

/** calcFee จากตาราง services ปัจจุบัน */
function quote(serviceId, input) {
  const svc = serviceRow(serviceId);
  return rules.calcFee(serviceId, input, svc ? { fee: svc.fee, feePerSqm: svc.fee_per_sqm } : undefined);
}

function findDraft(user, draftId) {
  if (!draftId || typeof draftId !== 'string') return null;
  return db.prepare('SELECT * FROM cases WHERE draft_id = ? AND applicant_id = ?').get(draftId, user.id) || null;
}

/** สถานะของ payment ณ ตอนนี้ (EXPIRED คำนวณสดจากนาฬิกา) */
function paymentStatus(p) {
  if (p.status === 'PAID') return 'PAID';
  return rules.qrExpired(p.qr_created_at, clock.nowMs()) ? 'EXPIRED' : 'PENDING';
}
function paymentJson(p, c) {
  const status = paymentStatus(p);
  return {
    ref: p.ref,
    amount: p.amount,
    status,
    statusLabel: PAY_STATUS_LABEL[status],
    qrCreatedAt: p.qr_created_at,
    qrExpiresAt: p.qr_expires_at,
    paidAt: p.paid_at || null,
    caseNo: status === 'PAID' && c ? c.case_no || null : null,
    receiptNo: status === 'PAID' && c ? c.receipt_no || null : null,
    draftId: c ? c.draft_id : null,
  };
}
/** payment ที่จะแสดง: ที่ชำระแล้วก่อน ไม่งั้นล่าสุด */
function currentPayment(caseRow) {
  return db.prepare(`SELECT * FROM payments WHERE case_id = ?
                     ORDER BY (status = 'PAID') DESC, qr_created_at DESC, ref DESC LIMIT 1`).get(caseRow.id) || null;
}

/** ยอดของร่าง: DRAFT = คำนวณสดจากตาราง services · อื่น ๆ = ยอดที่ล็อกไว้ */
function draftFee(c) {
  if (c.status === 'DRAFT') {
    const q = quote(c.service_id, c.service_id === 'SV-03' ? { area: c.area_sqm === null ? '' : c.area_sqm } : { qty: c.qty === null ? undefined : c.qty });
    return q.ok ? q.fee : null;
  }
  return c.fee;
}

function draftJson(c) {
  const list = files.list(c.id);
  const p = currentPayment(c);
  return {
    draftId: c.draft_id,
    serviceId: c.service_id,
    serviceName: C.SERVICES[c.service_id] ? C.SERVICES[c.service_id].name : c.service_id,
    status: c.status,
    fee: draftFee(c),
    qty: c.service_id === 'SV-01' ? c.qty : null,
    areaSqm: c.service_id === 'SV-03' ? c.area_sqm : null,
    caseNo: c.case_no || null,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    files: list.map(({ fileId, name, docKey, size, mime }) => ({ fileId, name, docKey, size, mime })),
    missing: files.missingDocs(c.service_id, list),
    payment: p ? paymentJson(p, c) : null,
  };
}

function nextDraftId() {
  const seq = store.nextSeq('draft', store.maxSuffix('cases', 'draft_id', 'DR-'));
  return `DR-${String(seq).padStart(4, '0')}`;
}
function nextPaymentRef() {
  // ตัวนับ 'payment' ต่อเนื่องไม่รีเซ็ตรายปี (A-47) · กันชนกับ ref ที่มีอยู่แล้ว
  let ref;
  do {
    ref = `PP-${String(store.nextSeq('payment', 0)).padStart(4, '0')}`;
  } while (db.prepare('SELECT 1 FROM payments WHERE ref = ?').get(ref));
  return ref;
}

// =====================================================================
// API
// =====================================================================
router.get('/api/fee-quote', citizenApi, (req, res) => {
  const serviceId = String(req.query.serviceId || '');
  if (!SERVICE_IDS.includes(serviceId)) return apiErr(res, 400, 'INVALID_SERVICE', 'ไม่พบบริการ');
  const q = quote(serviceId, inputOf(serviceId, req.query));
  if (!q.ok) return apiErr(res, 400, q.code, q.message);
  res.json({ serviceId, fee: q.fee });
});

router.post('/api/drafts', citizenApi, (req, res) => {
  const body = req.body || {};
  const serviceId = String(body.serviceId || '');
  if (!SERVICE_IDS.includes(serviceId)) return apiErr(res, 400, 'INVALID_SERVICE', 'ไม่พบบริการ');
  const q = quote(serviceId, inputOf(serviceId, body));
  if (!q.ok) return apiErr(res, 400, q.code, q.message);
  const out = store.tx(() => {
    const draftId = nextDraftId();
    const now = clock.nowISO();
    db.prepare(`INSERT INTO cases(draft_id, service_id, applicant_id, status, qty, area_sqm, fee, created_at, updated_at)
                VALUES(?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`)
      .run(draftId, serviceId, req.user.id,
        serviceId === 'SV-01' ? q.qty : null, serviceId === 'SV-03' ? q.area : null, q.fee, now, now);
    return { draftId, fee: q.fee };
  });
  res.status(201).json(out);
});

router.get('/api/drafts', citizenApi, (req, res) => {
  const rows = db.prepare(`SELECT * FROM cases WHERE applicant_id = ? AND status IN ('DRAFT','PENDING_PAYMENT')
                           ORDER BY draft_id`).all(req.user.id);
  res.json({ items: rows.map((c) => ({ draftId: c.draft_id, serviceId: c.service_id, status: c.status, fee: draftFee(c) })) });
});

router.get('/api/drafts/:id', citizenApi, (req, res) => {
  const c = findDraft(req.user, req.params.id);
  if (!c) return apiErr(res, 404, 'NOT_FOUND');
  res.json(draftJson(c));
});

router.put('/api/drafts/:id', citizenApi, (req, res) => {
  const c = findDraft(req.user, req.params.id);
  if (!c) return apiErr(res, 404, 'NOT_FOUND');
  if (!EDITABLE.includes(c.status)) return apiErr(res, 409, 'INVALID_STATE');
  const q = quote(c.service_id, inputOf(c.service_id, req.body || {}));
  if (!q.ok) return apiErr(res, 400, q.code, q.message);
  db.prepare('UPDATE cases SET qty = ?, area_sqm = ?, fee = ?, updated_at = ? WHERE id = ? AND status = \'DRAFT\'')
    .run(c.service_id === 'SV-01' ? q.qty : null, c.service_id === 'SV-03' ? q.area : null, q.fee, clock.nowISO(), c.id);
  res.json(draftJson(db.prepare('SELECT * FROM cases WHERE id = ?').get(c.id)));
});

router.delete('/api/drafts/:id', citizenApi, (req, res) => {
  const r = store.tx(() => {
    const c = findDraft(req.user, req.params.id);
    if (!c) return { status: 404, code: 'NOT_FOUND' };
    const paid = db.prepare("SELECT 1 FROM payments WHERE case_id = ? AND status = 'PAID'").get(c.id);
    if (!DELETABLE.includes(c.status) || c.case_no || paid) return { status: 409, code: 'INVALID_STATE' };
    db.prepare('DELETE FROM payments WHERE case_id = ?').run(c.id);
    db.prepare('DELETE FROM files WHERE case_id = ?').run(c.id);
    db.prepare('DELETE FROM case_events WHERE case_id = ?').run(c.id);
    db.prepare('DELETE FROM cases WHERE id = ?').run(c.id);
    return { status: 204 };
  });
  if (r.status !== 204) return apiErr(res, r.status, r.code);
  res.status(204).end();
});

router.post('/api/drafts/:id/files', citizenApi, files.receive, (req, res) => {
  const docKey = String((req.body && req.body.docKey) || '');
  const file = files.firstFile(req);
  const r = store.tx(() => {
    const c = findDraft(req.user, req.params.id);
    if (!c) return { error: { status: 404, code: 'NOT_FOUND', message: C.MESSAGES.NOT_FOUND } };
    if (!EDITABLE.includes(c.status)) return { error: { status: 409, code: 'INVALID_STATE', message: C.MESSAGES.INVALID_STATE } };
    const e = files.checkUpload({ serviceId: c.service_id, docKey, file, existingCount: files.count(c.id) });
    if (e) return { error: e };
    const saved = files.save(c.id, docKey, file, 'citizen');
    db.prepare('UPDATE cases SET updated_at = ? WHERE id = ?').run(clock.nowISO(), c.id);
    return { saved };
  });
  if (r.error) return files.sendErr(res, r.error);
  res.status(201).json(r.saved);
});

router.delete('/api/drafts/:id/files/:fileId', citizenApi, (req, res) => {
  const c = findDraft(req.user, req.params.id);
  if (!c) return apiErr(res, 404, 'NOT_FOUND');
  if (!EDITABLE.includes(c.status)) return apiErr(res, 409, 'INVALID_STATE');
  if (!files.remove(c.id, req.params.fileId)) return apiErr(res, 404, 'NOT_FOUND', 'ไม่พบไฟล์');
  res.status(204).end();
});

router.post('/api/drafts/:id/payment', citizenApi, (req, res) => {
  const r = store.tx(() => {
    const c = findDraft(req.user, req.params.id);
    if (!c) return { status: 404, body: { code: 'NOT_FOUND', message: C.MESSAGES.NOT_FOUND } };
    if (!['DRAFT', 'PENDING_PAYMENT'].includes(c.status) || c.case_no) {
      return { status: 409, body: { code: 'INVALID_STATE', message: C.MESSAGES.INVALID_STATE } };
    }
    const missing = files.missingDocs(c.service_id, files.list(c.id));
    if (missing.length) {
      return { status: 409, body: { code: 'MISSING_DOCS', message: files.missingMessage(missing), missing } };
    }
    const now = clock.nowMs();
    const nowIso = clock.toISO(now);
    let amount = c.fee;
    if (c.status === 'DRAFT') {
      // ล็อกยอดตอนเข้า PENDING_PAYMENT (BR-11 · A-42)
      const q = quote(c.service_id, c.service_id === 'SV-03' ? { area: c.area_sqm === null ? '' : c.area_sqm } : { qty: c.qty === null ? undefined : c.qty });
      if (!q.ok) return { status: 400, body: { code: q.code, message: q.message } };
      amount = q.fee;
      db.prepare("UPDATE cases SET status = 'PENDING_PAYMENT', fee = ?, updated_at = ? WHERE id = ?").run(amount, nowIso, c.id);
    }
    const ref = nextPaymentRef();
    const expires = rules.qrExpiresAt(now);
    db.prepare(`INSERT INTO payments(ref, case_id, amount, status, qr_created_at, qr_expires_at)
                VALUES(?, ?, ?, 'PENDING', ?, ?)`).run(ref, c.id, amount, nowIso, expires);
    return { status: 201, body: { ref, amount, status: 'PENDING', qrCreatedAt: nowIso, qrExpiresAt: expires } };
  });
  res.status(r.status).json(r.body);
});

function findPayment(user, ref) {
  return db.prepare(`SELECT p.*, c.applicant_id, c.case_no, c.receipt_no, c.draft_id
                     FROM payments p JOIN cases c ON c.id = p.case_id WHERE p.ref = ?`).get(String(ref || '')) || null;
}

router.get('/api/payments/:ref', citizenApi, (req, res) => {
  const p = findPayment(req.user, req.params.ref);
  if (!p || p.applicant_id !== req.user.id) return apiErr(res, 404, 'NOT_FOUND', 'ไม่พบรายการชำระเงิน');
  res.json(paymentJson(p, p));
});

router.get('/api/payments/:ref/qr.svg', citizenApi, async (req, res, next) => {
  try {
    const p = findPayment(req.user, req.params.ref);
    if (!p || p.applicant_id !== req.user.id) return apiErr(res, 404, 'NOT_FOUND', 'ไม่พบรายการชำระเงิน');
    const payload = `SIMULATED-PROMPTPAY|ref=${p.ref}|amount=${p.amount}|expires=${p.qr_expires_at}`;
    let svg;
    try {
      svg = await require('qrcode').toString(payload, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    } catch (e) {
      svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#fff" stroke="#000"/>`
        + `<text x="100" y="105" font-size="16" text-anchor="middle">${p.ref}</text></svg>`;
    }
    res.set('Content-Type', 'image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch (e) { next(e); }
});

router.post('/api/payments/:ref/simulate', citizenApi, (req, res) => {
  const p = findPayment(req.user, req.params.ref);
  if (!p || p.applicant_id !== req.user.id) return apiErr(res, 404, 'NOT_FOUND', 'ไม่พบรายการชำระเงิน');
  const r = payByRef(p.ref, p.amount);
  res.status(r.status).json(r.body);
});

// =====================================================================
// หน้า
// =====================================================================
function svcView(id) {
  const s = C.SERVICES[id];
  const row = serviceRow(id) || {};
  let feeText;
  if (id === 'SV-01') feeText = `${clock.baht(row.fee)} ต่อฉบับ (1–5 ฉบับ)`;
  else if (id === 'SV-02') feeText = `${clock.baht(row.fee)} คงที่`;
  else feeText = `${clock.baht(row.fee)} (1–100 ตร.ม.) · เกิน 100 ตร.ม. เพิ่ม ${clock.baht(row.fee_per_sqm)} ต่อ ตร.ม. (สูงสุด 500 ตร.ม.)`;
  return { id, name: s.name, docs: s.docs, feeText, sla: row.sla };
}

router.get('/citizen/new', citizenPage, (req, res) => {
  res.render('citizen/apply/catalog', { title: 'เลือกบริการ', services: SERVICE_IDS.map(svcView) });
});

router.get('/citizen/new/:service', citizenPage, (req, res) => {
  const serviceId = req.params.service;
  if (!SERVICE_IDS.includes(serviceId)) {
    return res.status(404).render('error', { title: 'ไม่พบบริการ', testid: 'not-found-msg', message: 'ไม่พบบริการ' });
  }
  let draft = null;
  if (req.query.draft !== undefined) {
    const c = findDraft(req.user, String(req.query.draft));
    if (!c) return res.status(404).render('error', { title: 'ไม่พบ', testid: 'not-found-msg', message: C.MESSAGES.NOT_FOUND });
    if (c.case_no) return res.redirect(`/citizen/cases/${encodeURIComponent(c.case_no)}`);
    if (!DELETABLE.includes(c.status)) {
      return res.status(404).render('error', { title: 'ไม่พบ', testid: 'not-found-msg', message: C.MESSAGES.NOT_FOUND });
    }
    if (c.service_id !== serviceId) return res.redirect(`/citizen/new/${c.service_id}?draft=${encodeURIComponent(c.draft_id)}`);
    draft = draftJson(c);
  }

  // ค่าเริ่มต้นของฟอร์ม (A-56: จำนวนฉบับตั้งต้น 1)
  let qty = '';
  let area = '';
  if (serviceId === 'SV-01') qty = draft && draft.qty !== null ? String(draft.qty) : '1';
  if (serviceId === 'SV-03') area = draft && draft.areaSqm !== null ? String(draft.areaSqm) : '';
  let fee = null;
  let feeError = '';
  const q = quote(serviceId, serviceId === 'SV-01' ? { qty } : serviceId === 'SV-03' ? { area } : {});
  if (q.ok) fee = q.fee;
  else if (draft) feeError = q.message; // ฟอร์มใหม่ SV-03 ที่ยังไม่กรอก: ไม่แสดง error แต่ปุ่มถัดไปใช้ไม่ได้
  if (draft && draft.status !== 'DRAFT') fee = draft.fee;

  const step = draft && draft.status === 'PENDING_PAYMENT' ? 3 : 1;
  const svc = svcView(serviceId);
  const state = {
    service: { id: serviceId, name: svc.name, docs: svc.docs },
    draft,
    step,
    fee,
    feeValid: q.ok,
    payStatusLabel: PAY_STATUS_LABEL,
  };
  res.render('citizen/apply/wizard', {
    title: `ยื่นคำขอ · ${svc.name}`,
    svc,
    draft,
    step,
    qty,
    area,
    fee,
    feeError,
    feeValid: q.ok,
    stateJson: JSON.stringify(state).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (ch) => (ch === '\u2028' ? '\\u2028' : '\\u2029')),
  });
});

module.exports = router;
