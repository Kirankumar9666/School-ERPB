/**
 * Bulk attendance (class / staff-group screen) tests —
 * GET /api/v1/admin/attendance/group and POST /api/v1/admin/attendance/bulk.
 * Covers the live roster read, atomic whole-class save, overwrite within the
 * 1-hour edit window, the lock after it closes (and the explicit override),
 * foreign-member rejection and RBAC. Node built-in test runner, zero deps.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request, auth } = require('./helpers');

test('admin attendance group + bulk confirm: atomic save, edit window, RBAC', async (t) => {
  const { server, base } = await startServer();
  const admin = await login(base, 'admin', 'Admin@123');

  const options = (await request(base, '/school/options', { token: admin.accessToken })).body.data;
  const class10A = options.classes.find((c) => c.grade === '10' && c.section === 'A');
  assert.ok(class10A, 'seeded class 10-A present with an id');

  const getGroup = async (params) =>
    request(base, `/admin/attendance/group?${new URLSearchParams(params)}`, { token: admin.accessToken });

  const today = new Date().toISOString().slice(0, 10);

  // Idempotency: the DB persists between runs, so clear this group's rows for
  // today before asserting on a clean slate.
  const prisma0 = require('../src/services/prisma');
  const rosterMembers = (await prisma0.student.findMany({ where: { classId: class10A.id } })).map((m) => m.id);
  await prisma0.attendanceConfirmation.deleteMany({
    where: { kind: 'student', groupKey: class10A.id, date: new Date(`${today}T00:00:00.000Z`) },
  });
  await prisma0.studentAttendance.deleteMany({ where: { studentId: { in: rosterMembers }, date: new Date(`${today}T00:00:00.000Z`) } });

  await t.test('group read: live roster, roll numbers, unmarked statuses, derived label', async () => {
    const res = await getGroup({ kind: 'student', groupKey: class10A.id, date: today });
    assert.equal(res.status, 200);
    const g = res.body.data;
    assert.equal(g.label, '10 - Class A'); // derived from grade/section, not a stored string
    assert.equal(g.count, g.members.length);
    assert.ok(g.count > 0);
    assert.ok(g.members.every((m) => m.rollNumber && m.name)); // real roster fields
    assert.ok(g.members.every((m) => m.status === null), 'no attendance yet → all unmarked');
    assert.equal(g.confirmation, null);
  });

  await t.test('bulk confirm: whole class saved in one request (toggled = absent, rest = present)', async () => {
    const roster = (await getGroup({ kind: 'student', groupKey: class10A.id, date: today })).body.data;
    const entries = roster.members.map((m, i) => ({ entityId: m.id, status: i === 0 ? 'absent' : 'present' }));
    const res = await request(base, '/admin/attendance/bulk', {
      method: 'POST', token: admin.accessToken,
      body: { kind: 'student', groupKey: class10A.id, date: today, entries },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.saved, roster.members.length);
    assert.equal(res.body.data.absent, 1);
    assert.equal(res.body.data.present, roster.members.length - 1);

    const after = (await getGroup({ kind: 'student', groupKey: class10A.id, date: today })).body.data;
    assert.ok(after.confirmation && after.confirmation.withinEditWindow, 'confirmation row written, window open');
    assert.equal(after.members[0].status, 'absent');
    assert.ok(after.members.slice(1).every((m) => m.status === 'present'));
  });

  await t.test('re-confirm within the 1-hour window overwrites the same day', async () => {
    const roster = (await getGroup({ kind: 'student', groupKey: class10A.id, date: today })).body.data;
    const entries = roster.members.map((m, i) => ({ entityId: m.id, status: i === 1 ? 'absent' : 'present' }));
    const res = await request(base, '/admin/attendance/bulk', {
      method: 'POST', token: admin.accessToken,
      body: { kind: 'student', groupKey: class10A.id, date: today, entries, override: true },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.absent, 1);

    const after = (await getGroup({ kind: 'student', groupKey: class10A.id, date: today })).body.data;
    assert.equal(after.members[1].status, 'absent');
    assert.equal(after.members[0].status, 'present'); // overwritten, not duplicated
  });

  await t.test('foreign member id → 400, nothing written (atomicity guard)', async () => {
    const roster = (await getGroup({ kind: 'student', groupKey: class10A.id, date: today })).body.data;
    const before = roster.members.map((m) => m.status).join(',');
    const res = await request(base, '/admin/attendance/bulk', {
      method: 'POST', token: admin.accessToken,
      body: {
        kind: 'student', groupKey: class10A.id, date: today,
        entries: [{ entityId: 'no-such-student', status: 'absent' }],
      },
    });
    assert.equal(res.status, 400);
    const after = (await getGroup({ kind: 'student', groupKey: class10A.id, date: today })).body.data;
    assert.equal(after.members.map((m) => m.status).join(','), before, 'no partial rows after rejection');
  });

  await t.test('after the 1-hour window: locked without override, saved with override', async () => {
    const prisma = require('../src/services/prisma');
    await prisma.attendanceConfirmation.update({
      where: { kind_groupKey_date: { kind: 'student', groupKey: class10A.id, date: new Date(`${today}T00:00:00.000Z`) } },
      data: { confirmedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }, // 2h ago → window closed
    });

    const roster = (await getGroup({ kind: 'student', groupKey: class10A.id, date: today })).body.data;
    assert.equal(roster.confirmation.withinEditWindow, false, 'GET reports the closed window');
    const entries = roster.members.map((m) => ({ entityId: m.id, status: 'present' }));

    const locked = await request(base, '/admin/attendance/bulk', {
      method: 'POST', token: admin.accessToken,
      body: { kind: 'student', groupKey: class10A.id, date: today, entries },
    });
    assert.equal(locked.status, 403);
    assert.equal(locked.body.code, 'EDIT_LOCKED');

    const overridden = await request(base, '/admin/attendance/bulk', {
      method: 'POST', token: admin.accessToken,
      body: { kind: 'student', groupKey: class10A.id, date: today, entries, override: true },
    });
    assert.equal(overridden.status, 201);
    const after = (await getGroup({ kind: 'student', groupKey: class10A.id, date: today })).body.data;
    assert.equal(after.confirmation.withinEditWindow, true, 'override re-opens a fresh window');
  });

  await t.test('employee groups: designation roster + bulk save mirrors the student flow', async () => {
    // Group key derived from live employee rows (same rule the UI applies)
    const employees = (await request(base, '/admin/employees', { token: admin.accessToken })).body.data;
    const designation = employees[0].designation;
    assert.ok(designation, 'seeded employees carry a designation');

    const grp = await getGroup({ kind: 'employee', groupKey: designation, date: today });
    assert.equal(grp.status, 200);
    const expected = employees.filter((e) => e.designation === designation).length;
    assert.equal(grp.body.data.members.length, expected, 'roster matches the live group');
    assert.ok(expected > 0, 'group is non-empty');

    const entries = grp.body.data.members.map((m, i) => ({ entityId: m.id, status: i === 0 ? 'absent' : 'present' }));
    const res = await request(base, '/admin/attendance/bulk', {
      method: 'POST', token: admin.accessToken,
      body: { kind: 'employee', groupKey: designation, date: today, entries },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.absent, 1);

    const after = await getGroup({ kind: 'employee', groupKey: designation, date: today });
    assert.equal(after.body.data.members[0].status, 'absent');
    assert.ok(after.body.data.confirmation.withinEditWindow);
  });

  await t.test('validation + RBAC: bad kind/date → 400; student token → 403', async () => {
    assert.equal((await getGroup({ kind: 'nope', groupKey: 'x', date: today })).status, 400);
    assert.equal((await getGroup({ kind: 'student', groupKey: class10A.id, date: 'not-a-date' })).status, 400);

    const student = await login(base, 'student', 'Student@123');
    const res = await request(base, `/admin/attendance/group?kind=student&groupKey=${class10A.id}&date=${today}`, {
      token: student.accessToken,
    });
    assert.equal(res.status, 403);
  });

  await stopServer(server);
});

