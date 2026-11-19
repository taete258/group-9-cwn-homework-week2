'use strict';
// rules.js · กฎธุรกิจที่เป็นตัวเลข (B03) — REQUIREMENTS §2 BR · DECISIONS ข้อ 3 6 7 8 9 10 12 18 · BUGS.md
//
//   const rules = require('../lib/rules');
//
// หลักการ
// - อ่านเวลาจาก clock.js เท่านั้น (ห้าม Date.now()/new Date() ในกฎ) · ทุกฟังก์ชันรับเวลาเป็น ISO/ms/Date
//   ถ้าไม่ส่ง now → ใช้ clock.nowMs()
// - วันที่ล้วนเป็น 'YYYY-MM-DD' (ค.ศ. ตามเวลาไทย) · เวลาที่คืนเป็น ISO '+07:00' ความละเอียดวินาที
// - holidays: Set/Array ของ 'YYYY-MM-DD' · ไม่ส่ง (undefined) → โหลดจากตาราง holidays ใน DB ณ ตอนเรียก
//   (กฎ A-42: กำหนดเสร็จคำนวณครั้งเดียวตอนชำระ · ส่วนขยายจากหยุดนับใช้ตารางวันหยุด ณ เวลาที่ส่งแก้)
// - require('../db') แบบ lazy เฉพาะฟังก์ชันที่ต้องใช้ DB (loadHolidays nextCaseNo nextDocNo) → unit test ฟังก์ชันล้วนไม่แตะ DB
// - BUG_MODE (BUGS.md) ที่อยู่ในไฟล์นี้: B01 ค่าธรรมเนียม SV-03 · B02 ขนาดไฟล์ · B03 วันหยุด · B04 หยุดนับ
//   · B05 อายุ QR · B10 ทันกำหนด % · B12 ตีกลับครั้งที่ 3 (แต่ละตัวแก้จุดเดียว อิสระต่อกัน)

const clock = require('./clock');
const { isBug } = require('./bugs');
const { MESSAGES, SLA_LABEL, OPEN_STATUSES } = require('./constants');

// ---------- ค่าคงที่ ----------
const CUTOFF_SEC = 16 * 3600 + 30 * 60;     // 16:30:00 (A-03)
const DUE_TIME = '16:30:00';
const QR_TTL_MS = 15 * clock.MINUTE;        // BR-10 (A-15)
const FIX_WINDOW_MS = 168 * clock.HOUR;     // BR-20 (A-21)
const MAX_FILE_BYTES = 5 * 1024 * 1024;     // 5,242,880 (BR-07)
const MAX_FILES = 5;
const MAX_RETURNS = 2;                       // BR-19 (A-20)
const MAX_WORKLOAD = 10;                     // BR-18 (A-19)
const REASON_MIN = 10;                       // BR-19 (A-12)
const SV01_QTY = { min: 1, max: 5 };
const SV03_AREA = { min: 1, max: 500, flat: 100 };
const FEE_RANGE = { min: 0, max: 100000 };  // BR-28
const SLA_RANGE = { min: 1, max: 60 };      // BR-28
const DEFAULT_FEES = {                       // TEST-DATA ตาราง 2 (ใช้เมื่อไม่ส่งค่าจากตาราง services)
  'SV-01': { fee: 20, feePerSqm: 0, sla: 3 },
  'SV-02': { fee: 500, feePerSqm: 0, sla: 10 },
  'SV-03': { fee: 1000, feePerSqm: 10, sla: 15 },
};
const CLOSED_FOR_SLA = ['COMPLETED', 'REJECTED', 'CANCELLED'];

const pad = (n, w = 2) => String(n).padStart(w, '0');
const isInt = (v) => Number.isInteger(v);
/** แปลงข้อความ/ตัวเลขเป็นจำนวนเต็ม · '' / '1.5' / 'abc' → NaN */
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
  return NaN;
}
function ms(x) { return x === undefined ? clock.nowMs() : clock.toMs(x); }
/** อ่านฟิลด์ได้ทั้ง camelCase และ snake_case */
function pick(o, camel, snake) {
  if (!o) return undefined;
  return o[camel] !== undefined ? o[camel] : o[snake];
}

