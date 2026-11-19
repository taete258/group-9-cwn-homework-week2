'use strict';
// routes/test.js · test hook (CONTRACT §8) — mount โดย server.js เฉพาะเมื่อ TEST_MODE=1 (B01)
//   POST /api/test/reset                       ล้าง + seed + นาฬิกา 2026-12-01T09:00:00+07:00 + ล้าง session ทุกคน
//   GET  /api/test/clock                       {"now": ...}
//   PUT  /api/test/clock {"now":"<ISO+offset>"} นาฬิกาแช่แข็ง · ไม่มี offset → 400 INVALID_TIME
//   POST /api/test/payments/:ref/pay {"amount"} ธนาคารจำลอง callback → ร่างกลายเป็นคำขอ (ได้เลขคำขอ/ใบเสร็จ/กำหนดเสร็จ)
//   POST /api/test/documents/:docNo/tamper      แก้ฟิลด์ applicant โดยไม่คำนวณลายเซ็นใหม่
//
// หมายเหตุ: /api/test/* ไม่ผ่าน SLA tick (CONTRACT §0.7) — server.js mount router นี้ก่อน tick

const express = require('express');
const store = require('../db');
const clock = require('../lib/clock');
const { isBug } = require('../lib/bugs');
const { MESSAGES } = require('../lib/constants');

const { db } = store;
const router = express.Router();

const QR_TTL_MS = 15 * 60 * 1000;

function err(res, status, code, message, extra = {}) {
  return res.status(status).json({ code, message: message || MESSAGES[code] || code, ...extra });
}

function rules() {
  try { return require('../lib/rules'); } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
    return {};
  }
}

// ---------- reset ----------
router.post('/reset', (req, res) => {
  store.resetAndSeed();          // ล้างทุกตาราง (รวม sessions otp_state notifications audit_log files) แล้ว seed
  clock.reset();
  res.json({ ok: true, now: clock.nowISO() });
});

// ---------- clock ----------
router.get('/clock', (req, res) => res.json({ now: clock.nowISO() }));
router.put('/clock', (req, res) => {
  const iso = req.body && req.body.now;
  if (!clock.set(iso)) return err(res, 400, 'INVALID_TIME');
  res.json({ now: clock.nowISO() });
});

// ---------- ธนาคารจำลอง ----------
/** QR หมดอายุเมื่ออายุ ≥ 15:00 (BR-10) · B05: ใช้ > แทน ≥ */
function qrExpired(createdAt, nowMs) {
  const r = rules();
  if (typeof r.qrExpired === 'function') return r.qrExpired(createdAt, nowMs);
  const age = nowMs - clock.toMs(createdAt);
  return isBug('B05') ? age > QR_TTL_MS : age >= QR_TTL_MS;
}

/** เลขคำขอ/ใบเสร็จถัดไปตามปี พ.ศ. ของเวลาชำระ (BR-09) — ต้องเรียกภายใน transaction */
function nextCaseNo(paidMs) {
  const r = rules();
  if (typeof r.nextCaseNo === 'function') return r.nextCaseNo(paidMs);
  const be = clock.beYear(paidMs);
  const prefix = `EG-${be}-`;
  const seq = store.nextSeq(`case:${be}`, store.maxSuffix('cases', 'case_no', prefix));
  const n = String(seq).padStart(6, '0');
  return { caseNo: prefix + n, receiptNo: `RC-${be}-${n}` };
}

/**
 * ชำระเงินด้วย ref (ใช้ได้จากที่อื่นด้วย) → { status, body }
 * ลำดับตรวจ: ไม่มี ref 404 → จ่ายแล้ว (ซ้ำ) 200 duplicate → หมดอายุ 410 → ยอดไม่ตรง 422 → สำเร็จ 200
 */
