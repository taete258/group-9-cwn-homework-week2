/**
 * egov.spec.ts · ชุด Playwright ครบ 51 TC ตาม /workspace/egov-brief/TEST-PLAN.md
 * อ้างอิงเฉพาะ TEST-PLAN.md · CONTRACT.md · TEST-DATA.md (ไม่อ่านโค้ดเว็บ)
 *
 * กติกา:
 *  - ทุก test เริ่มด้วย `await reset()` (POST /api/test/reset) แล้วล็อกอินใหม่ทุกครั้ง (CONTRACT 0.9)
 *    RESET กลาง TC → เรียก reset() ซ้ำ (ทิ้ง context เก่าทั้งหมด) แล้วล็อกอินใหม่
 *  - ผลคาดหวังเขียนตายตัวจาก TEST-PLAN/TEST-DATA (ไม่อ่านค่าจากหน้าจอมาเป็นคำตอบ)
 *  - ใช้ data-testid ตาม CONTRACT ข้อ 2
 *
 * รัน: BASE_URL=http://localhost:3000 npx playwright test
 * ตัวแปรเสริม: DB_PATH (TC-NFR-04) · BASE_URL_NO_TEST_MODE (TC-NFR-03 ส่วนปิด hook)
 */
import { test, expect, type APIRequestContext, type Browser, type Page, type Locator } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import * as fs from 'fs';
import * as path from 'path';
import {
  BASE_URL,
  abs,
  OTP,
  T0,
  R10,
  R9,
  SPACES10,
  ID,
  FULL_ID,
  MASKED,
  MASK_RE,
  STAFF_NAME,
  cn,
  STATUS_TH,
  LEVEL_TH,
  MSG,
  disposeAll,
  newApi,
  newPage,
  bodyOf,
  expectOk,
  expectErr,
  reset,
  setClock,
  getClock,
  pay,
  tamper,
  thaidStart,
  thaidVerify,
  staffLogin,
  loginC,
  loginS,
  uiLoginC,
  uiLoginS,
  staffPage,
  citizenPage,
  tid,
  rowOf,
  byAttr,
  attrList,
  expectCaseOrder,
  expectPath,
  gotoStatus,
  expectStatus,
  expectLevel,
  expectNotShown,
  tf,
  createDraft,
  uploadRaw,
  uploadOk,
  createPayment,
  newUnpaid,
  newPaid,
  getCase,
  myCases,
  act,
  queueApi,
  notiApi,
  dashApi,
  auditApi,
  notiUi,
  wizardToUpload,
  attachUi,
  removeFileUi,
  wizardToQr,
  uiReturn,
  uiReject,
  uiUnmask,
  auditFilterUi,
  auditRowsUi,
  expectKpis,
  selectDash,
  downloadVia,
  hasKeyDeep,
  pdfText,
  pdfTextLines,
  xlsxFirstSheet,
  parseCsv,
  expectNoPii,
} from './helpers';

// รันทีละ test (workers = 1 ใน playwright.config.ts) · ไม่ใช้โหมด serial เพื่อให้ TC ที่ล้มไม่ข้าม TC ถัดไป

test.afterEach(async () => {
  await disposeAll();
});

// ───────────────────────── ตัวช่วยเฉพาะไฟล์นี้ ─────────────────────────

const ROLE_TH: Record<string, string> = {
  citizen: 'ประชาชน',
  officer: 'เจ้าหน้าที่',
  head: 'หัวหน้าฝ่าย',
  executive: 'ผู้บริหาร',
  auditor: 'ผู้ตรวจสอบภายใน',
  admin: 'ผู้ดูแลระบบ',
};

/** ลำดับคิวทะเบียนเริ่มต้น (TEST-DATA 9.1) */
const REG_QUEUE = [20, 22, 24, 23, 25, 26, 13, 15, 27, 28, 29, 30, 16, 18, 19, 12, 21].map(cn);

/** เปิดหน้าเคสเจ้าหน้าที่ / ประชาชน */
const officerCase = (p: Page, n: number | string) => p.goto(`/officer/cases/${typeof n === 'number' ? cn(n) : n}`);
const citizenCase = (p: Page, n: number | string) => p.goto(`/citizen/cases/${typeof n === 'number' ? cn(n) : n}`);

/** ตั้งค่า input แล้วกระตุ้น input/change (หน้าคำนวณค่าธรรมเนียมทันที) */
async function setField(loc: Locator, value: string): Promise<void> {
  await loc.fill(value);
  await loc.dispatchEvent('change');
}

/** ปุ่มในแถว queue-row ของเลขคำขอ */
const queueRow = (p: Page, n: number) => rowOf(p, 'queue-row', cn(n));

/** owner ว่าง (null / '' / undefined) */
function expectNoOwner(owner: unknown): void {
  expect(owner === null || owner === undefined || owner === '', `owner ว่าง (ได้ ${JSON.stringify(owner)})`).toBe(true);
}

/** จำนวนงานในมือของเจ้าหน้าที่จาก /officer/queue */
async function expectWorkload(p: Page, n: number): Promise<void> {
  await p.goto('/officer/queue');
  await expect(tid(p, 'workload-count')).toHaveText(String(n));
}

/** เลือก filter ของคิว */
async function selectQueueFilter(p: Page, v: 'all' | 'unclaimed' | 'mine'): Promise<void> {
  const sel = tid(p, 'queue-filter');
  await sel.selectOption(v);
  await p.waitForLoadState();
  await expect(tid(p, 'queue-filter')).toHaveValue(v);
}

/** หน้า /verify (ไม่ล็อกอิน · context ใหม่) */
async function anonPage(browser: Browser): Promise<Page> {
  return newPage(browser);
}

/** แจ้งเตือนของคำขอหนึ่งใน `caseNo:level` */
const notiOf = (list: string[], n: number) => list.filter((x) => x.startsWith(cn(n) + ':'));

/** คลิกแล้วรอไฟล์ดาวน์โหลด (ไม่ดัก route) */
async function clickDownload(page: Page, click: () => Promise<void>): Promise<{ buf: Buffer; filename: string }> {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), click()]);
  const p = await dl.path();
  return { buf: fs.readFileSync(p!), filename: dl.suggestedFilename() };
}

/** ข้อความ audit ของเหตุการณ์ที่ตรงเงื่อนไข (API) */
async function auditOf(c: APIRequestContext, q: Record<string, string>): Promise<any[]> {
  const j = await auditApi(c, q);
  expect(j.count, 'audit count = items.length').toBe(j.items.length);
  return j.items;
}

/** ตรวจ JSON ไม่มีเลขบัตรเต็ม (TC-PDPA-02) */
function expectNoFullId(j: unknown, label: string): void {
  const s = JSON.stringify(j);
  expect(s, `${label}: \\d{13}`).not.toMatch(/\d{13}/);
  expect(s, `${label}: d-dddd-ddddd-dd-d`).not.toMatch(/\d-\d{4}-\d{5}-\d{2}-\d/);
  expect(hasKeyDeep(j, 'idNo'), `${label}: key idNo`).toBe(false);
  for (const raw of [ID.somying, ID.somchai, ID.piti]) expect(s, `${label}: ${raw}`).not.toContain(raw);
}

/** ชื่อที่เข้าถึงได้ของ input/select/textarea ที่มองเห็น — คืนรายการที่ไม่มีชื่อ */
async function unlabeledFields(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const els = Array.from(document.querySelectorAll('input, select, textarea')) as HTMLElement[];
    for (const el of els) {
      const inp = el as HTMLInputElement;
      if (inp.type === 'hidden') continue;
      const st = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (st.display === 'none' || st.visibility === 'hidden' || r.width === 0 || r.height === 0) continue;
      const txt = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      let name = txt(el.getAttribute('aria-label'));
      if (!name) {
        const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
        name = txt(ids.map((i) => document.getElementById(i)?.textContent ?? '').join(' '));
      }
      if (!name && inp.labels) name = txt(Array.from(inp.labels).map((l) => l.textContent ?? '').join(' '));
      if (!name) name = txt(el.getAttribute('title'));
      if (!name) out.push(el.getAttribute('data-testid') || el.getAttribute('name') || el.outerHTML.slice(0, 80));
    }
    return out;
  });
}

/** ตรวจหน้าไม่มี scroll แนวนอน */
async function expectNoHScroll(page: Page, label: string): Promise<void> {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(r.sw, `${label}: scrollWidth ${r.sw} > innerWidth ${r.iw}`).toBeLessThanOrEqual(r.iw);
}

/** กด Tab จนโฟกัสถึง data-testid ที่ต้องการ แล้วตรวจว่ามีวงโฟกัสมองเห็น */
async function tabTo(page: Page, testid: string, max = 60): Promise<void> {
  for (let i = 0; i < max; i++) {
    const cur = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '');
    if (cur === testid) break;
    await page.keyboard.press('Tab');
  }
  const info = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return { id: '', outline: 'none', width: '0px', shadow: 'none' };
    const st = getComputedStyle(el);
    return { id: el.getAttribute('data-testid') ?? '', outline: st.outlineStyle, width: st.outlineWidth, shadow: st.boxShadow };
  });
  expect(info.id, `Tab ถึง ${testid}`).toBe(testid);
  const visibleRing = (info.outline !== 'none' && info.width !== '0px') || (info.shadow && info.shadow !== 'none');
  expect(visibleRing, `วงโฟกัสของ ${testid} (outline=${info.outline} ${info.width} shadow=${info.shadow})`).toBeTruthy();
}

/** ไฟล์ DB สำหรับ inspection */
function dbFiles(): string[] {
  const cands = [process.env.DB_PATH, path.resolve(process.cwd(), 'data/egov.db'), path.resolve(__dirname, '../data/egov.db')]
    .filter((x): x is string => !!x)
    .filter((p) => fs.existsSync(p));
  const base = cands[0];
  if (!base) return [];
  const dir = path.dirname(base);
  const out = new Set<string>([base]);
  for (const ext of ['-wal', '-shm', '-journal']) if (fs.existsSync(base + ext)) out.add(base + ext);
  for (const f of fs.readdirSync(dir)) if (/\.(log|sql|dump|txt)$/i.test(f)) out.add(path.join(dir, f));
  return [...out];
}

// ═════════════════════════ AUTH ═════════════════════════

test('TC-AUTH-01 เลขบัตร 13 หลัก + checksum', async ({ browser }) => {
  await reset();
  const api = await newApi();
  const page = await newPage(browser);

  const invalid = ['110170012345', '11017001234567', ID.badChecksum, '11017001234ab'];
  for (const v of invalid) {
    await page.goto('/login');
    await tid(page, 'login-tab-citizen').click();
    const input = tid(page, 'thaid-id-input');
    await input.fill(v);
    await expect(input, `ช่องรับครบ ${v.length} ตัว (ไม่จำกัด maxlength)`).toHaveValue(v);
    await expect(tid(page, 'thaid-submit')).toHaveText('เข้าสู่ระบบด้วย ThaiD (จำลอง)');
    await tid(page, 'thaid-submit').click();
    await expect(tid(page, 'thaid-error')).toHaveText(MSG.INVALID_ID);
    await expectNotShown(tid(page, 'otp-step'));
    await expectErr(await thaidStart(api, v), 400, 'INVALID_ID', MSG.INVALID_ID);
  }

  for (const v of [ID.somchai, ID.somying, ID.piti, ID.mana]) {
    await page.goto('/login');
    await tid(page, 'login-tab-citizen').click();
    await tid(page, 'thaid-id-input').fill(v);
    await tid(page, 'thaid-submit').click();
    await expect(tid(page, 'otp-step')).toBeVisible();
    await expectNotShown(tid(page, 'thaid-error'));
    const j = await expectOk(await thaidStart(api, v), 200);
    expect(j).toEqual({ status: 'OTP_SENT' });
  }
});

test('TC-AUTH-02 OTP ผิด 3 ครั้งล็อก 15 นาที', async ({ browser }) => {
  await reset();
  // 1–3 ผ่านหน้าจอ
  const page = await newPage(browser);
  await uiLoginC(page, ID.piti, '000000');
  await expect(tid(page, 'otp-error')).toHaveText(MSG.OTP_INVALID);
  await expect(tid(page, 'otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');
  await tid(page, 'otp-input').fill('000000');
  await tid(page, 'otp-submit').click();
  await expect(tid(page, 'otp-attempts-left')).toHaveText('เหลือ 1 ครั้ง');
  await tid(page, 'otp-input').fill('000000');
  await tid(page, 'otp-submit').click();
  await expect(tid(page, 'lock-message')).toHaveText(MSG.LOCKED);
  await expect(tid(page, 'lock-until')).toHaveAttribute('data-iso', '2026-12-01T09:15:00+07:00');

  // 4 OTP ถูกทันที → ยัง 423
  const a = await newApi();
  await thaidStart(a, ID.piti);
  const j4 = await expectErr(await thaidVerify(a, ID.piti, OTP), 423, 'LOCKED', MSG.LOCKED);
  expect(Date.parse(j4.lockedUntil)).toBe(Date.parse('2026-12-01T09:15:00+07:00'));

  // 5 สมชายล็อกอินได้
  const s = await loginC(ID.somchai);
  expect((await expectOk(await s.get('/api/me'), 200)).role).toBe('citizen');

  // 6 09:14:59 ยังล็อก
  await setClock('2026-12-01T09:14:59+07:00');
  const b = await newApi();
  await thaidStart(b, ID.piti);
  await expectErr(await thaidVerify(b, ID.piti, OTP), 423, 'LOCKED');

  // 7 09:15:00 ปลดล็อก ตัวนับเริ่มใหม่
  await setClock('2026-12-01T09:15:00+07:00');
  const p7 = await newPage(browser);
  await uiLoginC(p7, ID.piti, '000000');
  await expect(tid(p7, 'otp-error')).toHaveText(MSG.OTP_INVALID);
  await expect(tid(p7, 'otp-attempts-left')).toHaveText('เหลือ 2 ครั้ง');
  // 8 OTP ถูก → สำเร็จ
  await tid(p7, 'otp-input').fill(OTP);
  await tid(p7, 'otp-submit').click();
  await expectPath(p7, '/citizen');

  // 9 RESET · ผิด 2 → ถูก → ออก → ผิด 2 → ไม่ล็อก
  await reset();
  const c = await newApi();
  await expectOk(await thaidStart(c, ID.piti), 200);
  expect((await expectErr(await thaidVerify(c, ID.piti, '000000'), 401, 'OTP_INVALID', MSG.OTP_INVALID)).attemptsLeft).toBe(2);
  expect((await expectErr(await thaidVerify(c, ID.piti, '000000'), 401, 'OTP_INVALID')).attemptsLeft).toBe(1);
  await expectOk(await thaidVerify(c, ID.piti, OTP), 200);
  expect((await c.post('/api/auth/logout')).status()).toBe(204);
  await expectOk(await thaidStart(c, ID.piti), 200);
  expect((await expectErr(await thaidVerify(c, ID.piti, '000000'), 401, 'OTP_INVALID')).attemptsLeft).toBe(2);
  expect((await expectErr(await thaidVerify(c, ID.piti, '000000'), 401, 'OTP_INVALID')).attemptsLeft).toBe(1);
  await expectOk(await thaidVerify(c, ID.piti, OTP), 200);
});

test('TC-AUTH-03 ลงทะเบียนครั้งแรก', async ({ browser }) => {
  await reset();
  const page = await newPage(browser);
  await uiLoginC(page, ID.mana);
  await expectPath(page, '/register');

  // 1 reg-name อ่านอย่างเดียว
  const name = tid(page, 'reg-name');
  await expect(name).toHaveValue('มานะ ตั้งใจ');
  expect(await name.evaluate((e) => (e as HTMLInputElement).readOnly)).toBe(true);
  await name.focus();
  await page.keyboard.type('abc');
  await expect(name).toHaveValue('มานะ ตั้งใจ');

  // 2–4 เบอร์ผิด
  for (const m of ['081234567', '08123456789', '1812345678', '08123abcde']) {
    await tid(page, 'reg-mobile').fill(m);
    await tid(page, 'reg-consent').check();
    await tid(page, 'reg-submit').click();
    await expect(tid(page, 'reg-error-mobile'), `เบอร์ ${m}`).toHaveText(MSG.INVALID_MOBILE);
    await expectPath(page, '/register');
  }
  // 5 ไม่ติ๊กยินยอม
  await tid(page, 'reg-mobile').fill('0845678901');
  await tid(page, 'reg-consent').uncheck();
  await tid(page, 'reg-submit').click();
  await expect(tid(page, 'reg-error-consent')).toHaveText(MSG.CONSENT_REQUIRED);
  await expectPath(page, '/register');
  // 6 สำเร็จ
  await tid(page, 'reg-mobile').fill('0845678901');
  await tid(page, 'reg-email').fill('');
  await tid(page, 'reg-consent').check();
  await expect(tid(page, 'reg-submit')).toHaveText('ลงทะเบียน');
  await tid(page, 'reg-submit').click();
  await expectPath(page, '/citizen');
  await expect(tid(page, 'citizen-welcome')).toHaveText('สวัสดี มานะ ตั้งใจ');
  // 7 ออกแล้วเข้าใหม่ → /citizen ตรง
  await tid(page, 'logout-btn').click();
  await expectPath(page, '/login');
  await uiLoginC(page, ID.mana);
  await expectPath(page, '/citizen');

  // 8 RESET · API
  await reset();
  const c = await newApi();
  await expectOk(await thaidStart(c, ID.mana), 200);
  const v = await expectOk(await thaidVerify(c, ID.mana, OTP), 200);
  expect(v.registered).toBe(false);
  await expectErr(
    await c.post('/api/auth/register', { data: { mobile: '081234567', email: '', consent: true } }),
    400,
    'INVALID_MOBILE',
    MSG.INVALID_MOBILE,
  );
  await expectErr(
    await c.post('/api/auth/register', { data: { mobile: '0845678901', email: '', consent: false } }),
    400,
    'CONSENT_REQUIRED',
    MSG.CONSENT_REQUIRED,
  );
});

test('TC-AUTH-04 เจ้าหน้าที่ SSO จำลองและหน้าตั้งต้นตามบทบาท', async ({ browser }) => {
  await reset();
  const rows: Array<[string, string, string, string | null]> = [
    ['off.reg1', '/officer/queue', 'officer', 'registry'],
    ['off.reg2', '/officer/queue', 'officer', 'registry'],
    ['off.works1', '/officer/queue', 'officer', 'works'],
    ['head1', '/head/approvals', 'head', null],
    ['exec1', '/dashboard', 'executive', null],
    ['audit1', '/audit', 'auditor', null],
    ['admin1', '/admin/services', 'admin', null],
  ];
  const page = await newPage(browser);
  for (const [u, landing, role, dept] of rows) {
    await page.goto('/login');
    await tid(page, 'login-tab-staff').click();
    await expect(tid(page, 'staff-submit')).toHaveText('เข้าสู่ระบบเจ้าหน้าที่ (SSO ภาครัฐ จำลอง)');
    await uiLoginS(page, u);
    await expectPath(page, landing);
    await expect(tid(page, 'user-name')).toHaveText(STAFF_NAME[u]);
    const r = tid(page, 'user-role');
    await expect(r).toHaveText(ROLE_TH[role]);
    await expect(r).toHaveAttribute('data-role', role);
    if (dept) await expect(r).toHaveAttribute('data-dept', dept);
    await tid(page, 'logout-btn').click();
    await expectPath(page, '/login');
  }

  // ผิด 3 กรณี ข้อความเดียวกัน
  const api = await newApi();
  for (const [u, pw] of [
    ['off.reg1', 'wrong'],
    ['nobody', 'Test@1234'],
    [ID.somchai, 'Test@1234'],
  ]) {
    await uiLoginS(page, u, pw);
    await expect(tid(page, 'staff-error'), `${u}/${pw}`).toHaveText(MSG.INVALID_CREDENTIALS);
    await expectErr(await staffLogin(api, u, pw), 401, 'INVALID_CREDENTIALS', MSG.INVALID_CREDENTIALS);
  }

  // หลังออกจากระบบ เปิดหน้าที่ต้องล็อกอิน → /login
  await uiLoginS(page, 'off.reg1');
  await expectPath(page, '/officer/queue');
  await tid(page, 'logout-btn').click();
  await expectPath(page, '/login');
  await page.goto('/officer/queue');
  await expectPath(page, '/login');
});

// ═════════════════════════ FEE ═════════════════════════

test('TC-FEE-01 ค่าธรรมเนียม SV-01 / SV-02 / SV-03', async ({ browser }) => {
  await reset();
  const page = await citizenPage(browser, ID.somchai);
  const api = page.request;

  // SV-03
  await page.goto('/citizen/new/SV-03');
  await expect(tid(page, 'service-name')).toHaveText('ขออนุญาตก่อสร้าง/ต่อเติมอาคาร');
  const sv03: Array<[number, string, string | null, string | null]> = [
    [0, '–', MSG.INVALID_AREA, 'INVALID_AREA'],
    [-1, '–', MSG.INVALID_AREA, 'INVALID_AREA'],
    [1, '฿1,000', null, null],
    [100, '฿1,000', null, null],
    [101, '฿1,010', null, null],
    [102, '฿1,020', null, null],
    [250, '฿2,500', null, null],
    [300, '฿3,000', null, null],
    [499, '฿4,990', null, null],
    [500, '฿5,000', null, null],
    [501, '–', MSG.AREA_TOO_LARGE, 'AREA_TOO_LARGE'],
  ];
  for (const [area, fee, err, code] of sv03) {
    await setField(tid(page, 'area-input'), String(area));
    await expect(tid(page, 'fee-total'), `พื้นที่ ${area}`).toHaveText(fee);
    if (err) {
      await expect(tid(page, 'fee-error')).toHaveText(err);
      await expect(tid(page, 'to-upload-btn')).toBeDisabled();
      await expectErr(await api.post(abs('/api/drafts'), { data: { serviceId: 'SV-03', areaSqm: area } }), 400, code!, err);
    } else {
      await expectNotShown(tid(page, 'fee-error'));
      await expect(tid(page, 'to-upload-btn')).toBeEnabled();
      const j = await expectOk(await api.post(abs('/api/drafts'), { data: { serviceId: 'SV-03', areaSqm: area } }), 201);
      expect(j.fee, `API fee พื้นที่ ${area}`).toBe(Number(fee.replace(/[฿,]/g, '')));
    }
  }

  // SV-01
  await page.goto('/citizen/new/SV-01');
  await expect(tid(page, 'service-name')).toHaveText('ขอหนังสือรับรอง');
  await expect(tid(page, 'qty-input')).toHaveValue('1');
  const sv01: Array<[number, string | null]> = [
    [0, null],
    [1, '฿20'],
    [2, '฿40'],
    [3, '฿60'],
    [4, '฿80'],
    [5, '฿100'],
    [6, null],
  ];
  for (const [qty, fee] of sv01) {
    await setField(tid(page, 'qty-input'), String(qty));
    if (fee) {
      await expect(tid(page, 'fee-total'), `qty ${qty}`).toHaveText(fee);
      await expectNotShown(tid(page, 'fee-error'));
      const j = await expectOk(await api.post(abs('/api/drafts'), { data: { serviceId: 'SV-01', qty } }), 201);
      expect(j.fee).toBe(Number(fee.replace(/[฿,]/g, '')));
    } else {
      await expect(tid(page, 'fee-error'), `qty ${qty}`).toHaveText(MSG.INVALID_QTY);
      await expect(tid(page, 'fee-total')).toHaveText('–');
      await expect(tid(page, 'to-upload-btn')).toBeDisabled();
      await expectErr(await api.post(abs('/api/drafts'), { data: { serviceId: 'SV-01', qty } }), 400, 'INVALID_QTY', MSG.INVALID_QTY);
    }
  }

  // SV-02
  await page.goto('/citizen/new/SV-02');
  await expect(tid(page, 'service-name')).toHaveText('ขออนุญาตประกอบกิจการ');
  await expect(tid(page, 'qty-input')).toHaveCount(0);
  await expect(tid(page, 'area-input')).toHaveCount(0);
  await expect(tid(page, 'fee-total')).toHaveText('฿500');
  const j2 = await expectOk(await api.post(abs('/api/drafts'), { data: { serviceId: 'SV-02' } }), 201);
  expect(j2.fee).toBe(500);
});

// ═════════════════════════ SUBMIT ═════════════════════════

test('TC-SUBMIT-01 ยื่นคำขอ SV-01 ครบวงจร', async ({ browser }) => {
  await reset();
  const page = await citizenPage(browser, ID.somchai);

  // 1
  await page.goto('/citizen');
  await tid(page, 'start-service-SV-01').click();
  await expectPath(page, '/citizen/new/SV-01');
  await expect(tid(page, 'wizard-step')).toHaveText('1/3 กรอกข้อมูล');
  await setField(tid(page, 'qty-input'), '2');
  await expect(tid(page, 'fee-total')).toHaveText('฿40');
  await tid(page, 'to-upload-btn').click();
  // 2
  await expect(tid(page, 'wizard-step')).toHaveText('2/3 แนบเอกสาร');
  await expect(tid(page, 'to-payment-btn')).toBeDisabled();
  await attachUi(page, 'id-card', tf('id-card.pdf'));
  await expect(tid(page, 'file-item')).toHaveCount(1);
  await expect(tid(page, 'file-item')).toHaveAttribute('data-doc-key', 'id-card');
  await expect(tid(page, 'to-payment-btn')).toBeEnabled();
  await expect(tid(page, 'to-payment-btn')).toHaveText('ไปชำระเงิน');
  await tid(page, 'to-payment-btn').click();
  // 3
  await expect(tid(page, 'wizard-step')).toHaveText('3/3 ชำระเงิน');
  await expect(tid(page, 'payment-amount')).toHaveText('฿40');
  await tid(page, 'create-qr-btn').click();
  await expect(tid(page, 'qr-ref')).toHaveText('PP-0002');
  await expect(tid(page, 'qr-expires')).toHaveAttribute('data-iso', '2026-12-01T09:15:00+07:00');
  await expect(tid(page, 'qr-expires')).toHaveText('หมดอายุ 1 ธ.ค. 2569 09:15');
  await expect(tid(page, 'payment-status')).toHaveText('รอชำระ');
  await expect(tid(page, 'payment-status')).toHaveAttribute('data-status', 'PENDING');
  // 4
  const pj = await expectOk(await pay('PP-0002', 40), 200);
  expect(pj).toEqual({ status: 'PAID', caseNo: cn(31), receiptNo: 'RC-2569-000031', duplicate: false });
  await tid(page, 'refresh-payment-btn').click();
  await expect(tid(page, 'payment-status')).toHaveText('ชำระแล้ว');
  await expect(tid(page, 'payment-status')).toHaveAttribute('data-status', 'PAID');
  await expect(tid(page, 'submitted-case-no')).toHaveText(cn(31));
  await expect(tid(page, 'receipt-no')).toHaveText('RC-2569-000031');
  await expect(tid(page, 'receipt-amount')).toHaveText('฿40');
  await expect(tid(page, 'receipt-paid-at')).toHaveAttribute('data-iso', '2026-12-01T09:00:00+07:00');
  // 5
  await tid(page, 'go-case-btn').click();
  await expectPath(page, `/citizen/cases/${cn(31)}`);
  await expectStatus(page, 'SUBMITTED');
  await expect(tid(page, 'case-fee')).toHaveText('฿40');
  await expect(tid(page, 'sla-due')).toHaveText('4 ธ.ค. 2569 16:30');
  await expect(tid(page, 'sla-due')).toHaveAttribute('data-iso', '2026-12-04T16:30:00+07:00');
  await expectLevel(page, 'normal');
  await expect(tid(page, 'cancel-case-btn')).toHaveCount(1);
  await expect(tid(page, 'case-step')).toHaveCount(0);

  // off.reg1 เห็นในคิว ท้ายกลุ่ม 4 ธ.ค.
  const o = await staffPage(browser, 'off.reg1');
  await o.goto('/officer/queue');
  const row = queueRow(o, 31);
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('row-owner')).toHaveText('');
  await expect(row.getByTestId('claim-btn')).toHaveCount(1);
  await expectCaseOrder(o, 'queue-row', [20, 22, 24, 23, 25, 26, 13, 15, 27, 28, 29, 30, 31, 16, 18, 19, 12, 21].map(cn));
});

