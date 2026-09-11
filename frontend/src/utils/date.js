/**
 * Shared date helpers — single source of truth for month math used across screens.
 */

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const pad2 = (n) => String(n).padStart(2, '0');

/** Month shifted by `offset` months from the current month. Returns { year, month (1-12), key: 'YYYY-MM' } */
export const monthShift = (offset = 0) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    key: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`,
  };
};

/** Human label, e.g. "September 2026" */
export const monthLabel = (year, month) => `${MONTH_NAMES[month - 1]} ${year}`;

/** Full ISO date (YYYY-MM-DD) for a Date object */
export const toISODate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Today's ISO date */
export const todayISO = () => toISODate(new Date());

/** Build a 42-cell calendar array for the given month. Cells: { day, iso, inMonth } or null */
export const buildCalendar = (year, month) => {
  const first = new Date(year, month - 1, 1);
  const startWeekday = first.getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month, 0).getDate();

  const cells = [];
  for (let i = 0; i < startWeekday; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push({ day, iso: `${year}-${pad2(month)}-${pad2(day)}`, inMonth: true });
  }
  while (cells.length % 7 !== 0) cells.push({ day: null, iso: null, inMonth: false });
  return cells;
};

/** Two-letter uppercase initials from a name */
export const initials = (name) =>
  (name || '?').split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();