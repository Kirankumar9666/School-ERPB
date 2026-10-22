/**
 * The teacher's 48-hour Marks Entry edit window.
 *
 * The rule: marks a teacher saves stay correctable BY THAT TEACHER for two days,
 * and after that only the Admin Panel can change them. What is proved here:
 *
 *   1. IT IS CLOCKED FROM A REAL SAVE TIME, ON THE BATCH, NOT ON A ROW AND NOT ON
 *      A FLAG. Each save records `teacherSavedAt`; the read reports that instant
 *      back so the page can count down from it, and the whole (class, subject,
 *      exam) batch locks as one unit even when a save covered only one student.
 *
 *   2. IT IS ENFORCED BY THE SERVER. A save after the window is refused with
 *      403 EDIT_LOCKED and writes nothing at all — not the marks, and not even
 *      the exam's date. The tests here never open a page: they post straight to
 *      the API with a hand-built body, because a rule that only the UI enforces
 *      is not a rule.
 *
 *   3. THE ADMIN IS THE WAY OUT, AND THE OVERRIDE IS FINAL. An admin can still
 *      change a locked batch at any time, the change is attributed to them, and
 *      it does NOT reopen the teacher's window — otherwise the office could fix a
 *      mark and the teacher could quietly change it straight back, which is the
 *      opposite of the rule.
 *
 * Elapsed time is simulated by writing `teacherSavedAt` in the past, which is
 * the only honest way to test a two-day clock without waiting two days: the
 * window is read from the column, not from a counter in the code. The one place
 * the exact boundary cannot be reached through the API is checked on
 * `marksEditWindow` itself, with an injected "now" so it is exact rather than
 * approximate.
 *
 * Node built-in test runner, zero extra deps.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request, auth } = require('./helpers');
const { marksEditWindow, MARKS_TEACHER_EDIT_WINDOW_MS } = require('../src/services/marks');

/** The teacher's upload header — no Class, no Subject. */
const TEACHER_HEADER = 'RollNumber,StudentName,ExamName,ExamDate,MaxMarks,ObtainedMarks';

