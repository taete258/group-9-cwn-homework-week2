'use strict';
// rules.test.js · unit test ค่าขอบของกฎตัวเลข (B03) · รัน: node --test src/lib/
// ใช้ DB ชั่วคราว (DB_PATH ใน tmp) เฉพาะส่วนเลขคำขอ · ไม่แตะ data/egov.db

const os = require('os');
const path = require('path');
const fs = require('fs');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.TEST_MODE = '1';
delete process.env.BUG_MODE;

const test = require('node:test');
const assert = require('node:assert/strict');
const clock = require('./clock');
const R = require('./rules');

const H = new Set(['2026-12-07', '2026-12-10', '2026-12-31', '2027-01-01']);
const T = (s) => `${s}+07:00`;

function withBug(code, fn) {
  const prev = process.env.BUG_MODE;
  process.env.BUG_MODE = code;
  try { fn(); } finally { if (prev === undefined) delete process.env.BUG_MODE; else process.env.BUG_MODE = prev; }
}

// ---------------- BR-01 ----------------
test('BR-01 เลขบัตร 13 หลัก + checksum', () => {
  assert.equal(R.validThaiId('110170012345'), false);    // 12
  assert.equal(R.validThaiId('1101700123456'), true);    // 13 ถูก
  assert.equal(R.validThaiId('11017001234567'), false);  // 14
  assert.equal(R.validThaiId('1101700123457'), false);   // checksum ผิด
  for (const id of ['3100600987659', '5500400111221', '1909900555015']) assert.equal(R.validThaiId(id), true, id);
  assert.equal(R.validThaiId('110170012345a'), false);
  assert.equal(R.validThaiId(''), false);
  assert.equal(R.validThaiId(R.normalizeId('1-1017-00123-45-6')), true);
});

test('BR-03 เบอร์มือถือ', () => {
  assert.equal(R.validMobile('081234567'), false);
  assert.equal(R.validMobile('0812345678'), true);
  assert.equal(R.validMobile('08123456789'), false);
  assert.equal(R.validMobile('1812345678'), false);
});

// ---------------- BR-04 BR-05 ----------------
test('BR-04 SV-01 ฿20/ฉบับ 1–5', () => {
  assert.deepEqual(R.calcFee('SV-01', { qty: 0 }), { ok: false, code: 'INVALID_QTY', message: 'จำนวนฉบับต้อง 1–5 ฉบับ' });
  assert.equal(R.calcFee('SV-01', { qty: 1 }).fee, 20);
  assert.equal(R.calcFee('SV-01', { qty: '5' }).fee, 100);
  assert.equal(R.calcFee('SV-01', { qty: 6 }).code, 'INVALID_QTY');
  assert.equal(R.calcFee('SV-01', { qty: 6 }).message, 'จำนวนฉบับต้อง 1–5 ฉบับ');
  assert.equal(R.calcFee('SV-01', { qty: '1.5' }).code, 'INVALID_QTY');
  assert.equal(R.calcFee('SV-01', {}).fee, 20); // ค่าตั้งต้น 1 ฉบับ (A-56)
  assert.equal(R.calcFee('SV-01', { qty: 5 }, { fee: 25 }).fee, 125); // admin แก้เป็น 25
});

