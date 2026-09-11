/**
 * Integration tests: student API endpoints (/api/v1/students/:id/*).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

let ctx;
let admin;
let student;
let teacher;

test('setup — boot API and log in all roles', async () => {
  ctx = await startServer();
  admin = await login(ctx.base, 'admin', 'Admin@123');
  student = await login(ctx.base, 'student', 'Student@123');
  teacher = await login(ctx.base, 'teacher', 'Teacher@123');
});

test('unauthenticated request → 401', async () => {
  const res = await request(ctx.base, '/students/stu-001/profile');
  assert.equal(res.status, 401);
});

test('admin can view any student profile', async () => {
  const res = await request(ctx.base, '/students/stu-003/profile', { token: admin.accessToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.name, 'Rahul Menon');
});

test('student can view own profile', async () => {
  const res = await request(ctx.base, '/students/stu-001/profile', { token: student.accessToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.name, 'Arjun Kumar');
  assert.equal(res.body.data.class, '10');
});

test('student cannot view another student profile → 403', async () => {
  const res = await request(ctx.base, '/students/stu-002/profile', { token: student.accessToken });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'FORBIDDEN');
});

test('employee role may view student profile', async () => {
  const res = await request(ctx.base, '/students/stu-001/profile', { token: teacher.accessToken });
  assert.equal(res.status, 200);
});

test('unknown student → 404', async () => {
  const res = await request(ctx.base, '/students/stu-999/profile', { token: admin.accessToken });
  assert.equal(res.status, 404);
});

test('attendance returns records plus computed summary', async () => {
  const res = await request(ctx.base, '/students/stu-001/attendance?month=2026-09', { token: student.accessToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.records['2026-09-01'], 'present');
  assert.equal(res.body.data.summary.present, 6);
  assert.equal(res.body.data.summary.absent, 1);
  assert.equal(res.body.data.summary.percent, 85.7);
});

test('student cannot read another student attendance → 403', async () => {
  const res = await request(ctx.base, '/students/stu-002/attendance', { token: student.accessToken });
  assert.equal(res.status, 403);
});

test('attendance for a month with no data → empty records, 0 percent', async () => {
  const res = await request(ctx.base, '/students/stu-001/attendance?month=2020-01', { token: admin.accessToken });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.records, {});
  assert.equal(res.body.data.summary.percent, 0);
});

test('marks: stu-001 has two exams; stu-002 has none', async () => {
  const own = await request(ctx.base, '/students/stu-001/marks', { token: student.accessToken });
  assert.equal(own.status, 200);
  assert.equal(own.body.data.length, 2);
  assert.equal(own.body.data[0].examName, 'Unit Test 1');

  const other = await request(ctx.base, '/students/stu-002/marks', { token: admin.accessToken });
  assert.equal(other.status, 200);
  assert.deepEqual(other.body.data, []);
});

test('timetable resolves the student class (cls-10A → 7 periods)', async () => {
  const res = await request(ctx.base, '/students/stu-001/timetable', { token: student.accessToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.class, '10');
  assert.equal(res.body.data.periods.length, 7);
  assert.equal(res.body.data.periods[0].subject, 'Mathematics');
});

test('achievements and syllabus for own class', async () => {
  const ach = await request(ctx.base, '/students/stu-001/achievements', { token: student.accessToken });
  assert.equal(ach.status, 200);
  assert.equal(ach.body.data.length, 2);

  const syl = await request(ctx.base, '/students/stu-001/syllabus', { token: teacher.accessToken });
  assert.equal(syl.status, 200);
  assert.equal(syl.body.data.length, 4);
});

test('teardown — stop server', async () => { await stopServer(ctx.server); });