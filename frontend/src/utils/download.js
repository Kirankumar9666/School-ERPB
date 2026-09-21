/**
 * Client-side file download helpers.
 * Text files are generated from page data (legacy document records); the
 * payslip PDF is fetched from the server as a blob and saved under the
 * filename the backend chose (Content-Disposition), with a data-derived
 * fallback when the header isn't readable.
 */
export const downloadTextFile = (filename, content) => {
  downloadBlob(new Blob([content], { type: 'text/plain;charset=utf-8' }), filename);
};

export const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

/** 'priya sharma' → 'priya-sharma' (mirrors the backend's slug) */
export const slugify = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** 'YYYY-MM' → 'August 2026' — same month labels the API sends */
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export const monthLabel = (month) => {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '');
  return m ? `${MONTH_NAMES[Number(m[2]) - 1]} ${m[1]}` : month;
};

/** Fallback download name when Content-Disposition isn't readable */
export const payslipFilename = (name, month) =>
  `payslip-${slugify(name)}-${slugify(monthLabel(month))}.pdf`;

/** 'attachment; filename="payslip-x.pdf"' → 'payslip-x.pdf' */
export const filenameFromDisposition = (header) => {
  const m = /filename="?([^";]+)"?/.exec(header || '');
  return m ? m[1] : null;
};
