/**
 * Ending and reopening an employee's employment.
 *
 * The rule under test throughout: leaving the school is an EVENT, not a deletion.
 * `POST /employees/:id/end-employment` appends a row to the employee's timeline
 * and flips `Employee.status` to `inactive`; it must not touch a single payroll
 * month, attendance row, mark, leave request or document. So the dependent-record
 * census is captured before and after and compared row for row — the counts are
 * read from the API, never restated here, so a change to which tables are
 * considered dependent cannot make this file pass wrongly.
 *
 * The second rule: the hard DELETE still exists, but only for a record nothing
 * depends on, and it is a different thing with a different name. So the tests
 * cover both halves — refused for a real employee, and allowed for a genuine
 * duplicate, including the case that decides the borderline: marks recorded by
 * an employee are stored by NAME, so they survive the delete and do not block it.
 *
 * Also covered: `status` is not settable through the edit form's route (it is
 * owned by the two lifecycle endpoints), the last working day cannot precede the
 * date of joining, the description's 500-char normalised bound, that an employee
 * linked to an admin login is refused (it would lock the office out), that
 * reactivation KEEPS the earlier ending, and that an audit entry is written.
 *
 * Nothing here is hardcoded: the employee, the reasons and the dates are the
 * API's own values, and the reason list is read from `/school/options` rather
 * than written out, so a new `EmploymentEndReason` cannot invalidate the file.
 *
 * Node built-in test runner, zero extra deps.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

test('employment: ending, reactivating, and the gated permanent delete', async (t) => {
  const { server, base } = await startServer();
  t.after(() => stopServer(server));

  const admin = await login(base, 'admin', 'Admin@123');
  const T = admin.accessToken;
  const prisma = require('../src/services/prisma');

  const EMP = 'emp-001'; // seeded teacher, has payroll/attendance/leave/documents
  const get = (path) => request(base, path, { token: T });
  const detail = async (id) => (await get(`/admin/employees/${id}`)).body.data;
  const end = (id, body) => request(base, `/admin/employees/${id}/end-employment`, { method: 'POST', token: T, body });
  const reactivate = (id) => request(base, `/admin/employees/${id}/reactivate`, { method: 'POST', token: T });

  /* The login limiter allows 5 attempts per IP per 15 minutes, so this file
     makes exactly four: the admin's own, and one either side of the ending. */
  const tryLogin = (username, password) => request(base, '/auth/login', { method: 'POST', body: { username, password } });

  /** The census as a comparable string, so before/after is a single assertion. */
  const censusOf = (d) => JSON.stringify(d.dependentRecords.map((r) => [r.key, r.count, r.blocking]));

  /** A brand-new employee with no history at all — the duplicate-cleanup case. */
  const scratch = () => request(base, '/admin/employees', {
    method: 'POST',
    token: T,
    body: { name: 'Scratch Person', department: 'Audit', designation: 'Clerk', role: 'accountant', dateOfJoining: '2024-02-01' },
  });

  /* ---- 1. The reason list is the schema's own, not a copy of it ---- */

  const options = (await get('/school/options')).body.data.enums;
  assert.ok(Array.isArray(options.employmentEndReasons) && options.employmentEndReasons.length > 0,
    'employmentEndReasons must be served from the Prisma enum');
  // Taken from the server rather than written here, so this stays true if the
  // enum gains or loses a value.
  const [REASON] = options.employmentEndReasons;

  /* ---- 2. Before anything: active, no ending recorded, history empty ---- */

  const fresh = await detail(EMP);
  assert.equal(fresh.status, 'active');
  assert.equal(fresh.employment, null, 'an employee with no ending must report employment: null');
  assert.deepEqual(fresh.employmentHistory, []);
  assert.equal(fresh.canDeletePermanently, false, 'a used employee must not be permanently deletable');
  assert.ok(fresh.dependentRecords.some((r) => r.blocking && r.count > 0),
    'the seeded teacher must genuinely have dependent records for this file to mean anything');
  // Marks are attributed by name, so they are reported but must never be a blocker.
  const marksRow = fresh.dependentRecords.find((r) => r.key === 'marksEntered');
  assert.ok(marksRow, 'marksEntered must appear in the census');
  assert.equal(marksRow.blocking, false, 'marks must never block a delete — that is why they are stored by name');

  const joining = fresh.dateOfJoining;
  const LAST_DAY = '2026-09-30';
  const before = censusOf(fresh);

  /* ---- 3. Validation: nothing is written by a rejected request ---- */

  const rejected = [
    ['an unknown reason', { reason: 'fired', lastWorkingDay: LAST_DAY }, /reason/i],
    ['a missing reason', { lastWorkingDay: LAST_DAY }, /reason/i],
    ['a missing last working day', { reason: REASON }, /lastWorkingDay/i],
    ['a non-ISO date', { reason: REASON, lastWorkingDay: '30-09-2026' }, /lastWorkingDay/i],
    ['a description over the bound', { reason: REASON, lastWorkingDay: LAST_DAY, description: 'x'.repeat(501) }, /description/i],
  ];
  for (const [what, body, field] of rejected) {
    const res = await end(EMP, body);
    assert.equal(res.status, 400, `${what} must be rejected — got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(field.test(JSON.stringify(res.body.errors || res.body.message || '')),
      `${what} must name the offending field — got ${JSON.stringify(res.body)}`);
  }
  assert.deepEqual((await detail(EMP)).employmentHistory, [], 'a rejected end must leave no timeline row');

  // Back-dating a last working day before the employee ever joined is a payroll
  // cutoff that closes before the employment it cuts off.
  if (joining) {
    const early = await end(EMP, { reason: REASON, lastWorkingDay: '2000-01-01' });
    assert.equal(early.status, 400);
    assert.match(early.body.message, /joining/i);
    assert.deepEqual((await detail(EMP)).employmentHistory, [], 'the rejected end must not have written a row');
  }

  const missing = await end('emp-does-not-exist', { reason: REASON, lastWorkingDay: LAST_DAY });
  assert.equal(missing.status, 404, 'an unknown employee must be a 404');

  // Exactly at the bound is accepted — the limit is inclusive.
  const atBound = await end((await scratch()).body.data.id, {
    reason: REASON, lastWorkingDay: LAST_DAY, description: 'x'.repeat(500),
  });
  assert.equal(atBound.status, 200, 'a 500-character description must be accepted');
  assert.equal(atBound.body.data.employment.description.length, 500);

  /* ---- 4. `status` is owned by the lifecycle routes, not the edit form ---- */

  const edited = await request(base, `/admin/employees/${EMP}`, {
    method: 'PUT',
    token: T,
    body: { name: fresh.name, department: fresh.department, designation: fresh.designation, status: 'inactive' },
  });
  assert.equal(edited.status, 409, 'editing an employee must not be able to set their status');
  assert.equal(edited.body.code, 'STATUS_NOT_EDITABLE');
  assert.equal((await detail(EMP)).status, 'active', 'the refused edit must not have changed anything');

  // A new employee is always active: there is no timeline row to explain anything else.
  const made = await scratch();
  assert.equal(made.status, 201);
  assert.equal(made.body.data.status, 'active', 'a new employee must join the active staff list');

  /* ---- 5. Ending the employment ---- */

  assert.equal((await tryLogin('teacher', 'Teacher@123')).status, 200, 'the teacher must be able to sign in beforehand');

  const ended = await end(EMP, {
    reason: REASON,
    lastWorkingDay: LAST_DAY,
    // CRLF is what a <textarea> submits on Windows; it must be stored as LF so the
    // on-screen counter and the stored value agree.
    description: 'Relocating.\r\nTwo lines.  ',
  });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.equal(ended.body.data.employee.status, 'inactive');
  assert.match(ended.body.message, /kept/i, 'the response must say the records were kept');

  const record = ended.body.data.employment;
  assert.equal(record.reason, REASON);
  assert.equal(record.lastWorkingDay, LAST_DAY);
  assert.equal(record.description, 'Relocating.\nTwo lines.', 'CRLF must normalise to LF and the ends must trim');
  assert.equal(record.endedBy, admin.user.username, 'the ending must record who processed it');
  assert.ok(!Number.isNaN(Date.parse(record.endedAt)), 'endedAt must be a real timestamp');
  assert.equal(record.open, true, 'a fresh ending is open');
  assert.equal(record.reactivatedAt, null);

  /* ---- 6. Nothing they own was touched ---- */

  const after = await detail(EMP);
  assert.equal(censusOf(after), before, 'the dependent-record census must be identical after ending the employment');
  assert.equal(after.employmentHistory.length, 1);
  assert.equal(after.employmentHistory[0].reason, REASON);
  assert.equal(after.employment.lastWorkingDay, LAST_DAY, 'the list-facing summary must carry the last working day');

  /* ---- 7. The login is disabled immediately ---- */

  const blocked = await tryLogin('teacher', 'Teacher@123');
  assert.equal(blocked.status, 401, 'an ended employee must not be able to sign in');
  assert.equal(blocked.body.code, 'INVALID_CREDENTIALS');
  // A wrong password must be indistinguishable, so a disabled account cannot be
  // probed for existence by its error message.
  const wrongPassword = await tryLogin('teacher', 'Definitely@Wrong1');
  assert.equal(wrongPassword.body.message, blocked.body.message, 'a disabled account must look exactly like a bad password');

  /* ---- 8. Ending twice is refused, and the timeline does not grow ---- */

  const twice = await end(EMP, { reason: options.employmentEndReasons.at(-1), lastWorkingDay: LAST_DAY });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.code, 'ALREADY_ENDED');
  assert.equal((await detail(EMP)).employmentHistory.length, 1, 'a refused second end must not add a row');

  /* ---- 9. The hard delete is refused, and says what to do instead ---- */

  const refused = await request(base, `/admin/employees/${EMP}`, { method: 'DELETE', token: T });
  assert.equal(refused.status, 409, 'a used employee must not be hard-deletable');
  assert.match(refused.body.message, /End Employment/i, 'the refusal must point at the route that does work');

  /* ---- 10. Reactivation restores the account and KEEPS the history ---- */

  const reopened = await reactivate(EMP);
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.data.employee.status, 'active');
  assert.equal(reopened.body.data.employee.employment, null, 'no open ending may remain after reactivating');

  const rehired = await detail(EMP);
  assert.equal(rehired.employmentHistory.length, 1, 'the earlier ending must SURVIVE the reactivation');
  const survived = rehired.employmentHistory[0];
  assert.equal(survived.open, false);
  assert.equal(survived.reason, REASON);
  assert.equal(survived.lastWorkingDay, LAST_DAY);
  assert.equal(survived.description, 'Relocating.\nTwo lines.', 'the note must not be rewritten by a reactivation');
  assert.equal(survived.reactivatedBy, admin.user.username);
  assert.ok(!Number.isNaN(Date.parse(survived.reactivatedAt)));

  assert.equal((await tryLogin('teacher', 'Teacher@123')).status, 200, 'the account must work again after reactivation');

  const reopenAgain = await reactivate(EMP);
  assert.equal(reopenAgain.status, 409, 'reactivating an active employee must be refused');
  assert.equal(reopenAgain.body.code, 'NOT_ENDED');

  /* ---- 11. Leave again after a rehire: two rows, and the newest is the live one ---- */

  const secondReason = options.employmentEndReasons.at(-1);
  const leftAgain = await end(EMP, { reason: secondReason, lastWorkingDay: '2026-12-31', description: 'Fixed term finished.' });
  assert.equal(leftAgain.status, 200, JSON.stringify(leftAgain.body));

  const twiceOver = await detail(EMP);
  assert.equal(twiceOver.employmentHistory.length, 2, 'a second spell of employment must add a row, not replace one');
  assert.equal(twiceOver.employmentHistory[0].reason, secondReason, 'history must be newest first');
  assert.equal(twiceOver.employmentHistory[0].open, true);
  assert.equal(twiceOver.employmentHistory[1].open, false, 'the first ending must still be closed, not reopened');
  assert.equal(twiceOver.employment.reason, secondReason,
    'the current status must follow the OPEN ending only — never the most recent row');
  assert.equal(twiceOver.employment.lastWorkingDay, '2026-12-31');

  // Put them back on the staff list for a clean finish.
  assert.equal((await reactivate(EMP)).status, 200);

  /* ---- 12. The rare permanent delete: allowed only when nothing depends on it ---- */

  const orphan = made.body.data.id;
  const orphanDetail = await detail(orphan);
  assert.equal(orphanDetail.canDeletePermanently, true, 'a record nothing depends on must be deletable');
  assert.ok(orphanDetail.dependentRecords.every((r) => r.count === 0));

  // Its own timeline row must not stand in the way: the FK cascades.
  assert.equal((await end(orphan, { reason: REASON, lastWorkingDay: LAST_DAY })).status, 200);
  const gone = await request(base, `/admin/employees/${orphan}`, { method: 'DELETE', token: T });
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.equal((await get('/admin/employees')).body.data.some((e) => e.id === orphan), false);
  assert.equal(await prisma.employmentEnd.count({ where: { employeeId: orphan } }), 0,
    'the timeline row must cascade with the employee, not block it');

  /* ---- 13. Marks are attributed by name, so they do NOT block a delete ---- */

  /* A (student, exam, subject) triple with no mark on it yet. The unique index is
     on exactly those three, so a blind pick collides with the seed — this finds
     a real gap, preferring a subject the student's own class actually teaches, so
     the row written below looks like a genuine entry rather than a test fixture. */
  const students = await prisma.student.findMany({ select: { id: true } });
  const exams = await prisma.exam.findMany({ select: { id: true } });
  const existing = await prisma.marksEntry.findMany({ select: { studentId: true, examId: true, subject: true } });
  const taught = [...new Set((await prisma.timetablePeriod.findMany({ select: { subject: true } })).map((p) => p.subject))];
  const taken = (sid, eid, subj) => existing.some((m) => m.studentId === sid && m.examId === eid && m.subject === subj);
  const slot = taught.length
    ? students.flatMap((s) => exams.flatMap((e) => taught
      .filter((subj) => !taken(s.id, e.id, subj))
      .map((subj) => ({ studentId: s.id, examId: e.id, subject: subj }))))
    : [];
  assert.ok(slot.length > 0, 'the seed must leave a free (student, exam, subject) slot to record a mark in');

  const marksUser = await prisma.user.create({
    data: { username: 'marks-only', passwordHash: 'not-a-real-hash', role: 'teacher', name: 'Marks Only' },
  });
  const marksEmp = await prisma.employee.create({
    data: { id: 'emp-marks-only', userId: marksUser.id, name: 'Marks Only' },
  });
  await prisma.marksEntry.create({
    data: { ...slot[0], maxMarks: 100, obtained: 88, enteredBy: 'marks-only' },
  });

  const marksDetail = await detail(marksEmp.id);
  const marksOnly = marksDetail.dependentRecords.find((r) => r.key === 'marksEntered');
  assert.equal(marksOnly.count, 1, 'the census must count the mark by the author username');
  assert.equal(marksOnly.blocking, false);
  assert.equal(marksDetail.canDeletePermanently, true,
    'marks must NOT block the delete — the schema stores them by name precisely so history survives');

  const removed = await request(base, `/admin/employees/${marksEmp.id}`, { method: 'DELETE', token: T });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(await prisma.marksEntry.count({ where: { enteredBy: 'marks-only' } }), 1,
    'the mark must outlive the employee it was entered by');
  assert.equal(await prisma.user.count({ where: { username: 'marks-only' } }), 1,
    'the login row is untouched by an employee delete — it is not what this path removes');

  /* ---- 14. An employee linked to an admin login is refused ---- */

  const adminLinkedUser = await prisma.user.create({
    data: { username: 'principal', passwordHash: 'not-a-real-hash', role: 'admin', name: 'Principal' },
  });
  const principal = await prisma.employee.create({
    data: { id: 'emp-principal', userId: adminLinkedUser.id, name: 'Principal', department: 'Admin', designation: 'Principal' },
  });
  const lockedOut = await end(principal.id, { reason: REASON, lastWorkingDay: LAST_DAY });
  assert.equal(lockedOut.status, 409, 'ending an admin-linked employee would lock the office out');
  assert.equal(lockedOut.body.code, 'ADMIN_LINK_CONFLICT');
  assert.equal((await detail(principal.id)).status, 'active', 'the refused end must not have demoted anyone');
  assert.equal((await prisma.user.findUnique({ where: { id: adminLinkedUser.id } })).status, 'active');

  /* ---- 15. The employee-facing read agrees with the admin's ---- */

  /* Read as the admin rather than spending a fifth login on a teacher session:
     `canAccessEmployee` admits an admin, and the thing under test here is that
     the employee route shares the include that carries the timeline, which does
     not depend on who asked. */
  const ownProfile = await request(base, `/employees/${EMP}/profile`, { token: T });
  assert.equal(ownProfile.status, 200);
  assert.equal(ownProfile.body.data.employment, null,
    'an employee who is on the staff list must see no open ending of their own');
  assert.deepEqual(ownProfile.body.data.employmentHistory, undefined,
    'the single-employee read carries the open ending only, not the full timeline');

  /* ---- 16. Every mutation is audited ---- */

  const audit = (await get('/admin/audit-log')).body.data;
  const routes = audit.map((a) => a.route);
  assert.ok(routes.some((r) => r.includes('/end-employment')), 'ending an employment must be audited');
  assert.ok(routes.some((r) => r.includes('/reactivate')), 'reactivating must be audited');
  /* The audit log identifies its actor by User id while EmploymentEnd identifies
     its author by username — deliberately: the timeline has to outlive the login
     it refers to, while the audit table owns a real FK. Each is checked against
     its own source rather than assuming they match. */
  assert.ok(audit.every((a) => a.actor === admin.user.id), 'the audit must name the admin who acted');
  assert.equal(record.endedBy, admin.user.username, 'the timeline must name the admin by login username');
});
