'use strict';
// clock.js · นาฬิกาของระบบ (B01)
// - TEST_MODE=1 → นาฬิกาแช่แข็ง เริ่มที่ 2026-12-01T09:00:00+07:00 · เปลี่ยนได้ด้วย PUT /api/test/clock
// - ไม่ตั้ง TEST_MODE → เวลาจริงของเครื่อง
// - ทุกกฎธุรกิจต้องอ่านเวลาจากที่นี่เท่านั้น (ห้าม Date.now() / new Date() ตรง ๆ)
// - เขตเวลา Asia/Bangkok = +07:00 คงที่ (ไม่มี DST) จึงคำนวณด้วยการบวก offset ตรง ๆ

const DEFAULT_NOW = '2026-12-01T09:00:00+07:00';
const OFFSET_MS = 7 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

const testMode = () => process.env.TEST_MODE === '1' || process.env.TEST_MODE === 'true';

let frozenMs = testMode() ? Date.parse(DEFAULT_NOW) : null;

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** ตรวจ ISO ที่ต้องมี offset (Z หรือ ±hh:mm) · คืน ms หรือ null */
function parseStrictISO(s) {
  if (typeof s !== 'string') return null;
  const m = ISO_WITH_OFFSET.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || (sec && +sec > 59)) return null;
  const ms = Date.parse(s.trim());
  if (Number.isNaN(ms)) return null;
  // ปฏิเสธวันที่ล้น เช่น 2026-02-31
  const local = new Date(Date.UTC(+y, +mo - 1, +d));
  if (local.getUTCMonth() !== +mo - 1) return null;
  return ms;
}

/** แปลงค่าใด ๆ (ms, Date, ISO, 'YYYY-MM-DD' = เที่ยงคืนไทย) เป็น ms */
function toMs(x) {
  if (x === null || x === undefined || x === '') return null;
  if (typeof x === 'number') return x;
  if (x instanceof Date) return x.getTime();
  if (typeof x === 'string') {
    const m = YMD.exec(x);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]) - OFFSET_MS;
    const ms = Date.parse(x);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

// ---------- นาฬิกา ----------
function nowMs() { return frozenMs !== null ? frozenMs : Date.now(); }
function now() { return new Date(nowMs()); }
function nowISO() { return toISO(nowMs()); }
/** ตั้งนาฬิกา (แช่แข็ง) · คืน true ถ้าสำเร็จ, false ถ้า ISO ไม่ถูกต้อง/ไม่มี offset */
function set(iso) {
  const ms = parseStrictISO(iso);
  if (ms === null) return false;
  frozenMs = Math.floor(ms / 1000) * 1000;
  return true;
}
function reset() { frozenMs = testMode() ? Date.parse(DEFAULT_NOW) : null; }
function isFrozen() { return frozenMs !== null; }

// ---------- แปลงเป็นเวลาไทย ----------
/** ส่วนประกอบเวลาไทย: { year, month(1-12), day, hour, minute, second, dow(0=อา..6=ส), ymd, beYear } */
function bkk(x) {
  const ms = toMs(x);
  if (ms === null) return null;
  const d = new Date(ms + OFFSET_MS);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return {
    year, month, day,
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
    dow: d.getUTCDay(),
    ymd: `${year}-${pad(month)}-${pad(day)}`,
    beYear: year + 543,
  };
}
/** ISO +07:00 ความละเอียดวินาที: '2026-12-04T16:30:00+07:00' */
function toISO(x) {
  const p = bkk(x);
  if (!p) return null;
  return `${p.ymd}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}+07:00`;
}
/** 'YYYY-MM-DD' ตามเวลาไทย */
function ymd(x) { const p = bkk(x); return p ? p.ymd : null; }
/** สร้าง ms จากวันที่ไทย + เวลา: fromBkk('2026-12-04', '16:30') หรือ fromBkk('2026-12-04', 16, 30, 0) */
function fromBkk(ymdStr, h = 0, mi = 0, s = 0) {
  if (typeof h === 'string') {
    const [hh, mm, ss] = h.split(':').map(Number);
    h = hh || 0; mi = mm || 0; s = ss || 0;
  }
  const m = YMD.exec(ymdStr);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], h, mi, s) - OFFSET_MS;
}
/** บวกวันปฏิทินให้ 'YYYY-MM-DD' */
function addDaysYmd(ymdStr, n) {
  const m = YMD.exec(ymdStr);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
/** วันในสัปดาห์ของ 'YYYY-MM-DD' (0=อาทิตย์ ... 6=เสาร์) */
function dowYmd(ymdStr) {
  const m = YMD.exec(ymdStr);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
}
/** ปี พ.ศ. ตามเวลาไทย */
function beYear(x) { const p = bkk(x); return p ? p.beYear : null; }

// ---------- รูปแบบแสดงผลบนจอ (CONTRACT §0.2) ----------
/** '4 ธ.ค. 2569 16:30' */
function formatThai(x) {
  const p = bkk(x);
  if (!p) return '–';
  return `${p.day} ${TH_MONTHS[p.month - 1]} ${p.beYear} ${pad(p.hour)}:${pad(p.minute)}`;
}
/** '2 ก.พ. 2570' (รับ 'YYYY-MM-DD' หรือเวลาใด ๆ) */
function formatThaiDate(x) {
  if (typeof x === 'string' && YMD.test(x)) {
    const [y, m, d] = x.split('-').map(Number);
    return `${d} ${TH_MONTHS[m - 1]} ${y + 543}`;
  }
  const p = bkk(x);
  if (!p) return '–';
  return `${p.day} ${TH_MONTHS[p.month - 1]} ${p.beYear}`;
}
/** '฿1,010' (จำนวนเต็มบาท) · ค่าไม่ใช่ตัวเลข → '–' */
function baht(n) {
  if (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) return '–';
  const v = Math.round(Number(n));
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (v < 0 ? '-฿' : '฿') + s;
}

module.exports = {
  DEFAULT_NOW, MINUTE, HOUR, DAY, OFFSET_MS, TH_MONTHS,
  testMode,
  now, nowMs, nowISO, set, reset, isFrozen,
  parseStrictISO, toMs, toISO, bkk, ymd, fromBkk, addDaysYmd, dowYmd, beYear,
  formatThai, formatThaiDate, baht,
};
