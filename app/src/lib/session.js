'use strict';
// session.js · session cookie (HttpOnly) เก็บในตาราง sessions (B01)
//
//   const session = require('../lib/session');
//   session.create(res, user, { registered: 1 })   // หลังล็อกอินสำเร็จ → ตั้ง cookie 'sid'
//   session.destroy(req, res)                       // ออกจากระบบ
//   req.user   → { id, role, dept, username, name, registered, sid } หรือ null (ตั้งโดย middleware)
//   session.hashPassword('Test@1234') / session.verifyPassword(pw, hash)
//
// role/dept ใน session เป็น snapshot ตอนล็อกอิน (admin เปลี่ยนบทบาท → มีผลกับล็อกอินครั้งถัดไป)
// POST /api/test/reset ลบทุกแถวใน sessions → cookie เก่าใช้ไม่ได้ทันที

const crypto = require('crypto');
const { db } = require('../db');
const clock = require('./clock');

const COOKIE = 'sid';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function cookieHeader(value, { clear = false } = {}) {
  const parts = [`${COOKIE}=${clear ? '' : value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (clear) parts.push('Max-Age=0');
  if (process.env.COOKIE_SECURE === '1') parts.push('Secure');
  return parts.join('; ');
}

function appendSetCookie(res, value) {
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  res.setHeader('Set-Cookie', [...list.filter((c) => !c.startsWith(COOKIE + '=')), value]);
}

/**
 * สร้าง session ใหม่ให้ user (แถวจากตาราง users) แล้วตั้ง cookie
 * opts.registered: 0 = ประชาชนที่ยังไม่ลงทะเบียน (เข้าได้เฉพาะ /register) · ค่าเริ่มต้นจาก user.registered
 * คืน sid
 */
function create(res, user, opts = {}) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const registered = opts.registered !== undefined ? (opts.registered ? 1 : 0) : (user.registered ? 1 : 0);
  db.prepare(`INSERT INTO sessions(sid, user_id, role, dept, registered, data, created_at)
              VALUES(?, ?, ?, ?, ?, ?, ?)`)
    .run(sid, user.id, user.role, user.dept || '', registered, JSON.stringify(opts.data || {}), clock.nowISO());
  appendSetCookie(res, cookieHeader(sid));
  return sid;
}

/** ลบ session ปัจจุบัน + ล้าง cookie */
function destroy(req, res) {
  const sid = req.sessionId || parseCookies(req.headers.cookie)[COOKIE];
  if (sid) db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
  appendSetCookie(res, cookieHeader('', { clear: true }));
  req.user = null;
  req.sessionId = null;
}

/** อัปเดตค่า session (เช่น registered = 1 หลังลงทะเบียน) */
function update(req, fields) {
  if (!req.sessionId) return;
  const allowed = ['role', 'dept', 'registered', 'data'];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    db.prepare(`UPDATE sessions SET ${k} = ? WHERE sid = ?`).run(k === 'data' ? JSON.stringify(v) : v, req.sessionId);
  }
}

/** ลบ session ทั้งหมด (reset) */
function clearAll() { db.prepare('DELETE FROM sessions').run(); }

/** middleware: อ่าน cookie → req.user / res.locals.user */
function middleware(req, res, next) {
  req.user = null;
  req.sessionId = null;
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  if (sid) {
    const row = db.prepare(`SELECT s.sid, s.role, s.dept, s.registered, s.data, u.id, u.username, u.name, u.active
                            FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.sid = ?`).get(sid);
    if (row && row.active) {
      let data = {};
      try { data = JSON.parse(row.data || '{}'); } catch { /* ignore */ }
      req.sessionId = row.sid;
      req.user = {
        id: row.id,
        sid: row.sid,
        role: row.role,
        dept: row.dept || '',
        username: row.username || null,
        name: row.name,
        registered: !!row.registered,
        data,
      };
    }
  }
  res.locals.user = req.user;
  next();
}

// ---------- รหัสผ่าน (scrypt) ----------
const SCRYPT = { N: 4096, r: 8, p: 1 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}
function verifyPassword(pw, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [algo, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const got = crypto.scryptSync(String(pw), Buffer.from(saltB64, 'base64url'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, got);
}

module.exports = {
  COOKIE, middleware, create, destroy, update, clearAll, parseCookies,
  hashPassword, verifyPassword,
};
