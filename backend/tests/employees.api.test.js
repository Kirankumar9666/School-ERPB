/**
 * Integration tests: employee API endpoints (/api/v1/employees/:id/*).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

let ctx;
let admin;
let teacher; // emp-001
let accountant; // emp-002
let student;

test('setup — boot API and log in all roles', async () => {
  ctx = await startServer();
  admin = await login(ctx.base, 'admin', 'Admin@123');
  teacher = await login(ctx.base, 'teacher', 'Teacher@123');
  accountant = await login(ctx.base, 'accountant', 'Accounts@123');
  student = await login(ctx.base, 'student', 'Student@123');
});

test('employee can view own profile', async () => {
  const res = await request(ctx.base, '/employees/emp-001/profile', { token: teacher.accessToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.name, 'Priya Sharma');
  assert.equal(res.body.data.role, 'teacher');
  assert.equal(res.body.data.assignedClasses.length, 2);
});

test('employee cannot view another employee profile → 403', async () => {
  const res = await request(ctx.base, '/employees/emp-002/profile', { token: teacher.accessToken });
  assert.equal(res.status, 403);
});

test('admin can view any employee profile; student role is rejected', async () => {
  const ok = await request(ctx.base, '/employees/emp-002/profile', { token: admin.accessToken });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.name, 'Ravi Patel');

  const denied = await request(ctx.base, '/employees/emp-001/profile', { token: student.accessToken });
  assert.equal(denied.status, 403);
});

test('employee attendance returns records plus summary (hours + percent)', async () => {
  const res = await request(ctx.base, '/employees/emp-001/attendance?month=2026-09', { token: teacher.accessToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.records['2026-09-01'].status, 'present');
  assert.equal(res.body.data.summary.hours, 47);
  assert.equal(res.body.data.summary.percent, 85.7);
});

test('leaves endpoint returns balance and history', async () => {
  const res = await request(ctx.base, '/employees/emp-001/leaves', { token: teacher.accessToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.balance.casual, 8);
  assert.equal(res.body.data.history.length, 2);
});

test('payroll: filtered by month and full list', async () => {
  const one = await request(ctx.base, '/employees/emp-001/payroll?month=2026-08', { token: teacher.accessToken });
  assert.equal(one.status, 200);
  assert.equal(one.body.data.length, 1);
  assert.equal(one.body.data[0].netSalary, 48650);

  const all = await request(ctx.base, '/employees/emp-001/payroll', { token: teacher.accessToken });
  assert.equal(all.body.data.length, 2);
});

test('employee timetable lists assigned periods by teacher name', async () => {
  const res = await request(ctx.base, '/employees/emp-001/timetable', { token: teacher.accessToken });
  assert.equal(res.status, 200);
  assert.ok(res.body.data.length >= 1);
  assert.ok(res.body.data.every((p) => p.teacher === 'Priya Sharma'));
  assert.ok(res.body.data.some((p) => p.classKey === 'cls-10A'));
});

test('assigned classes and documents endpoints', async () => {
  const classes = await request(ctx.base, '/employees/emp-001/assigned-classes', { token: teacher.accessToken });
  assert.equal(classes.status, 200);
  assert.equal(classes.body.data.length, 2);

  const docs = await request(ctx.base, '/employees/emp-001/documents', { token: teacher.accessToken });
  assert.equal(docs.status, 200);
  assert.equal(docs.body.data.length, 4);
});

test('apply leave: happy path appends a pending record', async () => {
  const res = await request(ctx.base, '/employees/emp-001/leaves/apply', {
    method: 'POST',
    token: teacher.accessToken,
    body: { type: 'casual', fromDate: '2026-12-01', toDate: '2026-12-02', reason: 'Family event out of town' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.status, 'pending');

  const leaves = await request(ctx.base, '/employees/emp-001/leaves', { token: teacher.accessToken });
  assert.equal(leaves.body.data.history.length, 3);
});

test('apply leave: validation (short reason, bad dates) → 400', async () => {
  const res = await request(ctx.base, '/employees/emp-001/leaves/apply', {
    method: 'POST',
    token: teacher.accessToken,
    body: { type: 'casual', fromDate: 'bad-date', toDate: '2026-12-02', reason: 'hi' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('apply leave: admin is not allowed (employee-only) → 403', async () => {
  const res = await request(ctx.base, '/employees/emp-001/leaves/apply', {
    method: 'POST',
    token: admin.accessToken,
    body: { type: 'casual', fromDate: '2026-12-01', toDate: '2026-12-02', reason: 'Admin trying to apply' },
  });
  assert.equal(res.status, 403);
});

test('apply leave: employee cannot apply for someone else → 403', async () => {
  const res = await request(ctx.base, '/employees/emp-002/leaves/apply', {
    method: 'POST',
    token: teacher.accessToken,
    body: { type: 'sick', fromDate: '2026-12-01', toDate: '2026-12-02', reason: 'Applying for a colleague' },
  });
  assert.equal(res.status, 403);
});

test('teardown — stop server', async () => { await stopServer(ctx.server); });