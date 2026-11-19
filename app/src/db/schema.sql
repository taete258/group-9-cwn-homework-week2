-- schema.sql · e-Service กลาง (B01)
-- กติกา:
--   * เวลาทุกคอลัมน์เก็บเป็น TEXT ISO 8601 +07:00 เช่น '2026-12-01T09:00:00+07:00' (ใช้ clock.toISO)
--     ห้ามเก็บ epoch ms (13 หลัก) — TC-NFR-04 ค้นหาเลข 13 หลักในไฟล์ DB
--   * วันที่ล้วนเก็บ 'YYYY-MM-DD' (ค.ศ.)
--   * เลขบัตร/เบอร์โทรเก็บเข้ารหัสเท่านั้น (db.encrypt) + blind index (db.idHash) สำหรับค้นหา
--   * ทุกตารางถูกล้างโดย POST /api/test/reset แล้ว seed ใหม่ (src/db/seed.js)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ตัวนับลำดับเลข (DR-xxxx, PP-xxxx, EG-<พ.ศ.>-xxxxxx, DOC-<พ.ศ.>-xxxxxx) ใช้ผ่าน db.nextSeq()
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,           -- เช่น 'draft' 'payment' 'case:2569' 'doc:2569'
  value INTEGER NOT NULL DEFAULT 0  -- ค่าล่าสุดที่ออกไปแล้ว
);

-- ผู้ใช้ทุกบทบาท (ประชาชน + เจ้าหน้าที่)
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  role          TEXT NOT NULL CHECK (role IN ('citizen','officer','head','executive','auditor','admin')),
  username      TEXT UNIQUE,                 -- เจ้าหน้าที่: off.reg1 ... · ประชาชน: NULL
  password_hash TEXT,                        -- session.hashPassword()
  name          TEXT NOT NULL,               -- ชื่อแสดง / ชื่อ-สกุลจาก ThaiD
  dept          TEXT NOT NULL DEFAULT '',    -- 'registry' | 'works' | ''
  id_hash       TEXT UNIQUE,                 -- ประชาชน: db.idHash(idNo) ใช้ค้นหา
  id_enc        TEXT,                        -- ประชาชน: db.encrypt(idNo) 13 หลักไม่มีขีด
  mobile_enc    TEXT,                        -- db.encrypt(<เบอร์มือถือ>) หรือ NULL
  email         TEXT NOT NULL DEFAULT '',
  registered    INTEGER NOT NULL DEFAULT 0,  -- ประชาชน: 1 = ลงทะเบียนแล้ว · เจ้าหน้าที่: 1
  consent_at    TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

-- session cookie 'sid' (src/lib/session.js) · role/dept เป็นค่า snapshot ตอนล็อกอิน
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  dept       TEXT NOT NULL DEFAULT '',
  registered INTEGER NOT NULL DEFAULT 1,     -- 0 = ประชาชนที่ยังต้องไป /register
  data       TEXT NOT NULL DEFAULT '{}',     -- JSON อิสระของ session
  created_at TEXT NOT NULL
);

-- ตัวนับ OTP ผิด / ล็อกเลขบัตร (BR-02)
CREATE TABLE IF NOT EXISTS otp_state (
  id_hash      TEXT PRIMARY KEY,             -- db.idHash(idNo)
  fail_count   INTEGER NOT NULL DEFAULT 0,
  last_fail_at TEXT,
  locked_until TEXT
);

