/**
 * Bulk attendance (class / employee screen) tests —
 * GET /api/v1/admin/attendance/group and POST /api/v1/admin/attendance/bulk.
 * Covers the live roster read, atomic whole-class save, overwrite within the
 * 1-hour edit window, the lock after it closes (and the explicit override),
 * the per-person employee group (an id is one person and locks only them, the
 * designation fallback that predates it), foreign-member rejection and RBAC.
 * Node built-in test runner, zero deps.
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
    const res = await getGroup({ kind: 'student', groupKey: class10A.id, date: today, session: 'FN' });
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
    const roster = (await getGroup({ kind: 'student', groupKey: class10A.id, date: today, session: 'FN' })).body.data;
    const entries = roster.members.map((m, i) => ({ entityId: m.id, status: i === 0 ? 'absent' : 'present' }));
    const res = await request(base, '/admin/attendance/bulk', {
      method: 'POST', token: admin.accessToken,
      body: { kind: 'student', groupKey: class10A.id, date: today, session: 'FN', entries },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.saved, roster.members.length);
    assert.equal(res.body.data.absent, 1);
    assert.equal(res.body.data.present, roster.members.length - 1);

    const after = (await getGroup({ kind: 'student', groupKey: class10A.id, date: today, session: 'FN' })).body.data;
    assert.ok(after.confirmation && after.confirmation.withinEditWindow, 'confirmation row written, window open');
    assert.equal(after.members[0].status, 'absent');
    assert.ok(after.members.slice(1).every((m) => m.status === 'present'));
  });

  await t.test('re-confirm within the 1-hour window overwrites the same day', async () => {
    const roster = (await getGroup({ kind: 'student', groupKey: class10A.id, date: today, session: 'FN' })).body.data;
    const entries = roster.members.map((m, i) => ({ entityId: m.id, status: i === 1 ? 'absent' : 'present' }));
    const res = await request(base, '/admin/attendance/bulk', {
      method: 'POST', token: admin.accessToken,
      body: { kind: 'student', groupKey: class10A.id, date: today, session: 'FN', entries, override: true },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.absent, 1);

    const after = (await getGroup({ kind: 'student', groupKey: class10A.id, date: today, session: 'FN' })).body.data;
    assert.equal(after.members[1].status, 'absent');
    assert.equal(after.members[0].status, 'present'); // overwritten, not duplicated
  });

  await t.test('foreign member id → 400, nothing written (atomicity guard)', async () => {
    const roster = (await getGroup({ kind: 'student', groupKey: class10A.id, date: today, session: 'FN' })).body.data;
    const before = roster.members.map((m) => m.status).join(',');
    const res = await request(base, '/admin/attendance/bulk', {
      method: 'POST', token: admin.accessToken,
      body: {
        kind: 'student', groupKey: class10A.id, date: today, session: 'FN',
        entries: [{ entityId: 'no-such-student', status: 'absent' }],
      },
    });
    assert.equal(res.status, 400);
    const after = (await getGroup({ kind: 'student', groupKey: class10A.id, date: today, session: 'FN' })).body.data;
    assert.equal(after.members.map((m) => m.status).join(','), before, 'no partial rows after rejection');
  });

  await t.test('after the 1-hour window: locked without override, saved with override', async () => {
    const prisma = require('../src/services/prisma');
    await prisma.attendanceConfirmation.update({
      where: { kind_groupKey_date_session: { kind: 'student', groupKey: class10A.id, date: new Date(`${today}T00:00:00.000Z`), session: 'FN' } },
      data: { confirmedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }, // 2h ago → window closed
    });

    const roster = (await getGroup({ kind: 'student', groupKey: class10A.id, date: today, session: 'FN' })).body.data;
    assert.equal(roster.confirmation.withinEditWindow, false, 'GET reports the closed window');
    const entries = roster.members.map((m) => ({ entityId: m.id, status: 'present' }));

    const locked = await request(base, '/admin/attendance/bulk', {
      method: 'POST', token: admin.accessToken,
      body: { kind: 'student', groupKey: class10A.id, date: today, session: 'FN', entries },
    });
    assert.equal(locked.status, 403);
    assert.equal(locked.body.code, 'EDIT_LOCKED');

    const overridden = await request(base, '/admin/attendance/bulk', {
      method: 'POST', token: admin.accessToken,
      body: { kind: 'student', groupKey: class10A.id, date: today, session: 'FN', entries, override: true },
    });
    assert.equal(overridden.status, 201);
    const after = (await getGroup({ kind: 'student', groupKey: class10A.id, date: today, session: 'FN' })).body.data;
    assert.equal(after.confirmation.withinEditWindow, true, 'override re-opens a fresh window');
  });

  await t.test('sessions are independent: FN and AN keep separate statuses and windows', async () => {
    const prisma = require('../src/services/prisma');
    await prisma.attendanceConfirmation.deleteMany({
      where: { kind: 'student', groupKey: class10A.id, date: new Date(`${today}T00:00:00.000Z`) },
    });
    await prisma.studentAttendance.deleteMany({
      where: { studentId: { in: rosterMembers }, date: new Date(`${today}T00:00:00.000Z`) },
    });

    const roster = (await getGroup({ kind: 'student', groupKey: class10A.id, date: today, session: 'FN' })).body.data;
    const entries = roster.members.map((m, i) => ({ entityId: m.id, status: i === 0 ? 'absent' : 'present' }));
    const fnSave = await request(base, '/admin/attendance/bulk', {
      method: 'POST', token: admin.accessToken,
      body: { kind: 'student', groupKey: class10A.id, date: today, session: 'FN', entries },
    });
    assert.equal(fnSave.status, 201);

    // The AN roster is untouched and its window is open even though FN is set.
    const anRoster = (await getGroup({ kind: 'student', groupKey: class10A.id, date: today, session: 'AN' })).body.data;
    assert.ok(anRoster.members.every((m) => m.status === null), 'AN has its own empty state after FN was confirmed');
    assert.equal(anRoster.confirmation, null, 'AN was not confirmed by the FN save');

    // And confirming AN writes separate rows: no overwrite, no duplication.
    const anSave = await request(base, '/admin/attendance/bulk', {
      method: 'POST', token: admin.accessToken,
      body: { kind: 'student', groupKey: class10A.id, date: today, session: 'AN', entries },
    });
    assert.equal(anSave.status, 201);

    const rows = await prisma.studentAttendance.count({
      where: { studentId: { in: rosterMembers }, date: new Date(`${today}T00:00:00.000Z`) },
    });
    assert.equal(rows, rosterMembers.length * 2, 'one FN + one AN row per member');

    const confirmations = await prisma.attendanceConfirmation.count({
      where: { kind: 'student', groupKey: class10A.id, date: new Date(`${today}T00:00:00.000Z`) },
    });
    assert.equal(confirmations, 2, 'one confirmation per session');
  });

  await t.test('employee groups: designation roster + bulk save mirrors the student flow', async () => {
    // Group key derived from live employee rows (same rule the UI applies)
    const employees = (await request(base, '/admin/employees', { token: admin.accessToken })).body.data;
    const designation = employees[0].designation;
    assert.ok(designation, 'seeded employees carry a designation');

    const grp = await getGroup({ kind: 'employee', groupKey: designation, date: today, session: 'FN' });
    assert.equal(grp.status, 200);
    const expected = employees.filter((e) => e.designation === designation).length;
    assert.equal(grp.body.data.members.length, expected, 'roster matches the live group');
    assert.ok(expected > 0, 'group is non-empty');

    // Idempotency (same as the student flow above): the DB persists between
    // runs, so a confirmation left by an earlier run would have closed the
    // 1-hour edit window and fail this save with EDIT_LOCKED.
    const prismaEmp = require('../src/services/prisma');
    const memberIds = grp.body.data.members.map((m) => m.id);
    await prismaEmp.attendanceConfirmation.deleteMany({
      where: { kind: 'employee', groupKey: designation, date: new Date(`${today}T00:00:00.000Z`) },
    });
    await prismaEmp.employeeAttendance.deleteMany({
      where: { employeeId: { in: memberIds }, date: new Date(`${today}T00:00:00.000Z`) },
    });

    const entries = grp.body.data.members.map((m, i) => ({ entityId: m.id, status: i === 0 ? 'absent' : 'present' }));
    const res = await request(base, '/admin/attendance/bulk', {
      method: 'POST', token: admin.accessToken,
      body: { kind: 'employee', groupKey: designation, date: today, session: 'FN', entries },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.absent, 1);

    const after = await getGroup({ kind: 'employee', groupKey: designation, date: today, session: 'FN' });
    assert.equal(after.body.data.members[0].status, 'absent');
    assert.ok(after.body.data.confirmation.withinEditWindow);
  });

  await t.test('employee groups: a person is their own group (id, not designation)', async () => {
    // The admin staff list is flat: one row per employee, each carrying their
    // designation. Selecting one marks THAT person only — no designation
    // grouping, no "N members" drill-down step.
    const employees = (await request(base, '/admin/employees', { token: admin.accessToken })).body.data;
    const person = employees[0];
    assert.ok(person.name && person.designation, 'live employee rows carry name + designation');

    const prismaEmp = require('../src/services/prisma');
    const day = new Date(`${today}T00:00:00.000Z`);
    await prismaEmp.attendanceConfirmation.deleteMany({ where: { kind: 'employee', groupKey: person.id, date: day } });
    await prismaEmp.employeeAttendance.deleteMany({ where: { employeeId: person.id, date: day } });

    const grp = await getGroup({ kind: 'employee', groupKey: person.id, date: today, session: 'FN' });
    assert.equal(grp.status, 200);
    const roster = grp.body.data;
    assert.equal(roster.label, person.name, 'the group is labelled with the person, not a designation');
    assert.equal(roster.count, 1, 'exactly one member — the selected person');
    assert.equal(roster.members[0].id, person.id);
    assert.equal(roster.members[0].parentName, person.designation, 'their designation is on the roster row');

    // Marking them writes only their own row…
    const save = await request(base, '/admin/attendance/bulk', {
      method: 'POST', token: admin.accessToken,
      body: { kind: 'employee', groupKey: person.id, date: today, session: 'FN', entries: [{ entityId: person.id, status: 'absent' }] },
    });
    assert.equal(save.status, 201);
    assert.equal(save.body.data.absent, 1);
    assert.equal(save.body.data.present, 0);

    const after = await getGroup({ kind: 'employee', groupKey: person.id, date: today, session: 'FN' });
    assert.equal(after.body.data.members[0].status, 'absent');
    assert.ok(after.body.data.confirmation.withinEditWindow, 'their own confirmation starts a fresh 1-hour window');

    // …and leaves a colleague of the SAME designation completely untouched:
    // one person's confirmation can no longer lock an entire department.
    const colleague = employees.find((e) => e.designation === person.designation && e.id !== person.id);
    if (colleague) {
      const peer = await getGroup({ kind: 'employee', groupKey: colleague.id, date: today, session: 'FN' });
      assert.equal(peer.body.data.members[0].status, null, "a same-designation colleague is unaffected");
      assert.equal(peer.body.data.confirmation, null, 'and gets their own, separate edit window');
    }
  });

  await t.test('employee groups: an unknown key is 404, a designation still resolves', async () => {
    const notFound = await getGroup({ kind: 'employee', groupKey: 'emp-does-not-exist', date: today, session: 'FN' });
    assert.equal(notFound.status, 404);

    // Legacy path: confirmations written by designation before the split stay
    // readable rather than 404-ing.
    const employees = (await request(base, '/admin/employees', { token: admin.accessToken })).body.data;
    const designation = employees.find((e) => e.designation).designation;
    const legacy = await getGroup({ kind: 'employee', groupKey: designation, date: today, session: 'FN' });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.data.count, employees.filter((e) => e.designation === designation).length);
  });

  await t.test('validation + RBAC: bad kind/date → 400; student token → 403', async () => {
    assert.equal((await getGroup({ kind: 'nope', groupKey: 'x', date: today, session: 'FN' })).status, 400);
    assert.equal((await getGroup({ kind: 'student', groupKey: class10A.id, date: 'not-a-date', session: 'FN' })).status, 400);

    const student = await login(base, 'student', 'Student@123');
    const res = await request(base, `/admin/attendance/group?kind=student&groupKey=${class10A.id}&date=${today}&session=FN`, {
      token: student.accessToken,
    });
    assert.equal(res.status, 403);
  });

  await stopServer(server);
});