// =====================================================================
// BR-01 เลขบัตรประชาชน 13 หลัก + checksum
// =====================================================================
/** true เมื่อเป็นตัวเลข 13 หลักพอดี (ไม่มีขีด) และ checksum ถูก */
function validThaiId(id) {
  const s = String(id === undefined || id === null ? '' : id);
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(s[12]);
}
/** ตัดขีด/ช่องว่างออกก่อนตรวจ ('1-1017-00123-45-6' → '1101700123456') */
function normalizeId(id) { return String(id || '').replace(/[\s-]/g, ''); }

// BR-03 เบอร์มือถือ 10 หลักขึ้นต้น 0
function validMobile(m) { return /^0\d{9}$/.test(String(m || '')); }

// =====================================================================
// BR-04 BR-05 ค่าธรรมเนียม (B01)
// =====================================================================
/**
 * calcFee('SV-03', { area: 101 }, { fee: 1000, feePerSqm: 10 })
 *   → { ok: true, fee: 1010 }  หรือ  { ok: false, code: 'INVALID_AREA', message }
 * svc = แถวจากตาราง services ({ fee, fee_per_sqm|feePerSqm }) · ไม่ส่ง → ค่า seed
 * SV-01: fee × qty (qty 1–5 · ไม่ส่ง qty = 1 ตาม A-56) · SV-02: fee คงที่ · SV-03: fee (feeBase) + feePerSqm × (area − 100) เมื่อ area ≥ 101
 */
function calcFee(serviceId, input = {}, svc) {
  const d = DEFAULT_FEES[serviceId];
  if (!d) return { ok: false, code: 'INVALID_STATE', message: MESSAGES.INVALID_STATE };
  const base = toInt(svc && svc.fee !== undefined ? svc.fee : d.fee);
  const perRaw = svc ? pick(svc, 'feePerSqm', 'fee_per_sqm') : undefined;
  const per = toInt(perRaw !== undefined && perRaw !== null ? perRaw : d.feePerSqm);

  if (serviceId === 'SV-01') {
    const raw = input.qty === undefined || input.qty === null ? 1 : input.qty;
    const qty = toInt(raw);
    if (!isInt(qty) || qty < SV01_QTY.min || qty > SV01_QTY.max) {
      return { ok: false, code: 'INVALID_QTY', message: MESSAGES.INVALID_QTY };
    }
    return { ok: true, fee: base * qty, qty };
  }
  if (serviceId === 'SV-02') return { ok: true, fee: base };

  // SV-03
  const area = toInt(input.area !== undefined ? input.area : input.area_sqm);
  if (isInt(area) && area > SV03_AREA.max) {
    return { ok: false, code: 'AREA_TOO_LARGE', message: MESSAGES.AREA_TOO_LARGE };
  }
  if (!isInt(area) || area < SV03_AREA.min) {
    return { ok: false, code: 'INVALID_AREA', message: MESSAGES.INVALID_AREA };
  }
  // B01: ใช้ > 101 แทน ≥ 101 → พื้นที่ 101 คิดอัตราเหมา (฿1,000) · 102 ยังถูก
  const stepped = isBug('B01') ? area > SV03_AREA.flat + 1 : area >= SV03_AREA.flat + 1;
  return { ok: true, fee: stepped ? base + per * (area - SV03_AREA.flat) : base, area };
}

// BR-28 ช่วงค่าที่ผู้ดูแลแก้ได้
function validFee(v) { const n = toInt(v); return isInt(n) && n >= FEE_RANGE.min && n <= FEE_RANGE.max; }
function validSla(v) { const n = toInt(v); return isInt(n) && n >= SLA_RANGE.min && n <= SLA_RANGE.max; }