test('BR-05 SV-03 ตามพื้นที่ · SV-02 คงที่', () => {
  assert.deepEqual(R.calcFee('SV-03', { area: 0 }), { ok: false, code: 'INVALID_AREA', message: 'กรุณาระบุพื้นที่ 1–500 ตร.ม.' });
  assert.equal(R.calcFee('SV-03', { area: -5 }).code, 'INVALID_AREA');
  assert.equal(R.calcFee('SV-03', { area: '' }).code, 'INVALID_AREA');
  assert.equal(R.calcFee('SV-03', { area: 1 }).fee, 1000);
  assert.equal(R.calcFee('SV-03', { area: 80 }).fee, 1000);
  assert.equal(R.calcFee('SV-03', { area: 100 }).fee, 1000);
  assert.equal(R.calcFee('SV-03', { area: 101 }).fee, 1010);
  assert.equal(R.calcFee('SV-03', { area: 150 }).fee, 1500);
  assert.equal(R.calcFee('SV-03', { area: '500' }).fee, 5000);
  assert.deepEqual(R.calcFee('SV-03', { area: 501 }), { ok: false, code: 'AREA_TOO_LARGE', message: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน' });
  assert.equal(R.calcFee('SV-03', { area: 101 }, { fee: 1000, fee_per_sqm: 10 }).fee, 1010);
  assert.equal(R.calcFee('SV-02', {}).fee, 500);
  assert.equal(R.calcFee('SV-02', {}, { fee: 600 }).fee, 600);
});

test('B01 SV-03 พื้นที่ 101 คิด ฿1,000 · 102 ยังถูก', () => {
  withBug('B01', () => {
    assert.equal(R.calcFee('SV-03', { area: 101 }).fee, 1000);
    assert.equal(R.calcFee('SV-03', { area: 102 }).fee, 1020);
    assert.equal(R.calcFee('SV-03', { area: 100 }).fee, 1000);
  });
  assert.equal(R.calcFee('SV-03', { area: 101 }).fee, 1010);
});

test('BR-28 ช่วงค่าที่ admin แก้ได้', () => {
  assert.deepEqual([-1, 0, 100000, 100001, '1.5'].map(R.validFee), [false, true, true, false, false]);
  assert.deepEqual([0, 1, 60, 61].map(R.validSla), [false, true, true, false]);
});

// ---------------- BR-07 ----------------
test('BR-07 ขนาดไฟล์ ≤ 5,242,880 · ไม่เกิน 5 ไฟล์ · B02', () => {
  assert.equal(R.fileSizeOk(5242879), true);
  assert.equal(R.fileSizeOk(5242880), true);
  assert.equal(R.fileSizeOk(5242881), false);
  assert.equal(R.canAddFile(4), true);
  assert.equal(R.canAddFile(5), false);
  withBug('B02', () => {
    assert.equal(R.fileSizeOk(5242880), false);
    assert.equal(R.fileSizeOk(5242879), true);
  });
});

// ---------------- BR-10 ----------------
test('BR-10 อายุ QR < 15:00 · B05', () => {
  const c = T('2026-12-01T08:55:00');
  assert.equal(R.qrExpiresAt(c), T('2026-12-01T09:10:00'));
  assert.equal(R.qrPayable(c, T('2026-12-01T09:00:00')), true);
  assert.equal(R.qrPayable(c, T('2026-12-01T09:09:59')), true);   // 14:59
  assert.equal(R.qrPayable(c, T('2026-12-01T09:10:00')), false);  // 15:00
  assert.equal(R.qrPayable(c, T('2026-12-01T09:10:01')), false);  // 15:01
  assert.equal(R.qrExpired(c, T('2026-12-01T09:10:00')), true);
  withBug('B05', () => {
    assert.equal(R.qrPayable(c, T('2026-12-01T09:10:00')), true);
    assert.equal(R.qrPayable(c, T('2026-12-01T09:10:01')), false);
  });
});

// ---------------- BR-12 ----------------
test('BR-12 กำหนดเสร็จ (TC-SLA-01 a–i)', () => {
  const rows = [
    ['2026-12-01T09:00:00', 3, '2026-12-04'],
    ['2026-12-01T16:29:00', 3, '2026-12-04'],
    ['2026-12-01T16:29:59', 3, '2026-12-04'],
    ['2026-12-01T16:30:00', 3, '2026-12-08'],
    ['2026-12-04T10:00:00', 3, '2026-12-11'],
    ['2026-12-05T10:00:00', 3, '2026-12-14'],
    ['2026-12-01T09:00:00', 10, '2026-12-17'],
    ['2026-12-01T09:00:00', 15, '2026-12-24'],
    ['2026-12-29T10:00:00', 3, '2027-01-05'],
    ['2026-12-31T23:59:00', 3, '2027-01-07'],
    ['2026-11-23T10:00:00', 3, '2026-11-26'],  // F01 ก่อนหยุดนับ
    ['2026-11-26T10:30:00', 3, '2026-12-01'],  // F02 ก่อนหยุดนับ
  ];
  for (const [paid, n, due] of rows) {
    assert.equal(R.computeDueAt(T(paid), n, H), T(`${due}T16:30:00`), `${paid} N=${n}`);
  }
  assert.equal(R.startDay(T('2026-12-05T10:00:00'), H), '2026-12-08');
  assert.equal(R.startDay(T('2026-12-31T23:59:00'), H), '2027-01-04');
  // admin เพิ่มวันหยุด 2 ธ.ค. → คำขอใหม่ (TC-RBAC-04 ขั้น 7)
  assert.equal(R.computeDueAt(T('2026-12-01T09:00:00'), 3, new Set([...H, '2026-12-02'])), T('2026-12-08T16:30:00'));
  assert.equal(R.computeDueAt(T('2026-12-01T09:00:00'), 3, [...H]), T('2026-12-04T16:30:00')); // array ก็ได้
  assert.equal(R.slaDaysOf('SV-03'), 15);
  assert.equal(R.slaDaysOf('SV-01', { sla: 5 }), 5);
});

test('B03 SLA ไม่ข้ามวันหยุดในตาราง', () => {
  withBug('B03', () => {
    assert.equal(R.computeDueAt(T('2026-12-01T16:30:00'), 3, H), T('2026-12-07T16:30:00'));
    assert.equal(R.computeDueAt(T('2026-12-04T10:00:00'), 3, H), T('2026-12-09T16:30:00'));
    assert.equal(R.computeDueAt(T('2026-12-05T10:00:00'), 3, H), T('2026-12-10T16:30:00'));
    assert.equal(R.computeDueAt(T('2026-12-29T10:00:00'), 3, H), T('2027-01-01T16:30:00'));
    assert.equal(R.computeDueAt(T('2026-12-31T23:59:00'), 3, H), T('2027-01-06T16:30:00'));
    // หยุดนับแถว 6 → 7 ธ.ค. แทน 8 ธ.ค.
    const r = R.dueAfterResubmit(T('2026-12-04T16:30:00'), T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), H);
    assert.equal(r.dueAt, T('2026-12-07T16:30:00'));
    // วันคงเหลือ: ศ.4 09:00 กำหนด อ.8 → ปกติ แทน ใกล้
    assert.equal(R.slaLevel({ status: 'IN_REVIEW', dueAt: T('2026-12-08T16:30:00') }, T('2026-12-04T09:00:00'), H), 'normal');
  });
});

// ---------------- BR-13 ----------------
test('BR-13 หยุดนับระหว่าง NEED_FIX (TC-SLA-02)', () => {
  const due = T('2026-12-04T16:30:00');
  let r = R.dueAfterResubmit(due, T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), H);
  assert.deepEqual(r, { dueAt: T('2026-12-08T16:30:00'), pausedDays: 1 });
  r = R.dueAfterResubmit(due, T('2026-12-02T09:00:00'), T('2026-12-02T15:00:00'), H);     // วันเดียวกัน
  assert.deepEqual(r, { dueAt: due, pausedDays: 0 });
  r = R.dueAfterResubmit(due, T('2026-12-04T10:00:00'), T('2026-12-08T17:00:00'), H);     // คร่อม ส-อา + จ.7
  assert.deepEqual(r, { dueAt: T('2026-12-08T16:30:00'), pausedDays: 1 });
  assert.equal(R.slaLevel({ status: 'IN_REVIEW', dueAt: r.dueAt }, T('2026-12-08T17:00:00'), H), 'overdue');
  // seed F01 …000017 (ตีกลับ 27 พ.ย. 14:00 กำหนดที่เก็บ 27 พ.ย.)
  const f01 = T('2026-11-27T16:30:00');
  r = R.dueAfterResubmit(f01, T('2026-11-27T14:00:00'), T('2026-12-01T09:00:00'), H);
  assert.deepEqual(r, { dueAt: T('2026-12-01T16:30:00'), pausedDays: 2 });
  assert.equal(R.slaLevel({ status: 'IN_REVIEW', dueAt: r.dueAt }, T('2026-12-01T09:00:00'), H), 'near');
  r = R.dueAfterResubmit(f01, T('2026-11-27T14:00:00'), T('2026-12-04T10:00:00'), H);
  assert.deepEqual(r, { dueAt: T('2026-12-04T16:30:00'), pausedDays: 5 });
  // ประวัติ F01/F02 (TEST-DATA 4.4)
  assert.equal(R.pausedDays(T('2026-11-24T11:00:00'), T('2026-11-25T10:00:00'), H), 1);
  assert.equal(R.pausedDays(T('2026-11-27T10:00:00'), T('2026-11-30T10:00:00'), H), 1);
  assert.equal(R.pausedDays(T('2026-11-30T14:00:00'), T('2026-12-01T08:30:00'), H), 1);
  withBug('B04', () => {
    const b = R.dueAfterResubmit(due, T('2026-12-02T11:00:00'), T('2026-12-03T10:00:00'), H);
    assert.deepEqual(b, { dueAt: due, pausedDays: 0 });
    const s = R.dueAfterResubmit(f01, T('2026-11-27T14:00:00'), T('2026-12-01T09:00:00'), H);
    assert.equal(s.dueAt, f01);
    assert.equal(R.slaLevel({ status: 'IN_REVIEW', dueAt: s.dueAt }, T('2026-12-01T09:00:00'), H), 'overdue');
  });
});

