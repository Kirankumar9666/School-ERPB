/**
 * Server-side payslip PDF generator (pdfkit).
 *
 * buildPayslipPdf(employee, record) → Buffer containing a print-ready A4
 * salary slip composed ENTIRELY from the two live rows passed in — the
 * employee's profile (identity + employment fields only) and that month's
 * PayrollRecord. Nothing is hardcoded: names, IDs, amounts, dates and the
 * paid/pending state are all read at generation time, so the same template
 * serves every employee and every month.
 *
 * Fonts: DejaVu Sans (assets/fonts) — the standard-14 PDF fonts are
 * WinAnsi-encoded and cannot render the rupee sign (₹, U+20B9) that every
 * amount needs. pdfkit subsets the embedded TTFs on export.
 */
const PDFDocument = require('pdfkit');
const path = require('path');
const { monthLabel } = require('./mappers');

const FONTS_DIR = path.join(__dirname, '..', 'assets', 'fonts');

/* Palette mirrors the frontend design tokens (index.css) */
const INK = '#211c15';
const INK_2 = '#55503f';
const INK_3 = '#8f866f';
const LINE = '#ddd5c2';
const LINE_2 = '#c7bda3';
const OXBLOOD = '#8a3324';
const OXBLOOD_DARK = '#6d2718';
const OXBLOOD_SOFT = '#f1e0d8';
const GREEN = '#3f6b4e';
const GOLD = '#9a7b23';

/* Content geometry — A4 with 50pt margins (page 595.28 × 841.89 pt) */
const MARGIN = 50;
const CONTENT_W = 595.28 - MARGIN * 2;
const COL_SPLIT = MARGIN + CONTENT_W / 2;

/** ₹ with en-IN thousands separators, from the record's real numbers */
const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

/** 'YYYY-MM-DD' (or a Date) → '31 Aug 2026', formatted in UTC so the date
 *  never shifts across timezones; null-safe → null */
const fmtDate = (d) => {
  if (!d) return null;
  const iso = d instanceof Date ? d.toISOString() : `${d}T00:00:00Z`;
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
};

/** 'priya sharma' → 'priya-sharma' (also used for the download filename) */
const slugify = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Descriptive download name, e.g. payslip-priya-sharma-august-2026.pdf */
const payslipFilename = (employee, month) =>
  `payslip-${slugify(employee?.name)}-${slugify(monthLabel(month))}.pdf`;

/**
 * One "label … amount" row of the earnings/deductions tables, amount
 * right-aligned to the content edge.
 */
const amountRow = (doc, label, amount, { bold = false, rule = true, width = CONTENT_W } = {}) => {
  const font = bold ? 'body-bold' : 'body';
  const rowH = 20;
  if (rule) {
    doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y).lineWidth(0.5)
      .strokeOpacity(bold ? 1 : 0.6).stroke(LINE).lineWidth(1).strokeOpacity(1);
    doc.y += 6;
  }
  const y = doc.y;
  doc.font(font).fontSize(10).fillColor(bold ? INK : INK_2)
    .text(label, MARGIN, y, { lineBreak: false });
  doc.font(font).fontSize(10).fillColor(bold ? INK : INK_2)
    .text(amount, MARGIN, y, { width, align: 'right', lineBreak: false });
  doc.y = y + rowH;
  doc.x = MARGIN;
};

/**
 * Small uppercase section heading with a letter-spaced kicker look.
 */
const sectionTitle = (doc, title) => {
  doc.font('body-bold').fontSize(8).fillColor(INK_3)
    .text(title.toUpperCase(), MARGIN, doc.y, { characterSpace: 1.2, lineBreak: false });
  doc.y += 16;
  doc.x = MARGIN;
};

/** One label/value pair of the employee-details grid */
const detailPair = (doc, label, value, x) => {
  doc.font('body').fontSize(8).fillColor(INK_3)
    .text(label.toUpperCase(), x, doc.y, { lineBreak: false });
  doc.font('body').fontSize(10.5).fillColor(INK)
    .text(value || '—', x, doc.y + 13, { lineBreak: false });
};

/**
 * Build the payslip PDF.
 * @param {object} employee  raw Prisma Employee row
 * @param {object} record    raw Prisma PayrollRecord row (that month)
 * @returns {Promise<Buffer>}
 */
