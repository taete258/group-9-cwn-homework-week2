/**
 * helpers.ts · ตัวช่วยกลางของชุด Playwright (TEST-PLAN 51 TC)
 * อ้างอิงเฉพาะ CONTRACT.md / TEST-DATA.md / TEST-PLAN.md (ไม่อ่านโค้ดเว็บ)
 *
 * หลักการ:
 *  - RESET (`POST /api/test/reset`) ล้าง session ทุกคน → หลัง reset ทุกครั้งต้องสร้าง context ใหม่ + ล็อกอินใหม่
 *  - API context ทุกตัวสร้างใหม่ผ่าน newApi()/loginC()/loginS() และถูก dispose ใน afterEach (disposeAll)
 *  - ไฟล์ทดสอบสร้างในหน่วยความจำตามสคริปต์ TEST-DATA ข้อ 11 (ขนาดตรงไบต์)
 */
import {
  expect,
  request as pwRequest,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContextOptions,
  type Locator,
  type Page,
  test as pwTest,
} from '@playwright/test';
import * as fs from 'fs';
import * as zlib from 'zlib';

// ───────────────────────── ค่าคงที่จาก TEST-DATA ─────────────────────────

export const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
export const abs = (p: string): string => (/^https?:\/\//.test(p) ? p : BASE_URL + p);

export const OTP = '123456';
export const PASSWORD = 'Test@1234';
export const T0 = '2026-12-01T09:00:00+07:00';
export const R10 = 'xxxxxxxxxx'; // เหตุผล 10 ตัว (A-44)
export const R9 = 'xxxxxxxxx'; // เหตุผล 9 ตัว
export const SPACES10 = '          ';

export const ID = {
  somchai: '1101700123456',
  somying: '3100600987659',
  mana: '5500400111221',
  piti: '1909900555015',
  badChecksum: '1101700123457',
} as const;

export const FULL_ID = {
  somchai: '1-1017-00123-45-6',
  somying: '3-1006-00987-65-9',
  mana: '5-5004-00111-22-1',
  piti: '1-9099-00555-01-5',
} as const;

export const MASKED = {
  somchai: 'X-XXXX-XXXXX-45-6',
  somying: 'X-XXXX-XXXXX-65-9',
  mana: 'X-XXXX-XXXXX-22-1',
  piti: 'X-XXXX-XXXXX-01-5',
} as const;

export const MASK_RE = /^X-XXXX-XXXXX-\d{2}-\d$/;

export const STAFF_NAME: Record<string, string> = {
  'off.reg1': 'เจ้าหน้าที่ทะเบียน 1',
  'off.reg2': 'เจ้าหน้าที่ทะเบียน 2',
  'off.works1': 'เจ้าหน้าที่โยธา 1',
  head1: 'หัวหน้าฝ่าย',
  exec1: 'ผู้บริหาร',
  audit1: 'ผู้ตรวจสอบภายใน',
  admin1: 'ผู้ดูแลระบบ',
};

/** เลขคำขอปี 2569 จากลำดับ เช่น cn(25) = EG-2569-000025 */
export const cn = (n: number | string): string => `EG-2569-${String(n).padStart(6, '0')}`;

export const STATUS_TH: Record<string, string> = {
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

export const LEVEL_TH: Record<string, string> = {
  normal: 'ปกติ',
  near: 'ใกล้ครบกำหนด',
  overdue: 'เกินกำหนด',
  paused: 'หยุดนับ',
  closed: 'ปิดแล้ว',
};

export const MSG = {
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
  INVALID_FEE: 'ค่าธรรมเนียมต้องเป็นจำนวนเต็ม 0–100,000 บาท',
  INVALID_SLA: 'SLA ต้องเป็นจำนวนเต็ม 1–60 วันทำการ',
  DUPLICATE_HOLIDAY: 'มีวันหยุดนี้อยู่แล้ว',
  SELF_ROLE_CHANGE: 'ไม่สามารถเปลี่ยนบทบาทของตัวเองได้',
  NO_REFUND: 'ค่าธรรมเนียมที่ชำระแล้วไม่คืน',
} as const;

// ───────────────────────── registry ของ context (dispose ทุก test) ─────────────────────────

const opened: Array<() => Promise<unknown>> = [];
let hookCtx: APIRequestContext | null = null;

export async function disposeAll(): Promise<void> {
  while (opened.length) {
    const close = opened.pop()!;
    try {
      await close();
    } catch {
      /* ignore */
    }
  }
  hookCtx = null;
}

/** API context ใหม่ (ไม่มี cookie) */
export async function newApi(): Promise<APIRequestContext> {
  const c = await pwRequest.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true });
  opened.push(() => c.dispose());
  return c;
}

