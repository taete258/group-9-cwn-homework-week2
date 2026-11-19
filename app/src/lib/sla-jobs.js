'use strict';

// งานที่ต้องประเมินทุก request ปกติ (เรียกจาก middleware ใน server.js)
const { db } = require('../db');
const clock = require('./clock');
const rules = require('./rules');

function tick() {
  const now = clock.nowISO();

  // BR-20: ครบ 168 ชั่วโมงพอดีก็ปิดคำขอที่รอแก้ไขโดยอัตโนมัติ
  const expired = db.prepare(`SELECT id, case_no, returned_at FROM cases
    WHERE status='NEED_FIX' AND returned_at IS NOT NULL`).all()
    .filter((row) => rules.fixWindowExpired(row.returned_at, now));
  const cancel = db.prepare(`UPDATE cases SET status='CANCELLED', cancelled_at=?, updated_at=?
    WHERE id=? AND status='NEED_FIX'`);
  const event = db.prepare(`INSERT INTO case_events(case_id,at,actor,event,from_status,to_status,note)
    VALUES(?,?,'system','AUTO_CANCEL','NEED_FIX','CANCELLED','หมดเวลาแก้ไข 168 ชั่วโมง')`);
  for (const row of expired) {
    const result = cancel.run(now, now, row.id);
    if (result.changes) event.run(row.id, now);
  }

  const cases = db.prepare(`SELECT id, case_no AS caseNo, status, due_at AS dueAt,
      dept, owner, issuer
    FROM cases
    WHERE case_no IS NOT NULL
      AND status IN ('SUBMITTED','IN_REVIEW','PENDING_APPROVAL','APPROVED')`).all();
  const officersInDept = db.prepare("SELECT username FROM users WHERE role='officer' AND active=1 AND dept=?");
  const add = db.prepare(`INSERT OR IGNORE INTO notifications(username,case_no,level,text,created_at)
    VALUES(?,?,?,?,?)`);

  for (const c of cases) {
    const level = rules.notifyLevel(c, now);
    if (!level) continue;
    const recipients = new Set();
    if (c.status === 'PENDING_APPROVAL') {
      db.prepare("SELECT username FROM users WHERE role='head' AND active=1").all()
        .forEach((u) => recipients.add(u.username));
    } else if (c.status === 'APPROVED') {
      if (c.issuer) recipients.add(c.issuer);
    } else if (c.owner) {
      recipients.add(c.owner);
    } else if (c.dept) {
      officersInDept.all(c.dept).forEach((u) => recipients.add(u.username));
    }

    if (level === 'overdue') {
      db.prepare("SELECT username FROM users WHERE role='head' AND active=1").all()
        .forEach((u) => recipients.add(u.username));
    }
    const thaiLevel = level === 'near' ? 'ใกล้ครบกำหนด' : 'เกินกำหนด';
    const message = `คำขอ ${c.caseNo} ${thaiLevel}`;
    for (const username of recipients) add.run(username, c.caseNo, level, message, now);
  }
}

module.exports = { tick };