test('TC-SUBMIT-02 เอกสารบังคับครบก่อนชำระ', async ({ browser }) => {
  await reset();
  const page = await citizenPage(browser, ID.somchai);

  // SV-02
  await wizardToUpload(page, 'SV-02');
  await attachUi(page, 'id-card', tf('id-card.pdf'));
  await expect(tid(page, 'to-payment-btn')).toBeDisabled();
  await expect(tid(page, 'missing-docs')).toHaveText('ยังขาดเอกสาร: แผนที่ตั้ง');
  await attachUi(page, 'map', tf('map.pdf'));
  await expect(tid(page, 'to-payment-btn')).toBeEnabled();
  await expectNotShown(tid(page, 'missing-docs'));
  await removeFileUi(page, byAttr(page, 'file-item', 'data-doc-key', 'map'));
  await expect(tid(page, 'to-payment-btn')).toBeDisabled();
  await expect(tid(page, 'missing-docs')).toHaveText('ยังขาดเอกสาร: แผนที่ตั้ง');

  // SV-03 พื้นที่ 100
  await wizardToUpload(page, 'SV-03', { area: 100 });
  await attachUi(page, 'id-card', tf('id-card.pdf'));
  await expect(tid(page, 'to-payment-btn')).toBeDisabled();
  await expect(tid(page, 'missing-docs')).toHaveText('ยังขาดเอกสาร: แบบแปลน, โฉนด');
  await attachUi(page, 'deed', tf('deed.pdf'));
  await expect(tid(page, 'to-payment-btn')).toBeDisabled();
  await expect(tid(page, 'missing-docs')).toHaveText('ยังขาดเอกสาร: แบบแปลน');
  await attachUi(page, 'plan', tf('plan-as-jpg.jpg'), false);
  await expect(tid(page, 'upload-error')).toHaveText(MSG.PLAN_NOT_PDF);
  await expect(tid(page, 'file-item')).toHaveCount(2);
  await expect(tid(page, 'to-payment-btn')).toBeDisabled();
  await expect(tid(page, 'missing-docs')).toHaveText('ยังขาดเอกสาร: แบบแปลน');
  await attachUi(page, 'plan', tf('plan.pdf'));
  await expect(tid(page, 'to-payment-btn')).toBeEnabled();
  await expectNotShown(tid(page, 'missing-docs'));

  // API
  const c = page.request;
  const d = await createDraft(c, 'SV-03', { area: 100 });
  await uploadOk(c, d.draftId, 'id-card', 'id-card.pdf');
  await uploadOk(c, d.draftId, 'deed', 'deed.pdf');
  const e = await expectErr(await c.post(abs(`/api/drafts/${d.draftId}/payment`)), 409, 'MISSING_DOCS');
  expect(e.missing).toEqual(['แบบแปลน']);
  await uploadOk(c, d.draftId, 'plan', 'plan.pdf');
  await expectOk(await c.post(abs(`/api/drafts/${d.draftId}/payment`)), 201);
});

test('TC-SUBMIT-03 ร่าง การลบร่าง และการยกเลิก', async ({ browser }) => {
  // ── ส่วน A ร่าง
  await reset();
  let page = await citizenPage(browser, ID.somchai);
  await page.goto('/citizen');
  await expect(tid(page, 'my-case-row')).toHaveCount(10);
  await expect(tid(page, 'my-draft-row')).toHaveCount(2);
  await expect(byAttr(page, 'my-draft-row', 'data-draft-id', 'DR-0001')).toHaveAttribute('data-status', 'DRAFT');
  await expect(byAttr(page, 'my-draft-row', 'data-draft-id', 'DR-0002')).toHaveAttribute('data-status', 'PENDING_PAYMENT');
  for (const t of await tid(page, 'my-draft-row').allInnerTexts()) expect(t).not.toContain('EG-');
  await byAttr(page, 'my-draft-row', 'data-draft-id', 'DR-0001').getByTestId('open-draft-btn').click();
  await expectPath(page, '/citizen/new/SV-01');
  expect(new URL(page.url()).searchParams.get('draft')).toBe('DR-0001');
  await expect(tid(page, 'qty-input')).toHaveValue('2');
  await expect(tid(page, 'fee-total')).toHaveText('฿40');
  await page.goto('/citizen/new/SV-01');
  await setField(tid(page, 'qty-input'), '3');
  await expect(tid(page, 'save-draft-btn')).toHaveText('บันทึกร่าง');
  await tid(page, 'save-draft-btn').click();
  await expect(tid(page, 'draft-id')).toHaveText('DR-0003');
  await page.goto('/citizen');
  await expect(tid(page, 'my-case-row')).toHaveCount(10);
  expect((await myCases(page.request)).length).toBe(10);
  expect((await expectOk(await page.request.get(abs('/api/drafts')), 200)).items.length).toBe(3);

  // ── ส่วน B ยกเลิก
  await reset();
  page = await citizenPage(browser, ID.somchai);
  await citizenCase(page, 30);
  await expect(tid(page, 'cancel-case-btn')).toHaveCount(1);
  await expect(tid(page, 'cancel-case-btn')).toHaveText('ยกเลิกคำขอ');
  await tid(page, 'cancel-case-btn').click();
  await expect(tid(page, 'cancel-confirm-text')).toHaveText(MSG.NO_REFUND);
  await tid(page, 'confirm-cancel-btn').click();
  await expectStatus(page, 'CANCELLED');
  await expect(tid(page, 'no-refund-note')).toHaveText(MSG.NO_REFUND);
  await expect(tid(page, 'cancel-case-btn')).toHaveCount(0);
  const o = await staffPage(browser, 'off.reg1');
  await o.goto('/officer/queue');
  await expect(tid(o, 'queue-row')).toHaveCount(16);
  await expect(queueRow(o, 30)).toHaveCount(0);
  const ex = await staffPage(browser, 'exec1');
  await ex.goto('/dashboard');
  await expect(tid(ex, 'kpi-backlog')).toHaveText('20');
  await expect(tid(ex, 'kpi-received')).toHaveText('3');

  // ── ส่วน C ยกเลิกไม่ได้เมื่อมีผู้รับ
  await reset();
  const r1 = await loginS('off.reg1');
  await expectOk(await act.claim(r1, cn(30)), 200);
  page = await citizenPage(browser, ID.somchai);
  await citizenCase(page, 30);
  await expectStatus(page, 'IN_REVIEW');
  await expect(tid(page, 'cancel-case-btn')).toHaveCount(0);
  await expectErr(await act.cancel(page.request, cn(30)), 409, 'CANNOT_CANCEL', MSG.CANNOT_CANCEL);
  await expectErr(await act.cancel(page.request, cn(13)), 409, 'CANNOT_CANCEL');

  // ── ส่วน E ลบร่าง
  await reset();
  const s = await loginC(ID.somchai);
  expect((await s.delete('/api/drafts/DR-0001')).status()).toBe(204);
  await expectErr(await s.get('/api/drafts/DR-0001'), 404, 'NOT_FOUND');
  page = await citizenPage(browser, ID.somchai);
  await page.goto('/citizen');
  await expect(tid(page, 'my-draft-row')).toHaveCount(1);
  await expect(tid(page, 'my-draft-row')).toHaveAttribute('data-draft-id', 'DR-0002');
  expect((await s.delete('/api/drafts/DR-0002')).status()).toBe(204);
  expect((await s.get('/api/payments/PP-0001')).status()).toBe(404);
  expect((await pay('PP-0001', 500)).status()).toBe(404);
  expect((await myCases(s)).length).toBe(10);

  // ── ส่วน F ยกเลิกชนกับรับเรื่อง
  await reset();
  const cit = await loginC(ID.somchai);
  const off = await loginS('off.reg1');
  const [rc, rk] = await Promise.all([act.cancel(cit, cn(30)), act.claim(off, cn(30))]);
  const cs = rc.status();
  const ks = rk.status();
  expect([cs, ks].filter((x) => x === 200).length, `cancel=${cs} claim=${ks} ต้องสำเร็จฝั่งเดียว`).toBe(1);
  const g = await getCase(off, cn(30));
  if (cs === 200) {
    await expectErr(rk, 409, 'INVALID_STATE');
    expect(g.status).toBe('CANCELLED');
    expectNoOwner(g.owner);
    expect((await queueApi(off, 'mine')).length).toBe(3);
  } else {
    await expectErr(rc, 409, 'CANNOT_CANCEL');
    expect(g.status).toBe('IN_REVIEW');
    expect(g.owner).toBe('off.reg1');
    expect((await queueApi(off, 'mine')).length).toBe(4);
  }
});

// ═════════════════════════ UPLOAD ═════════════════════════

test('TC-UPLOAD-01 ขนาดและจำนวนไฟล์', async ({ browser }) => {
  test.setTimeout(360_000);
  await reset();
  const page = await citizenPage(browser, ID.somchai);
  const c = page.request;
  await wizardToUpload(page, 'SV-01', { qty: 1 });

  // ขนาด (UI)
  await attachUi(page, 'id-card', tf('size-5242879.pdf'));
  await expect(tid(page, 'file-item')).toHaveCount(1);
  await removeFileUi(page, tid(page, 'file-item').first());
  await attachUi(page, 'id-card', tf('size-5242880.pdf'));
  await expect(tid(page, 'file-item')).toHaveCount(1);
  await expectNotShown(tid(page, 'upload-error'));
  await removeFileUi(page, tid(page, 'file-item').first());
  await attachUi(page, 'id-card', tf('size-5242881.pdf'), false);
  await expect(tid(page, 'upload-error')).toHaveText(MSG.FILE_TOO_LARGE);
  await expect(tid(page, 'file-item')).toHaveCount(0);

  // ขนาด (API)
  const d = await createDraft(c, 'SV-01', { qty: 1 });
  const a1 = await expectOk(await uploadRaw(c, d.draftId, 'id-card', tf('size-5242879.pdf')), 201);
  expect(a1.size).toBe(5_242_879);
  const a2 = await expectOk(await uploadRaw(c, d.draftId, 'extra', tf('size-5242880.pdf')), 201);
  expect(a2.size).toBe(5_242_880);
  await expectErr(await uploadRaw(c, d.draftId, 'extra', tf('size-5242881.pdf')), 400, 'FILE_TOO_LARGE', MSG.FILE_TOO_LARGE);

  // จำนวน (UI)
  await attachUi(page, 'id-card', tf('id-card.pdf'));
  for (const i of [1, 2, 3, 4]) await attachUi(page, 'extra', tf(`multi-${i}.pdf`));
  await expect(tid(page, 'file-item')).toHaveCount(5);
  await attachUi(page, 'extra', tf('multi-5.pdf'), false);
  await expect(tid(page, 'upload-error')).toHaveText(MSG.FILE_COUNT);
  await expect(tid(page, 'file-item')).toHaveCount(5);
  await removeFileUi(page, byAttr(page, 'file-item', 'data-name', 'multi-4.pdf'));
  await attachUi(page, 'extra', tf('multi-5.pdf'));
  await expect(tid(page, 'file-item')).toHaveCount(5);

  // จำนวน (API)
  const d2 = await createDraft(c, 'SV-01', { qty: 1 });
  await uploadOk(c, d2.draftId, 'id-card', 'id-card.pdf');
  for (const i of [1, 2, 3, 4]) await uploadOk(c, d2.draftId, 'extra', `multi-${i}.pdf`);
  await expectErr(await uploadRaw(c, d2.draftId, 'extra', tf('multi-5.pdf')), 400, 'FILE_COUNT', MSG.FILE_COUNT);
});

/** จำนวนไฟล์ในร่างจาก GET /api/drafts/:id (นับวัตถุที่มี fileId) */
function countFileObjs(j: unknown): number {
  if (Array.isArray(j)) return j.reduce((s, v) => s + countFileObjs(v), 0);
  if (j && typeof j === 'object') {
    const o = j as Record<string, unknown>;
    return ('fileId' in o ? 1 : 0) + Object.values(o).reduce<number>((s, v) => s + countFileObjs(v), 0);
  }
  return 0;
}

