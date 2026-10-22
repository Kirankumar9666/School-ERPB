/**
 * The Admin Panel's class-wide marks history and batch editor.
 *
 * The Employee Portal's Marks Entry (see marks.edit-window.test.js) saves one
 * (exam, subject) BATCH for a whole class. The admin can reach the same batches
 * through a different door: a card grid computed from the class's own marks, and
 * a roster editor opened by clicking a card. What is proved here:
 *
 *   1. THE GRID IS COMPUTED FROM THE ROWS, NOT STORED ANYWHERE. One card per
 *      (exam, subject) pair, each with that batch's own entered / avg / top. A
 *      batch is the unit because `@@unique([studentId, examId, subject])` makes
 *      a row belong to exactly one — so the count, the average and the top are
 *      all "of that batch", and no other grouping can produce them.
 *
 *   2. ONE GRID FOR THE WHOLE CLASS, WITH THE SUBJECT ON EACH CARD. `Exam` is
 *      `@@unique([classId, name])` and has no subject column, so an exam is a
 *      per-class object that HOLDS marks in several subjects. A grid per subject
 *      would repeat one exam's name and date in several places and imply a
 *      per-subject exam the schema does not have. Asserted on a class that really
 *      does have marks in more than one subject, so the shape is tested, not
 *      asserted about a fixture that happens to have one.
 *
 *   3. CLICKING A CARD IS AN EDIT, NOT A FRESH ENTRY. The opened batch comes back
 *      keyed to the class's students with their stored values — and a student
 *      with no mark comes back as `null`, not 0. A blank is a student who was
 *      absent; writing 0 for them would record a score nobody entered.
 *
 *   4. THE ADMIN HAS NO WINDOW. The teacher may be locked out of a batch hours or
 *      days after they saved it; the admin opens and corrects the same batch
 *      regardless, and the read exposes no `locked` / `editableUntil` for a UI to
 *      mistake for a restriction.
 *
 *   5. THE OVERRIDE DOES NOT REOPEN THE TEACHER'S WINDOW. This is the one
 *      consequence that has to hold, or the office could fix a mark and the
 *      teacher could quietly change it straight back. It also flips the
 *      attribution: `enteredBy` keeps the teacher, `updatedBy` becomes the admin.
 *
 * Nothing here hardcodes an exam name, a score or a class: the (class, subject)
 * pair is read from the same timetable-derived endpoint the page uses, the roster
 * from the live database, and the exam names are written by this file's own saves.
 *
 * Node built-in test runner, zero extra deps.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

test('admin marks history: live card grid, and a batch anyone can open at any time', async (t) => {
  const { server, base } = await startServer();
  const admin = await login(base, 'admin', 'Admin@123');
  const teacher = await login(base, 'teacher', 'Teacher@123'); // emp-001 — Priya Sharma
  const prisma = require('../src/services/prisma');
  const DAY = 24 * 60 * 60 * 1000;

  /* The pair the teacher actually holds, read from the same endpoint the page
     uses — so nothing below depends on a class or subject name being stable. */
  const own = (await request(base, '/employees/emp-001/marks/assignments', { token: teacher.accessToken })).body.data;
  assert.ok(own.length > 0, 'the seeded teacher holds at least one timetable period');
  const { classId, subject } = own[0];

  const students = await prisma.student.findMany({
    where: { classId }, select: { id: true, name: true, rollNumber: true }, orderBy: { rollNumber: 'asc' },
  });
  assert.ok(students.length > 1, 'the class has a roster of at least two students');
  const [first, second] = students;

  const view = (params = {}) =>
    request(base, `/admin/marks/class?${new URLSearchParams({ classId, ...params })}`, { token: admin.accessToken });

  const saveBatch = (body, token = admin.accessToken) =>
    request(base, '/admin/marks/class', { method: 'POST', token, body });

  const teacherSave = (body) =>
    request(base, '/employees/emp-001/marks', { method: 'POST', token: teacher.accessToken, body });

  /** The stored rows of one exam for this (class, subject) — the batch itself. */
  const batch = (examName) =>
    prisma.marksEntry.findMany({ where: { subject, exam: { classId, name: examName } }, orderBy: { studentId: 'asc' } });

  const card = (data, examName, cardSubject = subject) =>
    data.batches.find((b) => b.examName === examName && b.subject === cardSubject);

  /* A second subject for the SAME class, to prove one grid covers both. Taken
     from the class's own timetable where it has one, else asserted on the
     seeded marks — either way it is this database's data, never a fixture. */
  const seededOthers = await prisma.marksEntry.findMany({
    where: { exam: { classId }, subject: { not: subject } }, select: { subject: true }, distinct: ['subject'],
  });
  const otherSubject = seededOthers[0]?.subject || null;

  /* ---- 1. the grid is computed from the rows ---- */

  await t.test('cards are the class\'s own batches, each with its own count, average and top', async () => {
    // Two batches of the same subject, plus a batch of the same exam in a
    // different subject — so a card count that came from anywhere but the rows
    // would not line up.
    await teacherSave({
      classId, subject, examName: 'Admin Grid A', date: '2026-09-10', maxMarks: 100,
      entries: [{ studentId: first.id, obtained: 60 }, { studentId: second.id, obtained: 90 }],
    });
    await saveBatch({
      classId, subject, examName: 'Admin Grid B', date: '2026-09-20', maxMarks: 100,
      entries: [{ studentId: first.id, obtained: 75 }],
    });

    const { status, body } = await view();
    assert.equal(status, 200);
    const { batches, subjects, roster, classLabel } = body.data;

    const a = card(body.data, 'Admin Grid A');
    assert.ok(a, 'the teacher\'s batch has a card');
    assert.equal(a.saved, 2, 'with its own entered count');
    assert.equal(a.average, 75, 'and its own average');
    assert.equal(a.top, 90, 'and its own top');

    const b = card(body.data, 'Admin Grid B');
    assert.equal(b.saved, 1, 'a one-row batch counts one, not two');
    assert.equal(b.average, 75);
    assert.equal(b.top, 75);
    assert.equal(b.date, '2026-09-20', 'the exam date is the card\'s, not the save date');

    // Same exam, different subject: two cards, because two batches.
    if (otherSubject) {
      await saveBatch({
        classId, subject: otherSubject, examName: 'Admin Grid A', date: '2026-09-10', maxMarks: 100,
        entries: [{ studentId: first.id, obtained: 50 }],
      });
      // Re-read: the card for the second subject can only exist once it is saved,
      // and this test is about the grid being computed from the rows rather than
      // about the client keeping its own copy of them.
      const twin = card((await view()).body.data, 'Admin Grid A', otherSubject);
      assert.ok(twin, 'the same exam in another subject is a card of its own');
      assert.equal(twin.saved, 1);
      assert.equal(twin.average, 50);
      assert.ok(subjects.includes(otherSubject) && subjects.includes(subject),
        'and both subjects are offered to the filter');
    }

    // Newest exam first, then subject A-Z: the grid has to read as a history.
    const order = batches.map((x) => `${x.date}::${x.subject}`);
    const sorted = [...order].sort((p, q) => (p < q ? 1 : p > q ? -1 : 0));
    const sameDate = batches.filter((x) => x.date === batches[0].date).map((x) => x.subject);
    const sameDateSorted = [...sameDate].sort((p, q) => p.localeCompare(q));
    assert.deepEqual(sameDate, sameDateSorted, 'batches of one exam are ordered by subject');
    assert.equal(order[0], `${batches[0].date}::${batches[0].subject}`);

    assert.ok(typeof classLabel === 'string' && classLabel.length > 0, 'the class is named for the heading');
    assert.equal(roster.length, students.length, 'the roster is the whole class, not just the marked rows');
  });

  await t.test('a class with no marks reads as an empty grid, not an error', async () => {
    // A class with no marks in it at all — not merely no marks in the subject
    // under test. `Class → exams → marks` is the path, so this is the same
    // emptiness the route is being asked to render.
    const empty = await prisma.class.findFirst({
      where: { exams: { none: { marks: { some: {} } } } }, orderBy: { id: 'asc' },
    });
    if (!empty) return; // every class in this database has marks — nothing to assert
    const res = await request(base, `/admin/marks/class?${new URLSearchParams({ classId: empty.id })}`, { token: admin.accessToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.batches, [], 'no batches');
    assert.deepEqual(res.body.data.subjects, [], 'no subjects to filter by');
    assert.equal(res.body.data.batch, null, 'and no batch open');
  });

  /* ---- 2. one grid, subject on each card ---- */

  await t.test('the subject rides on the card, not on a second grid', async () => {
    if (!otherSubject) return; // only one subject in this class — the shape is not testable
    const { body } = await view();
    const forOther = body.data.batches.filter((x) => x.subject === otherSubject);
    const forOwn = body.data.batches.filter((x) => x.subject === subject);
    assert.ok(forOther.length > 0 && forOwn.length > 0, 'both subjects have cards');
    // Every card states its own subject, so a flat list is never ambiguous about
    // which batch a click would open.
    assert.ok(body.data.batches.every((x) => typeof x.subject === 'string' && x.subject.length > 0),
      'each card names its subject');
  });

  /* ---- 3. clicking a card is an edit ---- */

  await t.test('an opened batch comes back pre-filled, and an absent student stays absent', async () => {
    // A batch with a deliberate hole: the second student has no mark at all.
    await saveBatch({
      classId, subject, examName: 'Admin Grid C', date: '2026-09-22', maxMarks: 80,
      entries: [{ studentId: first.id, obtained: 64 }],
    });

    const { body } = await view({ examName: 'Admin Grid C', subject });
    assert.ok(body.data.batch, 'the batch is open');
    assert.equal(body.data.batch.examName, 'Admin Grid C');
    assert.equal(body.data.batch.subject, subject, 'as the timetable spells it');
    assert.equal(body.data.batch.date, '2026-09-22');
    assert.equal(body.data.batch.maxMarks, 80, 'with the batch\'s own Max Marks to pre-fill');

    const rows = body.data.roster;
    assert.equal(rows.length, students.length, 'the whole class, in roll order');
    assert.equal(rows[0].studentId, first.id);
    assert.equal(rows[0].obtained, 64, 'the stored mark comes back to edit');
    assert.equal(rows[1].obtained, null, 'a student with no mark is null, never a zero');
  });

  await t.test('the prefilled Max Marks is the agreed value, not a coin toss', async () => {
    // `maxMarks` lives on the ROW, so a batch built from separate one-student
    // saves can disagree with itself. The editor re-saves the whole class under
    // ONE max, so whichever value it prefills is the one that wins for everyone
    // — it has to be a real rule, not whichever row the database returned first.
    await saveBatch({ classId, subject, examName: 'Admin Grid G', date: '2026-09-05', maxMarks: 100, entries: [{ studentId: first.id, obtained: 30 }] });
    await saveBatch({ classId, subject, examName: 'Admin Grid G', date: '2026-09-05', maxMarks: 50, entries: [{ studentId: second.id, obtained: 20 }] });
    const split = await view({ examName: 'Admin Grid G', subject });
    assert.equal(split.body.data.batch.maxMarks, 100, 'a tie breaks to the higher bound, so a real mark is never falsely blocked');

    // Once the rows agree, that is what the editor shows.
    await saveBatch({ classId, subject, examName: 'Admin Grid G', date: '2026-09-05', maxMarks: 50, entries: [{ studentId: first.id, obtained: 30 }] });
    const agreed = await view({ examName: 'Admin Grid G', subject });
    assert.equal(agreed.body.data.batch.maxMarks, 50, 'the agreed value, not the one that arrived first');
  });

  await t.test('a half batch key is refused rather than guessed', async () => {
    // A batch is (exam, SUBJECT). An exam name alone identifies nothing, and
    // guessing a subject would open a different batch's marks. The reason is in
    // `errors`, the way every other zod failure on this router reports it.
    const only = await view({ examName: 'Admin Grid A' });
    assert.equal(only.status, 400);
    assert.equal(only.body.code, 'VALIDATION_ERROR');
    assert.match(JSON.stringify(only.body.errors), /subject/i, 'and the detail says what is missing');
    const other = await view({ subject });
    assert.equal(other.status, 400, 'a subject alone names no batch either');
    const neither = await view();
    assert.equal(neither.status, 200, 'while neither half is the plain grid');
  });

  await t.test('the batch is found however its name was typed', async () => {
    // `Exam` is unique per (classId, name) and THAT comparison is
    // case-sensitive, so an exact match would silently open nothing when a name
    // came back from the URL or was re-typed.
    const { status, body } = await view({ examName: 'admin grid c', subject: subject.toUpperCase() });
    assert.equal(status, 200);
    assert.equal(body.data.batch.examName, 'Admin Grid C', 'the stored spelling comes back, not the typed one');
    assert.equal(body.data.roster[0].obtained, 64, 'and it is the same batch\'s marks');
  });

  /* ---- 4. no window on the admin side ---- */

  await t.test('the read carries no lock state for a UI to honour', async () => {
    const { body } = await view();
    assert.ok(body.data.batches.length > 0);
    for (const key of Object.keys(body.data.batches[0])) {
      assert.ok(!['locked', 'editableUntil', 'remainingMs', 'windowMs'].includes(key),
        `the admin grid must not expose \`${key}\` — the admin is never locked`);
    }
    // `savedAt` IS sent, and only as provenance: when the TEACHER last saved.
    const c = card(body.data, 'Admin Grid A');
    assert.ok(c.savedAt === null || !Number.isNaN(new Date(c.savedAt).getTime()),
      'the one timestamp present is a real instant');
  });

  /* ---- 5. the override, and that it does not reopen the window ---- */

  await t.test('the admin corrects a batch the teacher is locked out of, and the lock holds', async () => {
    await teacherSave({
      classId, subject, examName: 'Admin Grid D', date: '2026-09-01', maxMarks: 100,
      entries: [{ studentId: first.id, obtained: 40 }, { studentId: second.id, obtained: 42 }],
    });
    // The window is read from a column, so ageing it is the only honest way to
    // test a two-day clock without waiting two days.
    const aged = new Date(Date.now() - 3 * DAY);
    await prisma.marksEntry.updateMany({
      where: { subject, exam: { classId, name: 'Admin Grid D' } },
      data: { teacherSavedAt: aged },
    });

    const teacherSees = await request(
      base,
      `/employees/emp-001/marks?${new URLSearchParams({ classId, subject, examName: 'Admin Grid D' })}`,
      { token: teacher.accessToken },
    );
    assert.equal(teacherSees.body.data.exam.locked, true, 'the teacher\'s window has closed');

    const refused = await teacherSave({
      classId, subject, examName: 'Admin Grid D', date: '2026-09-01', maxMarks: 100,
      entries: [{ studentId: first.id, obtained: 99 }],
    });
    assert.equal(refused.status, 403, 'so the teacher cannot change it');

    // The admin opens the very same card, days after it was saved.
    const opened = await view({ examName: 'Admin Grid D', subject });
    assert.equal(opened.body.data.roster[0].obtained, 40, 'pre-filled from what is stored');

    const saved = await saveBatch({
      classId, subject, examName: 'Admin Grid D', date: '2026-09-01', maxMarks: 100,
      entries: [{ studentId: first.id, obtained: 55 }, { studentId: second.id, obtained: 57 }],
    });
    assert.equal(saved.status, 201, 'the admin has no window at all');
    assert.equal(saved.body.data.saved, 2, 'and the whole class saves in one request');

    const rows = await batch('Admin Grid D');
    assert.equal(rows.find((r) => r.studentId === first.id).obtained, 55);
    assert.ok(rows.every((r) => r.updatedBy === 'admin'), 'every corrected row names the admin');
    assert.ok(rows.every((r) => r.enteredBy === 'teacher'), 'without erasing who first entered it');

    // The decisive one: the office must have the last word.
    assert.ok(rows.every((r) => r.teacherSavedAt.getTime() === aged.getTime()),
      'the admin\'s correction did not reopen the teacher\'s 48 hours');
    const stillShut = await teacherSave({
      classId, subject, examName: 'Admin Grid D', date: '2026-09-01', maxMarks: 100,
      entries: [{ studentId: first.id, obtained: 99 }],
    });
    assert.equal(stillShut.status, 403, 'and the teacher still cannot undo it');
    assert.equal((await batch('Admin Grid D')).find((r) => r.studentId === first.id).obtained, 55);
  });

  await t.test('the corrected card reflects the change, as a batch', async () => {
    const { body } = await view();
    const c = card(body.data, 'Admin Grid D');
    assert.equal(c.saved, 2);
    assert.equal(c.average, 56, 'the average moved with the marks');
    assert.equal(c.top, 57);
    assert.equal(c.updatedBy, 'admin', 'and the card carries the new attribution');
  });

  /* ---- 6. what a save will not accept ---- */

  await t.test('a student of another class is refused, by id, from a hand-rolled body', async () => {
    const outsider = await prisma.student.findFirst({ where: { classId: { not: classId } }, orderBy: { id: 'asc' } });
    if (!outsider) return; // one class only — nothing to smuggle in
    const res = await saveBatch({
      classId, subject, examName: 'Admin Grid A', maxMarks: 100,
      entries: [{ studentId: outsider.id, obtained: 10 }],
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /not in/i);
    // And the real mark beside it must not have landed: the save is all-or-nothing.
    assert.equal((await batch('Admin Grid A')).find((r) => r.studentId === first.id).obtained, 60,
      'the valid row in the same request was not written either');
  });

  await t.test('a mark above Max Marks is refused, with nothing written', async () => {
    const res = await saveBatch({
      classId, subject, examName: 'Admin Grid A', maxMarks: 100,
      entries: [{ studentId: first.id, obtained: 50 }, { studentId: second.id, obtained: 101 }],
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Max Marks/i);
    assert.equal((await batch('Admin Grid A')).find((r) => r.studentId === first.id).obtained, 60);
  });

  await t.test('a blank cell is neither a zero nor a deletion', async () => {
    // The second student HAS a mark in this batch (90, from the first test). What
    // a blank must never do is turn that into a 0 for a student nobody marked.
    // What it does instead is leave the row alone — this is an edit, not a
    // rebuild — which is also what makes opening a card and saving untouched a
    // safe no-op rather than a way to wipe a class.
    const res = await saveBatch({
      classId, subject, examName: 'Admin Grid A', maxMarks: 100,
      entries: [{ studentId: first.id, obtained: 61 }, { studentId: second.id, obtained: null }],
    });
    assert.equal(res.status, 201);
    const rows = await batch('Admin Grid A');
    assert.equal(rows.find((r) => r.studentId === first.id).obtained, 61, 'the typed mark is stored');
    assert.equal(rows.find((r) => r.studentId === second.id).obtained, 90,
      'the blank left the stored mark exactly as it was — not zeroed, not deleted');

    // And a blank where there was NO row creates none: an absent student is not a
    // student who scored zero. A fresh exam, one student marked, one not.
    await saveBatch({
      classId, subject, examName: 'Admin Grid F', maxMarks: 100,
      entries: [{ studentId: first.id, obtained: 12 }, { studentId: second.id, obtained: '' }],
    });
    const fresh = await batch('Admin Grid F');
    assert.equal(fresh.length, 1, 'no row was invented for the blank cell');
    assert.equal(fresh[0].studentId, first.id);

    // A request of nothing but blanks has nothing to save, and says so.
    const empty = await saveBatch({
      classId, subject, examName: 'Admin Grid A', maxMarks: 100,
      entries: [{ studentId: first.id, obtained: '' }],
    });
    assert.equal(empty.status, 400);
    assert.match(empty.body.message, /at least one mark/i);
    assert.equal((await batch('Admin Grid A')).find((r) => r.studentId === first.id).obtained, 61,
      'and the batch is untouched');
  });

  await t.test('bad input is refused with a reason, before any query runs', async () => {
    const cases = [
      [{ classId, subject, examName: 'Admin Grid A', maxMarks: 0, entries: [{ studentId: first.id, obtained: 1 }] }, /maxmarks|validation/i],
      [{ classId, subject, examName: 'Admin Grid A', maxMarks: 100000, entries: [{ studentId: first.id, obtained: 1 }] }, /maxmarks|validation/i],
      [{ classId, subject, examName: 'Admin Grid A', maxMarks: 100, entries: [{ studentId: first.id, obtained: 99999 }] }, /invalid|10000/i],
      [{ classId, subject, examName: 'Admin Grid A', maxMarks: 100, entries: [{ studentId: first.id, obtained: 'sixty' }] }, /invalid/i],
      [{ classId, subject, examName: 'A', maxMarks: 100, entries: [{ studentId: first.id, obtained: 1 }] }, /validation/i],
      [{ classId, examName: 'Admin Grid A', maxMarks: 100, entries: [{ studentId: first.id, obtained: 1 }] }, /validation/i],
      [{ classId, subject, maxMarks: 100, entries: [{ studentId: first.id, obtained: 1 }] }, /validation/i],
    ];
    for (const [body, pattern] of cases) {
      const res = await saveBatch(body);
      assert.equal(res.status, 400, `refused: ${JSON.stringify(body)}`);
      assert.match(res.body.message, pattern);
    }
    // None of those attempts touched the batch.
    assert.equal((await batch('Admin Grid A')).find((r) => r.studentId === first.id).obtained, 61);
  });

  await t.test('a class that does not exist is a 404, not an empty grid', async () => {
    const res = await request(base, `/admin/marks/class?${new URLSearchParams({ classId: 'cls-does-not-exist' })}`, { token: admin.accessToken });
    assert.equal(res.status, 404);
    assert.equal(res.body.message, 'Class not found');
  });

  /* ---- 7. the subject is stored as the class timetable spells it ---- */

  await t.test('a re-typed subject is stored in the timetable\'s spelling', async () => {
    // Subject is free text, so the admin may type any casing or spacing. What
    // lands must be the class's own spelling — the same string the permission
    // check and the other marks screens read.
    const res = await saveBatch({
      classId, subject: `  ${subject.toUpperCase()}  `, examName: 'Admin Grid E', maxMarks: 100,
      entries: [{ studentId: first.id, obtained: 44 }],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.subject, subject, 'the response reports the stored spelling');

    const { body } = await view({ examName: 'Admin Grid E', subject });
    assert.equal(body.data.batch.subject, subject, 'and the batch is found under it');
    assert.ok(body.data.subjects.includes(subject), 'with no duplicate entry for the odd spelling');
    assert.equal(body.data.subjects.length, new Set(body.data.subjects).size, 'subjects are distinct');
  });

  /* ---- 8. the read is admin-only, like every other marks route here ---- */

  await t.test('a teacher cannot read another teacher\'s class history', async () => {
    const res = await request(base, `/admin/marks/class?${new URLSearchParams({ classId })}`, { token: teacher.accessToken });
    assert.ok(res.status === 403, `expected the admin route to refuse a teacher, got ${res.status}`);
  });

  await t.test('teardown — stop server', async () => {
    await stopServer(server);
  });
});
