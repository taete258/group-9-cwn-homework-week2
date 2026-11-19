'use strict';
// bugs.js · BUG_MODE (B01) — ดู /workspace/egov-brief/BUGS.md
// BUG_MODE=B03,B07 → isBug('B03') === true · ไม่ตั้ง/ว่าง → เว็บถูกต้อง 100%
// อ่าน env ทุกครั้งที่เรียก (ถูกมาก) เพื่อให้ unit test ตั้ง process.env.BUG_MODE ระหว่างรันได้

const KNOWN = ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B09', 'B10', 'B11', 'B12'];

function parse(raw) {
  return String(raw || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .map((s) => (/^B\d$/.test(s) ? 'B0' + s.slice(1) : s)); // 'B3' → 'B03'
}

/** รายการบั๊กที่เปิดอยู่ เช่น ['B03','B07'] */
function activeBugs() { return parse(process.env.BUG_MODE); }

/** isBug('B03') → true เมื่อ BUG_MODE มี B03 */
function isBug(code) {
  const c = parse(code)[0];
  return !!c && activeBugs().includes(c);
}

module.exports = { isBug, activeBugs, KNOWN };