test('TC-UPLOAD-02 ชนิดไฟล์จากเนื้อไฟล์', async ({ browser }) => {
  await reset();
  const page = await citizenPage(browser, ID.somchai);
  const c = page.request;
  await wizardToUpload(page, 'SV-01', { qty: 1 });

  for (const n of ['ok-id.pdf', 'real.jpg', 'real.png']) {
    await attachUi(page, 'id-card', tf(n));
    await expect(tid(page, 'file-item')).toHaveCount(1);
    await removeFileUi(page, tid(page, 'file-item').first());
  }
  const bad = [tf('fake-text.pdf'), tf('fake-text.jpg'), tf('exe-as.png'), tf('notes.txt'), tf('fake-text.pdf', 'application/pdf')];
  for (const f of bad) {
    await attachUi(page, 'id-card', f, false);
    await expect(tid(page, 'upload-error'), f.name).toHaveText(MSG.FILE_TYPE);
    await expect(tid(page, 'file-item')).toHaveCount(0);
  }

  // API
  const d = await createDraft(c, 'SV-01', { qty: 1 });
  for (const n of ['ok-id.pdf', 'real.jpg', 'real.png']) await expectOk(await uploadRaw(c, d.draftId, 'extra', tf(n)), 201);
  const d2 = await createDraft(c, 'SV-01', { qty: 1 });
  await uploadOk(c, d2.draftId, 'id-card', 'ok-id.pdf');
  const before = countFileObjs(await expectOk(await c.get(abs(`/api/drafts/${d2.draftId}`)), 200));
  for (const f of bad) await expectErr(await uploadRaw(c, d2.draftId, 'extra', f), 400, 'FILE_TYPE', MSG.FILE_TYPE);
  const after = countFileObjs(await expectOk(await c.get(abs(`/api/drafts/${d2.draftId}`)), 200));
  expect(after, 'ไฟล์ที่ปฏิเสธไม่ถูกเก็บ').toBe(before);
});

// ═════════════════════════ PAY ═════════════════════════

test('TC-PAY-01 อายุ QR 15:00', async ({ browser }) => {
  // รอบ 1 · 09:00:00 (อายุ 5:00)
  await reset();
  let s = await loginC(ID.somchai);
  let j = await expectOk(await pay('PP-0001', 500), 200);
  expect(j.status).toBe('PAID');
  expect(j.caseNo).toBe(cn(31));

  // รอบ 2 · 09:09:59 (14:59)
  await reset();
  await setClock('2026-12-01T09:09:59+07:00');
  s = await loginC(ID.somchai);
  j = await expectOk(await pay('PP-0001', 500), 200);
  expect(j.status).toBe('PAID');
  expect(j.caseNo).toBe(cn(31));

  // รอบ 3 · 09:10:00 (15:00 พอดี) → หมดอายุ
  await reset();
  await setClock('2026-12-01T09:10:00+07:00');
  s = await loginC(ID.somchai);
  await expectErr(await pay('PP-0001', 500), 410, 'QR_EXPIRED', MSG.QR_EXPIRED);
  expect((await expectOk(await s.get('/api/payments/PP-0001'), 200)).status).toBe('EXPIRED');
  expect((await myCases(s)).length).toBe(10);
  // บนจอ
  const page = await citizenPage(browser, ID.somchai);
  await page.goto('/citizen/new/SV-02?draft=DR-0002');
  await expect(tid(page, 'qr-expired-msg')).toHaveText(MSG.QR_EXPIRED);
  await expect(tid(page, 'payment-status')).toHaveText('QR หมดอายุ');
  await expect(tid(page, 'payment-status')).toHaveAttribute('data-status', 'EXPIRED');
  await expect(tid(page, 'regenerate-qr-btn')).toHaveCount(1);
  await expect(tid(page, 'regenerate-qr-btn')).toHaveText('สร้าง QR ใหม่');
  await tid(page, 'regenerate-qr-btn').click();
  await expect(tid(page, 'qr-ref')).toHaveText('PP-0002');
  await expect(tid(page, 'qr-expires')).toHaveAttribute('data-iso', '2026-12-01T09:25:00+07:00');
  j = await expectOk(await pay('PP-0002', 500), 200);
  expect(j.caseNo).toBe(cn(31));

  // รอบ 4 · 09:10:01 (15:01)
  await reset();
  await setClock('2026-12-01T09:10:01+07:00');
  s = await loginC(ID.somchai);
  await expectErr(await pay('PP-0001', 500), 410, 'QR_EXPIRED');
});

test('TC-PAY-02 ยอดเงินและ callback ซ้ำ', async () => {
  await reset();
  const s = await loginC(ID.somchai);
  const u = await newUnpaid(s, 'SV-01', { qty: 1 });
  expect(u.ref).toBe('PP-0002');
  expect(u.amount).toBe(20);

  await expectErr(await pay('PP-0002', 19), 422, 'AMOUNT_MISMATCH', MSG.AMOUNT_MISMATCH);
  expect((await expectOk(await s.get('/api/payments/PP-0002'), 200)).status).toBe('PENDING');
  expect((await myCases(s)).length).toBe(10);

  await expectErr(await pay('PP-0002', 21), 422, 'AMOUNT_MISMATCH');
  expect((await expectOk(await s.get('/api/payments/PP-0002'), 200)).status).toBe('PENDING');

  const j3 = await expectOk(await pay('PP-0002', 20), 200);
  expect(j3).toMatchObject({ status: 'PAID', caseNo: cn(31), receiptNo: 'RC-2569-000031', duplicate: false });
  expect((await myCases(s)).length).toBe(11);

  const j4 = await expectOk(await pay('PP-0002', 20), 200);
  expect(j4).toMatchObject({ status: 'PAID', caseNo: cn(31), receiptNo: 'RC-2569-000031', duplicate: true });
  expect((await myCases(s)).length).toBe(11);

  const u2 = await newUnpaid(s, 'SV-01', { qty: 1 });
  const j5 = await expectOk(await pay(u2.ref, 20), 200);
  expect(j5.caseNo).toBe(cn(32));
  expect(j5.receiptNo).toBe('RC-2569-000032');
});

test('TC-PAY-03 ชำระพร้อมกัน เลขไม่ซ้ำ', async () => {
  await reset();
  const s = await loginC(ID.somchai);
  const y = await loginC(ID.somying);
  const refs: string[] = [];
  for (const c of [s, s, s, y, y, y]) refs.push((await newUnpaid(c, 'SV-01', { qty: 1 })).ref);
  expect([...refs].sort()).toEqual(['PP-0002', 'PP-0003', 'PP-0004', 'PP-0005', 'PP-0006', 'PP-0007']);

  const res = await Promise.all(refs.map((r) => pay(r, 20)));
  const js = [];
  for (const r of res) js.push(await expectOk(r, 200));
  const cases = js.map((j) => j.caseNo).sort();
  const rcs = js.map((j) => j.receiptNo).sort();
  expect(cases).toEqual([31, 32, 33, 34, 35, 36].map(cn));
  expect(rcs).toEqual([31, 32, 33, 34, 35, 36].map((n) => `RC-2569-0000${n}`));

  const newOf = async (c: APIRequestContext) =>
    (await myCases(c)).map((i) => i.caseNo).filter((x: string) => x >= cn(31));
  const sNew = await newOf(s);
  const yNew = await newOf(y);
  expect(sNew.length).toBe(3);
  expect(yNew.length).toBe(3);
  expect([...sNew, ...yNew].sort()).toEqual(cases);

  const n = await newPaid({ ctx: s });
  expect(n.caseNo).toBe(cn(37));
});

test('TC-PAY-04 เลขคำขอข้ามปี 2569 → 2570', async ({ browser }) => {
  await reset();
  await setClock('2026-12-31T23:58:00+07:00');
  const page = await citizenPage(browser, ID.somchai);
  // 1 สร้างร่าง + QR (ผ่านหน้าจอ เพื่ออ่าน receipt-paid-at)
  const ref = await wizardToQr(page, 'SV-01', { qty: 1 });
  const g1 = await expectOk(await page.request.get(abs(`/api/payments/${ref}`)), 200);
  expect(g1.caseNo ?? null).toBeNull();
  // 2 จ่าย 23:59
  await setClock('2026-12-31T23:59:00+07:00');
  const j2 = await expectOk(await pay(ref, 20), 200);
  expect(j2.caseNo).toBe(cn(31));
  expect(j2.receiptNo).toBe('RC-2569-000031');
  await tid(page, 'refresh-payment-btn').click();
  await expect(tid(page, 'submitted-case-no')).toHaveText(cn(31));
  await expect(tid(page, 'receipt-paid-at')).toHaveAttribute('data-iso', '2026-12-31T23:59:00+07:00');
  // 3 ข้ามปี
  await setClock('2027-01-01T00:00:00+07:00');
  const s = await loginC(ID.somchai);
  const u3 = await newUnpaid(s, 'SV-01', { qty: 1 });
  const j3 = await expectOk(await pay(u3.ref, 20), 200);
  expect(j3.caseNo).toBe('EG-2570-000001');
  expect(j3.receiptNo).toBe('RC-2570-000001');
  // 4
  const u4 = await newUnpaid(s, 'SV-01', { qty: 1 });
  const j4 = await expectOk(await pay(u4.ref, 20), 200);
  expect(j4.caseNo).toBe('EG-2570-000002');
  // 5
  const g = await getCase(s, cn(31));
  expect(g.caseNo).toBe(cn(31));
});

// ═════════════════════════ QUEUE ═════════════════════════

test('TC-QUEUE-01 ลำดับคิวและขอบเขตแผนก', async ({ browser }) => {
  await reset();
  const p1 = await staffPage(browser, 'off.reg1');
  await p1.goto('/officer/queue');
  await expect(tid(p1, 'queue-filter')).toHaveValue('all');
  await expect(tid(p1, 'queue-row')).toHaveCount(17);
  await expectCaseOrder(p1, 'queue-row', REG_QUEUE);
  const lv = tid(p1, 'row-sla-level');
  await expect(lv.nth(0)).toHaveText('เกินกำหนด');
  await expect(lv.nth(1)).toHaveText('ใกล้ครบกำหนด');
  await expect(lv.nth(2)).toHaveText('ใกล้ครบกำหนด');
  for (const m of await tid(p1, 'row-id-masked').allInnerTexts()) expect(m.trim()).toMatch(MASK_RE);
  await expect(tid(p1, 'claim-btn')).toHaveCount(4);
  for (const n of [24, 28, 29, 30]) await expect(queueRow(p1, n).getByTestId('claim-btn')).toHaveCount(1);
  for (const n of [19, 20, 22, 23, 25]) await expect(queueRow(p1, n).getByTestId('claim-btn')).toHaveCount(0);
  await expect(queueRow(p1, 19)).toHaveAttribute('data-owner', '');
  await selectQueueFilter(p1, 'unclaimed');
  await expectCaseOrder(p1, 'queue-row', [24, 28, 29, 30].map(cn));
  await selectQueueFilter(p1, 'mine');
  await expectCaseOrder(p1, 'queue-row', [20, 22, 23].map(cn));
  await expect(tid(p1, 'workload-count')).toHaveText('3');

  const p2 = await staffPage(browser, 'off.reg2');
  await p2.goto('/officer/queue');
  await selectQueueFilter(p2, 'mine');
  await expectCaseOrder(p2, 'queue-row', [25, 26, 13, 15, 27, 16, 18, 12, 21].map(cn));
  await expect(tid(p2, 'workload-count')).toHaveText('9');

  const pw = await staffPage(browser, 'off.works1');
  await pw.goto('/officer/queue');
  await expectCaseOrder(pw, 'queue-row', [cn(10)]);

  const ph = await staffPage(browser, 'head1');
  await ph.goto('/officer/queue');
  await expect(tid(ph, 'queue-row')).toHaveCount(18);
  await expectCaseOrder(ph, 'queue-row', [20, 22, 24, 10, 23, 25, 26, 13, 15, 27, 28, 29, 30, 16, 18, 19, 12, 21].map(cn));
  await expect(tid(ph, 'claim-btn')).toHaveCount(0);
  for (const n of [17, 11, 14, 1, 9]) await expect(queueRow(ph, n)).toHaveCount(0);
});

test('TC-QUEUE-02 รับเรื่องซ้อน (พร้อมกันและต่อกัน)', async ({ browser }) => {
  // ส่วน 1 พร้อมกัน (UI)
  await reset();
  const A = await staffPage(browser, 'off.reg1');
  const B = await staffPage(browser, 'off.reg2');
  await Promise.all([A.goto('/officer/queue'), B.goto('/officer/queue')]);
  await expect(queueRow(A, 28)).toHaveCount(1);
  await expect(queueRow(B, 28)).toHaveCount(1);
  await Promise.all([queueRow(A, 28).getByTestId('claim-btn').click(), queueRow(B, 28).getByTestId('claim-btn').click()]);
  const g = await getCase(A.request, cn(28));
  expect(['off.reg1', 'off.reg2']).toContain(g.owner);
  expect(g.status).toBe('IN_REVIEW');
  const [win, lose] = g.owner === 'off.reg1' ? [A, B] : [B, A];
  await expect(tid(lose, 'action-error')).toHaveText(MSG.ALREADY_CLAIMED);
  await win.goto('/officer/queue');
  await expect(queueRow(win, 28)).toHaveAttribute('data-owner', g.owner);
  await expect(queueRow(win, 28).getByTestId('row-owner')).toContainText(new RegExp(`${g.owner}|${STAFF_NAME[g.owner]}`));
  let au = await loginS('audit1');
  expect((await auditOf(au, { event: 'CLAIM' })).filter((i) => i.caseNo === cn(28)).length).toBe(1);

  // ส่วน 2 พร้อมกัน 10 ครั้ง (API)
  await reset();
  const r1 = await loginS('off.reg1');
  const r2 = await loginS('off.reg2');
  const res = await Promise.all([...Array(10)].map((_, i) => act.claim(i % 2 === 0 ? r1 : r2, cn(29))));
  const ok = res.filter((r) => r.status() === 200);
  expect(ok.length, 'ตอบ 200 ครั้งเดียว').toBe(1);
  for (const r of res.filter((r) => r.status() !== 200)) await expectErr(r, 409, 'ALREADY_CLAIMED');
  const winner = (await bodyOf(ok[0])).owner;
  expect(['off.reg1', 'off.reg2']).toContain(winner);
  expect((await getCase(r1, cn(29))).owner).toBe(winner);
  au = await loginS('audit1');
  expect((await auditOf(au, { event: 'CLAIM' })).filter((i) => i.caseNo === cn(29)).length).toBe(1);

  // ส่วน 3 ต่อกัน
  await reset();
  const s1 = await loginS('off.reg1');
  const s2 = await loginS('off.reg2');
  expect((await expectOk(await act.claim(s1, cn(29)), 200)).owner).toBe('off.reg1');
  await expectErr(await act.claim(s2, cn(29)), 409, 'ALREADY_CLAIMED', MSG.ALREADY_CLAIMED);
  expect((await getCase(s1, cn(29))).owner).toBe('off.reg1');
  const p2 = await staffPage(browser, 'off.reg2');
  await expectWorkload(p2, 9);
  await expectErr(await act.claim(s1, cn(29)), 409);
  au = await loginS('audit1');
  expect((await auditOf(au, { event: 'CLAIM' })).filter((i) => i.caseNo === cn(29)).length).toBe(1);
});

test('TC-QUEUE-03 งานในมือสูงสุด 10', async ({ browser }) => {
  await reset();
  let p = await staffPage(browser, 'off.reg2');
  // 1
  await expectWorkload(p, 9);
  // 2
  await queueRow(p, 28).getByTestId('claim-btn').click();
  await expect.poll(async () => (await getCase(p.request, cn(28))).owner).toBe('off.reg2');
  await expectWorkload(p, 10);
  // 3
  await queueRow(p, 29).getByTestId('claim-btn').click();
  await expect(tid(p, 'action-error')).toHaveText(MSG.WORKLOAD_LIMIT);
  await expectErr(await act.claim(p.request, cn(29)), 409, 'WORKLOAD_LIMIT', MSG.WORKLOAD_LIMIT);
  let g = await getCase(p.request, cn(29));
  expect(g.status).toBe('SUBMITTED');
  expectNoOwner(g.owner);
  await expectWorkload(p, 10);
  // 4
  await officerCase(p, 25);
  await tid(p, 'approve-btn').click();
  await expectStatus(p, 'APPROVED');
  await expectWorkload(p, 9);
  // 5
  await queueRow(p, 29).getByTestId('claim-btn').click();
  await expect.poll(async () => (await getCase(p.request, cn(29))).owner).toBe('off.reg2');
  await expectWorkload(p, 10);
  // 6
  const r1 = await loginS('off.reg1');
  expect((await expectOk(await act.claim(r1, cn(30)), 200)).owner).toBe('off.reg1');

  // 7 RESET
  await reset();
  p = await staffPage(browser, 'off.reg2');
  await officerCase(p, 25);
  await uiReturn(p, R10);
  await expectStatus(p, 'NEED_FIX');
  await expectWorkload(p, 8);
  // 8
  await queueRow(p, 28).getByTestId('claim-btn').click();
  await expect.poll(async () => (await getCase(p.request, cn(28))).owner).toBe('off.reg2');
  await p.goto('/officer/queue');
  await queueRow(p, 29).getByTestId('claim-btn').click();
  await expect.poll(async () => (await getCase(p.request, cn(29))).owner).toBe('off.reg2');
  await expectWorkload(p, 10);
  // 9 สมหญิงส่งแก้
  const y = await citizenPage(browser, ID.somying);
  await citizenCase(y, 25);
  await tid(y, 'submit-fix-btn').click();
  await expectStatus(y, 'IN_REVIEW');
  await expect(tid(y, 'action-error')).toHaveCount(0);
  g = await getCase(p.request, cn(25));
  expect(g.owner).toBe('off.reg2');
  await expectWorkload(p, 11);
  // 10
  await queueRow(p, 30).getByTestId('claim-btn').click();
  await expect(tid(p, 'action-error')).toHaveText(MSG.WORKLOAD_LIMIT);
  await expectErr(await act.claim(p.request, cn(30)), 409, 'WORKLOAD_LIMIT', MSG.WORKLOAD_LIMIT);
  await expectWorkload(p, 11);
});

// ═════════════════════════ SLA ═════════════════════════

test('TC-SLA-01 กำหนดเสร็จตามตารางวันที่', async ({ browser }) => {
  test.setTimeout(360_000);
  await reset(); // RESET ต้นเรื่อง (และ RESET ซ้ำก่อน NEW_PAID ทุกแถว)
  const rows: Array<{ k: string; svc: 'SV-01' | 'SV-02' | 'SV-03'; at: string; due: string; text: string; area?: number }> = [
    { k: 'a', svc: 'SV-01', at: '2026-12-01T09:00:00+07:00', due: '2026-12-04T16:30:00+07:00', text: '4 ธ.ค. 2569 16:30' },
    { k: 'b', svc: 'SV-01', at: '2026-12-01T16:29:00+07:00', due: '2026-12-04T16:30:00+07:00', text: '4 ธ.ค. 2569 16:30' },
    { k: 'c', svc: 'SV-01', at: '2026-12-01T16:30:00+07:00', due: '2026-12-08T16:30:00+07:00', text: '8 ธ.ค. 2569 16:30' },
    { k: 'd', svc: 'SV-01', at: '2026-12-04T10:00:00+07:00', due: '2026-12-11T16:30:00+07:00', text: '11 ธ.ค. 2569 16:30' },
    { k: 'e', svc: 'SV-01', at: '2026-12-05T10:00:00+07:00', due: '2026-12-14T16:30:00+07:00', text: '14 ธ.ค. 2569 16:30' },
    { k: 'f', svc: 'SV-02', at: '2026-12-01T09:00:00+07:00', due: '2026-12-17T16:30:00+07:00', text: '17 ธ.ค. 2569 16:30' },
    { k: 'g', svc: 'SV-03', at: '2026-12-01T09:00:00+07:00', due: '2026-12-24T16:30:00+07:00', text: '24 ธ.ค. 2569 16:30', area: 100 },
    { k: 'h', svc: 'SV-01', at: '2026-12-29T10:00:00+07:00', due: '2027-01-05T16:30:00+07:00', text: '5 ม.ค. 2570 16:30' },
    { k: 'i', svc: 'SV-01', at: '2026-12-31T23:59:00+07:00', due: '2027-01-07T16:30:00+07:00', text: '7 ม.ค. 2570 16:30' },
  ];
  for (const r of rows) {
    await reset();
    const n = await newPaid({ at: r.at, service: r.svc, qty: 1, area: r.area });
    expect(n.caseNo, `แถว ${r.k}`).toBe(cn(31));
    const g = await getCase(n.ctx, cn(31));
    expect(g.dueAt, `แถว ${r.k} dueAt`).toBe(r.due);
    const page = await citizenPage(browser, ID.somchai);
    await citizenCase(page, 31);
    await expect(tid(page, 'sla-due'), `แถว ${r.k}`).toHaveAttribute('data-iso', r.due);
    await expect(tid(page, 'sla-due'), `แถว ${r.k}`).toHaveText(r.text);
  }
});

