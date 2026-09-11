/**
 * End-to-end tests: realistic multi-step flows across roles and modules.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

let ctx;

test('setup — boot API', async () => { ctx = await startServer(); });

test('E2E 1: every seeded role can log in and reach its own landing data', async () => {
  const roles = [
    ['admin', 'Admin@123', 'admin'],
    ['teacher', 'Teacher@123', 'teacher'],
    ['accountant', 'Accounts@123', 'accountant'],
    ['student', 'Student@123', 'student'],
  ];

  for (const [username, password, role] of roles) {
    const data = await login(ctx.base, username, password);
    assert.equal(data.user.role, role, `${username} resolves to role ${role}`);
    const me = await request(ctx.base, '/auth/me', { token: data.accessToken });
    assert.equal(me.status, 200);
    assert.equal(me.body.data.username, username);
  }
});

test('E2E 2: student daily-view flow — profile → attendance → marks → timetable → announcements', async () => {
  const student = await login(ctx.base, 'student', 'Student@123');
  const token = student.accessToken;

  const profile = await request(ctx.base, '/students/stu-001/profile', { token });
  assert.equal(profile.status, 200);

  const attendance = await request(ctx.base, '/students/stu-001/attendance?month=2026-09', { token });
  assert.equal(attendance.status, 200);
  assert.equal(attendance.body.data.summary.percent, 85.7);

  const marks = await request(ctx.base, '/students/stu-001/marks', { token });
  assert.equal(marks.status, 200);
  assert.equal(marks.body.data.length, 2);

  const timetable = await request(ctx.base, '/students/stu-001/timetable', { token });
  assert.equal(timetable.status, 200);
  assert.equal(timetable.body.data.periods.length, 7);

  const announcements = await request(ctx.base, '/school/announcements', { token });
  assert.equal(announcements.status, 200);
  assert.ok(announcements.body.data.length > 0);
});

test('E2E 3: leave lifecycle — employee applies → admin decides (cross-role)', async () => {
  const teacher = await login(ctx.base, 'teacher', 'Teacher@123');
  const admin = await login(ctx.base, 'admin', 'Admin@123');

  // 1. employee applies
  const apply = await request(ctx.base, '/employees/emp-001/leaves/apply', {
    method: 'POST',
    token: teacher.accessToken,
    body: { type: 'earned', fromDate: '2026-12-21', toDate: '2026-12-23', reason: 'Year-end family vacation' },
  });
  assert.equal(apply.status, 201);
  const leaveId = apply.body.data.id;
  assert.equal(apply.body.data.status, 'pending');

  // 2. employee cannot use the admin decision endpoint
  const denied = await request(ctx.base, `/admin/leaves/${leaveId}/status`, {
    method: 'PUT',
    token: teacher.accessToken,
    body: { status: 'approved' },
  });
  assert.equal(denied.status, 403);

  // 3. admin sees the pending leave and approves it (state actually changes)
  const pending = await request(ctx.base, '/admin/leaves/pending', { token: admin.accessToken });
  assert.equal(pending.status, 200);
  const listed = pending.body.data.find((l) => l.id === leaveId);
  assert.ok(listed, 'new leave appears in the admin pending list');
  assert.equal(listed.employeeName, 'Priya Sharma');

  const approve = await request(ctx.base, `/admin/leaves/${leaveId}/status`, {
    method: 'PUT',
    token: admin.accessToken,
    body: { status: 'approved' },
  });
  assert.equal(approve.status, 200);

  // 4. the decision is visible back on the employee side
  const mine = await request(ctx.base, '/employees/emp-001/leaves', { token: teacher.accessToken });
  const record = mine.body.data.history.find((l) => l.id === leaveId);
  assert.equal(record.status, 'approved');
});

test('E2E 4: admin registers a student, publishes marks, student sees them', async () => {
  const admin = await login(ctx.base, 'admin', 'Admin@123');
  const student = await login(ctx.base, 'student', 'Student@123');

  // publish marks for stu-001 (student's own record)
  const publish = await request(ctx.base, '/admin/marks', {
    method: 'POST',
    token: admin.accessToken,
    body: {
      studentId: 'stu-001', examName: 'E2E Grand Test', date: '2026-09-11',
      subjects: [{ subject: 'Mathematics', maxMarks: 100, obtained: 95 }],
    },
  });
  assert.equal(publish.status, 201);

  // student reads their own marks and finds the new exam
  const marks = await request(ctx.base, '/students/stu-001/marks', { token: student.accessToken });
  assert.equal(marks.status, 200);
  const exam = marks.body.data.find((e) => e.examName === 'E2E Grand Test');
  assert.ok(exam, 'newly published exam is visible to the student');
  assert.equal(exam.subjects[0].obtained, 95);
});

test('teardown — stop server', async () => { await stopServer(ctx.server); });