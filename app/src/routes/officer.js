'use strict';
// officer.js · งานเจ้าหน้าที่/หัวหน้า (B07)
//   FR-12 คิว · FR-13 รับเรื่อง · FR-14 ตีกลับ · FR-15 ส่งต่ออัตโนมัติ · FR-16 อนุมัติ/ไม่อนุมัติ
//   FR-21 ปิดบังเลขบัตร + UNMASK · FR-29 สิทธิ์ไฟล์แนบ
//   BR-16 BR-17 BR-18 BR-19 BR-21 BR-24 BR-29 · CONTRACT §2.6 §2.7 §2.8 §6.2 §6.3 §6.7
//
// หน้า:  GET /officer/queue · GET /officer/cases/:caseNo · GET /head/approvals
// API:   GET  /api/officer/queue?filter=all|unclaimed|mine · GET /api/head/approvals
//        POST /api/officer/cases/:caseNo/claim|return|forward|unmask
//        POST /api/cases/:caseNo/approve|reject
//        GET  /api/cases/:caseNo (officer/head · มี fallback ของ citizen) · GET /api/cases/:caseNo/files · GET /api/files/:fileId
// (ออกเอกสาร POST /api/officer/cases/:caseNo/issue เป็นของ B08 · หน้านี้แค่แสดง issue-btn ให้ผู้ออกเอกสารตาม A-27)
//
// BUG_MODE ในไฟล์นี้ (BUGS.md · แต่ละตัวแก้จุดเดียว):
//   B07 เจ้าหน้าที่อนุมัติ SV-02/03 ผ่าน API ได้ (ปุ่มยังซ่อน) · B08 claim ข้ามการตรวจผู้ถือ
//   B09 API คิวส่ง idNo เต็ม · B11 unmask ไม่บันทึก Audit · (B12 อยู่ใน rules.canReturn)

const express = require('express');
const store = require('../db');
const clock = require('../lib/clock');
const rules = require('../lib/rules');
const mask = require('../lib/mask');
const C = require('../lib/constants');
const { isBug } = require('../lib/bugs');

const { db } = store;
const router = express.Router();

const STAFF = ['officer', 'head'];
const QUEUE_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'APPROVED'];
const CLAIMABLE = ['SUBMITTED', 'IN_REVIEW'];
const NO_CASE_ROLES = ['executive', 'auditor', 'admin'];

const EVENT_LABEL = {
  PAID: 'ชำระเงินและส่งคำขอ',
  SUBMIT: 'ส่งคำขอ',
  CLAIM: 'รับเรื่อง',
  RETURN: 'ตีกลับให้แก้ไขเอกสาร',
  RESUBMIT: 'ส่งแก้ไขเอกสารแล้ว',
  FORWARD: 'ผ่าน/ส่งต่อ',
  APPROVE: 'อนุมัติ',
  REJECT: 'ไม่อนุมัติ',
  ISSUE: 'ออกเอกสาร',
  CANCEL: 'ยกเลิกคำขอ',
  AUTO_CANCEL: 'ยกเลิกอัตโนมัติ (เกินเวลาแก้ไข)',
};

// =====================================================================
// ข้อมูล
// =====================================================================
const CASE_SELECT = `
  SELECT c.*, u.name AS applicant_name, u.id_enc AS applicant_id_enc, iu.dept AS issuer_dept
  FROM cases c
  JOIN users u ON u.id = c.applicant_id
  LEFT JOIN users iu ON iu.username = c.issuer`;

/** คำขอที่มีเลขแล้วเท่านั้น (ร่าง/รอชำระไม่ใช่ "คำขอ" สำหรับเจ้าหน้าที่) */
function loadCase(caseNo) {
  if (!caseNo || typeof caseNo !== 'string') return null;
  return db.prepare(`${CASE_SELECT} WHERE c.case_no = ?`).get(caseNo) || null;
}

function decryptId(enc) {
  try { return store.decrypt(enc) || ''; } catch (e) { return ''; }
}

function workloadOf(username) {
  return db.prepare("SELECT COUNT(*) AS n FROM cases WHERE status = 'IN_REVIEW' AND owner = ?").get(username).n;
}

/** แผนกที่คำขอแสดงในคิว · APPROVED (รอออกเอกสาร) อยู่คิวแผนกของผู้ออกเอกสาร (A-27 = ทะเบียน) */
function queueDept(c) {
  if (c.status === 'APPROVED') return c.dept || c.issuer_dept || 'registry';
  return c.dept || null;
}

