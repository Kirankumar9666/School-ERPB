/**
 * Integration tests: admin CRUD API (/api/v1/admin/*) — admin-only surface.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

let ctx;
let admin;
let student;

test('setup — boot API and log in', async () => {
  ctx = await startServer();
  admin = await login(ctx.base, 'admin', 'Admin@123');
  student = await login(ctx.base, 'student', 'Student@123');
});

test('every admin route rejects unauthenticated and non-admin callers', async () => {
  const anon = await request(ctx.base, '/admin/users');
  assert.equal(anon.status, 401);

  const denied = await request(ctx.base, '/admin/students', { token: student.accessToken });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'FORBIDDEN');
});

test('students: list, create, update, delete (full CRUD)', async () => {
  const list = await request(ctx.base, '/admin/students', { token: admin.accessToken });
  assert.equal(list.status, 200);
  const before = list.body.data.length;

  const created = await request(ctx.base, '/admin/students', {
    method: 'POST',
    token: admin.accessToken,
    body: {
      name: 'Test Student', class: '10', section: 'A', admissionYear: 2026,
      rollNumber: 'STU-2026-TEST', parentName: 'Test Parent', guardianContact: '+91-9000000000',
    },
  });
  assert.equal(created.status, 201);
  const newId = created.body.data.id;
  assert.ok(newId, 'created student has an id');

  const updated = await request(ctx.base, `/admin/students/${newId}`, {
    method: 'PUT',
    token: admin.accessToken,
    // schema is strict (full payload required), so send a complete valid body
    body: {
      name: 'Test Student Updated', class: '10', section: 'A', admissionYear: 2026,
      rollNumber: 'STU-2026-TEST', parentName: 'Test Parent', guardianContact: '+91-9000000000',
      feeDues: 1234, address: 'New Address, Bangalore',
    },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.feeDues, 1234);
  assert.equal(updated.body.data.name, 'Test Student Updated');

  const del = await request(ctx.base, `/admin/students/${newId}`, { method: 'DELETE', token: admin.accessToken });
  assert.equal(del.status, 200);

  const after = await request(ctx.base, '/admin/students', { token: admin.accessToken });
  assert.equal(after.body.data.length, before, 'list restored after delete');
});

test('students: create with invalid payload → 400 VALIDATION_ERROR', async () => {
  const res = await request(ctx.base, '/admin/students', {
    method: 'POST',
    token: admin.accessToken,
    body: { class: '10' }, // name missing
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  assert.ok(res.body.errors.name, 'error targets the name field');
});

test('students: update/delete unknown id → 404', async () => {
  const validBody = { name: 'Ghost Student', class: '9', section: 'B' };
  const upd = await request(ctx.base, '/admin/students/stu-999', { method: 'PUT', token: admin.accessToken, body: validBody });
  assert.equal(upd.status, 404);
  const del = await request(ctx.base, '/admin/students/stu-999', { method: 'DELETE', token: admin.accessToken });
  assert.equal(del.status, 404);
});

test('employees: list + create with employment fields', async () => {
  const list = await request(ctx.base, '/admin/employees', { token: admin.accessToken });
  assert.equal(list.status, 200);
  assert.ok(list.body.data.length >= 2);

  const created = await request(ctx.base, '/admin/employees', {
    method: 'POST',
    token: admin.accessToken,
    body: {
      name: 'Test Teacher', department: 'Physics', designation: 'Teacher',
      role: 'teacher', dateOfJoining: '2026-09-01', employmentType: 'Permanent',
    },
  });
  assert.equal(created.status, 201);
  assert.ok(created.body.data.id);
});

test('employees: invalid role → 400', async () => {
  const res = await request(ctx.base, '/admin/employees', {
    method: 'POST',
    token: admin.accessToken,
    body: { name: 'Bad Role', department: 'X', designation: 'Y', role: 'wizard', dateOfJoining: '2026-09-01', employmentType: 'Permanent' },
  });
  assert.equal(res.status, 400);
});

test('attendance marking: upsert + month filter', async () => {
  const marked = await request(ctx.base, '/admin/attendance', {
    method: 'POST',
    token: admin.accessToken,
    body: { entityType: 'student', entityId: 'stu-001', date: '2026-09-15', status: 'present' },
  });
  assert.equal(marked.status, 201);

  // verify the upsert through the student-facing endpoint (admin may read it)
  const att = await request(ctx.base, '/students/stu-001/attendance?month=2026-09', { token: admin.accessToken });
  assert.equal(att.status, 200);
  assert.equal(att.body.data.records['2026-09-15'], 'present');
});

test('attendance marking: invalid status/date → 400', async () => {
  const badStatus = await request(ctx.base, '/admin/attendance', {
    method: 'POST',
    token: admin.accessToken,
    body: { entityType: 'student', entityId: 'stu-001', date: '2026-09-15', status: 'teleporting' },
  });
  assert.equal(badStatus.status, 400);

  const badDate = await request(ctx.base, '/admin/attendance', {
    method: 'POST',
    token: admin.accessToken,
    body: { entityType: 'student', entityId: 'stu-001', date: '15-09-2026', status: 'present' },
  });
  assert.equal(badDate.status, 400);
});

test('marks: publish exam results and read them back', async () => {
  const res = await request(ctx.base, '/admin/marks', {
    method: 'POST',
    token: admin.accessToken,
    body: {
      studentId: 'stu-002', examName: 'Unit Test 2', date: '2026-09-12',
      subjects: [{ subject: 'Mathematics', maxMarks: 100, obtained: 75 }],
    },
  });
  assert.equal(res.status, 201);

  const read = await request(ctx.base, '/students/stu-002/marks', { token: admin.accessToken });
  assert.ok(read.body.data.some((e) => e.examName === 'Unit Test 2'), 'published exam visible in student marks');
});

test('announcements: create + verify via school endpoint', async () => {
  const created = await request(ctx.base, '/admin/announcements', {
    method: 'POST',
    token: admin.accessToken,
    body: { title: 'Test Announcement', body: 'This is a test announcement body.', targetRoles: ['student'], category: 'event' },
  });
  assert.equal(created.status, 201);

  const studentAnn = await request(ctx.base, '/school/announcements', { token: student.accessToken });
  assert.ok(studentAnn.body.data.some((a) => a.title === 'Test Announcement'), 'student sees the new announcement');
});

test('holidays: create + list + delete round-trip', async () => {
  const created = await request(ctx.base, '/admin/holidays', {
    method: 'POST',
    token: admin.accessToken,
    body: { date: '2026-12-31', name: 'Test Holiday' },
  });
  assert.equal(created.status, 201);
  const id = created.body.data.id;

  const listed = await request(ctx.base, '/school/holidays', { token: admin.accessToken });
  assert.ok(listed.body.data.some((h) => h.id === id));

  const del = await request(ctx.base, `/admin/holidays/${id}`, { method: 'DELETE', token: admin.accessToken });
  assert.equal(del.status, 200);
});

test('leaves: pending list shows a new application and status update works', async () => {
  const teacher = await login(ctx.base, 'teacher', 'Teacher@123');
  const create = await request(ctx.base, '/employees/emp-001/leaves/apply', {
    method: 'POST',
    token: teacher.accessToken,
    body: { type: 'sick', fromDate: '2026-11-10', toDate: '2026-11-10', reason: 'Testing approval flow' },
  });
  assert.equal(create.status, 201);
  const leaveId = create.body.data.id;

  // visible in the admin pending queue with employee info attached
  const pending = await request(ctx.base, '/admin/leaves/pending', { token: admin.accessToken });
  assert.equal(pending.status, 200);
  const listed = pending.body.data.find((l) => l.id === leaveId);
  assert.ok(listed, 'new pending leave listed for admin');
  assert.equal(listed.employeeId, 'emp-001');
  assert.equal(listed.employeeName, 'Priya Sharma');

  // decision endpoint validates status and updates the record
  const bad = await request(ctx.base, `/admin/leaves/${leaveId}/status`, {
    method: 'PUT', token: admin.accessToken, body: { status: 'maybe' },
  });
  assert.equal(bad.status, 400);

  const ok = await request(ctx.base, `/admin/leaves/${leaveId}/status`, {
    method: 'PUT', token: admin.accessToken, body: { status: 'rejected' },
  });
  assert.equal(ok.status, 200);

  const unknown = await request(ctx.base, '/admin/leaves/lv-nope/status', {
    method: 'PUT', token: admin.accessToken, body: { status: 'approved' },
  });
  assert.equal(unknown.status, 404);
});

test('audit log: admin mutations are recorded, no password material', async () => {
  await request(ctx.base, '/admin/holidays', {
    method: 'POST',
    token: admin.accessToken,
    body: { date: '2026-12-30', name: 'Audit Probe Holiday' },
  });

  const log = await request(ctx.base, '/admin/audit-log', { token: admin.accessToken });
  assert.equal(log.status, 200);
  const entries = log.body.data;
  assert.ok(entries.length > 0, 'audit log has entries');
  assert.ok(entries.every((e) => e.actor && e.method && e.route && e.at), 'entries have actor/method/route/timestamp');
  assert.ok(!JSON.stringify(entries).toLowerCase().includes('password'), 'no password material in the log');
});

test('users list never exposes passwordHash', async () => {
  const res = await request(ctx.base, '/admin/users', { token: admin.accessToken });
  assert.equal(res.status, 200);
  assert.ok(!JSON.stringify(res.body).includes('passwordHash'));
  assert.ok(res.body.data.length >= 4);
});

test('teardown — stop server', async () => { await stopServer(ctx.server); });