// =====================================================================
// BR-07 ขนาด/จำนวนไฟล์ (B02)
// =====================================================================
/** ≤ 5,242,880 ไบต์ · B02: ใช้ < แทน ≤ (5,242,880 พอดีถูกปฏิเสธ) */
function fileSizeOk(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) return false;
  return isBug('B02') ? n < MAX_FILE_BYTES : n <= MAX_FILE_BYTES;
}
/** แนบเพิ่มได้ไหม เมื่อมีอยู่แล้ว existing ไฟล์ */
function canAddFile(existing) { return Number(existing) < MAX_FILES; }

// =====================================================================
// BR-09 เลขคำขอ / ใบเสร็จ / เอกสาร
// =====================================================================
function formatCaseNo(beYear, seq) { return `EG-${beYear}-${pad(seq, 6)}`; }
function formatReceiptNo(beYear, seq) { return `RC-${beYear}-${pad(seq, 6)}`; }
function formatDocNo(beYear, seq) { return `DOC-${beYear}-${pad(seq, 6)}`; }

/**
 * ออกเลขคำขอ + ใบเสร็จถัดไปตามปี พ.ศ. ของเวลาชำระ (ต้องเรียกภายใน db.tx เดียวกับการ UPDATE คำขอ)
 * → { caseNo: 'EG-2569-000031', receiptNo: 'RC-2569-000031', seq: 31, beYear: 2569 }
 * ลำดับเริ่มใหม่ทุกปี พ.ศ. · better-sqlite3 synchronous + tx IMMEDIATE → ชำระพร้อมกันได้เลขไม่ซ้ำ
 */
function nextCaseNo(paidAt) {
  const dbm = require('../db');
  const be = clock.beYear(ms(paidAt));
  const seq = dbm.nextSeq(`case:${be}`, dbm.maxSuffix('cases', 'case_no', `EG-${be}-`));
  return { caseNo: formatCaseNo(be, seq), receiptNo: formatReceiptNo(be, seq), seq, beYear: be };
}
/** ออกเลขเอกสารถัดไปตามปี พ.ศ. ของเวลาออก ('DOC-2571-000001' เมื่อออก 29 ก.พ. 2028) */
function nextDocNo(issuedAt) {
  const dbm = require('../db');
  const be = clock.beYear(ms(issuedAt));
  const seq = dbm.nextSeq(`doc:${be}`, dbm.maxSuffix('documents', 'doc_no', `DOC-${be}-`));
  return formatDocNo(be, seq);
}

// =====================================================================
// BR-10 อายุ QR (B05)
// =====================================================================
/** เวลาหมดอายุ = สร้าง + 15:00 → ISO */
function qrExpiresAt(createdAt) { return clock.toISO(ms(createdAt) + QR_TTL_MS); }
/** ชำระได้ถ้า (เวลาชำระ − เวลาสร้าง) < 15:00 · B05: ใช้ ≤ (15:00 พอดียังจ่ายได้) */
function qrPayable(createdAt, payAt) {
  const age = ms(payAt) - ms(createdAt);
  return isBug('B05') ? age <= QR_TTL_MS : age < QR_TTL_MS;
}
/** QR หมดอายุ ณ now (ใช้แสดงสถานะ EXPIRED ของ payment ที่ยัง PENDING) */
function qrExpired(createdAt, now) { return !qrPayable(createdAt, now); }

