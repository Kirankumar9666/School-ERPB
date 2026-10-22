/**
 * Fee formatting — the shared wording for fee figures and year-and-class labels.
 *
 * Kept out of `FeeLedgerTable` so that file exports one component (fast refresh
 * needs that), and so the Record-payment modal, the Student Profile, the student
 * portal and the Fee Dues row all label a fee year exactly the same way.
 */
const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

const fmtDate = (iso) => (iso
  ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  : '—');

/**
 * "Class 9B · 2026–27" — the class the child was in that year, never today's.
 * A year whose fee row has no class recorded is labelled by the year alone rather
 * than being shown with a class that was never recorded.
 */
const feeRowLabel = (row) => (row.classLabel
  ? `${row.classLabel} · ${row.academicYearLabel}`
  : row.academicYearLabel);

/** "Class 9B · 2026–27 (₹6,000 due)" — the label for the pick-a-year control. */
const openYearOption = (row) => `${feeRowLabel(row)} (${money(row.balance)} due)`;

const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);

export { money, fmtDate, feeRowLabel, openYearOption, dash };
