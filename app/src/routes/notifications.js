'use strict';
// notifications.js · กระดิ่งแจ้งเตือน SLA (CONTRACT §2.12 · §6.3) — แจ้งเตือนสร้างโดย lib/sla-jobs.js (B09) ทุก request
//   GET /notifications       officer · head  → noti-item / noti-empty
//   GET /api/notifications   officer · head  → {items:[{id,caseNo,level,text,createdAt}]} ของผู้ใช้นั้นเท่านั้น
const express = require('express');
const { db } = require('../db');
const clock = require('../lib/clock');

const router = express.Router();
const ROLES = ['officer', 'head'];
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function items(username) {
  return db.prepare('SELECT id,case_no,level,text,created_at FROM notifications WHERE username=? ORDER BY created_at DESC,id DESC')
    .all(username)
    .map((n) => ({ id: n.id, caseNo: n.case_no, level: n.level, text: n.text, createdAt: n.created_at }));
}

router.get('/api/notifications', (req, res) => {
  if (!req.user) return res.apiError(401, 'UNAUTHENTICATED');
  if (!ROLES.includes(req.user.role)) return res.apiError(403, 'FORBIDDEN');
  res.json({ items: items(req.user.username) });
});

router.get('/notifications', (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (!ROLES.includes(req.user.role)) return res.forbidden();
  const list = items(req.user.username);
  const body = list.length
    ? `<ul class="noti-list">${list.map((n) => `<li data-testid="noti-item" data-case-no="${esc(n.caseNo)}" data-level="${esc(n.level)}" class="noti-${esc(n.level)}"><a href="/officer/cases/${encodeURIComponent(n.caseNo)}">${esc(n.text)}</a> · <time data-iso="${esc(n.createdAt)}">${esc(clock.formatThai(n.createdAt))}</time></li>`).join('')}</ul>`
    : '<p data-testid="noti-empty">ไม่มีแจ้งเตือน</p>';
  res.render('layout', { layout: false, title: 'แจ้งเตือน', body: `<h1>แจ้งเตือน</h1><section class="card">${body}</section>` });
});

module.exports = router;