// ---------------- BR-14 ----------------
test('BR-14 ระดับเตือน (TC-SLA-03)', () => {
  const lv = (due, now) => R.slaLevel({ status: 'IN_REVIEW', dueAt: T(due) }, T(now), H);
  const due = '2026-12-04T16:30:00';
  assert.equal(R.remainingWorkingDays(T('2026-12-01T09:00:00'), T(due), H), 3);
  assert.equal(lv(due, '2026-12-01T09:00:00'), 'normal');
  assert.equal(lv(due, '2026-12-02T09:00:00'), 'normal');
  assert.equal(R.remainingWorkingDays(T('2026-12-03T09:00:00'), T(due), H), 1);
  assert.equal(lv(due, '2026-12-03T09:00:00'), 'near');
  assert.equal(R.remainingWorkingDays(T('2026-12-04T16:30:00'), T(due), H), 0);
  assert.equal(lv(due, '2026-12-04T16:30:00'), 'near');
  assert.equal(lv(due, '2026-12-04T16:30:01'), 'overdue');
  assert.equal(lv(due, '2026-12-04T16:31:00'), 'overdue');
  assert.equal(lv(due, '2026-12-05T10:00:00'), 'overdue');
  // ส่วน B กำหนด อ.8
  const d8 = '2026-12-08T16:30:00';
  assert.equal(R.remainingWorkingDays(T('2026-12-03T09:00:00'), T(d8), H), 2);
  assert.equal(lv(d8, '2026-12-03T09:00:00'), 'normal');
  assert.equal(lv(d8, '2026-12-04T09:00:00'), 'near');
  assert.equal(lv(d8, '2026-12-08T16:30:00'), 'near');
  assert.equal(lv(d8, '2026-12-08T16:31:00'), 'overdue');
  // ส่วน C seed ที่ 1 ธ.ค. 09:00
  assert.equal(lv('2026-11-30T16:30:00', '2026-12-01T09:00:00'), 'overdue');
  assert.equal(lv('2026-12-01T16:30:00', '2026-12-01T09:00:00'), 'near');
  assert.equal(lv('2026-12-02T16:30:00', '2026-12-01T09:00:00'), 'near');
  assert.equal(lv('2026-12-03T16:30:00', '2026-12-01T09:00:00'), 'normal');
  assert.equal(lv('2026-12-01T16:30:00', '2026-12-01T16:30:00'), 'near');
  assert.equal(lv('2026-12-01T16:30:00', '2026-12-01T16:31:00'), 'overdue');
  const now = T('2026-12-01T09:00:00');
  assert.equal(R.slaLevel({ status: 'NEED_FIX', due_at: T('2026-11-27T16:30:00') }, now, H), 'paused');
  assert.equal(R.slaLevel({ status: 'COMPLETED', due_at: T('2026-10-01T16:30:00') }, now, H), 'closed');
  assert.equal(R.slaLevel({ status: 'REJECTED' }, now, H), 'closed');
  assert.equal(R.slaLevel({ status: 'CANCELLED' }, now, H), 'closed');
  assert.equal(R.slaLevel({ status: 'DRAFT' }, now, H), null);
  assert.equal(R.slaLabel('near'), 'ใกล้ครบกำหนด');
  assert.equal(R.notifyLevel({ status: 'SUBMITTED', dueAt: T('2026-12-02T16:30:00') }, now, H), 'near');
  assert.equal(R.notifyLevel({ status: 'NEED_FIX', dueAt: T('2026-11-27T16:30:00') }, now, H), null);
});