/** context สำหรับเรียก test hook /api/test/* (ไม่ต้องล็อกอิน) */
async function hook(): Promise<APIRequestContext> {
  if (!hookCtx) hookCtx = await newApi();
  return hookCtx;
}

/** browser context + page ใหม่ (ไม่มี cookie) · กล่อง confirm แบบ native ถูกกดยืนยันอัตโนมัติ */
export async function newPage(browser: Browser, opts: BrowserContextOptions = {}): Promise<Page> {
  const ctx = await browser.newContext({
    baseURL: BASE_URL,
    acceptDownloads: true,
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    // LAB 4: ตั้ง RECORD_VIDEO_DIR เพื่อบันทึกวิดีโอแยกโฟลเดอร์ตามรหัส TC (ไม่กระทบผลทดสอบ)
    ...(process.env.RECORD_VIDEO_DIR
      ? { recordVideo: { dir: `${process.env.RECORD_VIDEO_DIR}/${(pwTest.info().title.match(/^TC-[A-Z0-9]+-\d+/) || ['misc'])[0]}`, size: { width: 960, height: 600 } } }
      : {}),
    ...opts,
  });
  opened.push(() => ctx.close());
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => undefined));
  return page;
}

// ───────────────────────── อ่าน response ─────────────────────────

export async function bodyOf(res: APIResponse): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** ตรวจ HTTP status แล้วคืน JSON */
export async function expectOk(res: APIResponse, status = 200): Promise<any> {
  const text = await res.text();
  expect(res.status(), `${res.url()} → ${text.slice(0, 300)}`).toBe(status);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** ตรวจ error: status + `code` (+ `message` ตรงตัวอักษร ตาราง 5) */
export async function expectErr(res: APIResponse, status: number, code?: string, message?: string): Promise<any> {
  const text = await res.text();
  expect(res.status(), `${res.url()} → ${text.slice(0, 300)}`).toBe(status);
  let j: any = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = null;
  }
  if (code) expect(j?.code, `code ของ ${res.url()} → ${text.slice(0, 300)}`).toBe(code);
  if (message) expect(j?.message, `message ของ ${res.url()}`).toBe(message);
  return j;
}

// ───────────────────────── test hooks ─────────────────────────

/** RESET: ทุก TC เริ่มด้วยสูตรนี้ · ล้าง session ทุกคน (ต้องล็อกอินใหม่) */
export async function reset(): Promise<void> {
  // ทิ้ง context เดิมทั้งหมด (cookie ใช้ไม่ได้แล้วหลัง reset)
  await disposeAll();
  const c = await hook();
  const r = await c.post('/api/test/reset');
  const j = await expectOk(r, 200);
  expect(j?.ok, 'reset ok').toBe(true);
  expect(j?.now, 'reset now').toBe(T0);
}

/** CLOCK(t): ตั้งนาฬิกาแช่แข็ง */
export async function setClock(now: string): Promise<void> {
  const c = await hook();
  const r = await c.put('/api/test/clock', { data: { now } });
  const j = await expectOk(r, 200);
  expect(Date.parse(j?.now), `clock = ${now}`).toBe(Date.parse(now));
}

export async function getClock(): Promise<string> {
  const c = await hook();
  const j = await expectOk(await c.get('/api/test/clock'), 200);
  return j.now;
}

/** POST /api/test/payments/<ref>/pay */
export async function pay(ref: string, amount: number): Promise<APIResponse> {
  const c = await hook();
  return c.post(`/api/test/payments/${ref}/pay`, { data: { amount } });
}

export async function tamper(docNo: string): Promise<APIResponse> {
  const c = await hook();
  return c.post(`/api/test/documents/${docNo}/tamper`);
}

// ───────────────────────── ล็อกอิน ─────────────────────────

export const thaidStart = (c: APIRequestContext, idNo: string) =>
  c.post('/api/auth/thaid/start', { data: { idNo } });
export const thaidVerify = (c: APIRequestContext, idNo: string, otp: string) =>
  c.post('/api/auth/thaid/verify', { data: { idNo, otp } });
export const staffLogin = (c: APIRequestContext, username: string, password = PASSWORD) =>
  c.post('/api/auth/staff/login', { data: { username, password } });

/** LOGIN_C ผ่าน API → context ใหม่ที่มี cookie ของประชาชน */
export async function loginC(idNo: string): Promise<APIRequestContext> {
  const c = await newApi();
  await expectOk(await thaidStart(c, idNo), 200);
  await expectOk(await thaidVerify(c, idNo, OTP), 200);
  return c;
}

/** LOGIN_S ผ่าน API → context ใหม่ที่มี cookie ของเจ้าหน้าที่ */
export async function loginS(username: string): Promise<APIRequestContext> {
  const c = await newApi();
  await expectOk(await staffLogin(c, username), 200);
  return c;
}