// =====================================================================
// วันทำการ (B03)
// =====================================================================
/** โหลดวันหยุดจาก DB → Set('YYYY-MM-DD') */
function loadHolidays() {
  const { db } = require('../db');
  return new Set(db.prepare('SELECT date FROM holidays').all().map((r) => r.date));
}
function toHolidaySet(h) {
  if (h === undefined) return loadHolidays();
  if (h instanceof Set) return h;
  if (Array.isArray(h)) return new Set(h.map((x) => (typeof x === 'string' ? x : x.date)));
  return new Set();
}
/** จันทร์–ศุกร์ ที่ไม่อยู่ในตารางวันหยุด · B03: ข้ามแค่เสาร์-อาทิตย์ (ไม่ดูตารางวันหยุด) */
function isWorkingDay(ymd, holidays) {
  const dow = clock.dowYmd(ymd);
  if (dow === 0 || dow === 6) return false;
  if (isBug('B03')) return true;
  return !toHolidaySet(holidays).has(ymd);
}
/** วันทำการถัดไปหลัง ymd (ไม่รวม ymd) */
function nextWorkingDay(ymd, holidays) {
  const h = toHolidaySet(holidays);
  let d = clock.addDaysYmd(ymd, 1);
  while (!isWorkingDay(d, h)) d = clock.addDaysYmd(d, 1);
  return d;
}
/** วันทำการที่ n หลัง ymd (n = 0 → ymd เดิม) */
function addWorkingDays(ymd, n, holidays) {
  const h = toHolidaySet(holidays);
  let d = ymd;
  for (let i = 0; i < n; i++) d = nextWorkingDay(d, h);
  return d;
}
/** จำนวนวันทำการในช่วง (fromYmd, toYmd] · to ≤ from → 0 */
function countWorkingDays(fromYmd, toYmd, holidays) {
  if (!fromYmd || !toYmd || toYmd <= fromYmd) return 0;
  const h = toHolidaySet(holidays);
  let n = 0;
  for (let d = clock.addDaysYmd(fromYmd, 1); d <= toYmd; d = clock.addDaysYmd(d, 1)) {
    if (isWorkingDay(d, h)) n++;
  }
  return n;
}

// =====================================================================
// BR-12 D0 และกำหนดเสร็จ
// =====================================================================
/** D0 = วันที่ชำระ ถ้าเป็นวันทำการและก่อน 16:30:00 ไม่เช่นนั้นวันทำการถัดไป → 'YYYY-MM-DD' */
function startDay(paidAt, holidays) {
  const h = toHolidaySet(holidays);
  const p = clock.bkk(ms(paidAt));
  const sec = p.hour * 3600 + p.minute * 60 + p.second;
  if (isWorkingDay(p.ymd, h) && sec < CUTOFF_SEC) return p.ymd;
  return nextWorkingDay(p.ymd, h);
}
/** กำหนดเสร็จ = วันทำการที่ N หลัง D0 เวลา 16:30 → '2026-12-04T16:30:00+07:00' */
function computeDueAt(paidAt, slaDays, holidays) {
  const h = toHolidaySet(holidays);
  const due = addWorkingDays(startDay(paidAt, h), toInt(slaDays), h);
  return `${due}T${DUE_TIME}+07:00`;
}
/** SLA ของบริการ (จากแถว services ถ้ามี ไม่งั้นค่า seed) */
function slaDaysOf(serviceId, svc) {
  if (svc && svc.sla !== undefined) return toInt(svc.sla);
  return DEFAULT_FEES[serviceId] ? DEFAULT_FEES[serviceId].sla : NaN;
}

// =====================================================================
// BR-13 หยุดนับระหว่าง NEED_FIX (B04)
// =====================================================================
/** จำนวนวันทำการใน (วันที่ตีกลับ, วันที่ส่งแก้] (นับตามวันที่ ไม่ขึ้นกับเวลา) · B04 → 0 เสมอ */
function pausedDays(returnedAt, resubmittedAt, holidays) {
  if (isBug('B04')) return 0;
  return countWorkingDays(clock.ymd(ms(returnedAt)), clock.ymd(ms(resubmittedAt)), holidays);
}
/** กำหนดเดิม + days วันทำการ (คงเวลาเดิมของกำหนด เช่น 16:30) → ISO */
function extendDueAt(dueAt, days, holidays) {
  const p = clock.bkk(ms(dueAt));
  const d = addWorkingDays(p.ymd, days, holidays);
  return `${d}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}+07:00`;
}
/**
 * ตอนประชาชนส่งแก้: { dueAt: กำหนดใหม่, pausedDays } · ใช้ตารางวันหยุด ณ ตอนเรียก (A-42)
 * ตัวอย่าง: กำหนด 4 ธ.ค. · ตีกลับ 2 ธ.ค. 11:00 · ส่งแก้ 3 ธ.ค. 10:00 → { dueAt: '2026-12-08T16:30:00+07:00', pausedDays: 1 }
 */