const buildPayslipPdf = async (employee, record) => {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: { Title: `Salary Slip — ${monthLabel(record.month)}` },
  });
  doc.registerFont('body', path.join(FONTS_DIR, 'DejaVuSans.ttf'));
  doc.registerFont('body-bold', path.join(FONTS_DIR, 'DejaVuSans-Bold.ttf'));
  doc.registerFont('body-italic', path.join(FONTS_DIR, 'DejaVuSans-Oblique.ttf'));

  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  /* ── Header: brand + document title ─────────────────────────────────── */
  doc.font('body-bold').fontSize(20).fillColor(OXBLOOD).text('School ERP', MARGIN, MARGIN - 10);
  const titleY = doc.y + 2;
  doc.font('body-bold').fontSize(13).fillColor(INK)
    .text(`Salary Slip — ${monthLabel(record.month)}`, MARGIN, titleY);
  doc.font('body').fontSize(8).fillColor(INK_3)
    .text(`Generated on ${fmtDate(new Date().toISOString().slice(0, 10))}`, MARGIN, titleY + 4, {
      width: CONTENT_W, align: 'right', lineBreak: false,
    });
  doc.y = titleY + 22;
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + CONTENT_W, doc.y).lineWidth(1).stroke(OXBLOOD);
  doc.y += 18;
  doc.x = MARGIN;

  /* ── Employee details (identity + employment only) ──────────────────── */
  sectionTitle(doc, 'Employee Details');
  const detailY = doc.y;
  detailPair(doc, 'Name', employee.name, MARGIN);
  detailPair(doc, 'Employee ID', employee.employeeId || employee.id, MARGIN);
  detailPair(doc, 'Designation', employee.designation, MARGIN);
  doc.y = detailY;
  detailPair(doc, 'Department', employee.department, COL_SPLIT);
  detailPair(doc, 'Date of Joining', fmtDate(employee.dateOfJoining), COL_SPLIT);
  detailPair(doc, 'Employment Type', employee.employmentType, COL_SPLIT);
  doc.y = Math.max(doc.y, detailY + 60) + 8;
  doc.x = MARGIN;
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + CONTENT_W, doc.y).lineWidth(0.5).stroke(LINE_2);
  doc.y += 16;
  doc.x = MARGIN;

  /* ── Pay period + payment state (matches the page's status label) ───── */
  doc.font('body').fontSize(8).fillColor(INK_3).text('PAY PERIOD', MARGIN, doc.y, { lineBreak: false });
  doc.font('body-bold').fontSize(10).fillColor(INK)
    .text(monthLabel(record.month), MARGIN, doc.y + 13, { lineBreak: false });
  doc.font('body').fontSize(8).fillColor(INK_3).text('PAYMENT DATE', COL_SPLIT, doc.y, { lineBreak: false });
  if (record.paidOn) {
    doc.font('body-bold').fontSize(10).fillColor(GREEN)
      .text(`Paid on ${fmtDate(record.paidOn)}`, COL_SPLIT, doc.y + 13, { lineBreak: false });
  } else {
    doc.font('body-bold').fontSize(10).fillColor(GOLD)
      .text('Payment pending', COL_SPLIT, doc.y + 13, { lineBreak: false });
  }
  doc.y += 34;
  doc.x = MARGIN;

  /* ── Earnings table (every earning column the record carries) ───────── */
  sectionTitle(doc, 'Earnings');
  const earnings = [
    ['Basic Pay', record.basicPay],
    ['HRA', record.hra],
    ['Transport Allowance', record.transportAllowance],
    ['Medical Allowance', record.medicalAllowance],
  ];
  earnings.forEach(([label, value], i) => amountRow(doc, label, money(value), { rule: i > 0 }));
  const totalEarnings = earnings.reduce((sum, [, v]) => sum + (Number(v) || 0), 0);
  amountRow(doc, 'Total Earnings', money(totalEarnings), { bold: true, rule: true });
  doc.y += 10;
  doc.x = MARGIN;

  /* ── Deductions table ────────────────────────────────────────────────── */
  sectionTitle(doc, 'Deductions');
  const deductions = [
    ['Provident Fund (PF)', record.providentFund],
    ['Professional Tax', record.professionalTax],
    ['TDS', record.tds],
  ];
  deductions.forEach(([label, value], i) => amountRow(doc, label, money(value), { rule: i > 0 }));
  const totalDeductions = deductions.reduce((sum, [, v]) => sum + (Number(v) || 0), 0);
  amountRow(doc, 'Total Deductions', money(totalDeductions), { bold: true, rule: true });
  doc.y += 10;
  doc.x = MARGIN;

  /* ── Net payable — the highlighted bottom line ───────────────────────── */
  const boxH = 40;
  doc.roundedRect(MARGIN, doc.y, CONTENT_W, boxH, 4).fill(OXBLOOD_SOFT);
  const boxTextY = doc.y + 12;
  doc.font('body-bold').fontSize(8.5).fillColor(OXBLOOD_DARK)
    .text('NET PAYABLE', MARGIN + 16, boxTextY, { characterSpace: 1.2, lineBreak: false });
  doc.font('body-bold').fontSize(17).fillColor(OXBLOOD_DARK)
    .text(money(record.netSalary), MARGIN, boxTextY - 3, {
      width: CONTENT_W - 16, align: 'right', lineBreak: false,
    });
  doc.y += boxH + 24;
  doc.x = MARGIN;

  /* ── Footer: hairline + system-generated note ────────────────────────── */
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + CONTENT_W, doc.y).lineWidth(0.5).stroke(LINE);
  doc.font('body-italic').fontSize(8.5).fillColor(INK_3)
    .text('This is a computer-generated document and does not require a signature.', MARGIN, doc.y + 8, {
      width: CONTENT_W, align: 'center',
    });

  doc.end();
  return done;
};

module.exports = { buildPayslipPdf, payslipFilename };

