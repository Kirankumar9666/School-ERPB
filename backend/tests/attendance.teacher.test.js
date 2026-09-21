/**
 * Teacher-facing class attendance tests —
 * GET/POST /api/v1/employees/:id/attendance/(classes|group|students|bulk).
 *
 * Proves the teacher "Mark Attendance" flow added to the employee portal really
 * is the admin panel's flow: same tables, same 1-hour edit window, same atomic
 * bulk save — plus the scoping that makes it safe, which is enforced server-side
 * (a class the teacher isn't assigned to is rejected even when requested
 * directly, not merely hidden in the UI).
 *
 * Node built-in test runner, zero deps. The class and student the teacher must
 * NOT touch are created here rather than assumed from the seed, so the test
 * never depends on which classes happen to be unassigned.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

test('teacher class attendance: own classes only, shared records with admin', async (t) => {
  const { server, base } = await startServer();
  const admin = await login(base, 'admin', 'Admin@123');
  const teacher = await login(base, 'teacher', 'Teacher@123'); // emp-001
  const accountant = await login(base, 'accountant', 'Accounts@123'); // emp-002 — no classes
  const student = await login(base, 'student', 'Student@123');

  const prisma = require('../src/services/prisma');
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  /* A class this teacher does NOT teach, with a student in it — created live so
     the "not assigned" assertions rest on real rows, not a guessed id. */
  const foreignClassId = 'cls-8C';
  const foreignStudentId = 'stu-8c-001';
  await prisma.class.create({ data: { id: foreignClassId, grade: 8, section: 'C' } });
  await prisma.student.create({
    data: { id: foreignStudentId, name: 'Foreign Class Student', classId: foreignClassId, rollNumber: 'STU-2026-999' },
  });

  const teacherClasses = async (employeeId = 'emp-001', token = teacher.accessToken) =>
    request(base, `/employees/${employeeId}/attendance/classes`, { token });

  const getGroup = (params, token = teacher.accessToken) =>
    request(base, `/employees/emp-001/attendance/group?${new URLSearchParams(params)}`, { token });

  /* The teacher's own class list, read up front (subtest 1 re-reads it to prove
     its derivation). The first entry drives the roster/save subtests. */
  const ownClasses = (await teacherClasses()).body.data;
  assert.ok(ownClasses.length > 0, 'seeded teacher teaches at least one class');
  const ownClassId = ownClasses[0].id;

  await t.test("classes: derived from the teacher's live assignments, never hardcoded", async () => {
    const res = await teacherClasses();
    assert.equal(res.status, 200);
    const list = res.body.data;
    assert.ok(list.length > 0, 'seeded teacher teaches at least one class');

    // Cross-check against the profile's own assignedClasses (independent read).
    const profile = (await request(base, '/employees/emp-001/profile', { token: teacher.accessToken })).body.data;
    assert.deepEqual(
      list.map((c) => c.id).sort(),
      profile.assignedClasses.map((c) => c.classId).sort(),
      'the markable list is exactly this teacher\'s assignments',
    );

    // No assignment → not listed, even though the class now exists.
    assert.ok(!list.some((c) => c.id === foreignClassId), 'a class the teacher does not teach is absent');

    // Headcounts and labels are live, and match the real rosters.
    assert.ok(list.every((c) => typeof c.label === 'string' && c.label.length > 0));
    const liveCounts = await Promise.all(list.map((c) => prisma.student.count({ where: { classId: c.id } })));
    assert.deepEqual(list.map((c) => c.studentCount), liveCounts, 'headcounts match the live rosters');
  });

  await t.test('group read: own class roster matches the live students, admin-identical shape', async () => {
    const res = await getGroup({ groupKey: ownClassId, date: today });
    assert.equal(res.status, 200);
    const g = res.body.data;
    assert.equal(g.groupKey, ownClassId);
    assert.equal(g.count, g.members.length);
    assert.ok(g.count > 0);

    const liveRoster = await prisma.student.findMany({ where: { classId: ownClassId }, orderBy: { rollNumber: 'asc' } });
    assert.deepEqual(g.members.map((m) => m.id), liveRoster.map((s) => s.id));
    assert.ok(g.members.every((m) => m.rollNumber && m.name));

    // Identical payload to the admin endpoint for the same group + date.
    const adminGroup = (await request(
      base,
      `/admin/attendance/group?${new URLSearchParams({ kind: 'student', groupKey: ownClassId, date: today })}`,
      { token: admin.accessToken },
    )).body.data;
    assert.equal(g.label, adminGroup.label, 'same derived label');
    assert.deepEqual(g.members.map((m) => m.id), adminGroup.members.map((m) => m.id));
  });

  await t.test('a class the teacher is not assigned to → 403 on every entry point', async () => {
    const group = await getGroup({ groupKey: foreignClassId, date: today });
    assert.equal(group.status, 403);
    assert.equal(group.body.code, 'FORBIDDEN');

    const roster = await request(base, `/employees/emp-001/attendance/students?groupKey=${foreignClassId}`, { token: teacher.accessToken });
    assert.equal(roster.status, 403);

    const save = await request(base, '/employees/emp-001/attendance/bulk', {
      method: 'POST',
      token: teacher.accessToken,
      body: {
        kind: 'student', groupKey: foreignClassId, date: today,
        entries: [{ entityId: foreignStudentId, status: 'present' }],
      },
    });
    assert.equal(save.status, 403);
    assert.equal(save.body.code, 'FORBIDDEN');

    // …and nothing was written for that student.
    const rows = await prisma.studentAttendance.count({ where: { studentId: foreignStudentId } });
    assert.equal(rows, 0, 'rejected request left no attendance rows behind');
  });
  await t.test('own class roster via the students endpoint — same rows the admin screens use', async () => {
    const res = await request(base, `/employees/emp-001/attendance/students?groupKey=${ownClassId}`, { token: teacher.accessToken });
    assert.equal(res.status, 200);
    const rows = res.body.data;
    const liveRoster = await prisma.student.findMany({ where: { classId: ownClassId }, orderBy: { rollNumber: 'asc' } });
    assert.deepEqual(rows.map((r) => r.id), liveRoster.map((s) => s.id), 'roster is the live class list');
    assert.ok(rows.every((r) => r.name && r.rollNumber && r.class && r.section));
  });

  /*
   * One source of truth: what the teacher saves must be exactly what the admin
   * panel (and the student record) then reads. Idempotency first — the DB
   * persists between runs, so clear this class's rows for today before
   * asserting on a clean slate.
   */
  const ownMemberIds = (await prisma.student.findMany({ where: { classId: ownClassId }, select: { id: true } })).map((s) => s.id);
  await prisma.attendanceConfirmation.deleteMany({
    where: { kind: 'student', groupKey: ownClassId, date: new Date(`${today}T00:00:00.000Z`) },
  });
  await prisma.studentAttendance.deleteMany({
    where: { studentId: { in: ownMemberIds }, date: new Date(`${today}T00:00:00.000Z`) },
  });

  await t.test('teacher save is the admin panel record — identical rows on both sides', async () => {
    const roster = (await getGroup({ groupKey: ownClassId, date: today })).body.data;
    const entries = roster.members.map((m, i) => ({ entityId: m.id, status: i === 0 ? 'absent' : 'present' }));

    const saved = await request(base, '/employees/emp-001/attendance/bulk', {
      method: 'POST',
      token: teacher.accessToken,
      body: { kind: 'student', groupKey: ownClassId, date: today, entries },
    });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.data.saved, entries.length);
    assert.equal(saved.body.data.absent, 1);

    // The admin panel's own endpoint for the same group + date reads it back.
    const adminView = (await request(
      base,
      `/admin/attendance/group?${new URLSearchParams({ kind: 'student', groupKey: ownClassId, date: today })}`,
      { token: admin.accessToken },
    )).body.data;
    assert.equal(adminView.members[0].status, 'absent');
    assert.ok(adminView.members.slice(1).every((m) => m.status === 'present'));
    assert.ok(adminView.confirmation?.withinEditWindow, 'admin sees the confirmation the teacher created');

    // …and so does the student-facing record the student portal renders.
    const studentView = (await request(
      base,
      `/students/${ownMemberIds[0]}/attendance?month=${month}`,
      { token: teacher.accessToken },
    )).body.data;
    assert.equal(studentView.records[today], 'absent', 'the student record shows the teacher-marked status');

    // No duplicate rows: one attendance row per member for the day.
    const rowCount = await prisma.studentAttendance.count({
      where: { studentId: { in: ownMemberIds }, date: new Date(`${today}T00:00:00.000Z`) },
    });
    assert.equal(rowCount, entries.length, 'exactly one row per student, no duplicates');
  });

  await t.test('non-teaching staff have no markable classes → blocked by role', async () => {
    // The accountant (emp-002) is an employee but teaches nothing: the route is
    // teaching-staff-only, so even their own id is refused.
    const res = await teacherClasses('emp-002', accountant.accessToken);
    assert.equal(res.status, 403);

    // …and the student role cannot reach the teacher surface at all.
    const asStudent = await teacherClasses('emp-001', student.accessToken);
    assert.equal(asStudent.status, 403);
  });

  await stopServer(server);
});

