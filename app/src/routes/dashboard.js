'use strict';

// FR-22/23 · US-A01 · BR-25/26. Kept self-contained because this block owns
// only this route file; both the page and export use the same KPI calculation.
const express = require('express');
const ExcelJS = require('exceljs');
const { db } = require('../db');
const rules = require('../lib/rules');
const clock = require('../lib/clock');

const router = express.Router();
const SERVICES = ['ALL', 'SV-01', 'SV-02', 'SV-03'];
const PERIODS = ['2026-12', '2026-11', '2026-10', '2026'];
const KPI_ROWS = [
  ['รับเรื่อง', 'received'],
  ['ปิดงาน', 'closed'],
  ['ทันกำหนด %', 'ontimeText'],
  ['งานคงค้าง', 'backlog'],
  ['เกินกำหนดคงค้าง', 'overdue'],
];

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function authorized(req, res) {
  if (!req.user) {
    res.unauthenticated();
    return false;
  }
  if (req.user.role !== 'executive') {
    res.forbidden();
    return false;
  }
  return true;
}

function selection(query) {
  const now = clock.bkk(clock.nowMs());
  const fallbackPeriod = `${now.year}-${String(now.month).padStart(2, '0')}`;
  const requestedPeriod = String(query.period || fallbackPeriod);
  const period = /^\d{4}(?:-\d{2})?$/.test(requestedPeriod) ? requestedPeriod : fallbackPeriod;
  const requestedService = String(query.service || 'ALL');
  const service = SERVICES.includes(requestedService) ? requestedService : 'ALL';
  return { period, service };
}

function dashboardData({ period, service }) {
  const cases = db.prepare(`SELECT case_no, status, service_id, paid_at, closed_at, due_at, owner
    FROM cases WHERE case_no IS NOT NULL`).all();
  const calculated = rules.computeKpis(cases, { period, service, now: clock.nowMs() });
  // A-41: service filters apply to KPIs, while current officer workload is global.
  const globalWorkload = rules.computeKpis(cases, { period, service: 'ALL', now: clock.nowMs() }).workload;
  // The contract requires all three seeded staff, including staff with no load.
  const officers = db.prepare("SELECT username FROM users WHERE role='officer' AND active=1 ORDER BY username").all();
  const loadByUser = new Map(globalWorkload.map((w) => [w.username, w.count]));
  return {
    ...calculated,
    workload: officers.map(({ username }) => ({ username, count: loadByUser.get(username) || 0 })),
  };
}

function page(req, res, selected, stats) {
  const title = 'Dashboard · e-Service เทศบาลนครตัวอย่าง';
  const periodOptions = [...new Set([...PERIODS, selected.period])];
  const periodSelect = periodOptions.map((period) => `<option value="${esc(period)}"${period === selected.period ? ' selected' : ''}>${period === '2026' ? 'ทั้งปี 2569' : esc(period)}</option>`).join('');
  const serviceSelect = SERVICES.map((service) => `<option value="${service}"${service === selected.service ? ' selected' : ''}>${service === 'ALL' ? 'ทุกบริการ' : service}</option>`).join('');
  const workload = stats.workload.map((row) => `<tr data-testid="workload-row" data-username="${esc(row.username)}"><th scope="row">${esc(row.username)}</th><td data-testid="workload-value">${row.count}</td></tr>`).join('');
  const body = `<h1>Dashboard</h1>
      <form method="get" action="/dashboard" class="dashboard-filters card"><label for="period-select">ช่วงเวลา</label><select id="period-select" name="period" data-testid="period-select">${periodSelect}</select><label for="service-select">บริการ</label><select id="service-select" name="service" data-testid="service-select">${serviceSelect}</select><button type="submit" class="btn">แสดงผล</button></form>
      <section aria-label="ตัวชี้วัด" class="card"><dl class="kpi-grid"><div><dt>รับเรื่อง</dt><dd data-testid="kpi-received">${stats.received}</dd></div><div><dt>ปิดงาน</dt><dd data-testid="kpi-closed">${stats.closed}</dd></div><div><dt>ทันกำหนด %</dt><dd data-testid="kpi-ontime-pct">${esc(stats.ontimeText)}</dd></div><div><dt>งานคงค้าง</dt><dd data-testid="kpi-backlog">${stats.backlog}</dd></div><div><dt>เกินกำหนดคงค้าง</dt><dd data-testid="kpi-overdue">${stats.overdue}</dd></div></dl></section>
      <section class="card"><h2>งานในมือรายเจ้าหน้าที่</h2><table><caption class="sr-only">งานในมือรายเจ้าหน้าที่</caption><thead><tr><th scope="col">ผู้ใช้</th><th scope="col">จำนวนงาน</th></tr></thead><tbody>${workload}</tbody></table></section>
      <section aria-label="ส่งออกรายงาน" class="card"><h2>ส่งออกรายงาน</h2><a class="btn" data-testid="export-xlsx-btn" href="/api/dashboard/export?format=xlsx&amp;period=${encodeURIComponent(selected.period)}&amp;service=${encodeURIComponent(selected.service)}">ส่งออก Excel</a> <a class="btn" data-testid="export-pdf-btn" href="/api/dashboard/export?format=pdf&amp;period=${encodeURIComponent(selected.period)}&amp;service=${encodeURIComponent(selected.service)}">ส่งออก PDF</a></section>
    <script>document.querySelectorAll('[data-testid="period-select"],[data-testid="service-select"]').forEach(function(s){s.addEventListener('change',function(){s.form.requestSubmit()})})</script>`;
  return res.status(200).render('layout', { layout: false, title, body });
}