test('TC-SLA-02 หยุดนับ SLA ระหว่างรอแก้ไข', async ({ browser }) => {
  test.setTimeout(360_000);
  // ส่วน 1
  await reset();
  let n = await newPaid({ at: T0 });
  expect(n.caseNo).toBe(cn(31));
  expect((await getCase(n.ctx, cn(31))).dueAt).toBe('2026-12-04T16:30:00+07:00');
  await setClock('2026-12-02T11:00:00+07:00');
  let o = await loginS('off.reg1');
  await expectOk(await act.claim(o, cn(31)), 200);
  expect((await expectOk(await act.ret(o, cn(31)), 200)).status).toBe('NEED_FIX');
  let cp = await citizenPage(browser, ID.somchai);
  await citizenCase(cp, 31);
  await expectStatus(cp, 'NEED_FIX');
  await expectLevel(cp, 'paused');
  await expect(tid(cp, 'fix-deadline')).toHaveAttribute('data-iso', '2026-12-09T11:00:00+07:00');
  await setClock('2026-12-03T10:00:00+07:00');
  cp = await citizenPage(browser, ID.somchai);
  await citizenCase(cp, 31);
  await tid(cp, 'submit-fix-btn').click();
  await expectStatus(cp, 'IN_REVIEW');
  await citizenCase(cp, 31);
  await expect(tid(cp, 'sla-due')).toHaveAttribute('data-iso', '2026-12-08T16:30:00+07:00');
  await expect(tid(cp, 'sla-due')).toHaveText('8 ธ.ค. 2569 16:30');
  await expectLevel(cp, 'normal');
  o = await loginS('off.reg1');
  let g = await getCase(o, cn(31));
  expect(g.dueAt).toBe('2026-12-08T16:30:00+07:00');
  expect(g.owner).toBe('off.reg1');
  const op = await staffPage(browser, 'off.reg1');
  await officerCase(op, 31);
  await expect(tid(op, 'case-owner')).toHaveText('off.reg1');

  // ส่วน 2 seed 000017 ส่งแก้ 1 ธ.ค. 09:00
  await reset();
  cp = await citizenPage(browser, ID.somchai);
  await citizenCase(cp, 17);
  await expectLevel(cp, 'paused');
  await expect(tid(cp, 'sla-due')).toHaveAttribute('data-iso', '2026-11-27T16:30:00+07:00');
  await tid(cp, 'submit-fix-btn').click();
  await expectStatus(cp, 'IN_REVIEW');
  await citizenCase(cp, 17);
  await expect(tid(cp, 'sla-due')).toHaveAttribute('data-iso', '2026-12-01T16:30:00+07:00');
  await expectLevel(cp, 'near');
  o = await loginS('off.reg1');
  g = await getCase(o, cn(17));
  expect(g.dueAt).toBe('2026-12-01T16:30:00+07:00');
  expect(g.slaLevel).toBe('near');
  expect(g.owner).toBe('off.reg1');

  // ส่วน 3 ส่งแก้ 4 ธ.ค. 10:00
  await reset();
  await setClock('2026-12-04T10:00:00+07:00');
  let s = await loginC(ID.somchai);
  let rj = await expectOk(await act.resubmit(s, cn(17)), 200);
  expect(rj.status).toBe('IN_REVIEW');
  expect(rj.dueAt).toBe('2026-12-04T16:30:00+07:00');
  g = await getCase(s, cn(17));
  expect(g.dueAt).toBe('2026-12-04T16:30:00+07:00');
  expect(g.slaLevel).toBe('near');
  cp = await citizenPage(browser, ID.somchai);
  await citizenCase(cp, 17);
  await expectLevel(cp, 'near');

  // ส่วน 4 ตีกลับและส่งแก้วันเดียวกัน
  await reset();
  n = await newPaid({ at: T0 });
  await setClock('2026-12-02T09:00:00+07:00');
  o = await loginS('off.reg1');
  await expectOk(await act.claim(o, cn(31)), 200);
  await expectOk(await act.ret(o, cn(31)), 200);
  await setClock('2026-12-02T15:00:00+07:00');
  s = await loginC(ID.somchai);
  rj = await expectOk(await act.resubmit(s, cn(31)), 200);
  expect((await getCase(s, cn(31))).dueAt).toBe('2026-12-04T16:30:00+07:00');

  // ส่วน 5 คร่อมสุดสัปดาห์/วันหยุด ส่งแก้หลัง 16:30
  await reset();
  n = await newPaid({ at: T0 });
  await setClock('2026-12-04T10:00:00+07:00');
  o = await loginS('off.reg1');
  await expectOk(await act.claim(o, cn(31)), 200);
  await expectOk(await act.ret(o, cn(31)), 200);
  await setClock('2026-12-08T17:00:00+07:00');
  s = await loginC(ID.somchai);
  rj = await expectOk(await act.resubmit(s, cn(31)), 200);
  g = await getCase(s, cn(31));
  expect(g.dueAt).toBe('2026-12-08T16:30:00+07:00');
  expect(g.slaLevel).toBe('overdue');
  cp = await citizenPage(browser, ID.somchai);
  await citizenCase(cp, 31);
  await expectLevel(cp, 'overdue');
});

test('TC-SLA-03 ระดับเตือน ปกติ / ใกล้ครบกำหนด / เกินกำหนด', async ({ browser }) => {
  test.setTimeout(360_000);
  // ส่วน A
  await reset();
  const n = await newPaid({ at: T0 });
  expect(n.caseNo).toBe(cn(31));
  const A: Array<[string, string]> = [
    ['2026-12-01T09:00:00+07:00', 'normal'],
    ['2026-12-02T09:00:00+07:00', 'normal'],
    ['2026-12-03T09:00:00+07:00', 'near'],
    ['2026-12-04T16:30:00+07:00', 'near'],
    ['2026-12-04T16:30:01+07:00', 'overdue'],
    ['2026-12-04T16:31:00+07:00', 'overdue'],
    ['2026-12-05T10:00:00+07:00', 'overdue'],
  ];
  for (const [t, lv] of A) {
    await setClock(t);
    const p = await citizenPage(browser, ID.somchai);
    await citizenCase(p, 31);
    await expectLevel(p, lv);
    expect((await getCase(p.request, cn(31))).slaLevel, t).toBe(lv);
  }

  // ส่วน B seed 000016 (ของปิติ ผู้ถือ off.reg2)
  await reset();
  const B: Array<[string, string]> = [
    ['2026-12-03T09:00:00+07:00', 'normal'],
    ['2026-12-04T09:00:00+07:00', 'near'],
    ['2026-12-08T16:30:00+07:00', 'near'],
    ['2026-12-08T16:31:00+07:00', 'overdue'],
  ];
  for (const [t, lv] of B) {
    await setClock(t);
    const p = await staffPage(browser, 'off.reg2');
    await officerCase(p, 16);
    await expectLevel(p, lv);
    expect((await getCase(p.request, cn(16))).slaLevel, t).toBe(lv);
  }

  // ส่วน C seed ที่ 09:00
  await reset();
  const o = await staffPage(browser, 'off.reg1');
  await o.goto('/officer/queue');
  const C: Array<[number, string]> = [
    [20, 'overdue'],
    [22, 'near'],
    [24, 'near'],
    [25, 'normal'],
  ];
  for (const [c, lv] of C) {
    const row = queueRow(o, c);
    await expect(row).toHaveAttribute('data-sla-level', lv);
    await expect(row.getByTestId('row-sla-level')).toHaveText(LEVEL_TH[lv]);
  }
  for (const [c, lv] of C) {
    await officerCase(o, c);
    await expectLevel(o, lv);
  }
  const sc = await citizenPage(browser, ID.somchai);
  await citizenCase(sc, 17);
  await expectLevel(sc, 'paused');
  const sy = await citizenPage(browser, ID.somying);
  await citizenCase(sy, 1);
  await expectLevel(sy, 'closed');
  await setClock('2026-12-01T16:30:00+07:00');
  await officerCase(o, 22);
  await expectLevel(o, 'near');
  await setClock('2026-12-01T16:31:00+07:00');
  await officerCase(o, 22);
  await expectLevel(o, 'overdue');
});

// ═════════════════════════ NOTI ═════════════════════════

const NOTI_0900: Record<string, string[]> = {
  'off.reg1': [`${cn(20)}:overdue`, `${cn(22)}:near`, `${cn(24)}:near`],
  'off.reg2': [`${cn(24)}:near`],
  head1: [`${cn(20)}:overdue`],
  'off.works1': [],
};

/** ตรวจแจ้งเตือนของผู้ใช้ทั้งบนจอ (/notifications + bell-count) และ API */
async function expectNoti(browser: Browser, user: string, expected: string[]): Promise<void> {
  const p = await staffPage(browser, user);
  const sorted = [...expected].sort();
  expect(await notiUi(p), `${user} /notifications`).toEqual(sorted);
  await expect(tid(p, 'bell-count'), `${user} bell-count`).toHaveText(String(expected.length));
  expect(await notiApi(p.request), `${user} API`).toEqual(sorted);
  if (expected.length === 0) {
    await expect(tid(p, 'noti-empty')).toHaveText('ไม่มีแจ้งเตือน');
    await expect(tid(p, 'noti-item')).toHaveCount(0);
  }
}

test('TC-NOTI-01 ผู้รับแจ้งเตือนตามระดับ', async ({ browser }) => {
  await reset();
  // request แรกหลัง reset = ล็อกอิน off.reg1 ที่ 09:00
  const p1 = await staffPage(browser, 'off.reg1');
  for (const [u, exp] of Object.entries(NOTI_0900)) await expectNoti(browser, u, exp);
  await notiUi(p1);
  await expect(byAttr(p1, 'noti-item', 'data-case-no', cn(24))).toContainText(`คำขอ ${cn(24)} ใกล้ครบกำหนด`);
  await expect(byAttr(p1, 'noti-item', 'data-case-no', cn(20))).toContainText(`คำขอ ${cn(20)} เกินกำหนด`);

  // ต่อ: 16:31
  await setClock('2026-12-01T16:31:00+07:00');
  await p1.request.get(abs('/api/me'));
  await expectNoti(browser, 'off.reg1', [...NOTI_0900['off.reg1'], `${cn(22)}:overdue`]);
  await expectNoti(browser, 'head1', [`${cn(20)}:overdue`, `${cn(22)}:overdue`]);
  await expectNoti(browser, 'off.reg2', [`${cn(24)}:near`]);
});

test('TC-NOTI-02 ไม่แจ้งซ้ำ ข้ามระดับ และขั้นรออนุมัติ/รอออกเอกสาร', async ({ browser }) => {
  test.setTimeout(360_000);
  // ส่วน A ไม่แจ้งซ้ำ
  await reset();
  const p1 = await staffPage(browser, 'off.reg1');
  await setClock('2026-12-01T16:31:00+07:00');
  await p1.request.get(abs('/api/me'));
  const r1Exp = [...NOTI_0900['off.reg1'], `${cn(22)}:overdue`];
  const hExp = [`${cn(20)}:overdue`, `${cn(22)}:overdue`];
  const ph = await staffPage(browser, 'head1');
  for (const p of [p1, ph]) {
    for (let i = 0; i < 3; i++) await p.goto('/notifications');
    for (let i = 0; i < 3; i++) await notiApi(p.request);
    for (let i = 0; i < 2; i++) await p.goto('/officer/queue');
  }
  await expectNoti(browser, 'off.reg1', r1Exp);
  await expectNoti(browser, 'head1', hExp);

  // ส่วน B ข้ามระดับ (ส. 5 ธ.ค. 10:00)
  await reset();
  await setClock('2026-12-05T10:00:00+07:00');
  await staffPage(browser, 'off.reg1');
  const od = (ns: number[]) => ns.map((x) => `${cn(x)}:overdue`);
  const B: Record<string, string[]> = {
    'off.reg1': od([20, 22, 23, 24, 28, 29, 30]),
    'off.reg2': [...od([13, 15, 24, 25, 26, 27, 28, 29, 30]), `${cn(16)}:near`],
    'off.works1': od([10]),
    head1: [...od([10, 13, 14, 15, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30]), `${cn(11)}:near`],
  };
  for (const [u, exp] of Object.entries(B)) await expectNoti(browser, u, exp);
  for (const u of ['off.reg1', 'off.reg2', 'head1']) expect(notiOf(B[u], 24)).toEqual([`${cn(24)}:overdue`]);

  // ส่วน C ขั้นรออนุมัติ/รอออกเอกสาร
  await reset();
  await setClock('2026-12-04T09:00:00+07:00');
  const h = await loginS('head1');
  const r1 = await loginS('off.reg1');
  const r2 = await loginS('off.reg2');
  expect(notiOf(await notiApi(h), 14)).toEqual([`${cn(14)}:near`]);
  expect(notiOf(await notiApi(r1), 14)).toEqual([]);
  expect(notiOf(await notiApi(r2), 14)).toEqual([]);
  // 1
  await setClock('2026-12-04T16:31:00+07:00');
  await h.get('/api/me');
  expect(notiOf(await notiApi(h), 14)).toEqual([`${cn(14)}:near`, `${cn(14)}:overdue`]);
  expect(notiOf(await notiApi(r1), 14)).toEqual([]);
  expect(notiOf(await notiApi(r2), 14)).toEqual([]);
  // 2
  await setClock('2026-12-08T09:00:00+07:00');
  const h2 = await loginS('head1');
  const r1b = await loginS('off.reg1');
  const r2b = await loginS('off.reg2');
  expect(notiOf(await notiApi(r1b), 19)).toEqual([`${cn(19)}:near`]);
  expect(notiOf(await notiApi(r2b), 19)).toEqual([]);
  expect(notiOf(await notiApi(h2), 19)).toEqual([]);
  // 3
  await setClock('2026-12-09T16:31:00+07:00');
  const h3 = await loginS('head1');
  const r1c = await loginS('off.reg1');
  expect(notiOf(await notiApi(r1c), 19)).toEqual([`${cn(19)}:near`, `${cn(19)}:overdue`]);
  expect(notiOf(await notiApi(h3), 19)).toEqual([`${cn(19)}:overdue`]);
});

// ═════════════════════════ WORKFLOW ═════════════════════════

/** เปิด /verify/<code> แบบไม่ล็อกอิน แล้วตรวจผู้ลงนาม */
async function expectVerifySigner(browser: Browser, code: string, signer: string): Promise<void> {
  const v = await anonPage(browser);
  const st = await gotoStatus(v, `/verify/${code}`);
  expect(st).toBe(200);
  await expect(tid(v, 'verify-result')).toHaveAttribute('data-result', 'VALID');
  await expect(tid(v, 'verify-signer')).toHaveText(signer);
}

test('TC-WORKFLOW-01 SV-01 อนุมัติ + ออกเอกสาร', async ({ browser }) => {
  await reset();
  const p = await staffPage(browser, 'off.reg2');
  await officerCase(p, 25);
  // 1
  await expectStatus(p, 'IN_REVIEW');
  await expect(tid(p, 'approve-btn')).toHaveCount(1);
  await expect(tid(p, 'approve-btn')).toHaveText('อนุมัติ');
  await expect(tid(p, 'return-btn')).toHaveCount(1);
  await expect(tid(p, 'reject-btn')).toHaveCount(1);
  await expect(tid(p, 'forward-btn')).toHaveCount(0);
  await expect(tid(p, 'issue-btn')).toHaveCount(0);
  await expect(tid(p, 'case-fee')).toHaveText('฿60');
  // 2
  const r1 = await loginS('off.reg1');
  await expectErr(await act.approve(r1, cn(26)), 403, 'FORBIDDEN', MSG.FORBIDDEN);
  // 3
  await tid(p, 'approve-btn').click();
  await expectStatus(p, 'APPROVED');
  await expect(tid(p, 'issue-btn')).toHaveCount(1);
  await expect(tid(p, 'approve-btn')).toHaveCount(0);
  // 4
  await expect(tid(p, 'issue-btn')).toHaveText('ออกเอกสาร');
  await tid(p, 'issue-btn').click();
  await expectStatus(p, 'COMPLETED');
  await expect(tid(p, 'doc-no')).toHaveText('DOC-2569-000002');
  await expect(tid(p, 'verify-code')).toHaveText(/^[A-Z0-9]{8}$/);
  await expect(tid(p, 'closed-at')).toHaveAttribute('data-iso', '2026-12-01T09:00:00+07:00');
  await expectLevel(p, 'closed');
  // 5
  const y = await citizenPage(browser, ID.somying);
  await citizenCase(y, 25);
  await expectStatus(y, 'COMPLETED');
  await expect(tid(y, 'download-doc-btn')).toHaveCount(1);
  await expect(tid(y, 'download-doc-btn')).toHaveText('ดาวน์โหลดเอกสาร');
  const dl = await clickDownload(y, () => tid(y, 'download-doc-btn').click());
  expect(dl.filename).toBe('DOC-2569-000002.pdf');
  expect(await pdfText(dl.buf)).toContain(`docNo=DOC-2569-000002 caseNo=${cn(25)}`);
  const r = await y.request.get(abs('/api/documents/DOC-2569-000002/pdf'));
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toContain('application/pdf');
  expect(r.headers()['content-disposition']).toContain('DOC-2569-000002.pdf');
  // 6
  const ex = await loginS('exec1');
  const d = await dashApi(ex, '2026-12', 'ALL');
  expect(d).toMatchObject({ closed: 1, onTime: 1, received: 3, backlog: 20 });
});

test('TC-WORKFLOW-02 SV-02 ผ่านหัวหน้า', async ({ browser }) => {
  await reset();
  const p = await staffPage(browser, 'off.reg2');
  await officerCase(p, 13);
  // 1
  await expect(tid(p, 'approve-btn')).toHaveCount(0);
  await expect(tid(p, 'forward-btn')).toHaveCount(1);
  await expect(tid(p, 'forward-btn')).toHaveText('ผ่าน/ส่งต่อ');
  await expect(tid(p, 'forward-target')).toHaveCount(0);
  // 2
  await tid(p, 'forward-btn').click();
  await expectStatus(p, 'PENDING_APPROVAL');
  await expectWorkload(p, 8);
  await expect(queueRow(p, 13)).toHaveCount(0);
  // 3
  const h = await staffPage(browser, 'head1');
  await h.goto('/head/approvals');
  await expectCaseOrder(h, 'approval-row', [13, 14, 11].map(cn));
  // 4
  await rowOf(h, 'approval-row', cn(13)).getByTestId('approval-open').click();
  await expectPath(h, `/officer/cases/${cn(13)}`);
  await expect(tid(h, 'approve-btn')).toHaveCount(1);
  await expect(tid(h, 'reject-btn')).toHaveCount(1);
  await expect(tid(h, 'issue-btn')).toHaveCount(0);
  // 5
  await tid(h, 'approve-btn').click();
  await expectStatus(h, 'APPROVED');
  await expect(tid(h, 'issue-btn')).toHaveCount(0);
  // 6
  const o1 = await staffPage(browser, 'off.reg1');
  await officerCase(o1, 13);
  await expect(tid(o1, 'issue-btn')).toHaveCount(0);
  await expectErr(await act.issue(o1.request, cn(13)), 403, 'FORBIDDEN');
  // 7
  await officerCase(p, 13);
  await tid(p, 'issue-btn').click();
  await expectStatus(p, 'COMPLETED');
  await expect(tid(p, 'doc-no')).toHaveText('DOC-2569-000002');
  await expectVerifySigner(browser, (await tid(p, 'verify-code').innerText()).trim(), 'หัวหน้าฝ่าย');

  // 8 RESET · seed 000019
  await reset();
  const q = await staffPage(browser, 'off.reg1');
  await officerCase(q, 19);
  await tid(q, 'issue-btn').click();
  await expectStatus(q, 'COMPLETED');
  await expect(tid(q, 'doc-no')).toHaveText('DOC-2569-000002');
  await expectVerifySigner(browser, (await tid(q, 'verify-code').innerText()).trim(), 'หัวหน้าฝ่าย');
});