function dueAfterResubmit(dueAt, returnedAt, resubmittedAt, holidays) {
  const h = toHolidaySet(holidays);
  const days = pausedDays(returnedAt, resubmittedAt === undefined ? clock.nowMs() : resubmittedAt, h);
  return { dueAt: extendDueAt(dueAt, days, h), pausedDays: days };
}

// =====================================================================
// BR-14 ระดับเตือน
// =====================================================================
/** วันคงเหลือ = จำนวนวันทำการหลังวันนี้ถึงวันกำหนด (รวมวันกำหนด) · กำหนดเป็นวันนี้/ผ่านแล้ว → 0 */
function remainingWorkingDays(now, dueAt, holidays) {
  return countWorkingDays(clock.ymd(ms(now)), clock.ymd(ms(dueAt)), holidays);
}
/**
 * slaLevel({ status, dueAt|due_at }, now?, holidays?) → 'normal' | 'near' | 'overdue' | 'paused' | 'closed' | null
 * COMPLETED/REJECTED/CANCELLED → closed · NEED_FIX → paused · ร่าง/รอชำระ/ไม่มีกำหนด → null
 * overdue: ตอนนี้ > กำหนด (16:30:01 เกิน) · near: วันคงเหลือ ≤ 1 · normal: ≥ 2
 */
function slaLevel(c, now, holidays) {
  const status = pick(c, 'status', 'status');
  if (CLOSED_FOR_SLA.includes(status)) return 'closed';
  if (status === 'NEED_FIX') return 'paused';
  if (status === 'DRAFT' || status === 'PENDING_PAYMENT') return null;
  const due = pick(c, 'dueAt', 'due_at');
  if (!due) return null;
  const nowMs = ms(now);
  if (nowMs > ms(due)) return 'overdue';
  return remainingWorkingDays(nowMs, due, holidays) <= 1 ? 'near' : 'normal';
}
function slaLabel(level) { return level ? SLA_LABEL[level] : '–'; }
/** แจ้งเตือนเฉพาะ near / overdue ของคำขอที่ยังไม่ปิดและไม่อยู่ NEED_FIX */
function notifyLevel(c, now, holidays) {
  const l = slaLevel(c, now, holidays);
  return l === 'near' || l === 'overdue' ? l : null;
}

// =====================================================================
// BR-16 ลำดับคิว
// =====================================================================
/** กำหนดเสร็จเร็วสุดก่อน · เท่ากันเรียงเลขคำขอน้อยไปมาก · ไม่มีกำหนดไปท้าย */
function queueCompare(a, b) {
  const da = pick(a, 'dueAt', 'due_at');
  const dbb = pick(b, 'dueAt', 'due_at');
  const ma = da ? ms(da) : Infinity;
  const mb = dbb ? ms(dbb) : Infinity;
  if (ma !== mb) return ma < mb ? -1 : 1;
  const ca = String(pick(a, 'caseNo', 'case_no') || '');
  const cb = String(pick(b, 'caseNo', 'case_no') || '');
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}
function sortQueue(rows) { return [...rows].sort(queueCompare); }

// =====================================================================
// BR-18 BR-19 งานในมือ · ตีกลับ · เหตุผล (B12)
// =====================================================================
/** รับเรื่องได้ถ้างานในมือ (IN_REVIEW ที่ถือ) < 10 */
function canClaim(workload) { return Number(workload) < MAX_WORKLOAD; }
/** ตีกลับได้ถ้าตีกลับไปแล้ว < 2 ครั้ง · B12: ยอมครั้งที่ 3 */
function canReturn(returnCount) {
  const n = Number(returnCount) || 0;
  return isBug('B12') ? n < MAX_RETURNS + 1 : n < MAX_RETURNS;
}
/** ตรวจเหตุผลตีกลับ/ไม่อนุมัติ → null (ผ่าน) | 'REASON_TOO_SHORT' · นับตัวอักษร (code point) หลัง trim */
function reasonError(reason) {
  const s = String(reason === undefined || reason === null ? '' : reason).trim();
  return [...s].length >= REASON_MIN ? null : 'REASON_TOO_SHORT';
}
function reasonValid(reason) { return reasonError(reason) === null; }

