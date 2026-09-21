/**
 * Integration tests: admin CRUD API (/api/v1/admin/*) — admin-only surface.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

let ctx;
let admin;
let student;

/**
 * 'YYYY-MM-DD' `days` days from now, in the school timezone (Asia/Kolkata) —
 * the same clock the server's announcement window filter reads, so tests
 * straddling midnight UTC still agree with the server.
 */
const istDay = (days) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
};

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
    body: {
      title: 'Test Announcement', body: 'This is a test announcement body.',
      targetRoles: ['student'], category: 'event', showUntil: '2027-01-31',
    },
  });
  assert.equal(created.status, 201);
  // "Show from" left blank → the server defaults it to the real current date.
  assert.equal(created.body.data.showFrom, istDay(0), 'blank Show from defaults to today');
  assert.equal(created.body.data.showUntil, '2027-01-31');

  const studentAnn = await request(ctx.base, '/school/announcements', { token: student.accessToken });
  assert.ok(studentAnn.body.data.some((a) => a.title === 'Test Announcement'), 'student sees the new announcement');

  const del = await request(ctx.base, `/admin/announcements/${created.body.data.id}`, { method: 'DELETE', token: admin.accessToken });
  assert.equal(del.status, 200);
});

test('announcements: scheduling fields are validated', async () => {
  // showUntil is required — without it the circular would stay visible forever.
  const noUntil = await request(ctx.base, '/admin/announcements', {
    method: 'POST',
    token: admin.accessToken,
    body: { title: 'No Until', body: 'This body is long enough to pass.', targetRoles: ['student'], category: 'event' },
  });
  assert.equal(noUntil.status, 400);
  assert.ok(noUntil.body.errors?.showUntil, 'missing showUntil is rejected');

  // A window that ends before it starts is nonsensical.
  const reversed = await request(ctx.base, '/admin/announcements', {
    method: 'POST',
    token: admin.accessToken,
    body: {
      title: 'Reversed Window', body: 'This body is long enough to pass.',
      targetRoles: ['student'], category: 'event', showFrom: '2026-12-10', showUntil: '2026-12-01',
    },
  });
  assert.equal(reversed.status, 400);
  assert.ok(reversed.body.errors?.showUntil, 'showUntil < showFrom is rejected');

  // Dates must be real YYYY-MM-DD values.
  const malformed = await request(ctx.base, '/admin/announcements', {
    method: 'POST',
    token: admin.accessToken,
    body: {
      title: 'Bad Date', body: 'This body is long enough to pass.',
      targetRoles: ['student'], category: 'event', showUntil: '31/12/2026',
    },
  });
  assert.equal(malformed.status, 400);
  assert.ok(malformed.body.errors?.showUntil, 'non-ISO date rejected');
});

