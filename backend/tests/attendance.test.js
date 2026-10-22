/**
 * Unit tests: attendance calculation logic (src/utils/attendance.js).
 * Pure functions — no server needed.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeAttendance } = require('../src/utils/attendance');
const { MOCK_ATTENDANCE_STUDENT } = require('../src/mock/students');
const { MOCK_ATTENDANCE_EMPLOYEE } = require('../src/mock/employees');

test('student month summary matches the mock data (stu-001, 2026-09)', () => {
  const s = summarizeAttendance(MOCK_ATTENDANCE_STUDENT['stu-001']['2026-09']);
  assert.equal(s.marked, 9);
  assert.equal(s.present, 6);
  assert.equal(s.absent, 1);
  assert.equal(s.holiday, 2);
  assert.equal(s.workingDays, 7);
  assert.equal(s.attended, 6);
  assert.equal(s.percent, 85.7); // 6/7 working days, rounded to 1 decimal
});

test('employee month summary includes working hours (emp-001, 2026-09)', () => {
  const s = summarizeAttendance(MOCK_ATTENDANCE_EMPLOYEE['emp-001']['2026-09']);
  assert.equal(s.present, 5);
  assert.equal(s.late, 1);
  assert.equal(s.absent, 1);
  assert.equal(s.holiday, 2);
  assert.equal(s.workingDays, 7);
  assert.equal(s.attended, 6); // late counts as attended
  assert.equal(s.hours, 47); // 8+8+7+8+0+0+8+0+8
  assert.equal(s.percent, 85.7);
});

test('half-day counts as 0.5 attended day', () => {
  const s = summarizeAttendance({
    d1: 'present', d2: 'half-day', d3: 'absent',
  });
  assert.equal(s.marked, 3);
  assert.equal(s.halfDay, 1);
  assert.equal(s.workingDays, 3);
  assert.equal(s.attended, 1.5);
  assert.equal(s.percent, 50);
});

test('holidays are excluded from working days', () => {
  const s = summarizeAttendance({ d1: 'present', d2: 'holiday', d3: 'holiday' });
  assert.equal(s.marked, 3);
  assert.equal(s.workingDays, 1);
  assert.equal(s.attended, 1);
  assert.equal(s.percent, 100);
});

test('empty records → all zeros, never NaN', () => {
  const s = summarizeAttendance({});
  assert.equal(s.marked, 0);
  assert.equal(s.workingDays, 0);
  assert.equal(s.percent, 0);
  assert.ok(!Number.isNaN(s.percent));
});

test('null/undefined and unknown statuses are ignored', () => {
  const s = summarizeAttendance({ d1: 'present', d2: null, d3: 'mystery', d4: { status: 'present', workingHours: 4 } });
  assert.equal(s.marked, 2);
  assert.equal(s.present, 2);
});

test('null/undefined records input is safe', () => {
  const s = summarizeAttendance(null);
  assert.equal(s.percent, 0);
});

/* ---- FN/AN session merge + day aggregation ---- */

const { mergeDayStatus, buildDayRecords } = require('../src/utils/attendance');

test('mergeDayStatus: both sessions agree → that status; holiday and single-session cases', () => {
  assert.equal(mergeDayStatus('present', 'present'), 'present');
  assert.equal(mergeDayStatus('absent', 'absent'), 'absent');
  assert.equal(mergeDayStatus('late', 'late'), 'late');
  assert.equal(mergeDayStatus(null, null), null);

  // One session recorded (FN marked before AN) → the day shows what is known.
  assert.equal(mergeDayStatus('present', null), 'present');
  assert.equal(mergeDayStatus(null, 'absent'), 'absent');

  // A holiday on either session makes the whole day a holiday.
  assert.equal(mergeDayStatus('holiday', 'present'), 'holiday');
  assert.equal(mergeDayStatus('present', 'holiday'), 'holiday');
});

test('mergeDayStatus: sessions differing → the existing half-day concept; late wins over present', () => {
  assert.equal(mergeDayStatus('present', 'absent'), 'half-day');
  assert.equal(mergeDayStatus('absent', 'present'), 'half-day');
  assert.equal(mergeDayStatus('late', 'absent'), 'half-day');
  assert.equal(mergeDayStatus('present', 'half-day'), 'half-day');
  assert.equal(mergeDayStatus('late', 'present'), 'late');
});

test('buildDayRecords: session rows collapse to day records with summed hours', () => {
  const rows = [
    { date: new Date('2026-09-01T00:00:00.000Z'), session: 'FN', status: 'present', workingHours: 4 },
    { date: new Date('2026-09-01T00:00:00.000Z'), session: 'AN', status: 'present', workingHours: 4 },
    { date: new Date('2026-09-02T00:00:00.000Z'), session: 'FN', status: 'present', workingHours: 4 },
    { date: new Date('2026-09-02T00:00:00.000Z'), session: 'AN', status: 'absent', workingHours: 0 },
    { date: new Date('2026-09-03T00:00:00.000Z'), session: 'FN', status: 'absent', workingHours: 0 },
  ];

  const dayRecords = buildDayRecords(rows, true);
  assert.deepEqual(dayRecords['2026-09-01'], { status: 'present', workingHours: 8 });
  assert.deepEqual(dayRecords['2026-09-02'], { status: 'half-day', workingHours: 4 });
  assert.deepEqual(dayRecords['2026-09-03'], { status: 'absent', workingHours: 0 });

  // A single-session day keeps that session's status and hours.
  const partial = buildDayRecords(
    [{ date: new Date('2026-09-04T00:00:00.000Z'), session: 'AN', status: 'present', workingHours: 4 }],
    true,
  );
  assert.deepEqual(partial['2026-09-04'], { status: 'present', workingHours: 4 });

  const studentShape = buildDayRecords(
    [
      { date: new Date('2026-09-01T00:00:00.000Z'), session: 'FN', status: 'present' },
      { date: new Date('2026-09-01T00:00:00.000Z'), session: 'AN', status: 'absent' },
    ],
    false,
  );
  assert.equal(studentShape['2026-09-01'], 'half-day');
});