test('TC-WORKFLOW-03 SV-03 สามขั้นตอน', async ({ browser }) => {
  await reset();
  const p = await staffPage(browser, 'off.reg2');
  await officerCase(p, 12);
  // 1
  await expect(tid(p, 'case-step')).toHaveText('ขั้นตอน 1/3 · ฝ่ายทะเบียน');
  await expect(tid(p, 'case-fee')).toHaveText('฿1,010');
  await expect(tid(p, 'forward-btn')).toHaveCount(1);
  // 2
  await tid(p, 'forward-btn').click();
  await expectStatus(p, 'IN_REVIEW');
  await expect(tid(p, 'case-step')).toHaveText('ขั้นตอน 2/3 · ฝ่ายโยธา');
  await expect(tid(p, 'case-owner')).toHaveText('ยังไม่มีผู้รับ');
  await expectWorkload(p, 8);
  // 3
  await expect(queueRow(p, 12)).toHaveCount(0);
  await expect(tid(p, 'queue-row')).toHaveCount(16);
  // 4
  const w = await staffPage(browser, 'off.works1');
  await w.goto('/officer/queue');
  await expectCaseOrder(w, 'queue-row', [cn(10), cn(12)]);
  await expect(tid(w, 'claim-btn')).toHaveCount(2);
  // 5
  const r1 = await loginS('off.reg1');
  await expectErr(await act.claim(r1, cn(12)), 403, 'FORBIDDEN');
  // 6
  await queueRow(w, 12).getByTestId('claim-btn').click();
  await expect.poll(async () => (await getCase(w.request, cn(12))).owner).toBe('off.works1');
  await officerCase(w, 12);
  await expect(tid(w, 'case-owner')).toHaveText('off.works1');
  await tid(w, 'forward-btn').click();
  await expectStatus(w, 'PENDING_APPROVAL');
  await expect(tid(w, 'case-step')).toHaveText('ขั้นตอน 3/3 · หัวหน้าฝ่าย');
  // 7
  const h = await staffPage(browser, 'head1');
  await h.goto('/head/approvals');
  await expect(tid(h, 'approval-row')).toHaveCount(3);
  await expect(rowOf(h, 'approval-row', cn(12))).toHaveCount(1);
  await rowOf(h, 'approval-row', cn(12)).getByTestId('approval-open').click();
  await tid(h, 'approve-btn').click();
  await expectStatus(h, 'APPROVED');
  // 8
  await officerCase(w, 12);
  await expect(tid(w, 'issue-btn')).toHaveCount(0);
  await officerCase(p, 12);
  await expect(tid(p, 'issue-btn')).toHaveCount(1);
  await tid(p, 'issue-btn').click();
  await expectStatus(p, 'COMPLETED');
  await expectVerifySigner(browser, (await tid(p, 'verify-code').innerText()).trim(), 'หัวหน้าฝ่าย');
});

test('TC-WORKFLOW-04 ตีกลับสูงสุด 2 ครั้ง และผลหลังครบ', async ({ browser }) => {
  // ส่วน A
  await reset();
  const p = await staffPage(browser, 'off.reg1');
  const s = await loginC(ID.somchai);
  await officerCase(p, 20);
  await expect(tid(p, 'return-count')).toHaveText('0');
  // 1
  await uiReturn(p, R10);
  await expectStatus(p, 'NEED_FIX');
  await expect(tid(p, 'return-count')).toHaveText('1');
  // 2
  expect((await expectOk(await act.resubmit(s, cn(20)), 200)).status).toBe('IN_REVIEW');
  expect((await getCase(p.request, cn(20))).owner).toBe('off.reg1');
  // 3
  await officerCase(p, 20);
  await expectStatus(p, 'IN_REVIEW');
  await uiReturn(p, R10);
  await expectStatus(p, 'NEED_FIX');
  await expect(tid(p, 'return-count')).toHaveText('2');
  // 4
  expect((await expectOk(await act.resubmit(s, cn(20)), 200)).status).toBe('IN_REVIEW');
  // 5
  await officerCase(p, 20);
  await expectStatus(p, 'IN_REVIEW');
  await expect(tid(p, 'return-btn')).toHaveCount(0);
  await expectErr(await act.ret(p.request, cn(20)), 409, 'RETURN_LIMIT', MSG.RETURN_LIMIT);
  let g = await getCase(p.request, cn(20));
  expect(g.status).toBe('IN_REVIEW');
  expect(g.returnCount).toBe(2);
  await officerCase(p, 20);
  await expect(tid(p, 'return-count')).toHaveText('2');
  await expect(tid(p, 'approve-btn')).toHaveCount(1);
  await expect(tid(p, 'reject-btn')).toHaveCount(1);

  // ส่วน B seed 000023
  await reset();
  const q = await staffPage(browser, 'off.reg1');
  await officerCase(q, 23);
  await expect(tid(q, 'return-count')).toHaveText('2');
  await expect(tid(q, 'return-btn')).toHaveCount(0);
  await expectErr(await act.ret(q.request, cn(23)), 409, 'RETURN_LIMIT', MSG.RETURN_LIMIT);
  expect((await getCase(q.request, cn(23))).status).toBe('IN_REVIEW');
  await officerCase(q, 23);
  await expect(tid(q, 'approve-btn')).toHaveCount(1);
  await expect(tid(q, 'reject-btn')).toHaveCount(1);

  // ส่วน C SV-02 000013
  await reset();
  const r = await staffPage(browser, 'off.reg2');
  const s2 = await loginC(ID.somchai);
  await expectOk(await act.ret(r.request, cn(13)), 200);
  await expectOk(await act.resubmit(s2, cn(13)), 200);
  expect((await expectOk(await act.ret(r.request, cn(13)), 200)).returnCount).toBe(2);
  await expectOk(await act.resubmit(s2, cn(13)), 200);
  await officerCase(r, 13);
  await expectStatus(r, 'IN_REVIEW');
  await expect(tid(r, 'return-btn')).toHaveCount(0);
  await expect(tid(r, 'approve-btn')).toHaveCount(0);
  await expect(tid(r, 'reject-btn')).toHaveCount(0);
  await expect(tid(r, 'forward-btn')).toHaveCount(1);
  await expectErr(await act.reject(r.request, cn(13), R10), 403);
  await tid(r, 'forward-note').fill('ส่งต่อให้หัวหน้าพิจารณา');
  await tid(r, 'forward-btn').click();
  await expectStatus(r, 'PENDING_APPROVAL');
  const au = await staffPage(browser, 'audit1');
  await auditFilterUi(au, { event: 'FORWARD' });
  const rows = (await auditRowsUi(au)).filter((x) => x.caseNo === cn(13));
  expect(rows.length).toBe(1);
  expect(rows[0].detail).toContain('ส่งต่อให้หัวหน้าพิจารณา');
  const h = await staffPage(browser, 'head1');
  await officerCase(h, 13);
  await expect(tid(h, 'reject-btn')).toHaveCount(1);
  await expect(tid(h, 'approve-btn')).toHaveCount(1);
});

test('TC-WORKFLOW-05 เหตุผล ≥ 10 ตัวอักษร (ตีกลับ / ไม่อนุมัติ)', async ({ browser }) => {
  // ส่วน A ตีกลับ 000020
  await reset();
  const p = await staffPage(browser, 'off.reg1');
  for (const reason of [R9, SPACES10]) {
    await officerCase(p, 20);
    await uiReturn(p, reason);
    await expect(tid(p, 'return-reason-error'), JSON.stringify(reason)).toHaveText(MSG.REASON_TOO_SHORT);
    await expectErr(await act.ret(p.request, cn(20), reason), 400, 'REASON_TOO_SHORT', MSG.REASON_TOO_SHORT);
    await officerCase(p, 20);
    await expectStatus(p, 'IN_REVIEW');
  }
  await uiReturn(p, R10);
  await expectStatus(p, 'NEED_FIX');
  const s = await citizenPage(browser, ID.somchai);
  await citizenCase(s, 20);
  await expect(tid(s, 'return-reason-display')).toHaveText(R10);

  // ส่วน B ไม่อนุมัติ 000026
  await reset();
  const q = await staffPage(browser, 'off.reg2');
  await officerCase(q, 26);
  await uiReject(q, R9);
  await expect(tid(q, 'reject-reason-error')).toHaveText(MSG.REASON_TOO_SHORT);
  await expectErr(await act.reject(q.request, cn(26), R9), 400, 'REASON_TOO_SHORT', MSG.REASON_TOO_SHORT);
  await officerCase(q, 26);
  await expectStatus(q, 'IN_REVIEW');
  await uiReject(q, R10);
  await expectStatus(q, 'REJECTED');
  await officerCase(q, 26);
  await expect(tid(q, 'closed-at')).toHaveAttribute('data-iso', '2026-12-01T09:00:00+07:00');
  await expectLevel(q, 'closed');
  const s2 = await citizenPage(browser, ID.somchai);
  await citizenCase(s2, 26);
  await expect(tid(s2, 'no-refund-note')).toHaveText(MSG.NO_REFUND);
  const ex = await loginS('exec1');
  expect(await dashApi(ex)).toMatchObject({ closed: 1, onTime: 1 });

  // ส่วน C หัวหน้าไม่อนุมัติ 000011
  await reset();
  const h = await staffPage(browser, 'head1');
  await expectErr(await act.reject(h.request, cn(11), R9), 400, 'REASON_TOO_SHORT', MSG.REASON_TOO_SHORT);
  expect((await expectOk(await act.reject(h.request, cn(11), R10), 200)).status).toBe('REJECTED');
  await officerCase(h, 11);
  await expectStatus(h, 'REJECTED');
});

test('TC-WORKFLOW-06 เวลาแก้ไข 168 ชั่วโมง', async ({ browser }) => {
  await reset();
  let s = await citizenPage(browser, ID.somchai);
  await citizenCase(s, 17);
  await expectStatus(s, 'NEED_FIX');
  await expect(tid(s, 'return-reason-display')).toHaveText('ชื่อในเอกสารไม่ตรงกับบัตร กรุณาแก้ไข');
  await expect(tid(s, 'fix-deadline')).toHaveText('4 ธ.ค. 2569 14:00');
  await expect(tid(s, 'fix-deadline')).toHaveAttribute('data-iso', '2026-12-04T14:00:00+07:00');
  await expect(tid(s, 'submit-fix-btn')).toHaveCount(1);
  await expect(tid(s, 'submit-fix-btn')).toHaveText('ส่งแก้ไข');

  // รอบ A 167:59
  await reset();
  await setClock('2026-12-04T13:59:00+07:00');
  s = await citizenPage(browser, ID.somchai);
  await citizenCase(s, 17);
  await expect(tid(s, 'submit-fix-btn')).toBeEnabled();
  await tid(s, 'submit-fix-btn').click();
  await expectStatus(s, 'IN_REVIEW');

  // รอบ B 168:00
  await reset();
  await setClock('2026-12-04T14:00:00+07:00');
  s = await citizenPage(browser, ID.somchai);
  await citizenCase(s, 17);
  await expectStatus(s, 'CANCELLED');
  await expect(tid(s, 'submit-fix-btn')).toHaveCount(0);
  await expect(tid(s, 'no-refund-note')).toHaveText(MSG.NO_REFUND);
  await expectErr(await act.resubmit(s.request, cn(17)), 409);
  await expect(tid(s, 'case-timeline').locator('[data-testid="timeline-item"][data-iso="2026-12-04T14:00:00+07:00"]')).not.toHaveCount(0);
  const ex = await staffPage(browser, 'exec1');
  await ex.goto('/dashboard');
  await expect(tid(ex, 'kpi-backlog')).toHaveText('20');
  expect((await dashApi(ex.request)).backlog).toBe(20);
});

// ═════════════════════════ DOC ═════════════════════════

test('TC-DOC-01 ออกเอกสารและข้อมูลในเอกสาร', async ({ browser }) => {
  await reset();
  const o = await loginS('off.reg2');
  expect((await expectOk(await act.approve(o, cn(25)), 200)).status).toBe('APPROVED');
  const ij = await expectOk(await act.issue(o, cn(25)), 200);
  expect(ij).toMatchObject({ docNo: 'DOC-2569-000002', status: 'COMPLETED' });
  expect(ij.verifyCode).toMatch(/^[A-Z0-9]{8}$/);
  const code: string = ij.verifyCode;

  // PDF โดยผู้ยื่น
  const y = await citizenPage(browser, ID.somying);
  const r = await y.request.get(abs('/api/documents/DOC-2569-000002/pdf'));
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toContain('application/pdf');
  expect(r.headers()['content-disposition']).toContain('DOC-2569-000002.pdf');
  expect(await pdfText(await r.body())).toContain(
    `docNo=DOC-2569-000002 caseNo=${cn(25)} verify=${code} validUntil=2027-02-28`,
  );

  // หน้า /verify
  const v = await anonPage(browser);
  expect(await gotoStatus(v, `/verify/${code}`)).toBe(200);
  await expect(tid(v, 'verify-result')).toHaveText('เอกสารถูกต้อง');
  await expect(tid(v, 'verify-result')).toHaveAttribute('data-result', 'VALID');
  await expect(tid(v, 'verify-doc-no')).toHaveText('DOC-2569-000002');
  await expect(tid(v, 'verify-applicant')).toHaveText('สมหญิง ร***');
  await expect(tid(v, 'verify-service')).toHaveText('SV-01 ขอหนังสือรับรอง');
  await expect(tid(v, 'verify-issued')).toHaveAttribute('data-iso', '2026-12-01T09:00:00+07:00');
  await expect(tid(v, 'verify-expires')).toHaveAttribute('data-iso', '2027-02-28');
  await expect(tid(v, 'verify-expires')).toHaveText('28 ก.พ. 2570');
  await expect(tid(v, 'verify-signer')).toHaveText('เจ้าหน้าที่ทะเบียน 2');

  // QR บนหน้าเคส
  await citizenCase(y, 25);
  await expect(tid(y, 'doc-qr')).toHaveAttribute('data-url', `${BASE_URL}/verify/${code}`);

  // API verify
  const anon = await newApi();
  const vj = await expectOk(await anon.get(`/api/verify/${code}`), 200);
  expect(vj).toMatchObject({ result: 'VALID', validUntil: '2027-02-28', issuedAt: '2026-12-01T09:00:00+07:00' });

  // ไม่ใช่ผู้ยื่น
  const s = await loginC(ID.somchai);
  expect((await s.get('/api/documents/DOC-2569-000002/pdf')).status()).toBe(404);

  // ออกซ้ำ → 409 · ไม่เกิดเอกสารที่ 2
  await expectErr(await act.issue(o, cn(25)), 409, 'INVALID_STATE', MSG.INVALID_STATE);
  const r1 = await loginS('off.reg1');
  expect((await expectOk(await act.issue(r1, cn(19)), 200)).docNo, 'เอกสารถัดไปยังเป็น DOC-2569-000003').toBe('DOC-2569-000003');
});

test('TC-DOC-02 ตรวจเอกสาร /verify', async ({ browser }) => {
  await reset();
  const v = await anonPage(browser);
  expect(await gotoStatus(v, '/verify/K7M2Q9XA')).toBe(200);
  await expectPath(v, '/verify/K7M2Q9XA');
  await expect(tid(v, 'verify-result')).toHaveText('เอกสารถูกต้อง');
  await expect(tid(v, 'verify-result')).toHaveAttribute('data-result', 'VALID');
  await expect(tid(v, 'verify-doc-no')).toHaveText('DOC-2569-000001');
  await expect(tid(v, 'verify-applicant')).toHaveText('สมชาย ใ***');
  await expect(tid(v, 'verify-service')).toHaveText('SV-01 ขอหนังสือรับรอง');
  await expect(tid(v, 'verify-issued')).toHaveAttribute('data-iso', '2026-11-05T10:00:00+07:00');
  await expect(tid(v, 'verify-expires')).toHaveAttribute('data-iso', '2027-02-02');
  await expect(tid(v, 'verify-expires')).toHaveText('2 ก.พ. 2570');
  await expect(tid(v, 'verify-signer')).toHaveText('เจ้าหน้าที่ทะเบียน 1');
  const txt = await v.locator('body').innerText();
  expect(txt).not.toContain('ใจดี');
  expect(txt).not.toContain(ID.somchai);

  expect(await gotoStatus(v, '/verify/ZZZZZZZZ')).toBe(404);
  await expect(tid(v, 'verify-result')).toHaveText('ไม่พบเอกสาร');
  await expect(tid(v, 'verify-result')).toHaveAttribute('data-result', 'NOT_FOUND');
  await expect(tid(v, 'verify-applicant')).toHaveCount(0);
  await expect(tid(v, 'verify-doc-no')).toHaveCount(0);

  const a = await newApi();
  expect(await expectOk(await a.get('/api/verify/K7M2Q9XA'), 200)).toMatchObject({ result: 'VALID', applicantMasked: 'สมชาย ใ***' });
  expect(await expectErr(await a.get('/api/verify/ZZZZZZZZ'), 404)).toEqual({ result: 'NOT_FOUND' });
});

/** ตรวจผล /verify ที่นาฬิกาหนึ่ง */
async function verifyAt(browser: Browser, code: string, clock: string, result: 'VALID' | 'EXPIRED' | 'TAMPERED', expiresIso?: string) {
  await setClock(clock);
  const v = await anonPage(browser);
  expect(await gotoStatus(v, `/verify/${code}`), `${code} @ ${clock}`).toBe(200);
  const th = { VALID: 'เอกสารถูกต้อง', EXPIRED: 'เอกสารหมดอายุ', TAMPERED: 'ลายเซ็นไม่ถูกต้อง' }[result];
  await expect(tid(v, 'verify-result'), `${code} @ ${clock}`).toHaveText(th);
  await expect(tid(v, 'verify-result')).toHaveAttribute('data-result', result);
  if (expiresIso) await expect(tid(v, 'verify-expires')).toHaveAttribute('data-iso', expiresIso);
  if (result === 'TAMPERED') {
    await expect(tid(v, 'verify-doc-no')).toHaveCount(0);
    await expect(tid(v, 'verify-applicant')).toHaveCount(0);
  }
}