/** ล็อกอินประชาชนใน browser context ของ page (page.request ใช้ cookie ร่วมกับหน้าเว็บ) */
export async function pageLoginC(page: Page, idNo: string): Promise<void> {
  await expectOk(await page.request.post(abs('/api/auth/thaid/start'), { data: { idNo } }), 200);
  await expectOk(await page.request.post(abs('/api/auth/thaid/verify'), { data: { idNo, otp: OTP } }), 200);
}

export async function pageLoginS(page: Page, username: string): Promise<void> {
  await expectOk(
    await page.request.post(abs('/api/auth/staff/login'), { data: { username, password: PASSWORD } }),
    200,
  );
}

/** ล็อกอินประชาชนผ่านหน้า /login (ThaiD จำลอง) */
export async function uiLoginC(page: Page, idNo: string, otp = OTP): Promise<void> {
  await page.goto('/login');
  await tid(page, 'login-tab-citizen').click();
  await tid(page, 'thaid-id-input').fill(idNo);
  await tid(page, 'thaid-submit').click();
  await expect(tid(page, 'otp-step')).toBeVisible();
  await tid(page, 'otp-input').fill(otp);
  await tid(page, 'otp-submit').click();
}

/** ล็อกอินเจ้าหน้าที่ผ่านแท็บเจ้าหน้าที่ (SSO จำลอง) */
export async function uiLoginS(page: Page, username: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await tid(page, 'login-tab-staff').click();
  await tid(page, 'staff-username').fill(username);
  await tid(page, 'staff-password').fill(password);
  await tid(page, 'staff-submit').click();
}

export async function staffPage(browser: Browser, username: string, opts: BrowserContextOptions = {}): Promise<Page> {
  const p = await newPage(browser, opts);
  await pageLoginS(p, username);
  return p;
}

export async function citizenPage(browser: Browser, idNo: string, opts: BrowserContextOptions = {}): Promise<Page> {
  const p = await newPage(browser, opts);
  await pageLoginC(p, idNo);
  return p;
}

// ───────────────────────── locator ─────────────────────────

export const tid = (p: Page | Locator, id: string): Locator => p.getByTestId(id);

/** แถวที่มี data-case-no ตรง (queue-row / my-case-row / approval-row / noti-item / audit-row) */
export const rowOf = (p: Page | Locator, testid: string, caseNo: string): Locator =>
  p.locator(`[data-testid="${testid}"][data-case-no="${caseNo}"]`);

export const byAttr = (p: Page | Locator, testid: string, attr: string, value: string): Locator =>
  p.locator(`[data-testid="${testid}"][${attr}="${value}"]`);

/** อ่านค่าแอตทริบิวต์จากทุกองค์ประกอบ testid ตามลำดับในหน้า */
export async function attrList(p: Page | Locator, testid: string, attr: string): Promise<string[]> {
  return p.getByTestId(testid).evaluateAll(
    (els, a) => els.map((e) => e.getAttribute(a as string) ?? ''),
    attr,
  );
}

/** ลำดับเลขคำขอของแถว (คงที่แล้ว) */
export async function expectCaseOrder(p: Page, testid: string, expected: string[]): Promise<void> {
  await expect.poll(() => attrList(p, testid, 'data-case-no'), { timeout: 15_000 }).toEqual(expected);
}

export async function expectPath(page: Page, path: string): Promise<void> {
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe(path);
}

export async function gotoStatus(page: Page, path: string): Promise<number> {
  const r = await page.goto(path);
  return r ? r.status() : 0;
}

/** ตรวจข้อความสถานะ + data-status */
export async function expectStatus(page: Page | Locator, code: string): Promise<void> {
  const el = tid(page, 'case-status');
  await expect(el).toHaveText(STATUS_TH[code]);
  await expect(el).toHaveAttribute('data-status', code);
}

export async function expectLevel(page: Page | Locator, level: string, testid = 'sla-level'): Promise<void> {
  const el = tid(page, testid);
  await expect(el).toHaveText(LEVEL_TH[level]);
  await expect(el).toHaveAttribute('data-level', level);
}

/** ไม่ render หรือมองไม่เห็น (ใช้กับ error/ขั้นที่ "ไม่แสดง") */
export async function expectNotShown(loc: Locator): Promise<void> {
  await expect(loc).toBeHidden();
}

// ───────────────────────── ไฟล์ทดสอบ (TEST-DATA ข้อ 11) ─────────────────────────

export function pdfBuf(n: number): Buffer {
  const head = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n', 'latin1');
  const tail = Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
  const pad = n - head.length - tail.length;
  if (pad < 0) throw new Error('pdf too small');
  return Buffer.concat([head, Buffer.alloc(pad, 0x20), tail]);
}