test('ใช้นาฬิกาทดสอบเมื่อไม่ส่ง now', () => {
  clock.reset();
  assert.equal(clock.nowISO(), T('2026-12-01T09:00:00'));
  assert.equal(R.slaLevel({ status: 'IN_REVIEW', dueAt: T('2026-12-04T16:30:00') }, undefined, H), 'normal');
  clock.set(T('2026-12-04T16:30:01'));
  assert.equal(R.slaLevel({ status: 'IN_REVIEW', dueAt: T('2026-12-04T16:30:00') }, undefined, H), 'overdue');
  clock.reset();
});

// ---------------- BR-16 ----------------
test('BR-16 ลำดับคิว', () => {
  const rows = [
    { caseNo: 'EG-2569-000028', dueAt: T('2026-12-04T16:30:00') },
    { caseNo: 'EG-2569-000020', dueAt: T('2026-11-30T16:30:00') },
    { caseNo: 'EG-2569-000015', dueAt: T('2026-12-04T16:30:00') },
    { caseNo: 'EG-2569-000099', dueAt: null },
    { case_no: 'EG-2569-000013', due_at: T('2026-12-04T16:30:00') },
    { caseNo: 'EG-2569-000027', dueAt: T('2026-12-04T16:30:00') },
  ];
  assert.deepEqual(R.sortQueue(rows).map((r) => r.caseNo || r.case_no),
    ['EG-2569-000020', 'EG-2569-000013', 'EG-2569-000015', 'EG-2569-000027', 'EG-2569-000028', 'EG-2569-000099']);
});