router.get('/dashboard', (req, res) => {
  if (!authorized(req, res)) return;
  const selected = selection(req.query);
  return page(req, res, selected, dashboardData(selected));
});

router.get('/api/dashboard', (req, res) => {
  if (!authorized(req, res)) return;
  const selected = selection(req.query);
  const stats = dashboardData(selected);
  return res.json({ received: stats.received, closed: stats.closed, onTime: stats.onTime,
    ontimePct: stats.ontimePct, backlog: stats.backlog, overdue: stats.overdue,
    workload: stats.workload.map(({ username, count }) => ({ username, count })) });
});

/** PDF 1.4 หน้าเดียว ฟอนต์ Helvetica · lines = ข้อความ ASCII */
function simplePdf(lines) {
  const escPdf = (t) => String(t).replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');
  const stream = ['BT', '/F1 12 Tf', '50 790 Td', '16 TL', ...lines.map((l) => `(${escPdf(l)}) Tj T*`), 'ET'].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Title (Dashboard report) /Producer (e-Service) >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function recordExport(req, format, selected) {
  db.prepare(`INSERT INTO audit_log(time, username, role, event, case_no, from_status, to_status, detail)
    VALUES(?, ?, ?, 'EXPORT', NULL, NULL, NULL, ?)`).run(
    clock.nowISO(), req.user.username, req.user.role, `${format} ${selected.period} ${selected.service}`);
}

router.get('/api/dashboard/export', async (req, res, next) => {
  if (!authorized(req, res)) return;
  const format = String(req.query.format || '').toLowerCase();
  if (!['xlsx', 'pdf'].includes(format)) return res.apiError(400, 'INVALID_FORMAT', 'รูปแบบไฟล์ไม่ถูกต้อง');
  const selected = selection(req.query);
  const stats = dashboardData(selected);
  try {
    recordExport(req, format, selected);
    if (format === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Dashboard');
      sheet.addRow(['ตัวชี้วัด', 'ค่า']);
      KPI_ROWS.forEach(([label, key]) => sheet.addRow([label, String(stats[key])]));
      sheet.getColumn(1).width = 26;
      sheet.getColumn(2).width = 18;
      const bytes = await workbook.xlsx.writeBuffer();
      res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="dashboard-${selected.period}-${selected.service}.xlsx"` });
      return res.status(200).send(Buffer.from(bytes));
    }
    const ontime = stats.ontimePct == null ? '-' : stats.ontimeText;
    const asciiLine = `kpi received=${stats.received} closed=${stats.closed} ontime=${ontime} backlog=${stats.backlog} overdue=${stats.overdue}`;
    // PDF ขั้นต่ำแบบเขียนเอง: ข้อความ ASCII เป็น literal string (ไม่บีบอัด ไม่ hex) ให้เครื่องอ่านบรรทัด kpi ได้ (CONTRACT §7)
    // ไม่มี CreationDate/ID ที่เป็นตัวเลขยาว · ไม่มีชื่อผู้ยื่น เลขบัตร หรือเบอร์โทร
    const pdfBuf = simplePdf(['Dashboard report', `Period: ${selected.period}  Service: ${selected.service}`, asciiLine]);
    res.set({ 'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="dashboard-${selected.period}-${selected.service}.pdf"` });
    return res.status(200).send(pdfBuf);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