test('TC-DOC-03 เอกสารหมดอายุและลายเซ็นไม่ตรง', async ({ browser }) => {
  test.setTimeout(360_000);
  // ส่วน A SV-01 90 วัน
  await reset();
  let o = await loginS('off.reg2');
  await expectOk(await act.approve(o, cn(25)), 200);
  const c1 = (await expectOk(await act.issue(o, cn(25)), 200)).verifyCode;
  await verifyAt(browser, c1, '2027-02-28T23:59:00+07:00', 'VALID', '2027-02-28');
  await verifyAt(browser, c1, '2027-03-01T00:00:00+07:00', 'EXPIRED', '2027-02-28');

  // ส่วน B SV-02 1 ปี
  await reset();
  let r1 = await loginS('off.reg1');
  const c2 = (await expectOk(await act.issue(r1, cn(19)), 200)).verifyCode;
  await verifyAt(browser, c2, '2027-11-30T23:59:00+07:00', 'VALID', '2027-11-30');
  await verifyAt(browser, c2, '2027-12-01T00:00:00+07:00', 'EXPIRED');

  // ส่วน C seed
  await reset();
  await verifyAt(browser, 'K7M2Q9XA', '2027-02-02T23:59:00+07:00', 'VALID', '2027-02-02');
  await verifyAt(browser, 'K7M2Q9XA', '2027-02-03T00:00:00+07:00', 'EXPIRED');

  // ส่วน E ออก 29 ก.พ. 2571
  await reset();
  await setClock('2028-02-29T10:00:00+07:00');
  o = await loginS('off.reg2');
  r1 = await loginS('off.reg1');
  await expectOk(await act.approve(o, cn(25)), 200);
  const e1 = await expectOk(await act.issue(o, cn(25)), 200);
  expect(e1.docNo).toBe('DOC-2571-000001');
  const e2 = await expectOk(await act.issue(r1, cn(19)), 200);
  expect(e2.docNo).toBe('DOC-2571-000002');
  await verifyAt(browser, e1.verifyCode, '2028-05-28T23:59:00+07:00', 'VALID', '2028-05-28');
  await verifyAt(browser, e1.verifyCode, '2028-05-29T00:00:00+07:00', 'EXPIRED');
  await verifyAt(browser, e2.verifyCode, '2029-02-27T23:59:00+07:00', 'VALID', '2029-02-27');
  await verifyAt(browser, e2.verifyCode, '2029-02-28T00:00:00+07:00', 'EXPIRED');

  // ส่วน D ลายเซ็นไม่ตรง
  await reset();
  expect(await expectOk(await tamper('DOC-2569-000001'), 200)).toEqual({ ok: true });
  await verifyAt(browser, 'K7M2Q9XA', T0, 'TAMPERED');
  await verifyAt(browser, 'K7M2Q9XA', '2027-03-01T00:00:00+07:00', 'TAMPERED');
});

// ═════════════════════════ PDPA ═════════════════════════

test('TC-PDPA-01 ปิดบังเลขบัตรบนจอ', async ({ browser }) => {
  await reset();
  const p = await staffPage(browser, 'off.reg2');
  await p.goto('/officer/queue');
  await expect(tid(p, 'queue-row')).toHaveCount(17);
  for (const m of await tid(p, 'row-id-masked').allInnerTexts()) expect(m.trim()).toMatch(MASK_RE);
  await expect(queueRow(p, 25).getByTestId('row-id-masked')).toHaveText(MASKED.somying);
  await expect(queueRow(p, 26).getByTestId('row-id-masked')).toHaveText(MASKED.somchai);

  await officerCase(p, 25);
  await expect(tid(p, 'applicant-id')).toHaveText(MASKED.somying);
  const html = await p.content();
  expect(html).not.toContain(ID.somying);
  expect(html).not.toContain(FULL_ID.somying);

  const h = await staffPage(browser, 'head1');
  await officerCase(h, 25);
  await expect(tid(h, 'applicant-id')).toHaveText(MASKED.somying);

  const y = await citizenPage(browser, ID.somying);
  await citizenCase(y, 25);
  await expect(tid(y, 'case-id-full')).toHaveText(FULL_ID.somying);
  const s = await citizenPage(browser, ID.somchai);
  await citizenCase(s, 20);
  await expect(tid(s, 'case-id-full')).toHaveText(FULL_ID.somchai);
});

test('TC-PDPA-02 API (JSON) ไม่ส่งเลขบัตรเต็ม', async () => {
  await reset();
  for (const u of ['off.reg1', 'head1']) {
    const c = await loginS(u);
    const urls = [
      '/api/officer/queue?filter=all',
      `/api/cases/${cn(25)}`,
      `/api/cases/${cn(26)}`,
      `/api/cases/${cn(20)}`,
      '/api/notifications',
      `/api/cases/${cn(25)}/files`,
    ];
    for (const url of urls) {
      const r = await c.get(url);
      const label = `${u} ${url}`;
      expect(r.status(), label).toBe(200);
      expect(r.headers()['content-type'] ?? '', label).toContain('application/json');
      const j = await r.json();
      expectNoFullId(j, label);
      if (Array.isArray(j.items)) for (const it of j.items) if ('idMasked' in it) expect(it.idMasked, label).toMatch(MASK_RE);
      if (url.startsWith('/api/cases/') && !url.endsWith('/files')) expect(j.idMasked, label).toMatch(MASK_RE);
    }
    const q = await queueApi(c, 'all');
    expect(q.length).toBeGreaterThan(0);
    for (const it of q) expect(it.idMasked).toMatch(MASK_RE);
  }
});

test('TC-PDPA-03 แสดงเลขเต็มต้องมีเหตุผลและบันทึก Audit', async ({ browser }) => {
  await reset();
  const p = await staffPage(browser, 'off.reg2');
  await officerCase(p, 25);
  await expect(tid(p, 'show-full-id-btn')).toHaveText('แสดงเลขเต็ม');
  // 1 ว่าง
  await uiUnmask(p, '');
  await expect(tid(p, 'unmask-error')).toHaveText(MSG.REASON_REQUIRED);
  await expect(tid(p, 'full-id')).toHaveCount(0);
  await expectErr(await act.unmask(p.request, cn(25), ''), 400, 'REASON_REQUIRED', MSG.REASON_REQUIRED);
  // 2 เว้นวรรคล้วน
  await uiUnmask(p, '     ');
  await expect(tid(p, 'unmask-error')).toHaveText(MSG.REASON_REQUIRED);
  await expect(tid(p, 'full-id')).toHaveCount(0);
  await expectErr(await act.unmask(p.request, cn(25), '     '), 400, 'REASON_REQUIRED', MSG.REASON_REQUIRED);
  // 3
  await uiUnmask(p, 'ตรวจสอบตัวตนซ้ำ');
  await expect(tid(p, 'full-id')).toHaveText(FULL_ID.somying);
  // 4
  await p.reload();
  await expect(tid(p, 'applicant-id')).toHaveText(MASKED.somying);
  await expect(tid(p, 'full-id')).toHaveCount(0);
  // 5
  const au = await staffPage(browser, 'audit1');
  await auditFilterUi(au, { event: 'UNMASK' });
  await expect(tid(au, 'audit-count')).toHaveText('1');
  const rows = await auditRowsUi(au);
  expect(rows.length).toBe(1);
  expect(rows[0].actor).toBe('off.reg2');
  expect(rows[0].role).toBe('officer');
  expect(rows[0].caseText).toBe(cn(25));
  expect(rows[0].eventText).toBe('UNMASK');
  expect(rows[0].detail).toContain('ตรวจสอบตัวตนซ้ำ');
  expect(rows[0].iso).toBe(T0);
  // 6
  for (const c of [await loginS('exec1'), au.request, await loginC(ID.somying)]) {
    expect((await act.unmask(c, cn(25), 'x')).status()).toBe(403);
  }
});

// ═════════════════════════ DASH ═════════════════════════

const DASH_SVC: Record<string, { received: string; closed: string; pct: string; backlog: string; overdue: string }> = {
  ALL: { received: '3', closed: '0', pct: '–', backlog: '21', overdue: '1' },
  'SV-01': { received: '3', closed: '0', pct: '–', backlog: '11', overdue: '1' },
  'SV-02': { received: '0', closed: '0', pct: '–', backlog: '7', overdue: '0' },
  'SV-03': { received: '0', closed: '0', pct: '–', backlog: '3', overdue: '0' },
};

test('TC-DASH-01 Dashboard ตัวเลขเริ่มต้น', async ({ browser }) => {
  await reset();
  const p = await staffPage(browser, 'exec1');
  await p.goto('/dashboard');
  await expect(tid(p, 'period-select')).toHaveValue('2026-12');
  await expect(tid(p, 'service-select')).toHaveValue('ALL');
  await expectKpis(p, DASH_SVC.ALL);
  const api = await dashApi(p.request, '2026-12', 'ALL');
  expect(api).toMatchObject({ received: 3, closed: 0, backlog: 21, overdue: 1 });
  expect(api.ontimePct).toBeNull();
  const wl = Object.fromEntries((api.workload as any[]).map((w) => [w.username, w.count]));
  expect(wl).toMatchObject({ 'off.reg1': 3, 'off.reg2': 9, 'off.works1': 0 });

  await expect(tid(p, 'workload-row')).toHaveCount(3);
  for (const [u, n] of [
    ['off.reg1', '3'],
    ['off.reg2', '9'],
    ['off.works1', '0'],
  ]) {
    await expect(byAttr(p, 'workload-row', 'data-username', u).getByTestId('workload-value')).toHaveText(n);
  }
  expectNoPii(await p.locator('body').innerText(), '/dashboard');

  for (const svc of ['SV-01', 'SV-02', 'SV-03']) {
    await selectDash(p, '2026-12', svc);
    await expectKpis(p, DASH_SVC[svc]);
    const a = await dashApi(p.request, '2026-12', svc);
    expect(a, svc).toMatchObject({
      received: Number(DASH_SVC[svc].received),
      closed: 0,
      backlog: Number(DASH_SVC[svc].backlog),
      overdue: Number(DASH_SVC[svc].overdue),
    });
    expect(a.ontimePct).toBeNull();
  }
});

test('TC-DASH-02 Dashboard ย้อนหลัง พ.ย. ต.ค. รายปี', async ({ browser }) => {
  await reset();
  const p = await staffPage(browser, 'exec1');
  await p.goto('/dashboard');
  const rows: Array<[string, string, number, number, string, number]> = [
    ['2026-10', 'ALL', 1, 1, '100.0%', 100.0],
    ['2026-11', 'ALL', 26, 7, '85.7%', 85.7],
    ['2026-11', 'SV-01', 12, 3, '100.0%', 100.0],
    ['2026-11', 'SV-02', 10, 3, '66.7%', 66.7],
    ['2026-11', 'SV-03', 4, 1, '100.0%', 100.0],
    ['2026', 'ALL', 30, 8, '87.5%', 87.5],
    ['2026', 'SV-01', 16, 4, '100.0%', 100.0],
    ['2026', 'SV-02', 10, 3, '66.7%', 66.7],
    ['2026', 'SV-03', 4, 1, '100.0%', 100.0],
  ];
  for (const [period, svc, rec, closed, pct, pctNum] of rows) {
    await selectDash(p, period, svc);
    const now = DASH_SVC[svc];
    await expectKpis(p, { received: String(rec), closed: String(closed), pct, backlog: now.backlog, overdue: now.overdue });
    const a = await dashApi(p.request, period, svc);
    expect(a, `${period} ${svc}`).toMatchObject({
      received: rec,
      closed,
      backlog: Number(now.backlog),
      overdue: Number(now.overdue),
    });
    expect(Math.round(Number(a.ontimePct) * 10) / 10, `${period} ${svc} ontimePct`).toBe(pctNum);
  }
});

test('TC-DASH-03 ส่งออก Excel/PDF เท่าหน้าจอ และไม่มีข้อมูลส่วนบุคคล', async ({ browser }) => {
  await reset();
  const p = await staffPage(browser, 'exec1');
  await p.goto('/dashboard');
  const HEAD = ['ตัวชี้วัด', 'ค่า'];
  const LABELS = ['รับเรื่อง', 'ปิดงาน', 'ทันกำหนด %', 'งานคงค้าง', 'เกินกำหนดคงค้าง'];
  const checkXlsx = (buf: Buffer, vals: string[], label: string) => {
    const sh = xlsxFirstSheet(buf);
    expect(sh[0].slice(0, 2), `${label} หัวตาราง`).toEqual(HEAD);
    for (let i = 0; i < 5; i++) {
      expect(sh[i + 1]?.[0], `${label} A${i + 2}`).toBe(LABELS[i]);
      expect(String(sh[i + 1]?.[1] ?? ''), `${label} B${i + 2}`).toBe(vals[i]);
    }
    expectNoPii(sh.map((r) => r.join('\t')).join('\n'), label);
  };

  // พ.ย. ALL
  await selectDash(p, '2026-11', 'ALL');
  const nov = ['26', '7', '85.7%', '21', '1'];
  await expectKpis(p, { received: nov[0], closed: nov[1], pct: nov[2], backlog: nov[3], overdue: nov[4] });
  await expect(tid(p, 'export-xlsx-btn')).toHaveText('ส่งออก Excel');
  await expect(tid(p, 'export-pdf-btn')).toHaveText('ส่งออก PDF');
  const x1 = await downloadVia(p, '**/api/dashboard/export**', () => tid(p, 'export-xlsx-btn').click());
  checkXlsx(x1.buf, nov, 'xlsx พ.ย.');
  const p1 = await downloadVia(p, '**/api/dashboard/export**', () => tid(p, 'export-pdf-btn').click());
  expect(p1.headers['content-type'] ?? '').toContain('application/pdf');
  expect(p1.buf.subarray(0, 4).toString('latin1')).toBe('%PDF');
  expect(await pdfText(p1.buf)).toContain('kpi received=26 closed=7 ontime=85.7% backlog=21 overdue=1');
  expectNoPii(await pdfTextLines(p1.buf), 'pdf พ.ย.');

  // ธ.ค. ALL
  await selectDash(p, '2026-12', 'ALL');
  const dec = ['3', '0', '–', '21', '1'];
  await expectKpis(p, { received: dec[0], closed: dec[1], pct: dec[2], backlog: dec[3], overdue: dec[4] });
  const x2 = await downloadVia(p, '**/api/dashboard/export**', () => tid(p, 'export-xlsx-btn').click());
  checkXlsx(x2.buf, dec, 'xlsx ธ.ค.');

  // Audit EXPORT = 3
  const au = await staffPage(browser, 'audit1');
  await auditFilterUi(au, { event: 'EXPORT' });
  await expect(tid(au, 'audit-count')).toHaveText('3');
  const rows = await auditRowsUi(au);
  expect(rows.length).toBe(3);
  for (const r of rows) {
    expect(r.actor).toBe('exec1');
    expect(r.role).toBe('executive');
  }
  const details = rows.map((r) => r.detail);
  for (const [fmt, per] of [
    ['xlsx', '2026-11'],
    ['pdf', '2026-11'],
    ['xlsx', '2026-12'],
  ]) {
    expect(details.some((d) => d.includes(fmt) && d.includes(per)), `EXPORT ${fmt} ${per} ใน ${JSON.stringify(details)}`).toBe(true);
  }
});

test('TC-DASH-04 ค่าขอบ "ทันกำหนด" 16:29:59 / 16:30:00 / 16:30:01', async ({ browser }) => {
  await reset();
  await setClock('2026-12-03T16:00:00+07:00');
  const r1 = await staffPage(browser, 'off.reg1');
  const r2 = await staffPage(browser, 'off.reg2');
  const ex = await staffPage(browser, 'exec1');
  // 1
  expect((await expectOk(await act.approve(r2.request, cn(25)), 200)).status).toBe('APPROVED');
  expect((await expectOk(await act.approve(r1.request, cn(23)), 200)).status).toBe('APPROVED');

  const check = async (closed: number, onTime: number) => {
    const d = await dashApi(ex.request, '2026-12', 'ALL');
    expect(d.closed).toBe(closed);
    expect(d.onTime).toBe(onTime);
    await ex.goto('/dashboard');
    await expect(tid(ex, 'kpi-closed')).toHaveText(String(closed));
  };
  // 2
  await setClock('2026-12-03T16:29:59+07:00');
  await expectOk(await act.issue(r2.request, cn(25)), 200);
  await officerCase(r2, 25);
  await expect(tid(r2, 'closed-at')).toHaveAttribute('data-iso', '2026-12-03T16:29:59+07:00');
  await check(1, 1);
  // 3
  await setClock('2026-12-03T16:30:00+07:00');
  expect((await expectOk(await act.reject(r2.request, cn(26), R10), 200)).status).toBe('REJECTED');
  await officerCase(r2, 26);
  await expect(tid(r2, 'closed-at')).toHaveAttribute('data-iso', '2026-12-03T16:30:00+07:00');
  await check(2, 2);
  // 4
  await setClock('2026-12-03T16:30:01+07:00');
  await expectOk(await act.issue(r1.request, cn(23)), 200);
  await officerCase(r1, 23);
  await expect(tid(r1, 'closed-at')).toHaveAttribute('data-iso', '2026-12-03T16:30:01+07:00');
  await check(3, 2);
  await expect(tid(ex, 'kpi-backlog')).toHaveText('18');
  expect((await dashApi(ex.request, '2026-12', 'ALL')).backlog).toBe(18);
});

// ═════════════════════════ AUDIT ═════════════════════════

test('TC-AUDIT-01 เหตุการณ์และฟิลด์ใน Audit', async ({ browser }) => {
  await reset();
  // 1
  const r2 = await loginS('off.reg2');
  await expectOk(await act.claim(r2, cn(28)), 200);
  // 2
  const r1 = await loginS('off.reg1');
  await expectOk(await act.ret(r1, cn(20), R10), 200);
  // 3
  await expectOk(await act.forward(r2, cn(13)), 200);
  // 4
  const h = await loginS('head1');
  await expectOk(await act.approve(h, cn(13)), 200);
  // 5
  await expectOk(await act.approve(r2, cn(25)), 200);
  await expectOk(await act.issue(r2, cn(25)), 200);
  await expectOk(await act.reject(r2, cn(26), R10), 200);
  await expectOk(await act.unmask(r2, cn(25), 'ตรวจสอบตัวตนซ้ำ'), 200);
  // 6
  const ex = await loginS('exec1');
  expect((await ex.get('/api/dashboard/export?format=xlsx&period=2026-12&service=ALL')).status()).toBe(200);
  // 7
  const ad = await loginS('admin1');
  await expectOk(await ad.put('/api/admin/services/SV-01', { data: { fee: 25, sla: 3 } }), 200);
  // 8
  const p = await staffPage(browser, 'audit1');
  await p.goto('/audit');
  await expect(tid(p, 'audit-count')).toHaveText('16');
  const rows = await auditRowsUi(p);
  expect(rows.length).toBe(16);
  for (const r of rows) expect(r.iso, `${r.event} time`).toBe(T0);
  const ids = rows.map((r) => Number(r.id));
  for (let i = 1; i < ids.length; i++) expect(ids[i - 1], 'เรียง data-id มาก → น้อย').toBeGreaterThan(ids[i]);

  const by = (e: string) => rows.filter((r) => r.event === e);
  const logins = by('STAFF_LOGIN');
  expect(logins.map((r) => r.actor).sort()).toEqual(['admin1', 'audit1', 'exec1', 'head1', 'off.reg1', 'off.reg2']);
  for (const r of logins) expect(r.transition).toBe('–');

  const one = (e: string, actor: string, role: string, caseNo: string, transition: string, detail?: string) => {
    const list = by(e);
    expect(list.length, e).toBe(1);
    const r = list[0];
    expect(r.actor, e).toBe(actor);
    expect(r.actorText, e).toContain(actor);
    expect(r.role, e).toBe(role);
    expect(r.eventText, e).toBe(e);
    if (caseNo) expect(r.caseText, e).toBe(caseNo);
    expect(r.transition, e).toBe(transition);
    if (detail) expect(r.detail, e).toContain(detail);
  };
  one('CLAIM', 'off.reg2', 'officer', cn(28), 'SUBMITTED → IN_REVIEW');
  one('RETURN', 'off.reg1', 'officer', cn(20), 'IN_REVIEW → NEED_FIX', R10);
  one('FORWARD', 'off.reg2', 'officer', cn(13), 'IN_REVIEW → PENDING_APPROVAL');
  one('ISSUE', 'off.reg2', 'officer', cn(25), 'APPROVED → COMPLETED', 'DOC-2569-000002');
  one('REJECT', 'off.reg2', 'officer', cn(26), 'IN_REVIEW → REJECTED', R10);
  one('UNMASK', 'off.reg2', 'officer', cn(25), '–', 'ตรวจสอบตัวตนซ้ำ');
  one('EXPORT', 'exec1', 'executive', '', '–');
  expect(by('EXPORT')[0].detail).toContain('xlsx');
  expect(by('EXPORT')[0].detail).toContain('2026-12');
  one('ADMIN_CHANGE', 'admin1', 'admin', '', '–', 'SV-01 fee 20 → 25');
  const ap = by('APPROVE');
  expect(ap.length).toBe(2);
  const apH = ap.find((r) => r.actor === 'head1')!;
  const apO = ap.find((r) => r.actor === 'off.reg2')!;
  expect(apH.role).toBe('head');
  expect(apH.caseText).toBe(cn(13));
  expect(apH.transition).toBe('PENDING_APPROVAL → APPROVED');
  expect(apO.role).toBe('officer');
  expect(apO.caseText).toBe(cn(25));
  expect(apO.transition).toBe('IN_REVIEW → APPROVED');

  // กรอง
  await auditFilterUi(p, { actor: 'off.reg2' });
  await expect(tid(p, 'audit-count')).toHaveText('7');
  expect((await auditRowsUi(p)).map((r) => r.event).sort()).toEqual(
    ['APPROVE', 'CLAIM', 'FORWARD', 'ISSUE', 'REJECT', 'STAFF_LOGIN', 'UNMASK'],
  );
  await auditFilterUi(p, { event: 'APPROVE' });
  await expect(tid(p, 'audit-count')).toHaveText('2');
  expect((await auditRowsUi(p)).map((r) => r.actor).sort()).toEqual(['head1', 'off.reg2']);
  await auditFilterUi(p, { actor: 'off.reg2', event: 'APPROVE' });
  await expect(tid(p, 'audit-count')).toHaveText('1');

  // CSV (ไม่กรอง)
  await auditFilterUi(p, {});
  await expect(tid(p, 'audit-count')).toHaveText('16');
  await expect(tid(p, 'audit-export-csv-btn')).toHaveText('ส่งออก CSV');
  const dl = await clickDownload(p, () => tid(p, 'audit-export-csv-btn').click());
  const csv = parseCsv(dl.buf.toString('utf8'));
  expect(csv[0].join(',')).toBe('time,username,role,event,caseNo,fromStatus,toStatus,detail');
  expect(csv.length - 1).toBe(16);
  await p.goto('/audit');
  await expect(tid(p, 'audit-count')).toHaveText('17');
  const exp = (await auditRowsUi(p)).filter((r) => r.event === 'EXPORT' && r.actor === 'audit1');
  expect(exp.length).toBe(1);
  expect(exp[0].detail).toContain('audit-csv');
});

