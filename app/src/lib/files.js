'use strict';
// files.js · ไฟล์แนบ (B05) — FR-05 FR-06 · BR-06 BR-07 BR-08 · A-49
//
//   const files = require('../lib/files');
//   router.post('/x', files.receive, (req, res) => { const f = files.firstFile(req); ... })
//   files.detectType(buf)                 → 'application/pdf' | 'image/jpeg' | 'image/png' | null (magic bytes เท่านั้น)
//   files.checkUpload({ serviceId, docKey, file, existingCount })
//                                         → null (ผ่าน) | { status, code, message }
//   files.save(caseId, docKey, file, by)  → { fileId, name, docKey, size }   (เรียกภายใน tx ได้)
//   files.list(caseId)                    → [{ fileId, name, docKey, size, mime, uploadedAt }]
//   files.missingDocs(serviceId, list)    → ['แบบแปลน', 'โฉนด'] ตามลำดับ CONTRACT §4.3
//   files.remove(caseId, fileId)          → true/false
//
// หลักการ
// - ชนิดไฟล์ดูจากเนื้อไฟล์เท่านั้น (ไม่เชื่อชื่อ/นามสกุล/Content-Type)
// - ขนาดใช้ rules.fileSizeOk (BUG_MODE B02 อยู่ในนั้น) · multer รับได้ถึง 8 MB เพื่อให้ 5,242,881 ไบต์ได้ 400 FILE_TOO_LARGE ไม่ใช่ 413
// - ไฟล์ที่ถูกปฏิเสธไม่ถูกเก็บและไม่นับจำนวน · นับรวมทุกช่องแนบ (สูงสุด 5)
// - เนื้อไฟล์เก็บในตาราง files (BLOB) → POST /api/test/reset ล้างไฟล์อัปโหลดใหม่ไปพร้อมกัน
// - fileId = 'F-000001' (ตัวนับ 'file') ไม่มีเลข 13 หลักติดกัน (TC-NFR-04)

const multer = require('multer');
const store = require('../db');
const clock = require('./clock');
const rules = require('./rules');
const C = require('./constants');

const MULTER_LIMIT = 8 * 1024 * 1024; // > 5 MB + ส่วนหัว multipart (CONTRACT §0.10)

const MAGIC = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
];
const EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

/** ชนิดจริงจาก magic bytes · ไม่รู้จัก → null */
function detectType(buf) {
  if (!buf || !buf.length) return null;
  for (const m of MAGIC) {
    if (buf.length >= m.bytes.length && m.bytes.every((b, i) => buf[i] === b)) return m.mime;
  }
  return null;
}

/** multer (busboy) ถอดชื่อไฟล์เป็น latin1 → แปลงกลับเป็น UTF-8 ถ้าเป็นไบต์ UTF-8 ที่ถูกต้อง */
function decodeName(name) {
  const s = String(name || '').replace(/[\\/]/g, '_').trim();
  if (!s) return 'file';
  if (/[^\x00-\xff]/.test(s)) return s.slice(0, 200);
  const u = Buffer.from(s, 'latin1').toString('utf8');
  return (u.includes('�') ? s : u).slice(0, 200);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MULTER_LIMIT, files: 10, fields: 20 },
});
const anyFiles = upload.any();

/**
 * middleware รับ multipart · แปลง error ของ multer เป็น JSON ตาม CONTRACT
 * (ไฟล์ใหญ่เกิน limit ของ multer = ใหญ่เกิน 5 MB แน่นอน → FILE_TOO_LARGE)
 */
function receive(req, res, next) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.toLowerCase().startsWith('multipart/form-data')) return next();
  anyFiles(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return sendErr(res, { status: 400, code: 'FILE_TOO_LARGE' });
    if (err.code === 'LIMIT_FILE_COUNT') return sendErr(res, { status: 400, code: 'FILE_COUNT' });
    return sendErr(res, { status: 400, code: 'FILE_TYPE' });
  });
}

/** ไฟล์แรกใน request (ฟิลด์ 'file' ก่อน) → { name, buffer, size } | null */
function firstFile(req) {
  const list = Array.isArray(req.files) ? req.files : [];
  const f = list.find((x) => x.fieldname === 'file') || list[0];
  if (!f) return null;
  return { name: decodeName(f.originalname), buffer: f.buffer, size: f.size };
}