-- บริการ (ผู้ดูแลแก้ fee/sla ได้)
CREATE TABLE IF NOT EXISTS services (
  id          TEXT PRIMARY KEY,              -- 'SV-01' 'SV-02' 'SV-03'
  name        TEXT NOT NULL,
  fee         INTEGER NOT NULL,              -- SV-01 ต่อฉบับ · SV-02 คงที่ · SV-03 feeBase
  fee_per_sqm INTEGER NOT NULL DEFAULT 0,    -- SV-03 เท่านั้น (10)
  sla         INTEGER NOT NULL,              -- วันทำการ
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS holidays (
  date TEXT PRIMARY KEY,                     -- 'YYYY-MM-DD'
  name TEXT NOT NULL
);

-- ร่าง + คำขอ อยู่ตารางเดียว: ร่างมี draft_id ไม่มี case_no · ชำระแล้วได้ case_no
CREATE TABLE IF NOT EXISTS cases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id      TEXT UNIQUE,                 -- 'DR-0001' (คำขอ seed ที่ชำระแล้วอาจเป็น NULL)
  case_no       TEXT UNIQUE,                 -- 'EG-2569-000031' หลังชำระ
  receipt_no    TEXT UNIQUE,                 -- 'RC-2569-000031'
  service_id    TEXT NOT NULL REFERENCES services(id),
  applicant_id  INTEGER NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL CHECK (status IN ('DRAFT','PENDING_PAYMENT','SUBMITTED','IN_REVIEW','NEED_FIX',
                                                'PENDING_APPROVAL','APPROVED','COMPLETED','REJECTED','CANCELLED')),
  qty           INTEGER,                     -- SV-01 จำนวนฉบับ
  area_sqm      INTEGER,                     -- SV-03 พื้นที่
  fee           INTEGER,                     -- ยอดที่ล็อกตอนเข้า PENDING_PAYMENT (A-42)
  step          INTEGER,                     -- SV-03: 1 ทะเบียน · 2 โยธา · 3 หัวหน้า · อื่น ๆ NULL
  dept          TEXT,                        -- แผนกที่ถือเรื่องตอนนี้ 'registry' | 'works' | NULL (ขั้นหัวหน้า/ปิด)
  owner         TEXT,                        -- username ผู้ถือเรื่องตอนนี้ (NULL = ยังไม่มีผู้รับ)
  issuer        TEXT,                        -- username ผู้ออกเอกสาร (A-27: เจ้าหน้าที่ทะเบียนที่รับขั้นแรก)
  approved_by   TEXT,                        -- username ผู้อนุมัติ (= ผู้ลงนาม)
  approved_at   TEXT,
  return_count  INTEGER NOT NULL DEFAULT 0,
  returned_at   TEXT,                        -- เวลาตีกลับล่าสุด
  fix_deadline  TEXT,                        -- returned_at + 168 ชม. (เมื่อ NEED_FIX)
  return_reason TEXT,                        -- เหตุผลตีกลับล่าสุด
  reject_reason TEXT,
  paid_at       TEXT,
  due_at        TEXT,                        -- กำหนดเสร็จที่เก็บ (seed = ค่าตายตัว A-35)
  closed_at     TEXT,                        -- COMPLETED / REJECTED
  cancelled_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cases_applicant ON cases(applicant_id);
CREATE INDEX IF NOT EXISTS idx_cases_status    ON cases(status);

-- ประวัติตีกลับ/ส่งแก้ (ใช้คำนวณหยุดนับ SLA)
CREATE TABLE IF NOT EXISTS case_returns (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id        INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  n              INTEGER NOT NULL,           -- ครั้งที่ 1, 2
  returned_at    TEXT NOT NULL,
  returned_by    TEXT,
  reason         TEXT NOT NULL,
  resubmitted_at TEXT,
  paused_days    INTEGER
);

-- ไทม์ไลน์ของคำขอ (case-timeline / timeline-item) · แยกจาก audit_log
CREATE TABLE IF NOT EXISTS case_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,
  actor       TEXT,                          -- username หรือ 'citizen' / 'system'
  event       TEXT NOT NULL,                 -- PAID CLAIM RETURN RESUBMIT FORWARD APPROVE REJECT ISSUE CANCEL AUTO_CANCEL ...
  from_status TEXT,
  to_status   TEXT,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_case_events_case ON case_events(case_id);

-- ไฟล์แนบ (เก็บเนื้อไฟล์ใน DB → reset ล้างไฟล์อัปโหลดใหม่อัตโนมัติ)
CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,              -- fileId เช่น 'F-000001' หรือสุ่ม
  case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  doc_key     TEXT NOT NULL,                 -- id-card map site-photo plan deed extra
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,                 -- จาก magic bytes: application/pdf image/jpeg image/png
  size        INTEGER NOT NULL,
  content     BLOB NOT NULL,
  uploaded_at TEXT NOT NULL,
  uploaded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_case ON files(case_id);

-- QR ชำระเงิน (ref ใหม่ทุกครั้งที่สร้าง QR)
CREATE TABLE IF NOT EXISTS payments (
  ref           TEXT PRIMARY KEY,            -- 'PP-0001'
  case_id       INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  amount        INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID')),
                                             -- EXPIRED คำนวณสด: PENDING และ rules.qrExpired()
  qr_created_at TEXT NOT NULL,
  qr_expires_at TEXT NOT NULL,               -- qr_created_at + 15 นาที
  paid_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_case ON payments(case_id);

-- เอกสารดิจิทัล · ลายเซ็น = HMAC-SHA256(docNo|caseNo|applicant|serviceId|issuedAt|validUntil|signer)
CREATE TABLE IF NOT EXISTS documents (
  doc_no      TEXT PRIMARY KEY,              -- 'DOC-2569-000001'
  case_id     INTEGER REFERENCES cases(id) ON DELETE CASCADE,
  case_no     TEXT NOT NULL,
  applicant   TEXT NOT NULL,                 -- ชื่อเต็มผู้ยื่น (ฟิลด์ที่ tamper แก้)
  service_id  TEXT NOT NULL,
  issued_at   TEXT NOT NULL,                 -- ISO +07:00
  valid_until TEXT NOT NULL,                 -- 'YYYY-MM-DD' วันสุดท้ายที่ใช้ได้
  signer      TEXT NOT NULL,                 -- ชื่อแสดงผู้ลงนาม
  verify_code TEXT NOT NULL UNIQUE,          -- [A-Z0-9]{8}
  signature   TEXT NOT NULL,                 -- hex
  issued_by   TEXT                           -- username ผู้กดออกเอกสาร
);

-- กระดิ่งแจ้งเตือน: 1 ครั้งต่อระดับต่อคำขอต่อคน
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  case_no    TEXT NOT NULL,
  level      TEXT NOT NULL CHECK (level IN ('near','overdue')),
  text       TEXT NOT NULL,                  -- 'คำขอ EG-2569-000024 ใกล้ครบกำหนด'
  created_at TEXT NOT NULL,
  read_at    TEXT,
  UNIQUE (username, case_no, level)
);

-- Audit Trail (เพิ่มได้อย่างเดียว)
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  time        TEXT NOT NULL,                 -- ISO +07:00 จาก clock
  username    TEXT NOT NULL,
  role        TEXT NOT NULL,
  event       TEXT NOT NULL,                 -- STAFF_LOGIN CLAIM RETURN FORWARD APPROVE REJECT ISSUE UNMASK EXPORT ADMIN_CHANGE
  case_no     TEXT,
  from_status TEXT,
  to_status   TEXT,
  detail      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(time);

-- ห้ามแก้ audit · ลบได้เฉพาะตอน reset (meta.audit_purge = '1')
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
WHEN (SELECT value FROM meta WHERE key = 'audit_purge') IS NOT '1'
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