// ---------------- BR-18 BR-19 ----------------
test('BR-18 งานในมือ ≤ 10', () => {
  assert.equal(R.canClaim(9), true);
  assert.equal(R.canClaim(10), false);
  assert.equal(R.canClaim(11), false);
});

test('BR-19 ตีกลับ ≤ 2 ครั้ง · เหตุผล ≥ 10 ตัว · B12', () => {
  assert.equal(R.canReturn(0), true);
  assert.equal(R.canReturn(1), true);
  assert.equal(R.canReturn(2), false);
  assert.equal(R.reasonError('xxxxxxxxx'), 'REASON_TOO_SHORT');
  assert.equal(R.reasonError('xxxxxxxxxx'), null);
  assert.equal(R.reasonError('          '), 'REASON_TOO_SHORT');
  assert.equal(R.reasonError('  xxxxxxxxx  '), 'REASON_TOO_SHORT');
  assert.equal(R.reasonError(undefined), 'REASON_TOO_SHORT');
  assert.equal(R.reasonValid('ภาพเอกสารเบลอ อ่านเลขไม่ได้'), true);
  withBug('B12', () => {
    assert.equal(R.canReturn(2), true);
    assert.equal(R.canReturn(3), false);
  });
});

// ---------------- BR-20 ----------------
test('BR-20 เวลาแก้ไข 168 ชม.', () => {
  const ret = T('2026-11-27T14:00:00');
  assert.equal(R.fixDeadline(ret), T('2026-12-04T14:00:00'));
  assert.equal(R.fixDeadline(T('2026-12-02T11:00:00')), T('2026-12-09T11:00:00'));
  assert.equal(R.fixWindowOpen(ret, T('2026-12-04T13:59:00')), true);
  assert.equal(R.fixWindowOpen(ret, T('2026-12-04T13:59:59')), true);
  assert.equal(R.fixWindowOpen(ret, T('2026-12-04T14:00:00')), false);
  assert.equal(R.fixWindowExpired(ret, T('2026-12-04T14:00:00')), true);
});