function docOf(c) {
  return db.prepare('SELECT * FROM documents WHERE case_id = ? ORDER BY issued_at DESC, doc_no DESC LIMIT 1').get(c.id) || null;
}

function serviceText(id) {
  const s = C.SERVICES[id];
  return s ? `${id} ${s.name}` : String(id || '');
}

function nowISO() { return clock.nowISO(); }

function addAudit(user, event, caseNo, fromStatus, toStatus, detail) {
  db.prepare(`INSERT INTO audit_log(time, username, role, event, case_no, from_status, to_status, detail)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(nowISO(), user.username, user.role, event, caseNo || null, fromStatus || null, toStatus || null, detail || '');
}

function addEvent(c, actor, event, fromStatus, toStatus, note) {
  db.prepare(`INSERT INTO case_events(case_id, at, actor, event, from_status, to_status, note)
              VALUES(?, ?, ?, ?, ?, ?, ?)`)
    .run(c.id, nowISO(), actor, event, fromStatus || null, toStatus || null, note || '');
}

// =====================================================================
// สิทธิ์ (BR-21) — คืน null = ทำได้ · { status, code } = ไม่ได้
// =====================================================================
const deny = (status, code) => ({ status, code });

/** รับเรื่อง · ลำดับตรวจ: สิทธิ์ → ALREADY_CLAIMED → WORKLOAD_LIMIT (CONTRACT §6.3) */
function claimCheck(user, c, { bug = false, workload } = {}) {
  if (!user || user.role !== 'officer') return deny(403, 'FORBIDDEN');
  if (!CLAIMABLE.includes(c.status)) {
    if (c.dept && c.dept !== user.dept) return deny(403, 'FORBIDDEN');
    return deny(409, 'INVALID_STATE');
  }
  if (!c.dept || c.dept !== user.dept) return deny(403, 'FORBIDDEN');
  if (c.owner && !bug) return deny(409, 'ALREADY_CLAIMED');                 // B08: ข้ามการตรวจนี้
  const n = workload === undefined ? workloadOf(user.username) : workload;
  if (!rules.canClaim(n)) return deny(409, 'WORKLOAD_LIMIT');
  return null;
}

/** ผู้ถือเรื่อง (เจ้าหน้าที่) ที่ IN_REVIEW */
function holderCheck(user, c) {
  if (!user || user.role !== 'officer' || !c.owner || c.owner !== user.username) return deny(403, 'FORBIDDEN');
  if (c.status !== 'IN_REVIEW') return deny(409, 'INVALID_STATE');
  return null;
}

function returnCheck(user, c) {
  const d = holderCheck(user, c);
  if (d) return d;
  if (!rules.canReturn(c.return_count)) return deny(409, 'RETURN_LIMIT');   // B12 อยู่ใน rules
  return null;
}

function forwardCheck(user, c) {
  const d = holderCheck(user, c);
  if (d) return d;
  if (c.service_id === 'SV-01') return deny(409, 'INVALID_STATE');          // SV-01 ไม่มีขั้นถัดไป (อนุมัติเอง)
  return null;
}

/**
 * อนุมัติ/ไม่อนุมัติ · SV-01: ผู้ถือเรื่อง (เจ้าหน้าที่) ที่ IN_REVIEW · SV-02/03: head ที่ PENDING_APPROVAL
 * เจ้าหน้าที่ใช้กับ SV-02/03 → 403 · head ใช้กับ SV-01 → 403
 * bug (B07 เฉพาะ approve): เจ้าหน้าที่อนุมัติ SV-02/03 ได้เอง
 */
function decideCheck(user, c, { bug = false } = {}) {
  if (!user || !STAFF.includes(user.role)) return deny(403, 'FORBIDDEN');
  if (c.service_id === 'SV-01') {
    if (user.role !== 'officer' || c.owner !== user.username) return deny(403, 'FORBIDDEN');
    if (c.status !== 'IN_REVIEW') return deny(409, 'INVALID_STATE');
    return null;
  }
  if (user.role === 'head') {
    if (c.status !== 'PENDING_APPROVAL') return deny(409, 'INVALID_STATE');
    return null;
  }
  if (bug) {
    if (c.status === 'PENDING_APPROVAL' || c.status === 'IN_REVIEW') return null;
    return deny(409, 'INVALID_STATE');
  }
  return deny(403, 'FORBIDDEN');
}

/** ผู้ออกเอกสาร (A-27): เจ้าหน้าที่ทะเบียนที่รับขั้นแรก · แสดง issue-btn เมื่อ APPROVED */
function issuerOf(c) {
  return c.issuer || (c.service_id === 'SV-01' ? c.owner : null) || null;
}
function canIssue(user, c) {
  return !!user && user.role === 'officer' && c.status === 'APPROVED' && issuerOf(c) === user.username;
}

/**
 * สิทธิ์ไฟล์แนบ (BR-29 · FR-29): officer = แผนกตนเอง ขั้นปัจจุบันหรือเคยผ่าน · head ทุกแผนก
 * citizen เจ้าของ (คนอื่น 404) · executive/auditor/admin 403
 * คืน null = ได้ · { status, code }
 */
function fileAccess(user, c) {
  if (!user) return deny(401, 'UNAUTHENTICATED');
  if (user.role === 'citizen') {
    if (!c || c.applicant_id !== user.id) return deny(404, 'NOT_FOUND');
    return null;
  }
  if (NO_CASE_ROLES.includes(user.role)) return deny(403, 'FORBIDDEN');
  if (!c || !c.case_no) return deny(404, 'NOT_FOUND');
  if (user.role === 'head') return null;
  if (user.role !== 'officer') return deny(403, 'FORBIDDEN');
  if (user.dept === 'registry') return null;                          // ทุกคำขอเริ่มที่ทะเบียน (ขั้นปัจจุบัน/เคยผ่าน)
  if (user.dept === 'works') {
    const passedWorks = c.service_id === 'SV-03' && (c.dept === 'works' || Number(c.step) >= 2);
    return passedWorks ? null : deny(403, 'FORBIDDEN');
  }
  return deny(403, 'FORBIDDEN');
}

// =====================================================================
// แปลงเป็น JSON / แถว (ห้ามมีเลขบัตรเต็มสำหรับเจ้าหน้าที่ · BR-24)
// =====================================================================
function slaOf(c, holidays) { return rules.slaLevel(c, undefined, holidays) || null; }

function queueItem(c, holidays) {
  const idNo = decryptId(c.applicant_id_enc);
  const item = {
    caseNo: c.case_no,
    serviceId: c.service_id,
    applicantName: c.applicant_name,
    idMasked: mask.maskId(idNo),
    status: c.status,
    step: c.service_id === 'SV-03' ? (c.step || null) : null,
    owner: c.owner || null,
    dueAt: c.due_at || null,
    slaLevel: slaOf(c, holidays),
  };
  if (isBug('B09')) item.idNo = mask.digits(idNo);                         // B09: รั่วเลขเต็มใน API (จอยังปิดบัง)
  return item;
}

/** CONTRACT §6.7 · full = ประชาชนเจ้าของ (ได้ idNo แทน idMasked) */
function caseJson(c, { full = false } = {}) {
  const doc = docOf(c);
  const idNo = decryptId(c.applicant_id_enc);
  const out = {
    caseNo: c.case_no,
    serviceId: c.service_id,
    status: c.status,
    step: c.service_id === 'SV-03' ? (c.step || null) : null,
    fee: c.fee,
    paidAt: c.paid_at || null,
    dueAt: c.due_at || null,
    slaLevel: slaOf(c),
    owner: c.owner || null,
    returnCount: c.return_count || 0,
    closedAt: c.closed_at || null,
    applicantName: c.applicant_name,
  };
  if (full) out.idNo = mask.digits(idNo);
  else out.idMasked = mask.maskId(idNo);
  out.fixDeadline = c.status === 'NEED_FIX' ? (c.fix_deadline || (c.returned_at ? rules.fixDeadline(c.returned_at) : null)) : null;
  out.docNo = doc ? doc.doc_no : null;
  out.verifyCode = doc ? doc.verify_code : null;
  return out;
}

function staffQueueRows(user, filter) {
  const rows = db.prepare(`${CASE_SELECT} WHERE c.case_no IS NOT NULL AND c.status IN (${QUEUE_STATUSES.map(() => '?').join(',')})`)
    .all(...QUEUE_STATUSES);
  const scoped = user.role === 'head' ? rows : rows.filter((c) => queueDept(c) === user.dept);
  const sorted = rules.sortQueue(scoped);
  return sorted.filter((c) => matchFilter(c, user, filter));
}

function normFilter(f) { return ['all', 'unclaimed', 'mine'].includes(f) ? f : 'all'; }

function matchFilter(c, user, filter) {
  if (filter === 'unclaimed') return CLAIMABLE.includes(c.status) && !c.owner;
  if (filter === 'mine') return c.status === 'IN_REVIEW' && !!c.owner && c.owner === user.username;
  return true;
}

function approvalRows() {
  return rules.sortQueue(db.prepare(`${CASE_SELECT} WHERE c.case_no IS NOT NULL AND c.status = 'PENDING_APPROVAL'`).all());
}

// =====================================================================
// helper ของ route
// =====================================================================
/** API ของเจ้าหน้าที่/หัวหน้า: 401 ยังไม่ล็อกอิน · 403 บทบาทอื่น */
function apiStaff(req, res, next) {
  if (!req.user) return res.apiError(401, 'UNAUTHENTICATED');
  if (!STAFF.includes(req.user.role)) return res.apiError(403, 'FORBIDDEN');
  next();
}
function pageRoles(roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (!roles.includes(req.user.role)) return res.forbidden();
    next();
  };
}
function sendDeny(res, d) { return res.apiError(d.status, d.code); }

function baseUrl(req) {
  const env = (process.env.BASE_URL || '').trim().replace(/\/+$/, '');
  return env || `${req.protocol}://${req.get('host')}`;
}

// =====================================================================
// หน้า
// =====================================================================
router.get('/officer/queue', pageRoles(STAFF), (req, res) => {
  const user = req.user;
  const filter = normFilter(String(req.query.filter || 'all'));
  const holidays = rules.loadHolidays();
  const all = staffQueueRows(user, 'all');
  const workload = user.role === 'officer' ? workloadOf(user.username) : null;
  const rows = all.map((c) => ({
    c,
    item: queueItem(c, holidays),
    canClaim: user.role === 'officer' && !claimCheck(user, c, { workload: 0 }),   // ปุ่มแสดงตามสิทธิ์ · เพดานตรวจตอนกด
    unclaimed: matchFilter(c, user, 'unclaimed'),
    mine: matchFilter(c, user, 'mine'),
  }));
  res.render('officer/queue', {
    title: 'คิวงาน',
    filter,
    rows,
    workload,
    isOfficer: user.role === 'officer',
    serviceText,
  });
});

router.get('/officer/cases/:caseNo', pageRoles(STAFF), async (req, res, next) => {
  try {
    const user = req.user;
    const c = loadCase(req.params.caseNo);
    if (!c) return res.notFound();
    const doc = docOf(c);
    let qrDataUrl = null;
    let verifyUrl = null;
    if (doc) {
      verifyUrl = `${baseUrl(req)}/verify/${doc.verify_code}`;
      try { qrDataUrl = await require('qrcode').toDataURL(verifyUrl, { margin: 1, width: 160 }); } catch (e) { qrDataUrl = null; }
    }
    const files = fileAccess(user, c) ? [] : db.prepare('SELECT id, name, doc_key, size FROM files WHERE case_id = ? ORDER BY uploaded_at, id').all(c.id);
    const events = db.prepare('SELECT * FROM case_events WHERE case_id = ? ORDER BY at, id').all(c.id);
    const timeline = [];
    if (c.paid_at && !events.some((e) => e.event === 'PAID' || e.event === 'SUBMIT')) {
      timeline.push({ at: c.paid_at, label: EVENT_LABEL.PAID, actor: '', note: '' });
    }
    for (const e of events) {
      timeline.push({
        at: e.at,
        label: EVENT_LABEL[e.event] || e.event,
        actor: e.actor && e.actor !== 'citizen' && e.actor !== 'system' ? e.actor : (e.actor === 'system' ? 'ระบบ' : (e.actor === 'citizen' ? 'ผู้ยื่น' : '')),
        note: e.note || '',
      });
    }
    timeline.sort((a, b) => clock.toMs(a.at) - clock.toMs(b.at));

    const level = slaOf(c);
    res.render('officer/case', {
      title: `คำขอ ${c.case_no}`,
      c,
      serviceText: serviceText(c.service_id),
      idMasked: mask.maskId(decryptId(c.applicant_id_enc)),
      level,
      doc,
      verifyUrl,
      qrDataUrl,
      files,
      timeline,
      can: {
        claim: user.role === 'officer' && !claimCheck(user, c, { workload: 0 }),
        ret: !returnCheck(user, c),
        forward: !forwardCheck(user, c),
        approve: !decideCheck(user, c),
        reject: !decideCheck(user, c),
        issue: canIssue(user, c),
        unmask: STAFF.includes(user.role),
      },
      stepLabel: c.service_id === 'SV-03' && c.step ? C.STEP_LABEL[c.step] : null,
    });
  } catch (e) { next(e); }
});

router.get('/head/approvals', pageRoles(['head']), (req, res) => {
  res.render('head/approvals', {
    title: 'รายการรออนุมัติ',
    rows: approvalRows(),
    serviceText,
    rules,
  });
});

// =====================================================================
// API คิว
// =====================================================================
router.get('/api/officer/queue', apiStaff, (req, res) => {
  const filter = normFilter(String(req.query.filter || 'all'));
  const holidays = rules.loadHolidays();
  const items = staffQueueRows(req.user, filter).map((c) => queueItem(c, holidays));
  const out = { items };
  if (req.user.role === 'officer') out.workload = workloadOf(req.user.username);
  res.json(out);
});

router.get('/api/head/approvals', (req, res) => {
  if (!req.user) return res.apiError(401, 'UNAUTHENTICATED');
  if (req.user.role !== 'head') return res.apiError(403, 'FORBIDDEN');
  const holidays = rules.loadHolidays();
  res.json({ items: approvalRows().map((c) => queueItem(c, holidays)) });
});

// =====================================================================
// API การกระทำ (ทุกอันทำใน transaction เดียว → ไม่มี race ภายใน process)
// =====================================================================
/** หา case + ตรวจ 401/403 บทบาท + 404 · คืน c หรือ null (ส่ง response แล้ว) */
function caseForAction(req, res, roles = STAFF) {
  if (!req.user) { res.apiError(401, 'UNAUTHENTICATED'); return null; }
  if (!roles.includes(req.user.role)) { res.apiError(403, 'FORBIDDEN'); return null; }
  const c = loadCase(req.params.caseNo);
  if (!c) { res.apiError(404, 'NOT_FOUND'); return null; }
  return c;
}

// ---------- รับเรื่อง (FR-13 · BR-17 BR-18) ----------
router.post('/api/officer/cases/:caseNo/claim', (req, res) => {
  if (!req.user) return res.apiError(401, 'UNAUTHENTICATED');
  if (!STAFF.includes(req.user.role)) return res.apiError(403, 'FORBIDDEN');
  const user = req.user;
  const result = store.tx(() => {
    const c = loadCase(req.params.caseNo);
    if (!c) return deny(404, 'NOT_FOUND');
    const d = claimCheck(user, c, { bug: isBug('B08') });
    if (d) return d;
    const from = c.status;
    const issuer = c.issuer || (user.dept === 'registry' ? user.username : null);  // A-27
    db.prepare(`UPDATE cases SET status = 'IN_REVIEW', owner = ?, issuer = ?, updated_at = ? WHERE id = ?`)
      .run(user.username, issuer, nowISO(), c.id);
    addEvent(c, user.username, 'CLAIM', from, 'IN_REVIEW', '');
    addAudit(user, 'CLAIM', c.case_no, from, 'IN_REVIEW', '');
    return { ok: true, owner: user.username };
  });
  if (!result.ok) return sendDeny(res, result);
  res.json({ owner: result.owner });
});

// ---------- ตีกลับ (FR-14 · BR-19) ----------
router.post('/api/officer/cases/:caseNo/return', (req, res) => {
  const c0 = caseForAction(req, res);
  if (!c0) return;
  const user = req.user;
  const reason = String((req.body && req.body.reason) ?? '');
  const result = store.tx(() => {
    const c = loadCase(req.params.caseNo);
    const d = returnCheck(user, c);
    if (d) return d;
    if (rules.reasonError(reason)) return deny(400, 'REASON_TOO_SHORT');
    const text = reason.trim();
    const at = nowISO();
    const n = (c.return_count || 0) + 1;
    db.prepare(`UPDATE cases SET status = 'NEED_FIX', return_count = ?, returned_at = ?, fix_deadline = ?, return_reason = ?, updated_at = ?
                WHERE id = ?`)
      .run(n, at, rules.fixDeadline(at), text, at, c.id);
    db.prepare('INSERT INTO case_returns(case_id, n, returned_at, returned_by, reason) VALUES(?, ?, ?, ?, ?)')
      .run(c.id, n, at, user.username, text);
    addEvent(c, user.username, 'RETURN', 'IN_REVIEW', 'NEED_FIX', text);
    addAudit(user, 'RETURN', c.case_no, 'IN_REVIEW', 'NEED_FIX', text);
    return { ok: true, returnCount: n, fixDeadline: rules.fixDeadline(at) };
  });
  if (!result.ok) return sendDeny(res, result);
  res.json({ status: 'NEED_FIX', returnCount: result.returnCount, fixDeadline: result.fixDeadline });
});

// ---------- ส่งต่ออัตโนมัติ (FR-15 · BR-21) ----------
//   SV-02: ทะเบียน → หัวหน้า (PENDING_APPROVAL)
//   SV-03: ทะเบียน (1) → โยธา (2 · คิวโยธา ไม่มีผู้รับ) → หัวหน้า (3 · PENDING_APPROVAL)
router.post('/api/officer/cases/:caseNo/forward', (req, res) => {
  const c0 = caseForAction(req, res);
  if (!c0) return;
  const user = req.user;
  const note = String((req.body && req.body.note) ?? '').trim();
  const result = store.tx(() => {
    const c = loadCase(req.params.caseNo);
    const d = forwardCheck(user, c);
    if (d) return d;
    const at = nowISO();
    const issuer = c.issuer || (c.dept === 'registry' ? c.owner : null);
    let to;
    let step = c.step;
    let dept;
    if (c.service_id === 'SV-03' && (Number(c.step) || 1) === 1) {
      to = 'IN_REVIEW'; step = 2; dept = 'works';
    } else {
      to = 'PENDING_APPROVAL'; dept = null;
      if (c.service_id === 'SV-03') step = 3;
    }
    db.prepare('UPDATE cases SET status = ?, step = ?, dept = ?, owner = NULL, issuer = ?, updated_at = ? WHERE id = ?')
      .run(to, c.service_id === 'SV-03' ? step : null, dept, issuer, at, c.id);
    addEvent(c, user.username, 'FORWARD', 'IN_REVIEW', to, note);
    addAudit(user, 'FORWARD', c.case_no, 'IN_REVIEW', to, note);
    return { ok: true, status: to, step: c.service_id === 'SV-03' ? step : null };
  });
  if (!result.ok) return sendDeny(res, result);
  if (result.status === 'IN_REVIEW') return res.json({ status: 'IN_REVIEW', step: result.step });
  const out = { status: 'PENDING_APPROVAL' };
  if (result.step) out.step = result.step;
  res.json(out);
});

// ---------- อนุมัติ / ไม่อนุมัติ (FR-16 · BR-19 BR-21) ----------
router.post('/api/cases/:caseNo/approve', (req, res) => {
  const c0 = caseForAction(req, res);
  if (!c0) return;
  const user = req.user;
  const result = store.tx(() => {
    const c = loadCase(req.params.caseNo);
    const d = decideCheck(user, c, { bug: isBug('B07') });                 // B07: เจ้าหน้าที่อนุมัติ SV-02/03 ได้
    if (d) return d;
    const at = nowISO();
    const from = c.status;
    const issuer = c.issuer || (c.service_id === 'SV-01' ? c.owner : (c.dept === 'registry' ? c.owner : null));
    db.prepare(`UPDATE cases SET status = 'APPROVED', approved_by = ?, approved_at = ?, issuer = ?, updated_at = ? WHERE id = ?`)
      .run(user.username, at, issuer, at, c.id);
    addEvent(c, user.username, 'APPROVE', from, 'APPROVED', '');
    addAudit(user, 'APPROVE', c.case_no, from, 'APPROVED', '');
    return { ok: true };
  });
  if (!result.ok) return sendDeny(res, result);
  res.json({ status: 'APPROVED' });
});

router.post('/api/cases/:caseNo/reject', (req, res) => {
  const c0 = caseForAction(req, res);
  if (!c0) return;
  const user = req.user;
  const reason = String((req.body && req.body.reason) ?? '');
  const result = store.tx(() => {
    const c = loadCase(req.params.caseNo);
    const d = decideCheck(user, c);
    if (d) return d;
    if (rules.reasonError(reason)) return deny(400, 'REASON_TOO_SHORT');
    const text = reason.trim();
    const at = nowISO();
    const from = c.status;
    db.prepare(`UPDATE cases SET status = 'REJECTED', reject_reason = ?, closed_at = ?, updated_at = ? WHERE id = ?`)
      .run(text, at, at, c.id);
    addEvent(c, user.username, 'REJECT', from, 'REJECTED', text);
    addAudit(user, 'REJECT', c.case_no, from, 'REJECTED', text);
    return { ok: true, closedAt: at };
  });
  if (!result.ok) return sendDeny(res, result);
  res.json({ status: 'REJECTED', closedAt: result.closedAt });
});

// ---------- แสดงเลขเต็ม (FR-21 · BR-24) ----------
router.post('/api/officer/cases/:caseNo/unmask', (req, res) => {
  const c = caseForAction(req, res);
  if (!c) return;
  const reason = String((req.body && req.body.reason) ?? '').trim();
  if (!reason) return res.apiError(400, 'REASON_REQUIRED');
  const idNo = mask.digits(decryptId(c.applicant_id_enc));
  if (!isBug('B11')) addAudit(req.user, 'UNMASK', c.case_no, null, null, reason);  // B11: ไม่บันทึก
  res.json({ idNo });
});

// =====================================================================
// รายละเอียดคำขอ (CONTRACT §6.7) · officer/head ได้เฉพาะ idMasked
// (ถ้า citizen-cases.js ของ B06 ตอบ citizen ไปก่อนแล้ว ส่วน citizen ด้านล่างเป็นแค่ fallback)
// =====================================================================
router.get('/api/cases/:caseNo', (req, res) => {
  const user = req.user;
  if (!user) return res.apiError(401, 'UNAUTHENTICATED');
  if (NO_CASE_ROLES.includes(user.role)) return res.apiError(403, 'FORBIDDEN');
  const c = loadCase(req.params.caseNo);
  if (user.role === 'citizen') {
    if (!c || (c.applicant_id !== user.id && !isBug('B06'))) return res.apiError(404, 'NOT_FOUND');
    return res.json(caseJson(c, { full: c.applicant_id === user.id }));
  }
  if (!STAFF.includes(user.role)) return res.apiError(403, 'FORBIDDEN');
  if (!c) return res.apiError(404, 'NOT_FOUND');
  res.json(caseJson(c));
});

// =====================================================================
// ไฟล์แนบ (FR-29 · BR-29)
// =====================================================================
router.get('/api/cases/:caseNo/files', (req, res) => {
  const user = req.user;
  if (!user) return res.apiError(401, 'UNAUTHENTICATED');
  if (NO_CASE_ROLES.includes(user.role)) return res.apiError(403, 'FORBIDDEN');
  const c = loadCase(req.params.caseNo);
  const d = fileAccess(user, c);
  if (d) return sendDeny(res, d);
  const items = db.prepare('SELECT id AS fileId, name, doc_key AS docKey, size FROM files WHERE case_id = ? ORDER BY uploaded_at, id').all(c.id);
  res.json({ items });
});

router.get('/api/files/:fileId', (req, res) => {
  const user = req.user;
  if (!user) return res.apiError(401, 'UNAUTHENTICATED');
  if (NO_CASE_ROLES.includes(user.role)) return res.apiError(403, 'FORBIDDEN');
  const f = db.prepare('SELECT * FROM files WHERE id = ?').get(String(req.params.fileId));
  if (!f) return res.apiError(404, 'NOT_FOUND', 'ไม่พบไฟล์');
  const c = db.prepare(`${CASE_SELECT} WHERE c.id = ?`).get(f.case_id);
  // ไฟล์ของร่างตัวเอง (ยังไม่มีเลขคำขอ) ประชาชนเจ้าของเปิดได้ · เจ้าหน้าที่ไม่เห็นร่าง
  const d = fileAccess(user, c && (c.case_no || user.role === 'citizen') ? c : null);
  if (d) return sendDeny(res, d.status === 404 ? { status: 404, code: 'NOT_FOUND' } : d);
  const buf = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content || '');
  res.set('Content-Type', f.mime || 'application/octet-stream');
  res.set('Content-Length', String(buf.length));
  res.set('Content-Disposition', `inline; filename="${String(f.name).replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(buf);
});

module.exports = router;
// สำหรับ unit test / บล็อกอื่นที่อยากใช้กฎสิทธิ์เดียวกัน
module.exports.helpers = { claimCheck, returnCheck, forwardCheck, decideCheck, fileAccess, canIssue, queueDept, caseJson, queueItem };