function crc32(buf: Buffer): number {
  let c: number;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function pngBuf(n: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const base = Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.from([0x00, 0xff, 0x00, 0x00]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  const pad = n - base.length - 12;
  const text = Buffer.concat([Buffer.from('k\x00', 'latin1'), Buffer.alloc(pad - 2, 0x78)]);
  return Buffer.concat([base.subarray(0, base.length - 12), pngChunk('tEXt', text), base.subarray(base.length - 12)]);
}

export function jpgBuf(n: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const pad = n - soi.length - app0.length - 2 - 4;
  const len = Buffer.alloc(2);
  len.writeUInt16BE(pad + 2);
  return Buffer.concat([soi, app0, Buffer.from([0xff, 0xfe]), len, Buffer.alloc(pad, 0x78), Buffer.from([0xff, 0xd9])]);
}

export type FilePayload = { name: string; mimeType: string; buffer: Buffer };

/** ไฟล์ตามชื่อใน TEST-DATA ข้อ 11 */
export function tf(name: string, mimeType?: string): FilePayload {
  const sized = /^size-(\d+)\.pdf$/.exec(name);
  let buffer: Buffer;
  let mime: string;
  if (sized) {
    buffer = pdfBuf(Number(sized[1]));
    mime = 'application/pdf';
  } else if (['ok-id.pdf', 'id-card.pdf', 'map.pdf', 'plan.pdf', 'deed.pdf'].includes(name) || /^multi-\d\.pdf$/.test(name)) {
    buffer = pdfBuf(1024);
    mime = 'application/pdf';
  } else if (name === 'real.jpg' || name === 'plan-as-jpg.jpg') {
    buffer = jpgBuf(1024);
    mime = 'image/jpeg';
  } else if (name === 'real.png') {
    buffer = pngBuf(1024);
    mime = 'image/png';
  } else if (name === 'fake-text.pdf' || name === 'fake-text.jpg' || name === 'notes.txt') {
    buffer = Buffer.from('hello', 'latin1');
    mime = name === 'notes.txt' ? 'text/plain' : name.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream';
  } else if (name === 'exe-as.png') {
    buffer = Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(1022, 0)]);
    mime = 'image/png';
  } else {
    throw new Error(`unknown test file ${name}`);
  }
  return { name, mimeType: mimeType ?? mime, buffer };
}

export const REQUIRED_DOCS: Record<string, Array<[string, string]>> = {
  'SV-01': [['id-card', 'id-card.pdf']],
  'SV-02': [
    ['id-card', 'id-card.pdf'],
    ['map', 'map.pdf'],
  ],
  'SV-03': [
    ['id-card', 'id-card.pdf'],
    ['plan', 'plan.pdf'],
    ['deed', 'deed.pdf'],
  ],
};

// ───────────────────────── ร่าง / ชำระ / คำขอ (API) ─────────────────────────

export type ServiceId = 'SV-01' | 'SV-02' | 'SV-03';

export function draftBody(service: ServiceId, opt: { qty?: number; area?: number } = {}): Record<string, unknown> {
  if (service === 'SV-01') return { serviceId: service, qty: opt.qty ?? 1 };
  if (service === 'SV-03') return { serviceId: service, areaSqm: opt.area ?? 100 };
  return { serviceId: service };
}

export async function createDraft(
  c: APIRequestContext,
  service: ServiceId,
  opt: { qty?: number; area?: number } = {},
): Promise<{ draftId: string; fee: number }> {
  const j = await expectOk(await c.post('/api/drafts', { data: draftBody(service, opt) }), 201);
  expect(j.draftId, 'draftId').toMatch(/^DR-\d{4}$/);
  return j;
}

export function uploadRaw(c: APIRequestContext, draftId: string, docKey: string, f: FilePayload): Promise<APIResponse> {
  return c.post(`/api/drafts/${draftId}/files`, {
    multipart: { file: { name: f.name, mimeType: f.mimeType, buffer: f.buffer }, docKey },
    timeout: 120_000,
  });
}

export async function uploadOk(c: APIRequestContext, draftId: string, docKey: string, name: string): Promise<any> {
  return expectOk(await uploadRaw(c, draftId, docKey, tf(name)), 201);
}

export async function uploadRequired(c: APIRequestContext, draftId: string, service: ServiceId): Promise<void> {
  for (const [docKey, name] of REQUIRED_DOCS[service]) await uploadOk(c, draftId, docKey, name);
}

export async function createPayment(c: APIRequestContext, draftId: string): Promise<any> {
  const j = await expectOk(await c.post(`/api/drafts/${draftId}/payment`), 201);
  expect(j.ref, 'ref').toMatch(/^PP-\d{4}$/);
  return j;
}

