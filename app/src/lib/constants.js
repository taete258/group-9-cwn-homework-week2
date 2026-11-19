'use strict';
// constants.js · ค่าคงที่ที่ทุกบล็อกใช้ร่วมกัน (B01) — ตรงกับ CONTRACT §1 §2.1 §4

/** หน้าตั้งต้นหลังล็อกอิน (CONTRACT §1) · citizen ที่ยังไม่ลงทะเบียน → /register */
const LANDING = {
  citizen: '/citizen',
  officer: '/officer/queue',
  head: '/head/approvals',
  executive: '/dashboard',
  auditor: '/audit',
  admin: '/admin/services',
};

/** user-role ข้อความไทย (CONTRACT §2.1) */
const ROLE_LABEL = {
  citizen: 'ประชาชน',
  officer: 'เจ้าหน้าที่',
  head: 'หัวหน้าฝ่าย',
  executive: 'ผู้บริหาร',
  auditor: 'ผู้ตรวจสอบภายใน',
  admin: 'ผู้ดูแลระบบ',
};
const ROLES = Object.keys(ROLE_LABEL);

const DEPT_LABEL = { registry: 'ฝ่ายทะเบียน', works: 'ฝ่ายโยธา' };

/** case-status (CONTRACT §4.1) */
const STATUS_LABEL = {
  DRAFT: 'ร่าง',
  PENDING_PAYMENT: 'รอชำระเงิน',
  SUBMITTED: 'ส่งคำขอแล้ว',
  IN_REVIEW: 'กำลังตรวจสอบ',
  NEED_FIX: 'รอแก้ไขเอกสาร',
  PENDING_APPROVAL: 'รออนุมัติ',
  APPROVED: 'อนุมัติ',
  COMPLETED: 'เสร็จสิ้น',
  REJECTED: 'ไม่อนุมัติ',
  CANCELLED: 'ยกเลิก',
};
const OPEN_STATUSES = ['SUBMITTED', 'IN_REVIEW', 'NEED_FIX', 'PENDING_APPROVAL', 'APPROVED']; // งานคงค้าง
const CLOSED_STATUSES = ['COMPLETED', 'REJECTED', 'CANCELLED'];

/** sla-level (CONTRACT §4.2) */
const SLA_LABEL = {
  normal: 'ปกติ',
  near: 'ใกล้ครบกำหนด',
  overdue: 'เกินกำหนด',
  paused: 'หยุดนับ',
  closed: 'ปิดแล้ว',
};

/** บริการและเอกสาร (CONTRACT §4.3) · required ตามลำดับที่ใช้ใน missing-docs */
const SERVICES = {
  'SV-01': {
    name: 'ขอหนังสือรับรอง',
    docs: [{ key: 'id-card', label: 'บัตรประชาชน', required: true }],
    route: ['registry'],                 // ทะเบียนตรวจ + อนุมัติเอง
    approver: 'officer',
    validDays: 90,                       // A-23 (ออก + 89 วัน = วันสุดท้าย)
  },
  'SV-02': {
    name: 'ขออนุญาตประกอบกิจการ',
    docs: [
      { key: 'id-card', label: 'บัตรประชาชน', required: true },
      { key: 'map', label: 'แผนที่ตั้ง', required: true },
      { key: 'site-photo', label: 'ภาพสถานที่', required: false },
    ],
    route: ['registry', 'head'],
    approver: 'head',
    validYears: 1,
  },
  'SV-03': {
    name: 'ขออนุญาตก่อสร้าง/ต่อเติมอาคาร',
    docs: [
      { key: 'id-card', label: 'บัตรประชาชน', required: true },
      { key: 'plan', label: 'แบบแปลน', required: true, pdfOnly: true },
      { key: 'deed', label: 'โฉนด', required: true },
    ],
    route: ['registry', 'works', 'head'],
    approver: 'head',
    validYears: 1,
  },
};
const DOC_KEYS = ['id-card', 'map', 'site-photo', 'plan', 'deed', 'extra'];

/** case-step ของ SV-03 (CONTRACT §2.6) */
const STEP_LABEL = {
  1: 'ขั้นตอน 1/3 · ฝ่ายทะเบียน',
  2: 'ขั้นตอน 2/3 · ฝ่ายโยธา',
  3: 'ขั้นตอน 3/3 · หัวหน้าฝ่าย',
};

