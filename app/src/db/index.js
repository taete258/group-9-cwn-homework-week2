'use strict';
// db/index.js · เปิดฐานข้อมูล SQLite ที่ DB_PATH + helper กลาง (B01)
//
//   const { db, tx, nextSeq, encrypt, decrypt, idHash, resetAndSeed } = require('../db');
//
// - db        : better-sqlite3 Database (synchronous · ไม่มี race ภายใน process เดียว)
// - tx(fn)    : รัน fn ใน transaction (IMMEDIATE) คืนค่าของ fn
// - nextSeq(name, currentMax) : ออกเลขลำดับถัดไปแบบไม่ซ้ำ (เรียกภายใน tx)
// - encrypt/decrypt : AES-256-GCM สำหรับเลขบัตร/เบอร์โทร (NFR-04)
// - idHash(idNo)    : blind index (HMAC-SHA256 base64url) สำหรับค้นหาเลขบัตร
// - resetAndSeed()  : ล้างทุกตาราง + seed ใหม่ (ใช้โดย POST /api/test/reset และตอนเริ่มครั้งแรก)
// - onReset(fn)     : ลงทะเบียน callback ล้าง state ในหน่วยความจำของบล็อกอื่น (ถ้ามี)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'egov.db'));
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = DELETE'); // ไฟล์เดียว อ่านตรวจ (TC-NFR-04) ง่าย
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// ---------- transaction ----------
/** tx(() => {...}) รันใน transaction แบบ IMMEDIATE · ซ้อนกันได้ (better-sqlite3 ใช้ savepoint) */
function tx(fn) {
  return db.transaction(fn).immediate();
}

// ---------- ลำดับเลข ----------
/**
 * ออกเลขถัดไปของตัวนับ name · currentMax = ค่าสูงสุดที่มีอยู่ในข้อมูลแล้ว (เช่นจาก seed)
 * ผล = max(counter, currentMax) + 1 แล้วบันทึกไว้ (เลขที่ลบไปแล้วจะไม่ถูกใช้ซ้ำ)
 * ตัวอย่าง: nextSeq('draft', maxOf("SELECT draft_id ...")) → 3 → 'DR-0003'
 */
function nextSeq(name, currentMax = 0) {
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(name);
  const next = Math.max(row ? row.value : 0, Number(currentMax) || 0) + 1;
  db.prepare('INSERT INTO counters(name, value) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value')
    .run(name, next);
  return next;
}
/** เลขท้ายสูงสุดของรหัสในคอลัมน์ เช่น maxSuffix('cases','case_no','EG-2569-') → 30 */
function maxSuffix(table, column, prefix) {
  const rows = db.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${column} LIKE ?`).all(prefix + '%');
  let max = 0;
  for (const r of rows) {
    const n = parseInt(String(r.v).slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

// ---------- เข้ารหัสข้อมูลส่วนบุคคล (NFR-04) ----------
// คีย์ทดสอบ (ไม่ใช่ความลับจริง) ตั้งทับได้ด้วย PII_KEY (hex 64 ตัว หรือข้อความใด ๆ)
function deriveKey(label) {
  const raw = process.env.PII_KEY || 'egov-eservice-test-pii-key';
  const base = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : crypto.createHash('sha256').update(raw).digest();
  return crypto.createHmac('sha256', base).update(label).digest();
}
const ENC_KEY = deriveKey('enc');
const IDX_KEY = deriveKey('idx');

/** AES-256-GCM → 'v1.<base64url(iv|tag|ciphertext)>' · null/'' → null */
function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1.' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
function decrypt(token) {
  if (!token) return null;
  const buf = Buffer.from(String(token).replace(/^v1\./, ''), 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}
/** blind index ของเลขบัตร (ตัดขีด/ช่องว่างก่อน) · base64url ไม่มีเลข 13 หลักติดกัน */
function idHash(idNo) {
  const digits = String(idNo || '').replace(/[^0-9]/g, '');
  return crypto.createHmac('sha256', IDX_KEY).update(digits).digest('base64url');
}

// ---------- reset ----------
const resetHooks = [];
function onReset(fn) { resetHooks.push(fn); }

function userTables() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
}

/** ล้างข้อมูลทุกตาราง (โครงสร้างยังอยู่) */
function wipeAll() {
  db.pragma('foreign_keys = OFF');
  try {
    tx(() => {
      db.prepare("INSERT INTO meta(key, value) VALUES('audit_purge','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
      db.prepare('DELETE FROM audit_log').run();
      for (const t of userTables()) db.prepare(`DELETE FROM "${t}"`).run();
      db.prepare("DELETE FROM sqlite_sequence").run();
    });
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/** โหลด seed ของ B02 (src/db/seed.js) ถ้ามี · รองรับ module.exports = fn หรือ { seed } */
function loadSeed() {
  const p = path.join(__dirname, 'seed.js');
  if (!fs.existsSync(p)) return null;
  const mod = require(p);
  return typeof mod === 'function' ? mod : mod.seed;
}

/** ล้าง + seed ใหม่ + เรียก onReset hooks · ไม่ยุ่งกับนาฬิกา (test.js เป็นคนตั้ง) */
function resetAndSeed() {
  wipeAll();
  const seed = loadSeed();
  if (seed) tx(() => seed(db, module.exports));
  else console.warn('[db] src/db/seed.js ยังไม่มี — ฐานข้อมูลว่าง');
  for (const fn of resetHooks) {
    try { fn(); } catch (e) { console.error('[db] reset hook error:', e); }
  }
}

/** ตอนเริ่มเซิร์ฟเวอร์: ถ้ายังไม่มีผู้ใช้เลย ให้ seed */
function ensureSeeded() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n === 0) resetAndSeed();
}

module.exports = {
  db, DB_PATH, tx,
  nextSeq, maxSuffix,
  encrypt, decrypt, idHash,
  onReset, wipeAll, resetAndSeed, ensureSeeded,
};
