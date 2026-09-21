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

test('reminders: private per-user CRUD', async () => {
  // Invalid payloads are rejected before anything is stored.
  const badDate = await request(ctx.base, '/school/reminders', {
    method: 'POST', token: student.accessToken,
    body: { date: '01/10/2026', title: 'Bad date format' },
  });
  assert.equal(badDate.status, 400);

  const blankTitle = await request(ctx.base, '/school/reminders', {
    method: 'POST', token: student.accessToken,
    body: { date: '2026-10-01', title: '   ' },
  });
  assert.equal(blankTitle.status, 400);

  // A student sets a reminder for themselves.
  const created = await request(ctx.base, '/school/reminders', {
    method: 'POST', token: student.accessToken,
    body: { date: '2026-10-01', title: 'Prepare for science fair' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.date, '2026-10-01');
  assert.equal(created.body.data.title, 'Prepare for science fair');
  const id = created.body.data.id;

  // The owner sees it, soonest first.
  const mine = await request(ctx.base, '/school/reminders', { token: student.accessToken });
  assert.ok(mine.body.data.some((r) => r.id === id), 'owner sees their own reminder');

  // Privacy: nobody else's list contains it, and nobody else can delete it.
  const theirs = await request(ctx.base, '/school/reminders', { token: teacher.accessToken });
  assert.ok(!theirs.body.data.some((r) => r.id === id), 'other users never see this reminder');

  const foreignDelete = await request(ctx.base, `/school/reminders/${id}`, {
    method: 'DELETE', token: teacher.accessToken,
  });
  assert.equal(foreignDelete.status, 404, "another user's reminder is not deletable");

  const stillThere = await request(ctx.base, '/school/reminders', { token: student.accessToken });
  assert.ok(stillThere.body.data.some((r) => r.id === id), 'foreign delete attempt left the reminder intact');

  // Two reminders sort soonest first regardless of creation order.
  const later = await request(ctx.base, '/school/reminders', {
    method: 'POST', token: student.accessToken,
    body: { date: '2026-11-20', title: 'Project submission' },
  });
  assert.equal(later.status, 201);

  const sorted = await request(ctx.base, '/school/reminders', { token: student.accessToken });
  const dates = sorted.body.data.filter((r) => [id, later.body.data.id].includes(r.id)).map((r) => r.date);
  assert.deepEqual(dates, ['2026-10-01', '2026-11-20'], 'own reminders sort soonest first');

  // Owner can delete their own reminder.
  const del = await request(ctx.base, `/school/reminders/${id}`, { method: 'DELETE', token: student.accessToken });
  assert.equal(del.status, 200);
  const after = await request(ctx.base, '/school/reminders', { token: student.accessToken });
  assert.ok(!after.body.data.some((r) => r.id === id), 'deleted reminder is gone');

  // Cleanup so other assertions see only seeded data.
  await request(ctx.base, `/school/reminders/${later.body.data.id}`, { method: 'DELETE', token: student.accessToken });
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

test('reference options are derived from the schema + database, never hardcoded', async () => {
  const ok = await request(ctx.base, '/school/options', { token: admin.accessToken });
  assert.equal(ok.status, 200);

  const { enums, classes } = ok.body.data;

  // Enum option lists come from the Prisma schema enums, so they cannot drift
  // from what the write endpoints validate.
  assert.ok(enums.genders.includes('Female'));
  assert.ok(enums.employmentTypes.includes('Permanent'));
  assert.ok(enums.accountStatuses.includes('active'));
  assert.ok(enums.leaveTypes.includes('casual'));
  assert.deepEqual(enums.attendanceStatuses, ['present', 'absent', 'late', 'half-day', 'holiday']);
  assert.ok(enums.announcementCategories.length > 0);
  assert.ok(enums.achievementTypes.length > 0);
  assert.ok(enums.roles.includes('admin') && enums.roles.includes('librarian'));

  // Classes + sections are the rows in the classes table, with live headcounts.
  assert.deepEqual(classes.map((c) => c.id), ['cls-9B', 'cls-10A']); // grade asc
  const tenA = classes.find((c) => c.id === 'cls-10A');
  assert.equal(tenA.grade, '10');
  assert.equal(tenA.section, 'A');
  assert.equal(tenA.label, 'Class 10A');
  assert.equal(tenA.studentCount, 2); // seeded 10-A students, counted from rows

  // Employees manage timetables/syllabus, so they get the class list too;
  // students get the enum lists only.
  const staff = await request(ctx.base, '/school/options', { token: teacher.accessToken });
  assert.equal(staff.status, 200);
  assert.equal(staff.body.data.classes.length, 2);

  const pupil = await request(ctx.base, '/school/options', { token: student.accessToken });
  assert.equal(pupil.status, 200);
  assert.deepEqual(pupil.body.data.classes, []);
  assert.ok(pupil.body.data.enums.leaveTypes.includes('sick'));

  const anon = await request(ctx.base, '/school/options');
  assert.equal(anon.status, 401);
});

test('teardown — stop server', async () => { await stopServer(ctx.server); });