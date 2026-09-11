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
const STATUS_WEIGHT = { present: 1, late: 1, 'half-day': 0.5, absent: 0, holiday: 0 };

/**
 * Summarize a month of attendance records.
 * Accepts both shapes used by the mock stores:
 *   student:  { '2026-09-01': 'present', ... }
 *   employee: { '2026-09-01': { status: 'present', workingHours: 8 }, ... }
 *
 * @param {Record<string, string|{status: string, workingHours?: number}>} records
 * @returns {{present: number, absent: number, late: number, halfDay: number,
 *            holiday: number, marked: number, hours: number,
 *            workingDays: number, attended: number, percent: number}}
 */
const summarizeAttendance = (records) => {
  const summary = {
    present: 0, absent: 0, late: 0, halfDay: 0, holiday: 0,
    marked: 0, hours: 0, workingDays: 0, attended: 0, percent: 0,
  };

  Object.values(records || {}).forEach((entry) => {
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

module.exports = { summarizeAttendance };