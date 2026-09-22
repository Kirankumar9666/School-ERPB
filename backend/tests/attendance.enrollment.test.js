/**
 * Enrollment-gate tests for the Mark Attendance flow.
 *
 * A student must only ever appear in a day's attendance roster from their
 * enrolled day on (the day they were added to the class) — never for earlier
 * dates — and the save endpoints must refuse to write attendance for a day
 * before that student was enrolled. The class and student are created live
 * here (not taken from the seed) so the assertions rest on the rule itself,
 * and no fixed student/date is assumed to behave one way or the other.
 *
 * Node built-in test runner, zero deps.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

test('attendance enrollment gate: rosters and saves are scoped to enrolledAt', async (t) => {
  const { server, base } = await startServer();
  const admin = await login(base, 'admin', 'Admin@123');
  const prisma = require('../src/services/prisma');

  const today = new Date().toISOString().slice(0, 10);
  const before = '2026-09-01'; // strictly before today → before this student's enrollment
  const classId = 'cls-enr-9X';
  const studentId = 'stu-enr-001';

  /* A class + one student enrolled TODAY — the same rule the create endpoints
     apply (enrolledAt = the day the student is added). */
  await prisma.class.create({ data: { id: classId, grade: 9, section: 'X' } });
  await prisma.student.create({
    data: {
      id: studentId,
      name: 'Enrollment Gate Student',
      classId,
      rollNumber: 'STU-ENR-001',
      enrolledAt: new Date(`${today}T00:00:00.000Z`),
    },
  });

  const getGroup = (date) =>
    request(base, `/admin/attendance/group?${new URLSearchParams({ kind: 'student', groupKey: classId, date })}`, {
      token: admin.accessToken,
    });

  await t.test('a student added today is absent from every earlier day roster', async () => {
    const past = await getGroup(before);
    assert.equal(past.status, 200);
    assert.deepEqual(past.body.data.members.map((m) => m.id), [], 'not in the pre-enrollment roster');

    const todayRoster = await getGroup(today);
    assert.equal(todayRoster.status, 200);
    assert.deepEqual(todayRoster.body.data.members.map((m) => m.id), [studentId], 'listed from enrollment day on (inclusive)');
  });

  await t.test('bulk save refuses a pre-enrollment date and writes nothing', async () => {
    const res = await request(base, '/admin/attendance/bulk', {
      method: 'POST',
      token: admin.accessToken,
      body: {
        kind: 'student', groupKey: classId, date: before,
        entries: [{ entityId: studentId, status: 'present' }],
      },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /not enrolled on 2026-09-01/);
    const rows = await prisma.studentAttendance.count({ where: { studentId } });
    assert.equal(rows, 0, 'nothing written for the pre-enrollment date');
  });

  await t.test('bulk save on/after enrollment succeeds', async () => {
    const res = await request(base, '/admin/attendance/bulk', {
      method: 'POST',
      token: admin.accessToken,
      body: {
        kind: 'student', groupKey: classId, date: today,
        entries: [{ entityId: studentId, status: 'present' }],
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.saved, 1);
  });

  await t.test('single mark refuses a pre-enrollment date', async () => {
    const res = await request(base, '/admin/attendance', {
      method: 'POST',
      token: admin.accessToken,
      body: { entityType: 'student', entityId: studentId, date: before, status: 'present' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /was not enrolled on 2026-09-01/);
  });

  await t.test('mock fixtures stay visible for their seeded demo dates', async () => {
    // stu-001's seeded demo attendance covers 2026-09-01..10 and its enrollment
    // (June 1 of its 2022 admission year) precedes it — the roster keeps it,
    // proving the gate does not sweep away legitimate history. The seeded class
    // is cls-10A (10-A), which is where the fixtures live.
    const res = await request(
      base,
      `/admin/attendance/group?${new URLSearchParams({ kind: 'student', groupKey: 'cls-10A', date: '2026-09-05' })}`,
      { token: admin.accessToken },
    );
    assert.equal(res.status, 200);
    assert.ok(res.body.data.members.some((m) => m.id === 'stu-001'), 'fixture (admitted 2022) still listed on its demo day');
    assert.ok(res.body.data.members.some((m) => m.id === 'stu-002'), 'both 2022 fixtures still listed');
  });

  await stopServer(server);
});