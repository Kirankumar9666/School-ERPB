/**
 * Attendance calculation helpers — pure functions shared by the student and
 * employee attendance routes (unit-tested in tests/attendance.test.js).
 *
 * Weighting convention:
 *   present / late → 1 attended day
 *   half-day       → 0.5 attended day
 *   absent         → 0
 *   holiday        → excluded from working days entirely
 */
const { toDateStr, statusToApi } = require('../services/mappers');

const STATUS_WEIGHT = { present: 1, late: 1, 'half-day': 0.5, absent: 0, holiday: 0 };

/**
 * Merge a day's two per-session statuses into the single day-level status every
 * calendar, summary and percentage already consumes — the FN/AN split pushed
 * down into the existing "one status per day" shape.
 *
 * Rules (the flagged FN/AN design decision, applied everywhere below):
 *   1. A holiday on either session makes the whole day a holiday (school was
 *      closed; the day drops out of working-day counts, exactly as before).
 *   2. Only one session recorded → the day shows that session's status. Marking
 *      FN before AN is the normal flow, so a half-marked day must not invent
 *      half-days for a class the admin simply hasn't reached yet.
 *   3. Both sessions recorded → present iff both present, absent iff both
 *      absent, and the sessions differing (one present, one absent) resolves to
 *      the existing 'half-day' concept — so "HALF DAYS" and the gold calendar
 *      markers light up when FN ≠ AN. A 'late' or 'half-day' session beats a
 *      plain 'present'.
 *
 * @param {string|null} fn  API status of the Forenoon session (null = unmarked)
 * @param {string|null} an  API status of the Afternoon session
 * @returns {string|null} merged day status
 */
const mergeDayStatus = (fn, an) => {
  if (!fn && !an) return null;
  if (fn === 'holiday' || an === 'holiday') return 'holiday';
  if (!fn || !an) return fn || an;                     // single session recorded
  if (fn === 'absent' && an === 'absent') return 'absent';
  if (fn === 'absent' || an === 'absent') return 'half-day'; // sessions differ
  if (fn === 'half-day' || an === 'half-day') return 'half-day';
  if (fn === 'late' || an === 'late') return 'late';
  return 'present';
};

/**
 * Group per-session attendance rows into the per-day records map the rest of
 * the app consumes: 'YYYY-MM-DD' → status, or { status, workingHours } for
 * employees. Each row is one session (FN/AN) of one day; the two halves are
 * merged with `mergeDayStatus`, and employee hours are summed across them
 * (a 4h FN + 4h AN = the 8h day the payroll/percent figures always used).
 *
 * @param {Array<{date: Date, session: 'FN'|'AN', status: string, workingHours?: number}>} rows
 * @param {boolean} withHours employee shape (hours summed) vs plain status
 * @returns {Record<string, string|{status: string, workingHours: number}>}
 */
const buildDayRecords = (rows, withHours) => {
  const byDate = new Map(); // 'YYYY-MM-DD' → { fn, an, hours }
  (rows || []).forEach((r) => {
    const key = toDateStr(r.date);
    const entry = byDate.get(key) || { fn: null, an: null, hours: 0 };
    if (r.session === 'AN') entry.an = statusToApi(r.status);
    else entry.fn = statusToApi(r.status);
    entry.hours += r.workingHours || 0;
    byDate.set(key, entry);
  });
  const records = {};
  byDate.forEach((entry, key) => {
    const status = mergeDayStatus(entry.fn, entry.an);
    records[key] = withHours ? { status, workingHours: entry.hours } : status;
  });
  return records;
};

/** Weekday number (0 = Sunday) for a 'YYYY-MM-DD' key, or null if unparseable. */
const weekdayOf = (key) => {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const d = new Date(`${key}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d.getUTCDay();
};

/**
 * Summarize a month of attendance records.
 * Accepts both shapes used by the mock stores:
 *   student:  { '2026-09-01': 'present', ... }
 *   employee: { '2026-09-01': { status: 'present', workingHours: 8 }, ... }
 *
 * `weeklyOffDays` is the school's real weekly-off setting (weekday numbers,
 * 0 = Sunday). A record that falls on a weekly-off day is left out of the
 * working-day count (and from `marked`), exactly like a holiday — the school
 * was closed, so the day must not dilute attendance. The setting is passed in
 * by the route (freshly read from the DB), never hardcoded, so changing the
 * school's working week changes every percentage with no code edit.
 *
 * @param {Record<string, string|{status: string, workingHours?: number}>} records
 * @param {number[]} [weeklyOffDays] weekday numbers that are not working days
 * @returns {{present: number, absent: number, late: number, halfDay: number,
 *            holiday: number, marked: number, hours: number,
 *            workingDays: number, attended: number, percent: number}}
 */
const summarizeAttendance = (records, weeklyOffDays = []) => {
  const summary = {
    present: 0, absent: 0, late: 0, halfDay: 0, holiday: 0,
    marked: 0, hours: 0, workingDays: 0, attended: 0, percent: 0,
  };
  const off = new Set(weeklyOffDays || []);

  Object.entries(records || {}).forEach(([key, entry]) => {
    // A weekly off day is outside the working week — do not count it at all.
    const weekday = weekdayOf(key);
    if (weekday !== null && off.has(weekday)) return;

    const isEmployeeShape = typeof entry === 'object' && entry !== null;
    const status = isEmployeeShape ? entry.status : entry;
    if (!status || !(status in STATUS_WEIGHT)) return; // unknown/blank → skip

    summary.marked += 1;
    if (status === 'present') summary.present += 1;
    else if (status === 'absent') summary.absent += 1;
    else if (status === 'late') summary.late += 1;
    else if (status === 'half-day') summary.halfDay += 1;
    else if (status === 'holiday') summary.holiday += 1;

    if (isEmployeeShape) summary.hours += entry.workingHours || 0;
  });

  summary.workingDays = summary.marked - summary.holiday;
  summary.attended = summary.present + summary.late + summary.halfDay * 0.5;
  // Round to 1 decimal place; 0 working days → 0 (never NaN)
  summary.percent = summary.workingDays > 0
    ? Math.round((summary.attended / summary.workingDays) * 1000) / 10
    : 0;

  return summary;
};

module.exports = { summarizeAttendance, mergeDayStatus, buildDayRecords };