function payByRef(ref, amount) {
  return store.tx(() => {
    const p = db.prepare(`SELECT p.*, c.status AS case_status, c.service_id, c.case_no, c.receipt_no, c.id AS cid
                          FROM payments p JOIN cases c ON c.id = p.case_id WHERE p.ref = ?`).get(ref);
    if (!p) return { status: 404, body: { code: 'NOT_FOUND', message: 'ไม่พบรายการชำระเงิน' } };

    if (p.status === 'PAID') {
      return { status: 200, body: { status: 'PAID', caseNo: p.case_no, receiptNo: p.receipt_no, duplicate: true } };
    }
    const nowMs = clock.nowMs();
    if (qrExpired(p.qr_created_at, nowMs)) {
      return { status: 410, body: { code: 'QR_EXPIRED', message: MESSAGES.QR_EXPIRED } };
    }
    if (typeof amount !== 'number' && !(typeof amount === 'string' && /^\d+$/.test(amount))) {
      return { status: 422, body: { code: 'AMOUNT_MISMATCH', message: MESSAGES.AMOUNT_MISMATCH } };
    }
    if (Number(amount) !== Number(p.amount)) {
      return { status: 422, body: { code: 'AMOUNT_MISMATCH', message: MESSAGES.AMOUNT_MISMATCH } };
    }
    if (p.case_status !== 'PENDING_PAYMENT') {
      // ร่างนี้ชำระด้วย ref อื่นไปแล้ว หรือถูกยกเลิก
      return { status: 409, body: { code: 'INVALID_STATE', message: MESSAGES.INVALID_STATE } };
    }

    const r = rules();
    if (typeof r.computeDueAt !== 'function') throw new Error('rules.computeDueAt() ยังไม่มีใน src/lib/rules.js');
    const svc = db.prepare('SELECT sla FROM services WHERE id = ?').get(p.service_id);
    const nowIso = clock.toISO(nowMs);
    const { caseNo, receiptNo } = nextCaseNo(nowMs);
    const dueAt = clock.toISO(r.computeDueAt(nowMs, svc.sla));

    db.prepare(`UPDATE cases SET status = 'SUBMITTED', case_no = ?, receipt_no = ?, paid_at = ?, due_at = ?,
                  dept = 'registry', step = CASE WHEN service_id = 'SV-03' THEN 1 ELSE NULL END,
                  owner = NULL, updated_at = ?
                WHERE id = ?`).run(caseNo, receiptNo, nowIso, dueAt, nowIso, p.cid);
    db.prepare(`UPDATE payments SET status = 'PAID', paid_at = ? WHERE ref = ?`).run(nowIso, ref);
    db.prepare(`INSERT INTO case_events(case_id, at, actor, event, from_status, to_status, note)
                VALUES(?, ?, 'system', 'PAID', 'PENDING_PAYMENT', 'SUBMITTED', ?)`)
      .run(p.cid, nowIso, `ชำระเงิน ${ref} ใบเสร็จ ${receiptNo}`);

    return { status: 200, body: { status: 'PAID', caseNo, receiptNo, duplicate: false } };
  });
}

router.post('/payments/:ref/pay', (req, res) => {
  const amount = req.body ? req.body.amount : undefined;
  const r = payByRef(req.params.ref, amount);
  res.status(r.status).json(r.body);
});

// ---------- แก้เอกสารโดยไม่เซ็นใหม่ ----------
router.post('/documents/:docNo/tamper', (req, res) => {
  const info = db.prepare(`UPDATE documents SET applicant = applicant || ' (แก้ไข)' WHERE doc_no = ?`).run(req.params.docNo);
  if (info.changes === 0) return err(res, 404, 'NOT_FOUND', MESSAGES.DOC_NOT_FOUND);
  res.json({ ok: true });
});

// ที่เหลือใต้ /api/test → 404 JSON
router.use((req, res) => err(res, 404, 'NOT_FOUND', 'ไม่พบ test hook'));

module.exports = router;
module.exports.payByRef = payByRef;