// ---------------- BR-23 ----------------
test('BR-23 อายุเอกสาร · ปิดบังชื่อ', () => {
  assert.equal(R.docValidUntil('SV-01', T('2026-12-01T10:00:00')), '2027-02-28');
  assert.equal(R.docExpired('2027-02-28', T('2027-02-28T23:59:00')), false);
  assert.equal(R.docExpired('2027-02-28', T('2027-03-01T00:00:00')), true);
  assert.equal(R.docValidUntil('SV-02', T('2026-12-01T10:00:00')), '2027-11-30');
  assert.equal(R.docValidUntil('SV-03', T('2026-12-01T10:00:00')), '2027-11-30');
  assert.equal(R.docExpired('2027-11-30', T('2027-11-30T23:59:00')), false);
  assert.equal(R.docExpired('2027-11-30', T('2027-12-01T00:00:00')), true);
  assert.equal(R.docValidUntil('SV-01', T('2026-11-05T10:00:00')), '2027-02-02'); // seed K7M2Q9XA
  assert.equal(R.docValidUntil('SV-02', T('2028-02-29T10:00:00')), '2029-02-27');
  assert.equal(R.docValidUntil('SV-01', T('2028-02-29T10:00:00')), '2028-05-28');
  assert.equal(R.docValidUntil('SV-02', T('2027-02-28T10:00:00')), '2028-02-27');
  assert.equal(R.docValidUntil('SV-01', T('2026-12-01T00:30:00')), '2027-02-28'); // วันตามเวลาไทย
  assert.equal(R.maskApplicantName('สมชาย ใจดี'), 'สมชาย ใ***');
  assert.equal(R.maskApplicantName('สมหญิง รักไทย'), 'สมหญิง ร***');
  assert.equal(R.maskApplicantName('สมชาย'), 'สมชาย ***');
});

// ---------------- BR-25 BR-26 ----------------
test('BR-25 ทันกำหนด · % ปัดครึ่งขึ้น · B10', () => {
  const due = T('2026-12-03T16:30:00');
  assert.equal(R.isOnTime(T('2026-12-03T16:29:59'), due), true);
  assert.equal(R.isOnTime(T('2026-12-03T16:30:00'), due), true);
  assert.equal(R.isOnTime(T('2026-12-03T16:30:01'), due), false);
  assert.equal(R.isOnTime(T('2026-12-03T16:31:00'), due), false);
  assert.equal(R.ontimePct({ onTime: 6, closed: 7, received: 26 }), 85.7);
  assert.equal(R.ontimePct({ onTime: 2, closed: 3, received: 10 }), 66.7);
  assert.equal(R.ontimePct({ onTime: 1, closed: 1, received: 1 }), 100);
  assert.equal(R.ontimePct({ onTime: 7, closed: 8, received: 30 }), 87.5);
  assert.equal(R.ontimePct({ onTime: 0, closed: 0, received: 3 }), null);
  assert.equal(R.ontimePct({ onTime: 1, closed: 8 }), 12.5);   // ครึ่งพอดี 12.5
  assert.equal(R.ontimePct({ onTime: 1, closed: 16 }), 6.3);   // 6.25 → 6.3 (ปัดครึ่งขึ้น)
  assert.equal(R.formatPct(85.7), '85.7%');
  assert.equal(R.formatPct(100), '100.0%');
  assert.equal(R.formatPct(null), '–');
  withBug('B10', () => {
    assert.equal(R.formatPct(R.ontimePct({ onTime: 6, closed: 7, received: 26 })), '23.1%');
    assert.equal(R.formatPct(R.ontimePct({ onTime: 7, closed: 8, received: 30 })), '23.3%');
    assert.equal(R.formatPct(R.ontimePct({ onTime: 0, closed: 0, received: 3 })), '0.0%');
    assert.equal(R.formatPct(R.ontimePct({ onTime: 1, closed: 1, received: 1 })), '100.0%');
  });
});