function err(status, code, extra = {}) {
  return { status, code, message: C.MESSAGES[code] || code, ...extra };
}
function sendErr(res, e) {
  const { status, code, message, ...extra } = e;
  return res.status(status).json({ code, message: message || C.MESSAGES[code] || code, ...extra });
}

/** docKey ที่ใช้ได้ของบริการ (เอกสารตาม CONTRACT §4.3 + 'extra') */
function docKeysOf(serviceId) {
  const svc = C.SERVICES[serviceId];
  return svc ? [...svc.docs.map((d) => d.key), 'extra'] : [];
}
function docLabel(serviceId, key) {
  if (key === 'extra') return 'เอกสารเพิ่มเติม';
  const d = (C.SERVICES[serviceId] || { docs: [] }).docs.find((x) => x.key === key);
  return d ? d.label : key;
}

/**
 * ตรวจไฟล์ก่อนเก็บ · ลำดับ: ช่องแนบ → มีไฟล์ → ขนาด → ชนิด (magic bytes) → แบบแปลนต้อง PDF → จำนวน
 * คืน null เมื่อผ่าน (และตั้ง file.mime) หรือ { status, code, message }
 */
function checkUpload({ serviceId, docKey, file, existingCount }) {
  if (!docKeysOf(serviceId).includes(docKey)) {
    return { status: 400, code: 'INVALID_DOC_KEY', message: 'ช่องแนบเอกสารไม่ถูกต้อง' };
  }
  if (!file) return err(400, 'FILE_TYPE');
  if (!rules.fileSizeOk(file.size)) return err(400, 'FILE_TOO_LARGE');
  const mime = detectType(file.buffer);
  if (!mime) return err(400, 'FILE_TYPE');
  const spec = C.SERVICES[serviceId].docs.find((d) => d.key === docKey);
  if (spec && spec.pdfOnly && mime !== 'application/pdf') return err(400, 'PLAN_NOT_PDF');
  if (!rules.canAddFile(existingCount)) return err(400, 'FILE_COUNT');
  file.mime = mime;
  return null;
}

function count(caseId) {
  return store.db.prepare('SELECT COUNT(*) AS n FROM files WHERE case_id = ?').get(caseId).n;
}

/** เก็บไฟล์ (หลัง checkUpload ผ่าน) */
function save(caseId, docKey, file, by) {
  const seq = store.nextSeq('file', 0);
  const fileId = `F-${String(seq).padStart(6, '0')}`;
  const mime = file.mime || detectType(file.buffer);
  store.db.prepare(`INSERT INTO files(id, case_id, doc_key, name, mime, size, content, uploaded_at, uploaded_by)
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(fileId, caseId, docKey, file.name, mime, file.size, file.buffer, clock.nowISO(), by || 'citizen');
  return { fileId, name: file.name, docKey, size: file.size };
}

function list(caseId) {
  return store.db.prepare(`SELECT id, name, doc_key, size, mime, uploaded_at FROM files WHERE case_id = ? ORDER BY uploaded_at, rowid`)
    .all(caseId)
    .map((r) => ({ fileId: r.id, name: r.name, docKey: r.doc_key, size: r.size, mime: r.mime, uploadedAt: r.uploaded_at }));
}

function remove(caseId, fileId) {
  return store.db.prepare('DELETE FROM files WHERE id = ? AND case_id = ?').run(fileId, caseId).changes > 0;
}

/** ชื่อเอกสารบังคับที่ยังขาด ตามลำดับ CONTRACT §4.3 · แบบแปลนต้องเป็น PDF จึงนับว่าครบ */
function missingDocs(serviceId, fileList) {
  const svc = C.SERVICES[serviceId];
  if (!svc) return [];
  return svc.docs
    .filter((d) => d.required)
    .filter((d) => !fileList.some((f) => f.docKey === d.key && (!d.pdfOnly || f.mime === 'application/pdf')))
    .map((d) => d.label);
}
function missingMessage(missing) { return C.MESSAGES.MISSING_DOCS + missing.join(', '); }

module.exports = {
  MULTER_LIMIT, EXT,
  detectType, decodeName, receive, firstFile, sendErr,
  docKeysOf, docLabel, checkUpload, count, save, list, remove, missingDocs, missingMessage,
};