/** ร่าง + ไฟล์บังคับ + สร้าง QR (ยังไม่จ่าย) */
export async function newUnpaid(
  c: APIRequestContext,
  service: ServiceId = 'SV-01',
  opt: { qty?: number; area?: number } = {},
): Promise<{ draftId: string; fee: number; ref: string; amount: number }> {
  const d = await createDraft(c, service, opt);
  await uploadRequired(c, d.draftId, service);
  const p = await createPayment(c, d.draftId);
  return { draftId: d.draftId, fee: d.fee, ref: p.ref, amount: p.amount };
}

/** NEW_PAID(ผู้ยื่น, บริการ, เวลา, ตัวเลือก) */
export async function newPaid(
  opt: {
    idNo?: string;
    service?: ServiceId;
    qty?: number;
    area?: number;
    at?: string;
    ctx?: APIRequestContext;
  } = {},
): Promise<{ caseNo: string; receiptNo: string; ref: string; draftId: string; amount: number; ctx: APIRequestContext }> {
  if (opt.at) await setClock(opt.at);
  const ctx = opt.ctx ?? (await loginC(opt.idNo ?? ID.somchai));
  const service = opt.service ?? 'SV-01';
  const u = await newUnpaid(ctx, service, { qty: opt.qty, area: opt.area });
  const pj = await expectOk(await pay(u.ref, u.amount), 200);
  expect(pj.status).toBe('PAID');
  const g = await expectOk(await ctx.get(`/api/payments/${u.ref}`), 200);
  expect(g.caseNo, 'caseNo หลังชำระ').toBe(pj.caseNo);
  return { caseNo: g.caseNo, receiptNo: pj.receiptNo, ref: u.ref, draftId: u.draftId, amount: u.amount, ctx };
}

export async function getCase(c: APIRequestContext, caseNo: string): Promise<any> {
  return expectOk(await c.get(`/api/cases/${caseNo}`), 200);
}

export async function myCases(c: APIRequestContext): Promise<any[]> {
  const j = await expectOk(await c.get('/api/cases'), 200);
  return j.items;
}

export const act = {
  claim: (c: APIRequestContext, caseNo: string) => c.post(`/api/officer/cases/${caseNo}/claim`),
  ret: (c: APIRequestContext, caseNo: string, reason = R10) =>
    c.post(`/api/officer/cases/${caseNo}/return`, { data: { reason } }),
  forward: (c: APIRequestContext, caseNo: string, note?: string) =>
    c.post(`/api/officer/cases/${caseNo}/forward`, { data: note === undefined ? {} : { note } }),
  approve: (c: APIRequestContext, caseNo: string) => c.post(`/api/cases/${caseNo}/approve`),
  reject: (c: APIRequestContext, caseNo: string, reason = R10) =>
    c.post(`/api/cases/${caseNo}/reject`, { data: { reason } }),
  issue: (c: APIRequestContext, caseNo: string) => c.post(`/api/officer/cases/${caseNo}/issue`),
  unmask: (c: APIRequestContext, caseNo: string, reason: string) =>
    c.post(`/api/officer/cases/${caseNo}/unmask`, { data: { reason } }),
  cancel: (c: APIRequestContext, caseNo: string) => c.post(`/api/cases/${caseNo}/cancel`),
  resubmit: (c: APIRequestContext, caseNo: string) => c.post(`/api/cases/${caseNo}/resubmit`),
};

export async function queueApi(c: APIRequestContext, filter = 'all'): Promise<any[]> {
  const j = await expectOk(await c.get(`/api/officer/queue?filter=${filter}`), 200);
  return j.items;
}

export async function notiApi(c: APIRequestContext): Promise<string[]> {
  const j = await expectOk(await c.get('/api/notifications'), 200);
  return (j.items as any[]).map((i) => `${i.caseNo}:${i.level}`).sort();
}

export async function dashApi(c: APIRequestContext, period = '2026-12', service = 'ALL'): Promise<any> {
  return expectOk(await c.get(`/api/dashboard?period=${period}&service=${service}`), 200);
}

export async function auditApi(c: APIRequestContext, q: Record<string, string> = {}): Promise<{ count: number; items: any[] }> {
  const qs = new URLSearchParams({ actor: '', event: '', from: '', to: '', ...q }).toString();
  return expectOk(await c.get(`/api/audit?${qs}`), 200);
}

// ───────────────────────── หน้าจอ (UI) ─────────────────────────

/** อ่านรายการแจ้งเตือนบน /notifications เป็น `caseNo:level` (เรียง) */
export async function notiUi(page: Page): Promise<string[]> {
  await page.goto('/notifications');
  const cases = await attrList(page, 'noti-item', 'data-case-no');
  const levels = await attrList(page, 'noti-item', 'data-level');
  return cases.map((c, i) => `${c}:${levels[i]}`).sort();
}