test('TC-AUDIT-02 Audit แก้/ลบไม่ได้ (405)', async ({ browser }) => {
  await reset();
  const au = await loginS('audit1');
  const before = (await auditApi(au)).items;
  expect(before.length).toBe(1);
  const id = before[0].id;
  const ad = await loginS('admin1');
  for (const c of [ad, au]) {
    await expectErr(await c.put(`/api/audit/${id}`, { data: { detail: 'x' } }), 405, 'METHOD_NOT_ALLOWED');
    await expectErr(await c.patch(`/api/audit/${id}`, { data: { detail: 'x' } }), 405, 'METHOD_NOT_ALLOWED');
    await expectErr(await c.delete(`/api/audit/${id}`), 405, 'METHOD_NOT_ALLOWED');
    await expectErr(await c.put('/api/audit', { data: {} }), 405, 'METHOD_NOT_ALLOWED');
    await expectErr(await c.delete('/api/audit'), 405, 'METHOD_NOT_ALLOWED');
    await expectErr(await c.delete('/api/audit/999999'), 405, 'METHOD_NOT_ALLOWED');
  }
  const after = (await auditApi(au)).items;
  for (const b of before) expect(after, `แถวเดิม id=${b.id} ไม่ถูกแก้/หาย`).toContainEqual(b);
  const added = after.filter((a: any) => !before.some((b: any) => b.id === a.id));
  expect(added.length).toBe(1);
  expect(added[0].event).toBe('STAFF_LOGIN');
  expect(added[0].username).toBe('admin1');
  expect((await ad.get('/api/audit')).status()).toBe(403);

  const p = await staffPage(browser, 'audit1');
  await p.goto('/audit');
  await expect(tid(p, 'audit-row').first()).toBeVisible();
  await expect(tid(p, 'audit-edit-btn')).toHaveCount(0);
  await expect(tid(p, 'audit-delete-btn')).toHaveCount(0);
});

test('TC-AUDIT-03 กรองช่วงวันที่ตามเวลาไทย', async ({ browser }) => {
  await reset();
  const L: Array<[string, string]> = [
    ['2026-11-30T23:59:59+07:00', 'off.reg1'],
    ['2026-12-01T00:00:00+07:00', 'off.reg2'],
    ['2026-12-01T23:59:59+07:00', 'off.works1'],
    ['2026-12-02T00:00:00+07:00', 'off.reg1'],
  ];
  for (const [t, u] of L) {
    await setClock(t);
    await loginS(u);
  }
  await setClock('2026-12-02T09:00:00+07:00');
  const p = await staffPage(browser, 'audit1'); // L5
  const iso = {
    L1: L[0][0],
    L2: L[1][0],
    L3: L[2][0],
    L4: L[3][0],
    L5: '2026-12-02T09:00:00+07:00',
  };
  const cases: Array<[string, string, string, Array<keyof typeof iso>]> = [
    ['2026-12-01', '2026-12-01', '', ['L2', 'L3']],
    ['2026-11-30', '2026-11-30', '', ['L1']],
    ['2026-11-30', '2026-12-01', '', ['L1', 'L2', 'L3']],
    ['2026-12-02', '', '', ['L4', 'L5']],
    ['', '2026-11-30', '', ['L1']],
    ['2026-12-01', '2026-12-02', '', ['L2', 'L3', 'L4', 'L5']],
    ['2026-12-01', '2026-12-01', 'off.reg2', ['L2']],
  ];
  await p.goto('/audit');
  for (const [from, to, actor, want] of cases) {
    const label = `from=${from} to=${to} actor=${actor}`;
    await auditFilterUi(p, { from, to, actor });
    await expect(tid(p, 'audit-count'), label).toHaveText(String(want.length));
    const got = (await auditRowsUi(p)).map((r) => r.iso).sort();
    expect(got, label).toEqual(want.map((k) => iso[k]).sort());
    const j = await auditApi(p.request, { from, to, actor });
    expect(j.count, `API ${label}`).toBe(want.length);
    expect(j.items.map((i: any) => Date.parse(i.time)).sort(), `API ${label}`).toEqual(
      want.map((k) => Date.parse(iso[k])).sort(),
    );
  }
});

// ═════════════════════════ RBAC ═════════════════════════

test('TC-RBAC-01 ประชาชนเปิดคำขอคนอื่นไม่ได้ (IDOR)', async ({ browser }) => {
  await reset();
  const y = await citizenPage(browser, ID.somying);
  expect(await gotoStatus(y, `/citizen/cases/${cn(5)}`)).toBe(404);
  await expect(tid(y, 'not-found-msg')).toHaveText(MSG.NOT_FOUND);
  await expect(tid(y, 'case-no')).toHaveCount(0);
  await expect(tid(y, 'case-status')).toHaveCount(0);
  expect(await y.content()).not.toContain('สมชาย');

  const c = y.request;
  const r5 = await c.get(abs(`/api/cases/${cn(5)}`));
  const t5 = await r5.text();
  expect(r5.status()).toBe(404);
  expect(JSON.parse(t5)).toEqual({ code: 'NOT_FOUND', message: MSG.NOT_FOUND });
  const r9 = await c.get(abs('/api/cases/EG-2569-999999'));
  expect(r9.status()).toBe(404);
  expect(await r9.text(), 'แยกไม่ออกว่าเลขมีอยู่').toBe(t5);
  expect((await c.get(abs('/api/documents/DOC-2569-000001/pdf'))).status()).toBe(404);
  expect((await c.get(abs('/api/drafts/DR-0001'))).status()).toBe(404);
  expect((await act.cancel(c, cn(30))).status()).toBe(404);

  expect(await gotoStatus(y, `/citizen/cases/${cn(7)}`)).toBe(200);
  await expect(tid(y, 'case-no')).toHaveText(cn(7));
  const s = await loginC(ID.somchai);
  expect((await s.get(`/api/cases/${cn(5)}`)).status()).toBe(200);
});

test('TC-RBAC-02 เจ้าหน้าที่อนุมัติ SV-02 ไม่ได้ (API)', async ({ browser }) => {
  await reset();
  const p = await staffPage(browser, 'off.reg2');
  const c = p.request;
  // 1
  await expectErr(await act.approve(c, cn(14)), 403, 'FORBIDDEN');
  expect((await getCase(c, cn(14))).status).toBe('PENDING_APPROVAL');
  // 2
  await expectErr(await act.approve(c, cn(13)), 403, 'FORBIDDEN');
  expect((await getCase(c, cn(13))).status).toBe('IN_REVIEW');
  // 3
  await expectErr(await act.reject(c, cn(14), R10), 403, 'FORBIDDEN');
  expect((await getCase(c, cn(14))).status).toBe('PENDING_APPROVAL');
  // 4
  for (const n of [13, 14]) {
    await officerCase(p, n);
    await expect(tid(p, 'case-no')).toHaveText(cn(n));
    await expect(tid(p, 'approve-btn')).toHaveCount(0);
  }
  // 5
  const h = await loginS('head1');
  await expectErr(await act.approve(h, cn(25)), 403, 'FORBIDDEN');
  // 6
  expect((await expectOk(await act.approve(h, cn(14)), 200)).status).toBe('APPROVED');
  // 7
  const au = await staffPage(browser, 'audit1');
  await auditFilterUi(au, { event: 'APPROVE' });
  await expect(tid(au, 'audit-count')).toHaveText('1');
  const rows = await auditRowsUi(au);
  expect(rows.map((r) => r.actor)).toEqual(['head1']);
  expect(rows[0].caseNo).toBe(cn(14));
});

const NAV_ALL = [
  'nav-my-cases',
  'nav-queue',
  'nav-approvals',
  'nav-dashboard',
  'nav-audit',
  'nav-admin-services',
  'nav-admin-holidays',
  'nav-admin-users',
  'nav-bell',
];

test('TC-RBAC-03 ตารางสิทธิ์หน้า/API ตามบทบาท', async ({ browser }) => {
  test.setTimeout(480_000);
  await reset(); // RESET ต้นเรื่อง (และ RESET ซ้ำก่อนแต่ละบทบาท)
  const PAGES = [
    '/citizen',
    '/officer/queue',
    '/head/approvals',
    '/dashboard',
    '/audit',
    '/admin/services',
    '/admin/holidays',
    '/admin/users',
    '/notifications',
    '/verify/K7M2Q9XA',
  ];
  const allow: Record<string, string[]> = {
    citizen: ['/citizen', '/verify/K7M2Q9XA'],
    officer: ['/officer/queue', '/notifications', '/verify/K7M2Q9XA'],
    head: ['/officer/queue', '/head/approvals', '/notifications', '/verify/K7M2Q9XA'],
    executive: ['/dashboard', '/verify/K7M2Q9XA'],
    auditor: ['/audit', '/verify/K7M2Q9XA'],
    admin: ['/admin/services', '/admin/holidays', '/admin/users', '/verify/K7M2Q9XA'],
  };
  const nav: Record<string, string[]> = {
    citizen: ['nav-my-cases'],
    officer: ['nav-queue', 'nav-bell'],
    head: ['nav-queue', 'nav-approvals', 'nav-bell'],
    executive: ['nav-dashboard'],
    auditor: ['nav-audit'],
    admin: ['nav-admin-services', 'nav-admin-holidays', 'nav-admin-users'],
  };
  const landing: Record<string, string> = {
    citizen: '/citizen',
    officer: '/officer/queue',
    head: '/head/approvals',
    executive: '/dashboard',
    auditor: '/audit',
    admin: '/admin/services',
  };
  // [path, method, anon, citizen, officer, head, executive, auditor, admin]
  const API: Array<[string, 'GET' | 'POST', number[]]> = [
    ['/api/officer/queue', 'GET', [401, 403, 200, 200, 403, 403, 403]],
    ['/api/notifications', 'GET', [401, 403, 200, 200, 403, 403, 403]],
    ['/api/dashboard?period=2026-12&service=ALL', 'GET', [401, 403, 403, 403, 200, 403, 403]],
    ['/api/audit', 'GET', [401, 403, 403, 403, 403, 200, 403]],
    ['/api/admin/services', 'GET', [401, 403, 403, 403, 403, 403, 200]],
    ['/api/drafts', 'POST', [401, 201, 403, 403, 403, 403, 403]],
    [`/api/cases/${cn(25)}`, 'GET', [401, 200, 200, 200, 403, 403, 403]],
    [`/api/officer/cases/${cn(28)}/claim`, 'POST', [401, 403, 200, 403, 403, 403, 403]],
  ];
  const ROLES = ['anon', 'citizen', 'officer', 'head', 'executive', 'auditor', 'admin'] as const;
  const USER: Record<string, string> = { officer: 'off.reg1', head: 'head1', executive: 'exec1', auditor: 'audit1', admin: 'admin1' };

  for (const [ri, role] of ROLES.entries()) {
    await reset();
    // ── ส่วน A หน้า
    let page: Page;
    if (role === 'anon') page = await newPage(browser);
    else if (role === 'citizen') page = await citizenPage(browser, ID.somchai);
    else page = await staffPage(browser, USER[role]);
    for (const pth of PAGES) {
      const label = `${role} ${pth}`;
      const st = await gotoStatus(page, pth);
      if (role === 'anon') {
        if (pth.startsWith('/verify/')) {
          expect(st, label).toBe(200);
          await expectPath(page, pth);
        } else await expectPath(page, '/login');
      } else if (allow[role].includes(pth)) {
        expect(st, label).toBe(200);
        await expectPath(page, pth);
        await expect(tid(page, 'forbidden-msg'), label).toHaveCount(0);
      } else {
        expect(st, label).toBe(403);
        await expect(tid(page, 'forbidden-msg'), label).toHaveText(MSG.FORBIDDEN_PAGE);
      }
    }
    // ── ส่วน D เมนู
    if (role !== 'anon') {
      await page.goto(landing[role]);
      await expectPath(page, landing[role]);
      for (const n of NAV_ALL) await expect(tid(page, n), `${role} ${n}`).toHaveCount(nav[role].includes(n) ? 1 : 0);
    }
    // ── ส่วน B API (claim เป็นลำดับสุดท้าย)
    let c: APIRequestContext;
    let caseCtx: APIRequestContext;
    if (role === 'anon') c = caseCtx = await newApi();
    else if (role === 'citizen') {
      c = page.request;
      caseCtx = await loginC(ID.somying);
    } else c = caseCtx = page.request;
    for (const [url, method, exp] of API) {
      const ctx = url.startsWith('/api/cases/') ? caseCtx : c;
      const r =
        method === 'GET'
          ? await ctx.get(abs(url))
          : await ctx.post(abs(url), url === '/api/drafts' ? { data: { serviceId: 'SV-01', qty: 1 } } : {});
      expect(r.status(), `${role} ${method} ${url}`).toBe(exp[ri]);
    }
  }

  // ── ส่วน C ขอบเขตแผนก
  await reset();
  const w = await loginS('off.works1');
  const r1 = await loginS('off.reg1');
  await expectErr(await act.claim(w, cn(28)), 403, 'FORBIDDEN');
  await expectErr(await act.claim(r1, cn(10)), 403, 'FORBIDDEN');
  expect((await queueApi(w)).map((i) => i.caseNo)).toEqual([cn(10)]);
});

test('TC-RBAC-04 ผู้ดูแลระบบ: บริการ วันหยุด ผู้ใช้ และยอดที่ล็อก', async ({ browser }) => {
  test.setTimeout(360_000);
  await reset();
  const ad = await staffPage(browser, 'admin1');
  // 1
  await ad.goto('/admin/holidays');
  await expect(tid(ad, 'holiday-row')).toHaveCount(4);
  expect(await attrList(ad, 'holiday-row', 'data-date')).toEqual(['2026-12-07', '2026-12-10', '2026-12-31', '2027-01-01']);
  // 2
  const n31 = await newPaid({ at: T0 });
  expect(n31.caseNo).toBe(cn(31));
  expect((await getCase(n31.ctx, cn(31))).dueAt).toBe('2026-12-04T16:30:00+07:00');
  // 3
  await ad.goto('/admin/services');
  await tid(ad, 'svc-fee-SV-01').fill('25');
  await tid(ad, 'svc-save-SV-01').click();
  await expect(tid(ad, 'action-success')).toBeVisible();
  await ad.goto('/admin/services');
  await tid(ad, 'svc-fee-SV-02').fill('600');
  await tid(ad, 'svc-save-SV-02').click();
  await expect(tid(ad, 'action-success')).toBeVisible();
  // 4
  const s = await citizenPage(browser, ID.somchai);
  await s.goto('/citizen/new/SV-01');
  await setField(tid(s, 'qty-input'), '5');
  await expect(tid(s, 'fee-total')).toHaveText('฿125');
  await setField(tid(s, 'qty-input'), '1');
  await expect(tid(s, 'fee-total')).toHaveText('฿25');
  await s.goto('/citizen/new/SV-02');
  await expect(tid(s, 'fee-total')).toHaveText('฿600');
  await citizenCase(s, 30);
  await expect(tid(s, 'case-fee')).toHaveText('฿20');
  // 5
  await s.goto('/citizen/new/SV-02?draft=DR-0002');
  await expect(tid(s, 'payment-amount')).toHaveText('฿500');
  await expectErr(await pay('PP-0001', 600), 422, 'AMOUNT_MISMATCH', MSG.AMOUNT_MISMATCH);
  const pj = await expectOk(await pay('PP-0001', 500), 200);
  expect(pj.status).toBe('PAID');
  expect(pj.caseNo).toBe(cn(32));
  // 6
  await ad.goto('/admin/holidays');
  await tid(ad, 'holiday-date-input').fill('2026-12-02');
  await tid(ad, 'holiday-name-input').fill('วันหยุดทดสอบ');
  await tid(ad, 'holiday-add-btn').click();
  await expect(tid(ad, 'holiday-row')).toHaveCount(5);
  await expect(byAttr(ad, 'holiday-row', 'data-date', '2026-12-02')).toHaveCount(1);
  expect((await getCase(s.request, cn(31))).dueAt).toBe('2026-12-04T16:30:00+07:00');
  // 7
  const n33 = await newPaid({ at: T0 });
  expect(n33.caseNo).toBe(cn(33));
  expect(n33.amount).toBe(25);
  expect((await getCase(n33.ctx, cn(33))).dueAt).toBe('2026-12-08T16:30:00+07:00');
  // 8
  await expectOk(await ad.request.put(abs('/api/admin/users/exec1'), { data: { role: 'auditor', dept: '' } }), 200);
  const e = await newPage(browser);
  await uiLoginS(e, 'exec1');
  await expectPath(e, '/audit');
  expect(await gotoStatus(e, '/dashboard')).toBe(403);
  await expect(tid(e, 'forbidden-msg')).toHaveText(MSG.FORBIDDEN_PAGE);
  // 9
  await auditFilterUi(e, { event: 'ADMIN_CHANGE' });
  await expect(tid(e, 'audit-count')).toHaveText('4');
  let rows = await auditRowsUi(e);
  for (const r of rows) {
    expect(r.actor).toBe('admin1');
    expect(r.role).toBe('admin');
  }
  let det = rows.map((r) => r.detail).join('\n');
  for (const d of ['SV-01 fee 20 → 25', 'SV-02 fee 500 → 600', 'holiday add 2026-12-02', 'exec1 role executive → auditor'])
    expect(det).toContain(d);
  // 10
  expect((await ad.request.post(abs('/api/drafts'), { data: { serviceId: 'SV-01', qty: 1 } })).status()).toBe(403);
  // 11
  await ad.goto('/admin/holidays');
  await byAttr(ad, 'holiday-row', 'data-date', '2026-12-02').getByTestId('holiday-delete-btn').click();
  await expect(tid(ad, 'holiday-row')).toHaveCount(4);
  await auditFilterUi(e, { event: 'ADMIN_CHANGE' });
  await expect(tid(e, 'audit-count')).toHaveText('5');
  rows = await auditRowsUi(e);
  det = rows.map((r) => r.detail).join('\n');
  expect(det).toContain('holiday delete 2026-12-02');
});