const AUDIT_EVENTS = ['STAFF_LOGIN', 'CLAIM', 'RETURN', 'FORWARD', 'APPROVE', 'REJECT', 'ISSUE', 'UNMASK', 'EXPORT', 'ADMIN_CHANGE'];

/** ข้อความ error ตรงตัวอักษร (CONTRACT §5) · ใช้คู่กับ res.apiError(status, code) */
const MESSAGES = {
  INVALID_ID: 'เลขบัตรประชาชนไม่ถูกต้อง',
  OTP_INVALID: 'รหัส OTP ไม่ถูกต้อง',
  LOCKED: 'ผิดเกินกำหนด เลขบัตรนี้ถูกล็อก 15 นาที',
  INVALID_CREDENTIALS: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
  INVALID_MOBILE: 'เบอร์มือถือต้องเป็นตัวเลข 10 หลักขึ้นต้นด้วย 0',
  CONSENT_REQUIRED: 'กรุณายินยอมการประมวลผลข้อมูลส่วนบุคคล (PDPA)',
  INVALID_QTY: 'จำนวนฉบับต้อง 1–5 ฉบับ',
  INVALID_AREA: 'กรุณาระบุพื้นที่ 1–500 ตร.ม.',
  AREA_TOO_LARGE: 'พื้นที่เกิน 500 ตร.ม. กรุณายื่นที่สำนักงาน',
  FILE_TOO_LARGE: 'ไฟล์ใหญ่เกิน 5 MB',
  FILE_TYPE: 'รองรับเฉพาะไฟล์ PDF, JPG, PNG',
  FILE_COUNT: 'แนบได้สูงสุด 5 ไฟล์ต่อคำขอ',
  PLAN_NOT_PDF: 'แบบแปลนต้องเป็นไฟล์ PDF เท่านั้น',
  MISSING_DOCS: 'ยังขาดเอกสาร: ',            // + รายชื่อคั่น ', '
  QR_EXPIRED: 'QR หมดอายุ กรุณาสร้าง QR ใหม่',
  AMOUNT_MISMATCH: 'ยอดเงินไม่ตรงกับค่าธรรมเนียม',
  NOT_FOUND: 'ไม่พบคำขอ',
  CANNOT_CANCEL: 'ยกเลิกไม่ได้ คำขอมีเจ้าหน้าที่รับเรื่องแล้ว',
  FIX_WINDOW_EXPIRED: 'หมดเวลาแก้ไขแล้ว คำขอถูกยกเลิก',
  ALREADY_CLAIMED: 'มีเจ้าหน้าที่รับเรื่องนี้แล้ว',
  WORKLOAD_LIMIT: 'รับงานได้สูงสุด 10 เรื่อง',
  RETURN_LIMIT: 'ตีกลับได้สูงสุด 2 ครั้ง',
  REASON_TOO_SHORT: 'กรุณากรอกเหตุผลอย่างน้อย 10 ตัวอักษร',
  REASON_REQUIRED: 'กรุณากรอกเหตุผล',
  INVALID_STATE: 'สถานะคำขอไม่ถูกต้องสำหรับรายการนี้',
  FORBIDDEN: 'ไม่มีสิทธิ์ทำรายการนี้',
  FORBIDDEN_PAGE: 'ไม่มีสิทธิ์เข้าถึงหน้านี้',
  UNAUTHENTICATED: 'กรุณาเข้าสู่ระบบ',
  INVALID_FEE: 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท',
  INVALID_SLA: 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ',
  DUPLICATE_HOLIDAY: 'มีวันหยุดนี้อยู่แล้ว',
  SELF_ROLE_CHANGE: 'ไม่สามารถเปลี่ยนบทบาทของตัวเองได้',
  METHOD_NOT_ALLOWED: 'Method Not Allowed',
  INVALID_TIME: 'รูปแบบเวลาไม่ถูกต้อง (ต้องเป็น ISO 8601 พร้อม offset)',
  DOC_NOT_FOUND: 'ไม่พบเอกสาร',
};

module.exports = {
  LANDING, ROLE_LABEL, ROLES, DEPT_LABEL, STATUS_LABEL, OPEN_STATUSES, CLOSED_STATUSES,
  SLA_LABEL, SERVICES, DOC_KEYS, STEP_LABEL, AUDIT_EVENTS, MESSAGES,
};