/** ขั้นตอนยื่นขั้น 1 → 2 (กรอกข้อมูลแล้วไปแนบเอกสาร) */
export async function wizardToUpload(page: Page, service: ServiceId, opt: { qty?: number; area?: number } = {}): Promise<void> {
  await page.goto(`/citizen/new/${service}`);
  await expect(tid(page, 'wizard-step')).toHaveText('1/3 กรอกข้อมูล');
  if (service === 'SV-01' && opt.qty !== undefined) await tid(page, 'qty-input').fill(String(opt.qty));
  if (service === 'SV-03') await tid(page, 'area-input').fill(String(opt.area ?? 100));
  await expect(tid(page, 'to-upload-btn')).toBeEnabled();
  await tid(page, 'to-upload-btn').click();
  await expect(tid(page, 'wizard-step')).toHaveText('2/3 แนบเอกสาร');
}

/** แนบไฟล์ผ่าน input แล้วรอให้จำนวน file-item เปลี่ยนตามที่คาด (รับ = +1 · ปฏิเสธ = เท่าเดิม + upload-error) */
export async function attachUi(page: Page, docKey: string, f: FilePayload, accepted = true): Promise<void> {
  const items = tid(page, 'file-item');
  const before = await items.count();
  await tid(page, `upload-input-${docKey}`).setInputFiles(f);
  if (accepted) {
    await expect(items).toHaveCount(before + 1, { timeout: 60_000 });
  } else {
    await expect(tid(page, 'upload-error')).toBeVisible({ timeout: 60_000 });
    await expect(items).toHaveCount(before);
  }
}

export async function removeFileUi(page: Page, item: Locator): Promise<void> {
  const items = tid(page, 'file-item');
  const before = await items.count();
  await item.getByTestId('file-remove-btn').click();
  await expect(items).toHaveCount(before - 1);
}

/** ขั้นตอนยื่นถึงขั้นชำระ + สร้าง QR → คืน ref */
export async function wizardToQr(page: Page, service: ServiceId = 'SV-01', opt: { qty?: number; area?: number } = {}): Promise<string> {
  await wizardToUpload(page, service, opt);
  for (const [docKey, name] of REQUIRED_DOCS[service]) await attachUi(page, docKey, tf(name));
  await expect(tid(page, 'to-payment-btn')).toBeEnabled();
  await tid(page, 'to-payment-btn').click();
  await expect(tid(page, 'wizard-step')).toHaveText('3/3 ชำระเงิน');
  await tid(page, 'create-qr-btn').click();
  await expect(tid(page, 'qr-ref')).toHaveText(/^PP-\d{4}$/);
  return (await tid(page, 'qr-ref').innerText()).trim();
}

/** ตีกลับผ่านหน้าจอ (เปิดกล่องถ้ายังไม่เปิด) */
export async function uiReturn(page: Page, reason: string): Promise<void> {
  if (!(await tid(page, 'return-reason').isVisible())) await tid(page, 'return-btn').click();
  await tid(page, 'return-reason').fill(reason);
  await tid(page, 'return-submit').click();
}

export async function uiReject(page: Page, reason: string): Promise<void> {
  if (!(await tid(page, 'reject-reason').isVisible())) await tid(page, 'reject-btn').click();
  await tid(page, 'reject-reason').fill(reason);
  await tid(page, 'reject-submit').click();
}

export async function uiUnmask(page: Page, reason: string): Promise<void> {
  if (!(await tid(page, 'unmask-reason').isVisible())) await tid(page, 'show-full-id-btn').click();
  await tid(page, 'unmask-reason').fill(reason);
  await tid(page, 'unmask-submit').click();
}

/** ตั้งตัวกรอง /audit แล้วกดค้นหา */
export async function auditFilterUi(
  page: Page,
  f: { actor?: string; event?: string; from?: string; to?: string } = {},
): Promise<void> {
  if (!new URL(page.url()).pathname.startsWith('/audit')) await page.goto('/audit');
  await tid(page, 'audit-filter-actor').fill(f.actor ?? '');
  await tid(page, 'audit-filter-event').selectOption(f.event ?? '');
  await tid(page, 'audit-filter-from').fill(f.from ?? '');
  await tid(page, 'audit-filter-to').fill(f.to ?? '');
  await tid(page, 'audit-apply-btn').click();
  await page.waitForLoadState();
}

export type AuditRowUi = {
  id: string;
  event: string;
  actor: string;
  caseNo: string;
  iso: string;
  role: string;
  transition: string;
  detail: string;
  eventText: string;
  actorText: string;
  caseText: string;
};