test('BR-25 BR-26 computeKpis: เดือน/ปี/บริการ/คงค้าง', () => {
  const rows = [];
  const add = (o) => rows.push({ owner: null, ...o });
  // ต.ค. ปิด 1 ทัน
  add({ case_no: 'A1', service_id: 'SV-01', status: 'COMPLETED', paid_at: T('2026-10-05T10:00:00'), due_at: T('2026-10-08T16:30:00'), closed_at: T('2026-10-08T16:30:00') });
  // พ.ย. ปิด 7 (ไม่ทัน 1) · CANCELLED 1 (นับรับเรื่อง ไม่นับปิด)
  for (let i = 0; i < 6; i++) add({ case_no: `B${i}`, service_id: i < 2 ? 'SV-02' : 'SV-01', status: i % 2 ? 'REJECTED' : 'COMPLETED', paid_at: T('2026-11-02T10:00:00'), due_at: T('2026-11-20T16:30:00'), closed_at: T('2026-11-19T10:00:00') });
  add({ case_no: 'B6', service_id: 'SV-02', status: 'COMPLETED', paid_at: T('2026-11-02T10:00:00'), due_at: T('2026-11-17T16:30:00'), closed_at: T('2026-11-19T10:00:00') });
  add({ case_no: 'B7', service_id: 'SV-01', status: 'CANCELLED', paid_at: T('2026-11-03T10:00:00'), due_at: T('2026-11-06T16:30:00') });
  // คงค้าง ธ.ค.
  add({ case_no: 'C1', service_id: 'SV-01', status: 'IN_REVIEW', owner: 'off.reg1', paid_at: T('2026-11-25T10:00:00'), due_at: T('2026-11-30T16:30:00') });
  add({ case_no: 'C2', service_id: 'SV-01', status: 'NEED_FIX', paid_at: T('2026-11-23T10:00:00'), due_at: T('2026-11-27T16:30:00') });
  add({ case_no: 'C3', service_id: 'SV-01', status: 'SUBMITTED', paid_at: T('2026-12-01T08:00:00'), due_at: T('2026-12-04T16:30:00') });
  add({ case_no: null, service_id: 'SV-01', status: 'DRAFT' });
  const now = T('2026-12-01T09:00:00');

  const nov = R.computeKpis(rows, { period: '2026-11', now });
  assert.deepEqual({ ...nov, workload: undefined }, { received: 10, closed: 7, onTime: 6, ontimePct: 85.7, ontimeText: '85.7%', backlog: 3, overdue: 1, workload: undefined });
  assert.deepEqual(nov.workload, [{ username: 'off.reg1', count: 1 }]);
  const sv02 = R.computeKpis(rows, { period: '2026-11', service: 'SV-02', now });
  assert.equal(sv02.ontimeText, '66.7%');
  const year = R.computeKpis(rows, { period: '2026', now });
  assert.equal(year.closed, 8);
  assert.equal(year.onTime, 7);
  assert.equal(year.ontimeText, '87.5%');           // ไม่ใช่ 92.9% (เฉลี่ยรายเดือน)
  const dec = R.computeKpis(rows, { period: '2026-12', now });
  assert.equal(dec.received, 1);
  assert.equal(dec.closed, 0);
  assert.equal(dec.ontimePct, null);
  assert.equal(dec.ontimeText, '–');
  assert.equal(R.inPeriod(T('2026-11-30T23:59:59'), '2026-12'), false);
  assert.equal(R.inPeriod(T('2026-12-01T00:00:00'), '2026-12'), true);
  assert.equal(R.inPeriod('2026-11-30T17:00:00Z', '2026-12'), true); // = 1 ธ.ค. 00:00 ไทย
});

