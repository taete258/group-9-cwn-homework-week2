'use strict';
// mask.js · ปิดบังเลขบัตรประชาชน (B07) — CONTRACT §2.6 §2.7 · BR-24 · A-24
//
//   const mask = require('../lib/mask');
//   mask.maskId('3100600987659')   → 'X-XXXX-XXXXX-65-9'   (จอ/JSON ของเจ้าหน้าที่ทุกบทบาท)
//   mask.formatId('3100600987659') → '3-1006-00987-65-9'   (ประชาชนเจ้าของ / หลัง unmask)
//   mask.digits('3-1006-00987-65-9') → '3100600987659'
//
// หลักการ: response ของเจ้าหน้าที่ต้องไม่มีเลข 13 หลักติดกันหรือรูปแบบ d-dddd-ddddd-dd-d (TC-PDPA-02)
// · เลขเต็มออกได้ทางเดียวคือ POST /api/officer/cases/:caseNo/unmask (มีเหตุผล + Audit UNMASK)

/** ตัดทุกอย่างที่ไม่ใช่ตัวเลข */
function digits(idNo) {
  return String(idNo === null || idNo === undefined ? '' : idNo).replace(/\D/g, '');
}

/** 'X-XXXX-XXXXX-65-9' (เห็น 3 หลักท้าย) · ข้อมูลไม่ครบ 13 หลัก → 'X-XXXX-XXXXX-XX-X' */
function maskId(idNo) {
  const d = digits(idNo);
  if (d.length !== 13) return 'X-XXXX-XXXXX-XX-X';
  return `X-XXXX-XXXXX-${d.slice(10, 12)}-${d.slice(12)}`;
}

/** '3-1006-00987-65-9' · ข้อมูลไม่ครบ 13 หลัก → คืนค่าเดิม */
function formatId(idNo) {
  const d = digits(idNo);
  if (d.length !== 13) return String(idNo || '');
  return `${d.slice(0, 1)}-${d.slice(1, 5)}-${d.slice(5, 10)}-${d.slice(10, 12)}-${d.slice(12)}`;
}

/** true ถ้าข้อความมีเลขบัตรเต็ม (13 หลักติดกัน หรือรูปแบบมีขีด) — ใช้ตรวจตัวเองก่อนส่ง JSON */
function containsFullId(text) {
  const s = String(text || '');
  return /\d{13}/.test(s) || /\d-\d{4}-\d{5}-\d{2}-\d/.test(s);
}

module.exports = { digits, maskId, formatId, containsFullId };
