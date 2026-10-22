/**
 * The weekly off days are a school-level DB setting, default Sunday only.
 * These tests pin the contract: the setting is stored, readable by any
 * signed-in user, editable only by an admin, validated — and, the point of the
 * feature, it drives attendance working-day counts so a Saturday is a normal
 * working day unless the school explicitly makes it an off day.
 *
 * Node built-in test runner, zero deps.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');
const { summarizeAttendance } = require('../src/utils/attendance');

/* ---- pure calculation (no server) ---- */

test('summarizeAttendance: weekly off days are excluded from working days', () => {
  // 2026-10-03 is a Saturday; 2026-10-04 is a Sunday.
  const records = { '2026-10-03': 'present', '2026-10-04': 'present' };

  // Default school week: Sunday off, Saturday is normal.
  const sundayOnly = summarizeAttendance(records, [0]);
  assert.equal(sundayOnly.workingDays, 1, 'Saturday is a working day');
  assert.equal(sundayOnly.attended, 1);
  assert.equal(sundayOnly.percent, 100);

  // A school that takes both weekend days off excludes the Saturday too.
  const weekendOff = summarizeAttendance(records, [0, 6]);
  assert.equal(weekendOff.workingDays, 0, 'Saturday is excluded when it is a weekly off');
  assert.equal(weekendOff.percent, 0);

  // No off days at all (school works seven days) keeps both.
  const allWork = summarizeAttendance(records, []);
  assert.equal(allWork.workingDays, 2);
});

/* ---- API ---- */

let ctx;
let admin;
let teacher;

test('setup — boot API and log in', async () => {
  ctx = await startServer();
  admin = await login(ctx.base, 'admin', 'Admin@123');
  teacher = await login(ctx.base, 'teacher', 'Teacher@123');
});

test('weekly off setting: default Sunday, admin-only update, validation', async () => {
  // Default: Sunday only.
  const initial = await request(ctx.base, '/school/settings', { token: teacher.accessToken });
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.data.weeklyOffDays, [0]);

  // The options endpoint carries the same setting for pages that already load it.
  const options = await request(ctx.base, '/school/options', { token: admin.accessToken });
  assert.equal(options.status, 200);
  assert.deepEqual(options.body.data.weeklyOffDays, [0]);

  // Only an admin may change it.
  const denied = await request(ctx.base, '/admin/settings', {
    method: 'PUT', token: teacher.accessToken, body: { weeklyOffDays: [0, 6] },
  });
  assert.equal(denied.status, 403);

  // Unknown weekday numbers are rejected.
  const invalid = await request(ctx.base, '/admin/settings', {
    method: 'PUT', token: admin.accessToken, body: { weeklyOffDays: [7] },
  });
  assert.equal(invalid.status, 400);

  // Update: Saturday + Sunday off. Stored de-duplicated and sorted.
  const saved = await request(ctx.base, '/admin/settings', {
    method: 'PUT', token: admin.accessToken, body: { weeklyOffDays: [6, 0, 6] },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.data.weeklyOffDays, [0, 6]);

  const after = await request(ctx.base, '/school/settings', { token: teacher.accessToken });
  assert.deepEqual(after.body.data.weeklyOffDays, [0, 6]);

  // Back to the school default so the shared dev DB is left as seeded.
  const reset = await request(ctx.base, '/admin/settings', {
    method: 'PUT', token: admin.accessToken, body: { weeklyOffDays: [0] },
  });
  assert.deepEqual(reset.body.data.weeklyOffDays, [0]);
});

test('a marked Saturday is a working day; the setting changes the count, never the record', async () => {
  // 2026-10-03 is a Saturday — the school is open under the default (Sunday off).
  const mark = await request(ctx.base, '/admin/attendance', {
    method: 'POST',
    token: admin.accessToken,
    body: { entityType: 'student', entityId: 'stu-001', date: '2026-10-03', session: 'FN', status: 'present' },
  });
  assert.equal(mark.status, 201);

  // It shows on the student's own calendar and counts as a working day.
  const att = await request(ctx.base, '/students/stu-001/attendance?month=2026-10', { token: admin.accessToken });
  assert.equal(att.status, 200);
  assert.equal(att.body.data.records['2026-10-03'], 'present', 'the Saturday appears in the saved records');
  assert.deepEqual(att.body.data.weeklyOffDays, [0]);
  assert.equal(att.body.data.summary.workingDays, 1, 'Saturday is a working day by default');
  assert.equal(att.body.data.summary.percent, 100);

  // Make Saturday a weekly off: the SAME saved record is excluded from working days.
  await request(ctx.base, '/admin/settings', {
    method: 'PUT', token: admin.accessToken, body: { weeklyOffDays: [0, 6] },
  });
  const satOff = await request(ctx.base, '/students/stu-001/attendance?month=2026-10', { token: admin.accessToken });
  assert.equal(satOff.body.data.summary.workingDays, 0, 'Saturday drops out once it is a weekly off');
  assert.equal(satOff.body.data.records['2026-10-03'], 'present', 'the saved attendance record is untouched');

  // Reset for the next test file.
  await request(ctx.base, '/admin/settings', {
    method: 'PUT', token: admin.accessToken, body: { weeklyOffDays: [0] },
  });
});

test('teardown — stop server', async () => { await stopServer(ctx.server); });