test('marks edit window: 48 hours for the teacher, always for the admin', async (t) => {
  const { server, base } = await startServer();
  const admin = await login(base, 'admin', 'Admin@123');
  const teacher = await login(base, 'teacher', 'Teacher@123'); // emp-001 — Priya Sharma

  const prisma = require('../src/services/prisma');
  const DAY = 24 * 60 * 60 * 1000;

  /* Nothing below is hardcoded: the (class, subject) pair comes from the same
     timetable-derived endpoint the page uses, and the roster is read live. */
  const own = (await request(base, '/employees/emp-001/marks/assignments', { token: teacher.accessToken })).body.data;
  assert.ok(own.length > 0, 'the seeded teacher holds at least one timetable period');
  const { classId, subject, classLabel } = own[0];

  const students = await prisma.student.findMany({
    where: { classId }, select: { id: true, name: true, rollNumber: true }, orderBy: { rollNumber: 'asc' },
  });
  assert.ok(students.length > 1, 'the class has a roster of at least two students');
  const [first, second] = students;

  const grid = (examName, token = teacher.accessToken) =>
    request(base, `/employees/emp-001/marks?${new URLSearchParams({ classId, subject, ...(examName ? { examName } : {}) })}`, { token });

  const save = (body, token = teacher.accessToken) =>
    request(base, '/employees/emp-001/marks', { method: 'POST', token, body });

  const adminSave = (studentId, examName, obtained, token = admin.accessToken) =>
    request(base, '/admin/marks', {
      method: 'POST',
      token,
      body: {
        studentId, examName, date: '2026-09-29',
        subjects: [{ subject, maxMarks: 100, obtained }],
      },
    });

  const upload = (buffer, filename, token = teacher.accessToken) => {
    const fd = new FormData();
    fd.append('file', new Blob([buffer], { type: 'text/csv' }), filename);
    fd.append('classId', classId);
    fd.append('subject', subject);
    return fetch(`${base}/employees/emp-001/marks/bulk`, {
      method: 'POST', headers: auth(token), body: fd,
    }).then(async (res) => ({ status: res.status, body: JSON.parse((await res.text()) || '{}') }));
  };

  /** The rows of one exam for this (class, subject) — the batch itself. */
  const batch = (examName) =>
    prisma.marksEntry.findMany({ where: { subject, exam: { classId, name: examName } }, orderBy: { studentId: 'asc' } });

  /** Move a whole batch's teacher clock `ms` into the past. */
  const ageBatch = (examName, ms) =>
    prisma.marksEntry.updateMany({
      where: { subject, exam: { classId, name: examName } },
      data: { teacherSavedAt: new Date(Date.now() - ms) },
    });

  /** Teacher save of the given marks, one attempt. */
  const saveMarks = (examName, entries, date = '2026-09-29') =>
    save({ classId, subject, examName, date, maxMarks: 100, entries });

  /* ---- 1. a save stamps the batch's real clock ---- */

  await t.test('a teacher save records the save time and the read reports it back', async () => {
    const before = Date.now();
    const res = await saveMarks('Window Fresh', [
      { studentId: first.id, obtained: 71 },
      { studentId: second.id, obtained: 62 },
    ]);
    assert.equal(res.status, 201);
    assert.ok(Date.now() - before < 60000, 'the save really happened just now');

    // The window is echoed as data derived from that instant — not as a duration
    // the client is expected to trust, and not as a flag with no timestamp.
    assert.ok(res.body.data.savedAt, 'the save response carries the instant it stamped');
    const { savedAt, locked, remainingMs, windowMs, editableUntil } = res.body.data;
    assert.equal(locked, false, 'a batch just saved is open');
    assert.equal(windowMs, 48 * 60 * 60 * 1000, 'the window is 48 hours, as stated');
    assert.ok(remainingMs > 47.5 * 60 * 60 * 1000, 'and essentially all of it is still ahead');
    assert.equal(new Date(editableUntil).getTime(), new Date(savedAt).getTime() + MARKS_TEACHER_EDIT_WINDOW_MS,
      'the deadline is the save time plus the window — both real values');

    // And it is stored, on every row of the batch, so the read has something to
    // count from after a reload.
    const rows = await batch('Window Fresh');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.teacherSavedAt instanceof Date), 'every row of the batch carries a real timestamp');

    // The grid agrees with the save response, which is what makes a page reload
    // show the same countdown rather than restarting it.
    const read = await grid('Window Fresh');
    assert.equal(read.status, 200);
    assert.equal(read.body.data.exam.savedAt, savedAt, 'the open exam reports the same anchor');
    assert.equal(read.body.data.exam.locked, false);
    assert.equal(read.body.data.exam.windowMs, 48 * 60 * 60 * 1000);

    const summary = read.body.data.exams.find((e) => e.examName === 'Window Fresh');
    assert.ok(summary, 'the batch is listed under already-saved');
    assert.equal(summary.savedAt, savedAt, 'with the same anchor as the open exam');
    assert.equal(summary.locked, false);
  });

  await t.test('the same anchor is reported whatever the subject was typed as', async () => {
    // A differently-cased name resolves to the same exam, so it must not report a
    // different (or absent) window — a countdown that restarts on a re-typed name
    // would be a way to dodge the rule by spelling it differently.
    const read = await grid('window fresh');
    assert.equal(read.body.data.exam.savedAt, (await grid('Window Fresh')).body.data.exam.savedAt);
  });

  /* ---- 2. the window is per batch, and a re-save refreshes all of it ---- */

  await t.test('the window is the batch, not the student row', async () => {
    // Age the whole batch to 40 hours ago — two hours from locking.
    await ageBatch('Window Fresh', 40 * 60 * 60 * 1000);
    assert.equal((await grid('Window Fresh')).body.data.exam.locked, false, 'still open at 40 hours');

    // Correct ONE student. A teacher saves a batch, so the correction refreshes
    // the batch even though only one row's column moves: the anchor is the newest
    // teacher save anywhere in the group, not a row's own timestamp. A per-row
    // window would leave the rest of the class locked, and half an editable class
    // is not a rule anybody can act on.
    const res = await saveMarks('Window Fresh', [{ studentId: second.id, obtained: 65 }]);
    assert.equal(res.status, 201, 'the teacher may still correct the batch');
    assert.equal(res.body.data.locked, false);

    const rows = await batch('Window Fresh');
    const read = await grid('Window Fresh');
    assert.equal(read.body.data.exam.locked, false, 'the batch is open again');
    assert.equal(read.body.data.exam.savedAt, rows.find((r) => r.studentId === second.id).teacherSavedAt.toISOString(),
      'and the anchor it reports is that newest save — the one row that actually moved');

    // The proof that the batch, not the row, is what governs: age ONE row far
    // past the window on its own, then save naming only that student.
    await prisma.marksEntry.update({
      where: { id: rows.find((r) => r.studentId === first.id).id },
      data: { teacherSavedAt: new Date(Date.now() - 70 * 60 * 60 * 1000) },
    });
    const other = await saveMarks('Window Fresh', [{ studentId: first.id, obtained: 74 }]);
    assert.equal(other.status, 201,
      'a row 70 hours old is still editable, because the batch it belongs to was saved moments ago');
    assert.equal((await batch('Window Fresh')).find((r) => r.studentId === first.id).obtained, 74);
  });

  /* ---- 3. after 48 hours the save is refused ---- */

  await t.test('the exact boundary is 48 hours, measured from the last teacher save', () => {
    // Checked on the shared rule with an injected clock, because reaching
    // "exactly zero remaining" through the API would need the database write and
    // the request to land in the same millisecond. Both sides use this function.
    const savedAt = new Date('2026-09-29T10:00:00.000Z');
    const at = (iso) => marksEditWindow(savedAt, new Date(iso).getTime());

    assert.equal(at('2026-10-01T10:00:00.000Z').locked, true, 'past the window it is closed');
    assert.equal(marksEditWindow(savedAt, savedAt.getTime() + MARKS_TEACHER_EDIT_WINDOW_MS).locked, true,
      'at exactly 48 hours it is closed — the window is 48 hours long, not "just under"');
    assert.equal(marksEditWindow(savedAt, savedAt.getTime() + MARKS_TEACHER_EDIT_WINDOW_MS - 1).locked, false,
      'one millisecond before that it is still open');
    assert.equal(at('2026-09-29T12:00:00.000Z').remainingMs, 46 * 60 * 60 * 1000, 'remaining is the real difference');

    // A closed window reports zero, never a negative: there is nothing left to
    // count, and callers must not each have to clamp it.

    // No anchor at all means no window: a marks set only the office entered has
    // no teacher save to count down from.
    const noSave = marksEditWindow(null, Date.now());
    assert.deepEqual(
      { locked: noSave.locked, remainingMs: noSave.remainingMs, savedAt: noSave.savedAt },
      { locked: false, remainingMs: null, savedAt: null },
      'an unsaved batch is open, with no countdown rather than an invented one',
    );
  });

  await t.test('49 hours on, the save is refused and nothing is written', async () => {
    await ageBatch('Window Fresh', 49 * 60 * 60 * 1000);
    const before = await batch('Window Fresh');

    const res = await saveMarks('Window Fresh', [
      { studentId: first.id, obtained: 99 },
      { studentId: second.id, obtained: 99 },
    ]);
    assert.equal(res.status, 403, 'a save past the window is refused');
    assert.equal(res.body.code, 'EDIT_LOCKED', 'with the same code the attendance window uses');
    assert.match(res.body.message, /2-day edit window/i);
    assert.match(res.body.message, /Window Fresh/, 'naming the exam that is closed');
    assert.match(res.body.message, /admin/i, 'and saying who can still change it');

    const after = await batch('Window Fresh');
    assert.deepEqual(after.map((r) => r.obtained), before.map((r) => r.obtained), 'not one mark changed');
    assert.deepEqual(after.map((r) => r.teacherSavedAt?.getTime()), before.map((r) => r.teacherSavedAt?.getTime()),
      'and the clock was not quietly pushed forward by the attempt');

    // The read still works, and still returns the marks — a locked batch is
    // read-only, not hidden.
    const read = await grid('Window Fresh');
    assert.equal(read.status, 200);
    assert.equal(read.body.data.exam.locked, true, 'the page is told it is locked');
    assert.equal(read.body.data.exam.remainingMs, 0);
    assert.equal(read.body.data.roster.find((s) => s.studentId === first.id).obtained, before[0].obtained,
      'and the values are still there to show');
  });

  await t.test('47 hours on, the very same save succeeds', async () => {
    // The mirror of the test above, so the refusal cannot be a blanket ban on
    // re-saving this exam.
    await ageBatch('Window Fresh', 47 * 60 * 60 * 1000);
    const res = await saveMarks('Window Fresh', [{ studentId: first.id, obtained: 73 }]);
    assert.equal(res.status, 201, 'a minute inside the window is still the teacher\'s to change');
    assert.equal(res.body.data.locked, false);
    assert.equal((await batch('Window Fresh')).find((r) => r.studentId === first.id).obtained, 73);

    // Put it back past the window for the tests that follow.
    await ageBatch('Window Fresh', 49 * 60 * 60 * 1000);
  });

  await t.test('a refused save does not touch the exam either', async () => {
    const exam = await prisma.exam.findFirst({ where: { classId, name: 'Window Fresh' } });
    const dateBefore = exam.date.toISOString();

    // The exam's date is part of what a save writes, so it has to obey the same
    // window — otherwise a refused request still changes the record.
    const res = await save({ classId, subject, examName: 'Window Fresh', date: '2026-01-01', maxMarks: 100, entries: [{ studentId: first.id, obtained: 5 }] });
    assert.equal(res.status, 403);
    const after = await prisma.exam.findUnique({ where: { id: exam.id } });
    assert.equal(after.date.toISOString(), dateBefore, 'the exam kept its own date');
  });

  await t.test('a different exam for the same class and subject is unaffected', async () => {
    // The window is per batch. A locked one must not lock the subject for the
    // rest of the term.
    const res = await saveMarks('Window Another', [{ studentId: first.id, obtained: 55 }]);
    assert.equal(res.status, 201, 'a fresh exam in the same class and subject is still enterable');
    assert.equal((await batch('Window Another'))[0].teacherSavedAt instanceof Date, true);
  });

  /* ---- 4. the bulk upload is the same save, so the same window ---- */

  await t.test('bulk upload obeys the same window, per exam in the file', async () => {
    const csvFor = (examName, obtained) => [
      TEACHER_HEADER,
      ...students.map((s) => `${s.rollNumber},${s.name},${examName},29-09-2026,100,${obtained}`),
    ].join('\r\n');

    // A file naming the closed exam: refused whole, exactly like a bad row.
    const closed = await upload(csvFor('Window Fresh', 88), 'closed.csv');
    assert.equal(closed.status, 403, 'the upload is refused, not partially applied');
    assert.equal(closed.body.code, 'EDIT_LOCKED');
    assert.match(closed.body.message, /Window Fresh/);
    assert.ok((await batch('Window Fresh')).every((r) => r.obtained !== 88), 'no row took the file\'s values');

    // A file naming a fresh exam: unaffected, because the window is per batch.
    const open = await upload(csvFor('Window Bulk Fresh', 41), 'open.csv');
    assert.equal(open.status, 201);
    assert.ok((await batch('Window Bulk Fresh')).every((r) => r.obtained === 41 && r.teacherSavedAt instanceof Date),
      'and it is stamped like any other teacher save');

    // A file mixing a closed exam with a fresh one is refused entirely — the
    // route's existing "one bad row saves nothing" contract, unchanged. One
    // header, then rows for both exams: the closed one is what fails the save.
    const mixedCsv = [
      TEACHER_HEADER,
      ...students.map((s) => `${s.rollNumber},${s.name},Window Bulk Fresh,29-09-2026,100,42`),
      `${first.rollNumber},${first.name},Window Fresh,29-09-2026,100,90`,
    ].join('\r\n');
    const mixed = await upload(mixedCsv, 'mixed.csv');
    assert.equal(mixed.status, 403, 'one closed exam in the file refuses the whole upload');
    assert.equal(mixed.body.code, 'EDIT_LOCKED');
    assert.ok((await batch('Window Bulk Fresh')).every((r) => r.obtained === 41), 'the fresh rows were not written either');
  });

  /* ---- 5. the admin override, and why it is final ---- */

  await t.test('the admin can still change a locked batch, and it is attributed to them', async () => {
    const lockedAt = (await batch('Window Fresh')).map((r) => r.teacherSavedAt.getTime());

    const res = await adminSave(first.id, 'Window Fresh', 91);
    assert.equal(res.status, 201, 'the admin has no window at all');

    const row = (await batch('Window Fresh')).find((r) => r.studentId === first.id);
    assert.equal(row.obtained, 91, 'the admin\'s value is stored');
    assert.equal(row.updatedBy, 'admin', 'and recorded as a change by the admin');
    assert.ok(row.updatedAt instanceof Date, 'with the time of that change');

    // The teacher is still locked out. If the admin's write had refreshed the
    // window, the office could never have the last word.
    assert.deepEqual((await batch('Window Fresh')).map((r) => r.teacherSavedAt.getTime()), lockedAt,
      'the admin\'s correction did not reopen the teacher\'s 48 hours');
    const retried = await saveMarks('Window Fresh', [{ studentId: first.id, obtained: 99 }]);
    assert.equal(retried.status, 403, 'and the teacher still cannot undo it');
    assert.equal((await batch('Window Fresh')).find((r) => r.studentId === first.id).obtained, 91);
  });

  await t.test('the admin\'s own read shows the change as theirs', async () => {
    // The "LAST CHANGED BY" attribution has to follow the override, or the record
    // of who did what is exactly the stale history this window exists to protect.
    const byStudent = (await request(base, `/admin/marks?classId=${classId}`, { token: admin.accessToken })).body.data;
    const seen = Object.entries(byStudent)
      .flatMap(([studentId, exams]) => exams
        .filter((e) => e.examName === 'Window Fresh')
        .flatMap((e) => e.subjects.filter((s) => s.subject === subject).map((s) => ({ studentId, ...s }))));
    assert.equal(seen.length, students.length, 'the whole batch is readable from the admin side');

    assert.ok(seen.every((r) => r.enteredBy === 'teacher'), 'who first entered it is not erased');
    const changed = seen.find((r) => r.studentId === first.id);
    assert.equal(changed.updatedBy, 'admin', 'and who last changed it is the admin');
    assert.ok(seen.filter((r) => r.studentId !== first.id).every((r) => r.updatedBy === 'teacher'),
      'the rows nobody overrode still name the teacher');
  });

  /* ---- 6. batches with no teacher save ---- */

  await t.test('a batch only the office entered has no teacher window', async () => {
    // The teacher is entering marks here, not correcting anyone's — including not
    // correcting the office's. A window that started on an admin save would lock
    // a teacher out of work they have never done.
    const created = await adminSave(first.id, 'Window Office Only', 30);
    assert.equal(created.status, 201);

    const stored = (await batch('Window Office Only')).find((r) => r.studentId === first.id);
    assert.equal(stored.enteredBy, 'admin');
    assert.equal(stored.teacherSavedAt, null, 'an admin save does not start a teacher clock');

    const read = await grid('Window Office Only');
    assert.equal(read.body.data.exam.locked, false, 'so the teacher finds it open');
    assert.equal(read.body.data.exam.savedAt, null, 'with no countdown to show');
    assert.equal(read.body.data.exams.find((e) => e.examName === 'Window Office Only').remainingMs, null,
      'and no invented countdown on the card either');

    const res = await saveMarks('Window Office Only', [{ studentId: first.id, obtained: 34 }]);
    assert.equal(res.status, 201, 'the teacher may enter it');
    assert.ok((await batch('Window Office Only')).every((r) => r.teacherSavedAt instanceof Date),
      'and doing so starts their clock');
  });

  await t.test('marks saved before this column existed are open, not locked', async () => {
    // The seeded marks predate `teacherSavedAt`, so there is no recorded save
    // time to count from. Reading them as "expired" would lock every teacher out
    // of the entire back catalogue on the strength of a guess.
    const seeded = await prisma.marksEntry.findFirst({
      where: { subject, teacherSavedAt: null, exam: { classId, name: { not: 'Window Fresh' } } },
      include: { exam: { select: { name: true } } },
      orderBy: { examId: 'asc' },
    });
    if (!seeded) return; // this class/subject has no seeded marks — nothing to assert
    assert.equal(seeded.teacherSavedAt, null);
    const read = await grid(seeded.exam.name);
    assert.equal(read.body.data.exam.locked, false, 'a mark with no recorded save time is editable');
  });

  await t.test('the window belongs to the marks, not to attendance', async () => {
    // The attendance feature keeps its own 1-hour confirmation window. A change
    // here must not quietly move that one, so its constant is asserted intact.
    const { ATTENDANCE_EDIT_WINDOW_MS } = require('../src/services/attendance');
    assert.equal(ATTENDANCE_EDIT_WINDOW_MS, 60 * 60 * 1000, 'attendance still uses one hour');
    assert.equal(MARKS_TEACHER_EDIT_WINDOW_MS, 2 * DAY, 'marks use two days');
    assert.notEqual(MARKS_TEACHER_EDIT_WINDOW_MS, ATTENDANCE_EDIT_WINDOW_MS, 'and they are separate constants');
  });

  await t.test('teardown — stop server', async () => {
    await stopServer(server);
  });
});
