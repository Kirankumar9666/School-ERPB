/**
 * Integration tests: school-wide endpoints (/api/v1/school/*).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

let ctx;
let admin;
let student;
let teacher;
let accountant;

test('setup — boot API and log in all roles', async () => {
  ctx = await startServer();
  admin = await login(ctx.base, 'admin', 'Admin@123');
  student = await login(ctx.base, 'student', 'Student@123');
  teacher = await login(ctx.base, 'teacher', 'Teacher@123');
  accountant = await login(ctx.base, 'accountant', 'Accounts@123');
});

test('announcements are role-filtered', async () => {
  const forStudent = await request(ctx.base, '/school/announcements', { token: student.accessToken });
  assert.equal(forStudent.status, 200);
  assert.ok(forStudent.body.data.every((a) => a.targetRoles.includes('student')), 'student only sees student-targeted items');
  assert.ok(!forStudent.body.data.some((a) => a.title.includes('Staff Meeting')), 'staff meeting hidden from students');

  const forStaff = await request(ctx.base, '/school/announcements', { token: accountant.accessToken });
  assert.ok(forStaff.body.data.some((a) => a.title.includes('Staff Meeting')), 'staff sees staff meeting');
});

test('holidays: full list and month filter', async () => {
  const all = await request(ctx.base, '/school/holidays', { token: teacher.accessToken });
  assert.equal(all.status, 200);
  assert.equal(all.body.data.length, 7);

  const oct = await request(ctx.base, '/school/holidays?month=2026-10', { token: teacher.accessToken });
  assert.equal(oct.body.data.length, 2); // Gandhi Jayanti + Diwali
  assert.ok(oct.body.data.every((h) => h.date.startsWith('2026-10')));
});

test('school summary is admin-only → 403 for others', async () => {
  const ok = await request(ctx.base, '/school/summary', { token: admin.accessToken });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.totalStudents, 3);
  assert.equal(ok.body.data.totalEmployees, 2);
  assert.equal(ok.body.data.totalFeeDues, 15000); // 5000 + 0 + 10000

  const denied = await request(ctx.base, '/school/summary', { token: teacher.accessToken });
  assert.equal(denied.status, 403);
});

test('teardown — stop server', async () => { await stopServer(ctx.server); });