export async function auditRowsUi(page: Page): Promise<AuditRowUi[]> {
  return page.getByTestId('audit-row').evaluateAll((rows) =>
    rows.map((r) => {
      const q = (id: string) => r.querySelector(`[data-testid="${id}"]`);
      const t = (id: string) => (q(id)?.textContent ?? '').replace(/\s+/g, ' ').trim();
      return {
        id: r.getAttribute('data-id') ?? '',
        event: r.getAttribute('data-event') ?? '',
        actor: r.getAttribute('data-actor') ?? '',
        caseNo: r.getAttribute('data-case-no') ?? '',
        iso: q('audit-time')?.getAttribute('data-iso') ?? '',
        role: t('audit-role'),
        transition: t('audit-transition'),
        detail: t('audit-detail'),
        eventText: t('audit-event'),
        actorText: t('audit-actor'),
        caseText: t('audit-case-no'),
      };
    }),
  );
}

/** ตรวจ KPI 5 ช่องบน /dashboard */
export async function expectKpis(
  page: Page,
  k: { received: string; closed: string; pct?: string; backlog: string; overdue: string },
): Promise<void> {
  await expect(tid(page, 'kpi-received')).toHaveText(k.received);
  await expect(tid(page, 'kpi-closed')).toHaveText(k.closed);
  if (k.pct !== undefined) await expect(tid(page, 'kpi-ontime-pct')).toHaveText(k.pct);
  await expect(tid(page, 'kpi-backlog')).toHaveText(k.backlog);
  await expect(tid(page, 'kpi-overdue')).toHaveText(k.overdue);
}

export async function selectDash(page: Page, period: string, service: string): Promise<void> {
  const ps = tid(page, 'period-select');
  const ss = tid(page, 'service-select');
  if ((await ps.inputValue()) !== period) {
    await ps.selectOption(period);
    await page.waitForLoadState();
  }
  await expect(ps).toHaveValue(period);
  if ((await ss.inputValue()) !== service) {
    await ss.selectOption(service);
    await page.waitForLoadState();
  }
  await expect(ss).toHaveValue(service);
  await expect(ps).toHaveValue(period);
}

/** กดปุ่มที่ทำให้เกิดดาวน์โหลด · ดัก response (ยิงเซิร์ฟเวอร์ครั้งเดียว) เพื่ออ่าน header */
export async function downloadVia(
  page: Page,
  urlGlob: string,
  click: () => Promise<void>,
): Promise<{ buf: Buffer; headers: Record<string, string>; filename: string }> {
  let headers: Record<string, string> = {};
  const handler = async (route: any) => {
    const r = await route.fetch();
    headers = r.headers();
    await route.fulfill({ response: r });
  };
  await page.context().route(urlGlob, handler);
  try {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), click()]);
    const p = await dl.path();
    const buf = fs.readFileSync(p!);
    return { buf, headers, filename: dl.suggestedFilename() };
  } finally {
    await page.context().unroute(urlGlob, handler);
  }
}

// ───────────────────────── การตรวจข้อมูล ─────────────────────────

/** มี key ชื่อนี้ที่ชั้นใดก็ได้ */
export function hasKeyDeep(obj: unknown, key: string): boolean {
  if (Array.isArray(obj)) return obj.some((v) => hasKeyDeep(v, key));
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === key) return true;
      if (hasKeyDeep(v, key)) return true;
    }
  }
  return false;
}

// ───────────────────────── PDF / XLSX / CSV ─────────────────────────

function pdfStringsFromContent(content: string): string {
  // ดึงสตริงจาก operator แสดงข้อความ (Tj/TJ/'/") · ขึ้นบรรทัดใหม่เมื่อย้ายตำแหน่ง/จบบล็อก
  const lines: string[] = [];
  let cur = '';
  let i = 0;
  const n = content.length;
  const flush = () => {
    if (cur) lines.push(cur);
    cur = '';
  };
  while (i < n) {
    const ch = content[i];
    if (ch === '(') {
      let depth = 1;
      i++;
      let s = '';
      while (i < n && depth > 0) {
        const c = content[i];
        if (c === '\\') {
          const nx = content[i + 1];
          if (nx === 'n') s += '\n';
          else if (nx === 'r') s += '\r';
          else if (nx === 't') s += '\t';
          else if (nx === 'b') s += '\b';
          else if (nx === 'f') s += '\f';
          else if (/[0-7]/.test(nx)) {
            const m = /^[0-7]{1,3}/.exec(content.slice(i + 1, i + 4))![0];
            s += String.fromCharCode(parseInt(m, 8));
            i += m.length - 1;
          } else if (nx === '\n' || nx === '\r') {
            /* line continuation */
          } else s += nx;
          i += 2;
          continue;
        }
        if (c === '(') depth++;
        if (c === ')') {
          depth--;
          if (depth === 0) break;
        }
        s += c;
        i++;
      }
      i++;
      cur += s;
      continue;
    }
    if (ch === '<' && content[i + 1] !== '<') {
      const end = content.indexOf('>', i);
      if (end < 0) break;
      const hex = content.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, '');
      let s = '';
      for (let k = 0; k + 1 < hex.length; k += 2) s += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
      if (hex.length % 2 === 1) s += String.fromCharCode(parseInt(hex.slice(-1) + '0', 16));
      cur += s;
      i = end + 1;
      continue;
    }
    if (ch === '<' && content[i + 1] === '<') {
      i += 2;
      continue;
    }
    const m = /^(BT|ET|Td|TD|T\*|Tm|'|")(?=[\s\[\]()<>\/]|$)/.exec(content.slice(i, i + 3));
    if (m && (i === 0 || /[\s\]\)>]/.test(content[i - 1]))) {
      flush();
      i += m[1].length;
      continue;
    }
    i++;
  }
  flush();
  return lines.join('\n');
}