// =====================================================================
// BR-20 เวลาแก้ไขของประชาชน 168 ชม.
// =====================================================================
function fixDeadline(returnedAt) { return clock.toISO(ms(returnedAt) + FIX_WINDOW_MS); }
/** ส่งแก้ได้ถ้า now − ตีกลับ < 168:00 (167:59 ✓ · 168:00 ✗ ยกเลิกอัตโนมัติ) */
function fixWindowOpen(returnedAt, now) { return ms(now) - ms(returnedAt) < FIX_WINDOW_MS; }
function fixWindowExpired(returnedAt, now) { return !fixWindowOpen(returnedAt, now); }

// =====================================================================
// BR-23 อายุเอกสาร · ปิดบังชื่อ
// =====================================================================
/**
 * วันสุดท้ายที่ใช้ได้ 'YYYY-MM-DD'
 * SV-01: วันออก + 89 วัน · SV-02/03: วันครบรอบปีถัดไป − 1 วัน (ออก 29 ก.พ. → ครบรอบ 28 ก.พ.)
 */
function docValidUntil(serviceId, issuedAt) {
  const p = clock.bkk(ms(issuedAt));
  if (serviceId === 'SV-01') return clock.addDaysYmd(p.ymd, 89);
  const y = p.year + 1;
  let anniv = `${y}-${pad(p.month)}-${pad(p.day)}`;
  if (p.month === 2 && p.day === 29 && !isLeap(y)) anniv = `${y}-02-28`;
  return clock.addDaysYmd(anniv, -1);
}
function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
/** หมดอายุเมื่อวันที่ (เวลาไทย) ของ now เลยวันสุดท้าย (28 ก.พ. 23:59 ✓ · 1 มี.ค. 00:00 ✗) */
function docExpired(validUntil, now) { return clock.ymd(ms(now)) > validUntil; }
/** 'สมชาย ใจดี' → 'สมชาย ใ***' · ไม่มีนามสกุล → 'สมชาย ***' */
function maskApplicantName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '***';
  if (parts.length === 1) return `${parts[0]} ***`;
  const surname = parts[parts.length - 1];
  return `${parts.slice(0, -1).join(' ')} ${[...surname][0]}***`;
}

// =====================================================================
// BR-25 BR-26 ตัวชี้วัด Dashboard (B10)
// =====================================================================
/** ทันกำหนด ⇔ closed_at ≤ กำหนดเสร็จ (รวม 16:30:00) */
function isOnTime(closedAt, dueAt) {
  if (!closedAt || !dueAt) return false;
  return ms(closedAt) <= ms(dueAt);
}
/**
 * ทันกำหนด % ทศนิยม 1 ตำแหน่ง ปัดครึ่งขึ้น (เลขจำนวนเต็มล้วน ไม่มี float error) · ตัวหาร 0 → null
 * B10: หารด้วย "รับเรื่อง" แทน "ปิดงาน"
 */