test('TC-RBAC-05 สิทธิ์เปิด/ดาวน์โหลดไฟล์แนบ', async ({ browser }) => {
  await reset();
  const reg1 = await loginS('off.reg1');
  const reg2 = await loginS('off.reg2');
  const works = await loginS('off.works1');
  const head = await loginS('head1');
  const ying = await loginC(ID.somying);
  const chai = await loginC(ID.somchai);
  const ex = await loginS('exec1');
  const au = await loginS('audit1');
  const ad = await loginS('admin1');
  const anon = await newApi();

  // fileId อ้างอิง (head เห็นได้ทุกแผนก)
  const ref: Record<number, string[]> = {};
  for (const n of [25, 10, 12, 11]) {
    const j = await expectOk(await head.get(`/api/cases/${cn(n)}/files`), 200);
    ref[n] = (j.items as any[]).map((i) => i.fileId);
  }

  const okRow = async (c: APIRequestContext, n: number, names: string[], label: string) => {
    const j = await expectOk(await c.get(`/api/cases/${cn(n)}/files`), 200);
    expect((j.items as any[]).map((i) => i.name).sort(), label).toEqual([...names].sort());
    for (const it of j.items as any[]) {
      const r = await c.get(`/api/files/${it.fileId}`);
      expect(r.status(), `${label} file ${it.name}`).toBe(200);
      expect(r.headers()['content-type'] ?? '', `${label} file ${it.name}`).toContain('application/pdf');
      expect((await r.body()).subarray(0, 4).toString('latin1')).toBe('%PDF');
    }
  };
  const denyRow = async (c: APIRequestContext, n: number, status: number, label: string) => {
    expect((await c.get(`/api/cases/${cn(n)}/files`)).status(), `${label} /files`).toBe(status);
    for (const f of ref[n]) expect((await c.get(`/api/files/${f}`)).status(), `${label} /api/files`).toBe(status);
  };
  const SV03 = ['id-card.pdf', 'plan.pdf', 'deed.pdf'];

  await okRow(reg1, 25, ['id-card.pdf'], 'off.reg1 000025');
  await denyRow(works, 25, 403, 'off.works1 000025');
  await okRow(reg2, 12, SV03, 'off.reg2 000012');
  await denyRow(works, 12, 403, 'off.works1 000012');
  await okRow(works, 10, SV03, 'off.works1 000010');
  await okRow(reg1, 10, SV03, 'off.reg1 000010');
  await okRow(works, 11, SV03, 'off.works1 000011');
  await okRow(head, 25, ['id-card.pdf'], 'head1 000025');
  await okRow(head, 10, SV03, 'head1 000010');
  await okRow(head, 12, SV03, 'head1 000012');
  await okRow(ying, 25, ['id-card.pdf'], 'สมหญิง 000025');
  await denyRow(chai, 25, 404, 'สมชาย 000025');
  for (const [c, u] of [
    [ex, 'exec1'],
    [au, 'audit1'],
    [ad, 'admin1'],
  ] as const)
    await denyRow(c, 25, 403, `${u} 000025`);
  await denyRow(anon, 25, 401, 'ไม่ล็อกอิน 000025');
  expect((await reg1.get('/api/files/no-such-file-id-999999')).status()).toBe(404);

  // UI
  const p = await staffPage(browser, 'off.reg1');
  await officerCase(p, 25);
  await expect(tid(p, 'doc-item')).toHaveCount(1);
  await expect(tid(p, 'doc-item')).toHaveAttribute('data-name', 'id-card.pdf');
  const link = tid(p, 'doc-item').getByTestId('doc-download-link');
  await expect(link).toHaveCount(1);
  const href = await link.getAttribute('href');
  expect(href ?? '').toMatch(/\/api\/files\//);
  const fr = await p.request.get(abs(href!));
  expect(fr.status()).toBe(200);
  expect((await fr.body()).length).toBeGreaterThan(0);
  const q = await staffPage(browser, 'off.reg2');
  await officerCase(q, 12);
  await expect(tid(q, 'doc-item')).toHaveCount(3);
  const y = await citizenPage(browser, ID.somying);
  await citizenCase(y, 25);
  await expect(tid(y, 'doc-item')).toHaveCount(1);
});

test('TC-RBAC-06 ผู้ดูแลระบบ: ช่วงค่าที่ยอมรับ', async ({ browser }) => {
  await reset();
  const ad = await staffPage(browser, 'admin1');
  const c = ad.request;
  const svc01 = async () => ((await expectOk(await c.get(abs('/api/admin/services')), 200)).items as any[]).find((i) => i.id === 'SV-01');

  const ui = async (field: 'fee' | 'sla', v: number, err: string | null) => {
    await ad.goto('/admin/services');
    await tid(ad, `svc-${field}-SV-01`).fill(String(v));
    await tid(ad, 'svc-save-SV-01').click();
    if (err) await expect(tid(ad, 'action-error'), `${field}=${v}`).toHaveText(err);
    else await expect(tid(ad, 'action-success'), `${field}=${v}`).toBeVisible();
  };

  // fee
  await ui('fee', -1, MSG.INVALID_FEE);
  await expectErr(await c.put(abs('/api/admin/services/SV-01'), { data: { fee: -1, sla: 3 } }), 400, 'INVALID_FEE', MSG.INVALID_FEE);
  expect((await svc01()).fee).toBe(20);
  await ui('fee', 0, null);
  expect((await svc01()).fee).toBe(0);
  await ui('fee', 100000, null);
  expect((await svc01()).fee).toBe(100000);
  await ui('fee', 100001, MSG.INVALID_FEE);
  await expectErr(await c.put(abs('/api/admin/services/SV-01'), { data: { fee: 100001, sla: 3 } }), 400, 'INVALID_FEE');
  expect((await svc01()).fee).toBe(100000);
  // sla
  await ui('sla', 0, MSG.INVALID_SLA);
  await expectErr(await c.put(abs('/api/admin/services/SV-01'), { data: { fee: 100000, sla: 0 } }), 400, 'INVALID_SLA', MSG.INVALID_SLA);
  expect((await svc01()).sla).toBe(3);
  await ui('sla', 1, null);
  expect((await svc01()).sla).toBe(1);
  await ui('sla', 60, null);
  expect((await svc01()).sla).toBe(60);
  await ui('sla', 61, MSG.INVALID_SLA);
  await expectErr(await c.put(abs('/api/admin/services/SV-01'), { data: { fee: 100000, sla: 61 } }), 400, 'INVALID_SLA');
  expect((await svc01()).sla).toBe(60);

  // วันหยุด
  await expectErr(
    await c.post(abs('/api/admin/holidays'), { data: { date: '2026-12-07', name: 'ซ้ำ' } }),
    409,
    'DUPLICATE_HOLIDAY',
    MSG.DUPLICATE_HOLIDAY,
  );
  await ad.goto('/admin/holidays');
  await expect(tid(ad, 'holiday-row')).toHaveCount(4);
  expect((await c.post(abs('/api/admin/holidays'), { data: { date: '2026-12-05', name: 'วันเสาร์' } })).status()).toBe(201);
  // ผู้ใช้: เปลี่ยนบทบาทตัวเอง
  await expectErr(
    await c.put(abs('/api/admin/users/admin1'), { data: { role: 'executive', dept: '' } }),
    409,
    'SELF_ROLE_CHANGE',
    MSG.SELF_ROLE_CHANGE,
  );
  expect((await expectOk(await c.get(abs('/api/me')), 200)).role).toBe('admin');

  // Audit
  const au = await staffPage(browser, 'audit1');
  await auditFilterUi(au, { event: 'ADMIN_CHANGE' });
  await expect(tid(au, 'audit-count')).toHaveText('5');
  const det = (await auditRowsUi(au)).map((r) => r.detail).join('\n');
  for (const d of ['SV-01 fee 20 → 0', 'SV-01 fee 0 → 100000', 'SV-01 sla 3 → 1', 'SV-01 sla 1 → 60', 'holiday add 2026-12-05'])
    expect(det).toContain(d);
});

// ═════════════════════════ NFR ═════════════════════════

test('TC-NFR-01 Responsive 375 / 768 / 1280', async ({ browser }) => {
  test.setTimeout(480_000);
  await reset();
  const SIZES = [
    { width: 375, height: 812 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ];
  const groups: Array<{ who: string; pages: string[] }> = [
    { who: 'anon', pages: ['/login', '/verify/K7M2Q9XA'] },
    { who: 'citizen', pages: ['/citizen', '/citizen/new/SV-03', `/citizen/cases/${cn(13)}`] },
    { who: 'off.reg1', pages: ['/officer/queue', `/officer/cases/${cn(20)}`] },
    { who: 'head1', pages: ['/head/approvals'] },
    { who: 'exec1', pages: ['/dashboard'] },
    { who: 'audit1', pages: ['/audit'] },
    { who: 'admin1', pages: ['/admin/services'] },
  ];
  let checks = 0;
  for (const g of groups) {
    const page =
      g.who === 'anon' ? await newPage(browser) : g.who === 'citizen' ? await citizenPage(browser, ID.somchai) : await staffPage(browser, g.who);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      for (const pth of g.pages) {
        await page.goto(pth);
        await expectPath(page, pth);
        await expectNoHScroll(page, `${g.who} ${pth} @${size.width}`);
        checks++;
      }
    }
  }
  expect(checks).toBe(33);

  // งานหลักที่ 375 px
  const m = await newPage(browser, { viewport: { width: 375, height: 812 } });
  await uiLoginC(m, ID.somchai);
  await expectPath(m, '/citizen');
  await tid(m, 'start-service-SV-01').click();
  await expectPath(m, '/citizen/new/SV-01');
  await setField(tid(m, 'qty-input'), '1');
  await expect(tid(m, 'fee-total')).toHaveText('฿20');
  await tid(m, 'to-upload-btn').click();
  await attachUi(m, 'id-card', tf('id-card.pdf'));
  await expect(tid(m, 'to-payment-btn')).toBeEnabled();
  await tid(m, 'to-payment-btn').click();
  const qr = tid(m, 'create-qr-btn');
  await expect(qr).toBeVisible();
  await qr.scrollIntoViewIfNeeded();
  const box = await qr.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  await expectNoHScroll(m, 'งานหลัก 375');
});

test('TC-NFR-02 WCAG: axe + คีย์บอร์ด + label + สถานะไม่ใช้สีอย่างเดียว', async ({ browser }) => {
  test.setTimeout(480_000);
  await reset();
  const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

  // ── ส่วน A axe + ส่วน C label
  const anon = await newPage(browser);
  const mana = await newPage(browser);
  await uiLoginC(mana, ID.mana);
  await expectPath(mana, '/register');
  const cit = await citizenPage(browser, ID.somchai);
  const r1 = await staffPage(browser, 'off.reg1');
  const h = await staffPage(browser, 'head1');
  const ex = await staffPage(browser, 'exec1');
  const au = await staffPage(browser, 'audit1');
  const ad = await staffPage(browser, 'admin1');
  const targets: Array<[Page, string]> = [
    [anon, '/login'],
    [mana, '/register'],
    [cit, '/citizen'],
    [cit, '/citizen/new/SV-01'],
    [cit, `/citizen/cases/${cn(17)}`],
    [r1, '/officer/queue'],
    [r1, `/officer/cases/${cn(20)}`],
    [h, '/head/approvals'],
    [ex, '/dashboard'],
    [au, '/audit'],
    [ad, '/admin/services'],
    [r1, '/notifications'],
    [anon, '/verify/K7M2Q9XA'],
  ];
  const problems: string[] = [];
  for (const [p, pth] of targets) {
    await p.goto(pth);
    await expectPath(p, pth);
    const res = await new AxeBuilder({ page: p }).withTags(TAGS).analyze();
    const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    for (const v of bad) problems.push(`${pth}: [${v.impact}] ${v.id} (${v.nodes.length}) ${v.help}`);
    const unl = await unlabeledFields(p);
    for (const u of unl) problems.push(`${pth}: ไม่มี label → ${u}`);
  }
  expect(problems, problems.join('\n')).toEqual([]);

  // ── ส่วน B คีย์บอร์ดอย่างเดียว
  const k = await newPage(browser);
  await k.goto('/login');
  await tabTo(k, 'thaid-id-input');
  await k.keyboard.type(ID.somchai);
  await k.keyboard.press('Enter');
  await expect(tid(k, 'otp-input')).toBeVisible();
  await tabTo(k, 'otp-input');
  await k.keyboard.type(OTP);
  await k.keyboard.press('Enter');
  await expectPath(k, '/citizen');
  await tabTo(k, 'start-service-SV-01');
  await k.keyboard.press('Enter');
  await expectPath(k, '/citizen/new/SV-01');
  await tabTo(k, 'qty-input');
  await k.keyboard.press('Control+A');
  await k.keyboard.type('1');
  await expect(tid(k, 'qty-input')).toHaveValue('1');
  await tabTo(k, 'to-upload-btn');
  await k.keyboard.press('Enter');
  await expect(tid(k, 'wizard-step')).toHaveText('2/3 แนบเอกสาร');
  await tid(k, 'upload-input-id-card').focus();
  await tid(k, 'upload-input-id-card').setInputFiles(tf('id-card.pdf'));
  await expect(tid(k, 'file-item')).toHaveCount(1, { timeout: 60_000 });
  await expect(tid(k, 'to-payment-btn')).toBeEnabled();
  await tabTo(k, 'to-payment-btn');
  await k.keyboard.press('Enter');
  await expect(tid(k, 'create-qr-btn')).toBeVisible();

  // ── ส่วน D สถานะไม่ใช้สีอย่างเดียว
  const statusChecks = async (forced: boolean) => {
    const tag = forced ? ' (forcedColors)' : '';
    await r1.emulateMedia({ forcedColors: forced ? 'active' : 'none' });
    await cit.emulateMedia({ forcedColors: forced ? 'active' : 'none' });
    await r1.goto('/officer/queue');
    const rows = await r1.getByTestId('queue-row').evaluateAll((els) =>
      els.map((r) => ({
        st: r.getAttribute('data-status') ?? '',
        lv: r.getAttribute('data-sla-level') ?? '',
        stText: (r.querySelector('[data-testid="row-status"]') as HTMLElement | null)?.innerText.trim() ?? '',
        lvText: (r.querySelector('[data-testid="row-sla-level"]') as HTMLElement | null)?.innerText.trim() ?? '',
      })),
    );
    expect(rows.length).toBe(17);
    for (const r of rows) {
      expect(r.stText, `row-status${tag}`).toBe(STATUS_TH[r.st]);
      expect(r.lvText, `row-sla-level${tag}`).toBe(LEVEL_TH[r.lv]);
    }
    await officerCase(r1, 20);
    await expectStatus(r1, 'IN_REVIEW');
    await expectLevel(r1, 'overdue');
    await citizenCase(cit, 17);
    await expectStatus(cit, 'NEED_FIX');
    await expectLevel(cit, 'paused');
    await cit.goto('/citizen');
    const mine = await cit.getByTestId('my-case-row').evaluateAll((els) =>
      els.map((r) => ({
        st: r.getAttribute('data-status') ?? '',
        stText: (r.querySelector('[data-testid="row-status"]') as HTMLElement | null)?.innerText.trim() ?? '',
      })),
    );
    expect(mine.length).toBe(10);
    for (const r of mine) expect(r.stText, `my-case row-status${tag}`).toBe(STATUS_TH[r.st]);
  };
  await statusChecks(false);
  await statusChecks(true);
});

test('TC-NFR-03 Health เวลาโหลด และผลซ้ำได้', async ({ browser }) => {
  test.setTimeout(360_000);
  await reset();
  // health
  const a = await newApi();
  const hr = await a.get('/api/health');
  expect(hr.status()).toBe(200);
  expect(JSON.parse(await hr.text())).toEqual({ status: 'ok' });

  // เวลาโหลด (รอบที่ 2)
  const measure = async (p: Page, pth: string) => {
    await p.goto(pth, { waitUntil: 'load' });
    const t0 = Date.now();
    await p.goto(pth, { waitUntil: 'load' });
    const ms = Date.now() - t0;
    await expectPath(p, pth);
    expect(ms, `${pth} โหลด ${ms} ms`).toBeLessThanOrEqual(3000);
  };
  await measure(await newPage(browser), '/login');
  await measure(await citizenPage(browser, ID.somchai), '/citizen');
  await measure(await staffPage(browser, 'off.reg1'), '/officer/queue');
  await measure(await staffPage(browser, 'exec1'), '/dashboard');
  await measure(await staffPage(browser, 'audit1'), '/audit');

  // ผลซ้ำได้
  const snap = async () => {
    const clock = await getClock();
    const r1 = await loginS('off.reg1');
    const q = (await queueApi(r1, 'all')).map((i) => ({ caseNo: i.caseNo, dueAt: i.dueAt, status: i.status, owner: i.owner ?? null }));
    const ex = await loginS('exec1');
    const d = await dashApi(ex, '2026-12', 'ALL');
    return { clock, q, d };
  };
  await reset();
  const S1 = await snap();
  await setClock('2026-12-10T12:00:00+07:00');
  const r1 = await loginS('off.reg1');
  await expectOk(await act.claim(r1, cn(28)), 200);
  await newPaid({});
  await reset();
  const S2 = await snap();
  expect(S2).toEqual(S1);
  expect(S2.clock).toBe(T0);

  // นาฬิกาไม่มี offset → 400
  // [B13] context `a` ถูก dispose ไปแล้วโดย reset() (disposeAll) → ใช้ context ใหม่ (ไม่เปลี่ยนผลคาดหวัง)
  const a2 = await newApi();
  await expectErr(await a2.put('/api/test/clock', { data: { now: '2026-12-01 09:00' } }), 400, 'INVALID_TIME');

  // ปิด hook (ถ้ามีเว็บอีกตัวที่ไม่ตั้ง TEST_MODE)
  const noTm = process.env.BASE_URL_NO_TEST_MODE;
  if (noTm) {
    const b = await newApi();
    expect((await b.post(`${noTm.replace(/\/+$/, '')}/api/test/reset`)).status()).toBe(404);
  } else {
    test.info().annotations.push({ type: 'note', description: 'ไม่ได้ตั้ง BASE_URL_NO_TEST_MODE → ข้ามการตรวจ hook ปิด (404)' });
  }
});

test('TC-NFR-04 เข้ารหัสข้อมูลส่วนบุคคลที่เก็บ (inspection)', async () => {
  await reset();
  // มานะลงทะเบียน (ตาม TC-AUTH-03)
  const m = await newApi();
  await expectOk(await thaidStart(m, ID.mana), 200);
  expect((await expectOk(await thaidVerify(m, ID.mana, OTP), 200)).registered).toBe(false);
  await expectOk(await m.post('/api/auth/register', { data: { mobile: '0845678901', email: '', consent: true } }), 201);

  const files = dbFiles();
  expect(files.length, 'ไม่พบไฟล์ฐานข้อมูล (ตั้ง DB_PATH หรือรันจากโฟลเดอร์ app/ ที่มี data/egov.db)').toBeGreaterThan(0);
  const needles = [
    ID.somchai,
    ID.somying,
    ID.piti,
    ID.mana,
    '0812345678',
    '0823456789',
    '0834567890',
    '0845678901',
    FULL_ID.somchai,
    FULL_ID.somying,
    FULL_ID.piti,
    FULL_ID.mana,
  ];
  const found: string[] = [];
  for (const f of files) {
    const buf = fs.readFileSync(f);
    for (const n of needles) {
      for (const enc of ['utf8', 'utf16le'] as const) {
        if (buf.includes(Buffer.from(n, enc))) found.push(`${path.basename(f)}: ${n} (${enc})`);
      }
    }
  }
  expect(found, found.join('\n')).toEqual([]);

  // ตัวควบคุมบวก: ถอดรหัสได้ถูกต้อง
  const s = await loginC(ID.somchai);
  expect((await getCase(s, cn(5))).idNo).toBe(ID.somchai);
});