/** ข้อความ ASCII จาก PDF: ไบต์ดิบ + stream ที่คลาย Flate + สตริงใน operator ข้อความ (+ pdf-parse ถ้ามีติดตั้ง) */
export async function pdfText(buf: Buffer): Promise<string> {
  const raw = buf.toString('latin1');
  const parts: string[] = [raw, pdfStringsFromContent(raw)];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const chunk = buf.subarray(start, end);
    try {
      const data = zlib.inflateSync(chunk, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('latin1');
      parts.push(data, pdfStringsFromContent(data));
    } catch {
      /* not flate */
    }
    re.lastIndex = end;
  }
  try {
    const modName = 'pdf-parse';
    const mod: any = await import(modName);
    const fn = mod.default ?? mod;
    if (typeof fn === 'function') {
      const r = await fn(buf);
      if (r?.text) parts.push(r.text);
    }
  } catch {
    /* pdf-parse ไม่ได้ติดตั้ง */
  }
  return parts.join('\n');
}

/** บรรทัดข้อความที่ดึงได้จาก PDF (ไม่รวมไบต์ดิบ) สำหรับตรวจข้อมูลส่วนบุคคล */
export async function pdfTextLines(buf: Buffer): Promise<string> {
  const all = await pdfText(buf);
  // ตัดไบต์ดิบชิ้นแรกออก (เป็น binary) — ตรวจเฉพาะข้อความที่ดึงออกมา
  return all.slice(buf.toString('latin1').length);
}

function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip (xlsx)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let k = 0; k < count; k++) {
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lName = buf.readUInt16LE(localOff + 26);
    const lExtra = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lName + lExtra;
    const data = buf.subarray(start, start + compSize);
    out.set(name, method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function xmlDecode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)![0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** อ่านชีตแรกของ .xlsx เป็นตาราง string[แถว][คอลัมน์] (แถว 0 = แถวที่ 1) */
export function xlsxFirstSheet(buf: Buffer): string[][] {
  const z = unzip(buf);
  const shared: string[] = [];
  const ssx = z.get('xl/sharedStrings.xml')?.toString('utf8');
  if (ssx) {
    for (const si of ssx.match(/<si>[\s\S]*?<\/si>|<si\/>/g) ?? []) {
      shared.push([...si.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlDecode(m[1])).join(''));
    }
  }
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = z.get('xl/workbook.xml')?.toString('utf8');
  const rels = z.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  if (wb && rels) {
    const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1];
    for (const rel of rels.match(/<Relationship\b[^>]*>/g) ?? []) {
      if (rid && new RegExp(`\\bId="${rid}"`).test(rel)) {
        const target = /\bTarget="([^"]+)"/.exec(rel)?.[1];
        if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
      }
    }
  }
  const sx = z.get(sheetPath)?.toString('utf8') ?? '';
  const rows: string[][] = [];
  for (const rm of sx.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rIdx = Number(/\br="(\d+)"/.exec(rm[1])?.[1] ?? rows.length + 1) - 1;
    const row: string[] = [];
    let auto = 0;
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const inner = cm[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const ci = ref ? colIndex(ref) : auto;
      auto = ci + 1;
      const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
      let v = '';
      if (t === 's') v = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? -1)] ?? '';
      else if (t === 'inlineStr')
        v = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlDecode(m[1])).join('');
      else v = xmlDecode(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
      row[ci] = v;
    }
    rows[rIdx] = Array.from(row, (x) => x ?? '');
  }
  return Array.from(rows, (r) => r ?? []);
}

/** แยก CSV (รองรับ "…" และ "" ภายใน) */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      out.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    out.push(row);
  }
  return out.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** ข้อความต้องไม่มีข้อมูลส่วนบุคคล (BR-24) */
export function expectNoPii(text: string, label: string): void {
  expect(text, `${label}: เลข 13 หลัก`).not.toMatch(/\d{13}/);
  expect(text, `${label}: เบอร์โทร`).not.toMatch(/0\d{9}/);
  for (const name of ['สมชาย', 'สมหญิง', 'ปิติ', 'มานะ']) expect(text, `${label}: ชื่อ ${name}`).not.toContain(name);
}