function ontimePct({ onTime, closed, received }) {
  const den = isBug('B10') ? Number(received) || 0 : Number(closed) || 0;
  if (den <= 0) return null;
  const tenths = Math.floor((2 * 1000 * Number(onTime) + den) / (2 * den)); // round-half-up(onTime/den × 1000)
  return tenths / 10;
}
/** 85.7 → '85.7%' · 100 → '100.0%' · null → '–' */
function formatPct(p) {
  if (p === null || p === undefined || Number.isNaN(Number(p))) return '–';
  return `${Number(p).toFixed(1)}%`;
}
/** iso อยู่ในช่วง 'YYYY-MM' หรือ 'YYYY' (ตามวันที่ไทย) */
function inPeriod(iso, period) {
  if (!iso || !period) return false;
  const d = clock.ymd(ms(iso));
  const p = String(period);
  return !!d && d.slice(0, p.length) === p && (p.length === 4 || p.length === 7);
}
/**
 * computeKpis(rows, { period: '2026-11' | '2026', service: 'ALL' | 'SV-01'..., now? })
 * rows = แถว cases (snake_case หรือ camelCase: case_no status service_id paid_at closed_at due_at owner)
 * → { received, closed, onTime, ontimePct, ontimeText, backlog, overdue, workload: [{username,count}] }
 * รายปี: period 'YYYY' รวมจำนวนทุกเดือนแล้วคิด % จากยอดรวม (ไม่เฉลี่ย % รายเดือน)
 * งานคงค้าง/เกินกำหนดคงค้างเป็นค่า ณ ตอนนี้ ไม่ขึ้นกับ period (A-41)
 */
function computeKpis(rows, { period, service = 'ALL', now } = {}) {
  const nowMs = ms(now);
  const list = rows.filter((r) => service === 'ALL' || !service || pick(r, 'serviceId', 'service_id') === service);
  let received = 0, closed = 0, onTime = 0, backlog = 0, overdue = 0;
  const load = new Map();
  for (const r of list) {
    const status = r.status;
    const caseNo = pick(r, 'caseNo', 'case_no');
    const due = pick(r, 'dueAt', 'due_at');
    if (caseNo && inPeriod(pick(r, 'paidAt', 'paid_at'), period)) received++;
    if ((status === 'COMPLETED' || status === 'REJECTED') && inPeriod(pick(r, 'closedAt', 'closed_at'), period)) {
      closed++;
      if (isOnTime(pick(r, 'closedAt', 'closed_at'), due)) onTime++;
    }
    if (OPEN_STATUSES.includes(status)) {
      backlog++;
      if (status !== 'NEED_FIX' && due && nowMs > ms(due)) overdue++;
    }
    if (status === 'IN_REVIEW' && r.owner) load.set(r.owner, (load.get(r.owner) || 0) + 1);
  }
  const pct = ontimePct({ onTime, closed, received });
  const workload = [...load.entries()].map(([username, count]) => ({ username, count }))
    .sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));
  return { received, closed, onTime, ontimePct: pct, ontimeText: formatPct(pct), backlog, overdue, workload };
}

module.exports = {
  // ค่าคงที่
  CUTOFF_SEC, DUE_TIME, QR_TTL_MS, FIX_WINDOW_MS, MAX_FILE_BYTES, MAX_FILES, MAX_RETURNS, MAX_WORKLOAD,
  REASON_MIN, SV01_QTY, SV03_AREA, FEE_RANGE, SLA_RANGE, DEFAULT_FEES,
  // BR-01 BR-03
  validThaiId, normalizeId, validMobile,
  // BR-04 BR-05 BR-28
  calcFee, validFee, validSla,
  // BR-07
  fileSizeOk, canAddFile,
  // BR-09
  formatCaseNo, formatReceiptNo, formatDocNo, nextCaseNo, nextDocNo,
  // BR-10
  qrExpiresAt, qrPayable, qrExpired,
  // วันทำการ + BR-12 BR-13
  loadHolidays, isWorkingDay, nextWorkingDay, addWorkingDays, countWorkingDays,
  startDay, computeDueAt, slaDaysOf, pausedDays, extendDueAt, dueAfterResubmit,
  // BR-14
  remainingWorkingDays, slaLevel, slaLabel, notifyLevel,
  // BR-16 BR-18 BR-19
  queueCompare, sortQueue, canClaim, canReturn, reasonError, reasonValid,
  // BR-20
  fixDeadline, fixWindowOpen, fixWindowExpired,
  // BR-23
  docValidUntil, docExpired, maskApplicantName,
  // BR-25 BR-26
  isOnTime, ontimePct, formatPct, inPeriod, computeKpis,
};