// ---------------- BR-09 ----------------
test('BR-09 รูปแบบเลข', () => {
  assert.equal(R.formatCaseNo(2569, 31), 'EG-2569-000031');
  assert.equal(R.formatReceiptNo(2570, 1), 'RC-2570-000001');
  assert.equal(R.formatDocNo(2571, 2), 'DOC-2571-000002');
});

// better-sqlite3 อาจยังไม่ได้ build บนเครื่อง host (รันจริงใน Docker) → ข้ามเฉพาะส่วนที่ต้องใช้ DB
let sqliteOk = true;
try { new (require('better-sqlite3'))(':memory:').close(); } catch { sqliteOk = false; }

test('BR-09 เลขคำขอ: ปี พ.ศ. ของเวลาชำระ · ลำดับใหม่ทุกปี · ไม่ซ้ำ (DB)', { skip: !sqliteOk && 'better-sqlite3 native binding ไม่พร้อมบน host' }, () => {
  const dbm = require('../db');
  const { db } = dbm;
  const at = T('2026-11-01T10:00:00');
  db.prepare('INSERT INTO services(id,name,fee,fee_per_sqm,sla) VALUES(?,?,?,?,?)').run('SV-01', 'x', 20, 0, 3);
  const uid = db.prepare("INSERT INTO users(role,name,created_at) VALUES('citizen','t',?)").run(at).lastInsertRowid;
  const ins = db.prepare("INSERT INTO cases(case_no,service_id,applicant_id,status,created_at,updated_at) VALUES(?, 'SV-01', ?, 'SUBMITTED', ?, ?)");
  for (let i = 1; i <= 30; i++) ins.run(R.formatCaseNo(2569, i), uid, at, at);

  const a = dbm.tx(() => R.nextCaseNo(T('2026-12-31T23:59:00')));
  assert.deepEqual(a, { caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031', seq: 31, beYear: 2569 });
  ins.run(a.caseNo, uid, at, at);
  const b = dbm.tx(() => R.nextCaseNo(T('2027-01-01T00:00:00')));
  assert.equal(b.caseNo, 'EG-2570-000001');
  assert.equal(b.receiptNo, 'RC-2570-000001');
  assert.equal(dbm.tx(() => R.nextCaseNo(T('2027-01-01T00:00:00'))).caseNo, 'EG-2570-000002');
  // 6 รายการติดกันไม่ซ้ำ
  const set = new Set();
  for (let i = 0; i < 6; i++) set.add(dbm.tx(() => R.nextCaseNo(T('2026-12-01T09:00:00'))).caseNo);
  assert.deepEqual([...set], ['EG-2569-000032', 'EG-2569-000033', 'EG-2569-000034', 'EG-2569-000035', 'EG-2569-000036', 'EG-2569-000037']);
  // เลขเอกสารตามปีของเวลาออก
  assert.equal(dbm.tx(() => R.nextDocNo(T('2028-02-29T10:00:00'))), 'DOC-2571-000001');
  // วันหยุดจาก DB (ไม่ส่ง holidays)
  db.prepare('INSERT INTO holidays(date,name) VALUES(?,?)').run('2026-12-07', 'x');
  db.prepare('INSERT INTO holidays(date,name) VALUES(?,?)').run('2026-12-10', 'x');
  assert.equal(R.computeDueAt(T('2026-12-01T16:30:00'), 3), T('2026-12-08T16:30:00'));
  assert.equal(R.computeDueAt(T('2026-12-04T10:00:00'), 3), T('2026-12-11T16:30:00'));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