test('announcements: visibility window auto-shows/hides circulars on the portals', async () => {
  const base = { body: 'This body is long enough to pass.', targetRoles: ['student'], category: 'event' };

  // Scheduled for the future → must NOT appear yet (e.g. a holiday notice
  // posted now that only shows starting next week).
  const future = await request(ctx.base, '/admin/announcements', {
    method: 'POST', token: admin.accessToken,
    body: { title: 'Scheduled Notice', ...base, showFrom: istDay(10), showUntil: istDay(40) },
  });
  assert.equal(future.status, 201);

  // Already expired → must NOT appear anymore, with no manual hiding.
  const expired = await request(ctx.base, '/admin/announcements', {
    method: 'POST', token: admin.accessToken,
    body: { title: 'Expired Notice', ...base, showFrom: istDay(-40), showUntil: istDay(-10) },
  });
  assert.equal(expired.status, 201);

  const before = await request(ctx.base, '/school/announcements', { token: student.accessToken });
  assert.ok(!before.body.data.some((a) => a.title === 'Scheduled Notice'), 'future showFrom is hidden');
  assert.ok(!before.body.data.some((a) => a.title === 'Expired Notice'), 'past showUntil is hidden');

  // Extend/shift the scheduled window via PUT so it covers today → appears.
  const extended = await request(ctx.base, `/admin/announcements/${future.body.data.id}`, {
    method: 'PUT',
    token: admin.accessToken,
    body: {
      title: 'Scheduled Notice', ...base,
      showFrom: istDay(-1), showUntil: istDay(30),
    },
  });
  assert.equal(extended.status, 200);
  assert.equal(extended.body.data.showUntil, istDay(30));

  const after = await request(ctx.base, '/school/announcements', { token: student.accessToken });
  assert.ok(after.body.data.some((a) => a.title === 'Scheduled Notice'), 'extended window makes it visible');
  assert.ok(!after.body.data.some((a) => a.title === 'Expired Notice'), 'expired one stays hidden');

  // Newest first: the just-extended circular (showFrom yesterday) sorts above
  // everything seeded with an older showFrom.
  const titles = after.body.data.map((a) => a.title);
  assert.equal(titles[0], 'Scheduled Notice', 'visible circulars sort by showFrom descending');

  await request(ctx.base, `/admin/announcements/${future.body.data.id}`, { method: 'DELETE', token: admin.accessToken });
  await request(ctx.base, `/admin/announcements/${expired.body.data.id}`, { method: 'DELETE', token: admin.accessToken });
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
test('users list exposes linkedEntityId so an account can be matched to its student/employee', async () => {
  const [users, students, employees] = await Promise.all([
    request(ctx.base, '/admin/users', { token: admin.accessToken }),
    request(ctx.base, '/admin/students', { token: admin.accessToken }),
    request(ctx.base, '/admin/employees', { token: admin.accessToken }),
  ]);
  const studentIds = new Set(students.body.data.map((s) => s.id));
  const employeeIds = new Set(employees.body.data.map((e) => e.id));

  // every account reports the field, and any non-null link resolves to a real record
  for (const u of users.body.data) {
    assert.ok('linkedEntityId' in u, `${u.username} exposes linkedEntityId`);
    if (u.linkedEntityId !== null) {
      assert.ok(
        studentIds.has(u.linkedEntityId) || employeeIds.has(u.linkedEntityId),
        `${u.username} links to a real student/employee (${u.linkedEntityId})`,
      );
    }
  }

  // student and employee accounts carry their record id; the admin carries none
  // (that is what keeps the admin in the screen's separate "Other Accounts" list)
  assert.equal(users.body.data.find((u) => u.username === 'student').linkedEntityId, 'stu-001');
  assert.equal(users.body.data.find((u) => u.username === 'teacher').linkedEntityId, 'emp-001');
  assert.ok(users.body.data.some((u) => u.linkedEntityId === null), 'an unlinked account exists');
});

test('password reset (PUT /admin/users/:id/reset-password): admin-only, complexity enforced, new password really logs in', async () => {
  // The user id of the student account, derived live from the users list
  const users = await request(ctx.base, '/admin/users', { token: admin.accessToken });
  const target = users.body.data.find((u) => u.linkedEntityId === 'stu-001');
  assert.ok(target, 'the student account is listed with its user id');

  // A non-admin can never call it — students have no self-service reset anywhere
  const denied = await request(ctx.base, `/admin/users/${target.id}/reset-password`, {
    method: 'PUT', token: student.accessToken, body: { newPassword: 'StudentNew@123' },
  });
  assert.equal(denied.status, 403);

  // Complexity rules: too short, and each missing character class rejected
  const weak = [
    'Ab@1', // too short
    'alllowercase1', // no uppercase
    'ALLUPPERCASE1', // no lowercase
    'NoDigitsHere', // no digit
  ];
  for (const newPassword of weak) {
    const bad = await request(ctx.base, `/admin/users/${target.id}/reset-password`, {
      method: 'PUT', token: admin.accessToken, body: { newPassword },
    });
    assert.equal(bad.status, 400, `"${newPassword}" must be rejected`);
    assert.equal(bad.body.code, 'VALIDATION_ERROR');
  }

  // A strong password succeeds, the old one stops working, and the new one
  // logs in — proving the hash was really written to the database with bcrypt.
  const ok = await request(ctx.base, `/admin/users/${target.id}/reset-password`, {
    method: 'PUT', token: admin.accessToken, body: { newPassword: 'NewPass@123' },
  });
  assert.equal(ok.status, 200);

  const oldFails = await request(ctx.base, '/auth/login', {
    method: 'POST', body: { username: 'student', password: 'Student@123' },
  });
  assert.equal(oldFails.status, 401, 'the old password no longer authenticates');

  const relogin = await login(ctx.base, 'student', 'NewPass@123');
  assert.ok(relogin.accessToken, 'the new password logs the student in');
});

test('teardown — stop server', async () => { await stopServer(ctx.server); });
