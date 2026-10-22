/**
 * Chosen promotion targets — the admin picks the academic YEAR and the CLASS.
 *
 * Step 1 of the promotion improvement: the move endpoints (`promote` for one
 * student, `promote` for a whole class, `keep` to repeat a year) may now be told
 * WHERE to go instead of only accepting an action name. This file is written
 * against the HTTP API on purpose, because the rules that matter live at that
 * boundary: the schema that carries the choice, the mapping of a domain error to a
 * status, and whether OMITTING the choice still behaves exactly as it always did.
 *
 * ## Every test builds its OWN class
 *
 * Tests share one seeded database and run in order, so a test that reuses a class
 * another test has already promoted into is reading state it did not create —
 * which is how a stale query comes to look like a broken rule. Each test therefore
 * creates a class of its own (from the level list, never a name typed here) and
 * only ever looks at that class. Nothing a later test does can change an earlier
 * one's answer.
 *
 * ## What the roster means, and what it does NOT
 *
 * A year's roster lists the SEATS for that year, whatever their status. Promoting
 * a child CLOSES their old seat (it is that year's register, kept on purpose) — so
 * a promoted child still appears in the OLD year's roster, with status `promoted`.
 * To ask "did this child leave the class", read the child's current class pointer
 * (`/admin/students`), which is what "in this class now" actually means.
 *
 * ## Defaults must not move
 *
 * The most important assertion here is the negative one: a request body with no
 * year and no class must produce the SAME target it did before this feature
 * existed — the next year in the calendar and the next class in the level chain.
 * Every "chosen" test is written beside its "omitted" twin.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');
const prisma = require('../src/services/prisma');

let server;
let base;
let token;

/* Read from the API in `before`; stable for the whole run. */
let years; // every academic year, from /class-management/years
let currentYear;
let levels; // every grade level, from /school/options

before(async () => {
  ({ server, base } = await startServer());
  token = (await login(base, 'admin', 'Admin@123')).accessToken;

  const overview = (await request(base, '/admin/class-management/overview', { token })).body.data;
  years = (await request(base, '/admin/class-management/years', { token })).body.data;
  levels = (await request(base, '/school/options', { token })).body.data.levels;

  currentYear = overview.currentAcademicYear;
  assert.ok(currentYear, 'a current academic year must exist');
  assert.ok(levels.length > 0, 'the seed must leave grade levels');
});

after(async () => { await stopServer(server); });

const get = (path) => request(base, path, { token });
const post = (path, body) => request(base, path, { method: 'POST', token, body });

/** Years that start strictly after the current one, oldest first. */
const laterYears = () => years
  .filter((y) => y.startDate > currentYear.startDate)
  .sort((a, b) => a.startDate.localeCompare(b.startDate));

/* A level that is NOT the top one, so its class can be promoted. Derived from the
   level list by order, never a name written down here. */
const promotableLevel = () => {
  const ascending = [...levels].sort((a, b) => a.order - b.order);
  return ascending[Math.floor(ascending.length / 2)];
};

/* Unique sections within this file, so two tests can never ask for the same class
   row — "the class this test made" is then unambiguous. Two letters, as the schema
   requires (letters only, no digits). */
let sectionSeq = 0;
const nextSection = () => {
  sectionSeq += 1;
  const n = sectionSeq - 1;
  return String.fromCharCode(65 + Math.floor(n / 26)) + String.fromCharCode(65 + (n % 26));
};

/** Create a fresh class on a promotable level. Its own, so no test shares one. */
const makeClass = async () => {
  const level = promotableLevel();
  const res = await post('/admin/classes', { levelId: level.id, section: nextSection() });
  assert.equal(res.status, 201, `creating a class should succeed: ${JSON.stringify(res.body)}`);
  return res.body.data;
};

/** A phone number that is unique across this file's run, so no two students collide. */
let phoneCounter = 9000000000;
const uniquePhone = () => String((phoneCounter += 7));

/**
 * Create one isolated student in `classId`, with a full identity triple so the
 * duplicate rule and the promotion review both accept them without a human.
 */
const makeStudent = async (classId, tag) => {
  const res = await post('/admin/students', {
    name: `${tag} Learner`,
    classId,
    parentName: `${tag} Parent`,
    guardianContact: uniquePhone(),
  });
  assert.equal(res.status, 201, `creating ${tag} should succeed: ${JSON.stringify(res.body)}`);
  return res.body.data;
};

/** The student rows, so a test can ask what class a child is in NOW. */
const students = async () => (await get('/admin/students')).body.data;
/** The class id a child holds NOW, from the student row's own pointer. Null when
    they hold no current class (a graduate). */
const currentClassOf = async (studentId) => (await students()).find((s) => s.id === studentId)?.classId ?? null;

/** This year's seats in a class — every row, whatever its status. */
const roster = async (classId) => (await get(
  `/admin/class-management/years/${currentYear.id}/classes/${classId}/roster`,
)).body.data;

/** The promotion options for a class, from the endpoint the screens will read. */
const optionsForClass = async (classId) => (await get(
  `/admin/class-management/classes/${classId}/promotion-options`,
)).body.data;

/* ══════════════════════════════════════════════════════════════════════════
   The options endpoint the screens will read
   ══════════════════════════════════════════════════════════════════════════ */

test('promotion options for a student report the current year/class, a suggested target, the allowed years and the real classes', async () => {
  const cls = await makeClass();
  const student = await makeStudent(cls.id, 'Options');
  const res = await get(`/admin/class-management/students/${student.id}/promotion-options`);
  assert.equal(res.status, 200, `options should load: ${JSON.stringify(res.body)}`);
  const opts = res.body.data;

  assert.equal(opts.currentYear.id, currentYear.id, 'the current year must be the one that contains today');
  assert.equal(opts.currentClass.id, cls.id, 'the current class must be the student\'s own');

  // The suggested year is the soonest one that is actually later.
  const later = laterYears();
  assert.ok(later.length > 0, 'the seed must offer at least one later year');
  assert.equal(opts.suggestedYear.id, later[0].id, 'the default target year must be the next one in the calendar');

  // Every offered year is later than the current one, and none is the current one.
  assert.ok(opts.allowedYears.length > 0, 'there must be years to choose');
  opts.allowedYears.forEach((y) => {
    assert.ok(y.startDate > currentYear.startDate, `${y.label} starts before the current year and must not be offered`);
    assert.notEqual(y.id, currentYear.id, 'the current year must never be an allowed target');
  });
  assert.equal(opts.allowedYears[0].id, later[0].id, 'the allowed list must be oldest-first, so the default is first');

  // The classes are real rows, and the suggested class is the automatic next one.
  assert.ok(opts.classes.length > 0, 'the real class list must not be empty');
  assert.ok(opts.classes.every((c) => c.label), 'every class must carry a label');
  assert.ok(opts.suggestedClass, 'a promotable class must suggest a next class');
});

test('promotion options for a class report the same shape without a student', async () => {
  const cls = await makeClass();
  const res = await get(`/admin/class-management/classes/${cls.id}/promotion-options`);
  assert.equal(res.status, 200, `options should load: ${JSON.stringify(res.body)}`);
  const opts = res.body.data;
  assert.equal(opts.student, null, 'a class-scoped call names no student');
  assert.equal(opts.currentClass.id, cls.id);
  assert.equal(opts.suggestedYear.id, laterYears()[0].id);
});

test('promotion options for an unknown id are a not-found, not a crash', async () => {
  const res = await get('/admin/class-management/students/stu-does-not-exist/promotion-options');
  assert.equal(res.status, 404, `unknown student should be 404: ${JSON.stringify(res.body)}`);
});

test('promotion options carry every field the Promote popup renders, and the classes it must offer', async () => {
  /* The popup (PromoteStudentModal.jsx) reads exactly these fields and no others:
     it prints the student, shows the current year/class, displays the suggested
     year as read-only text, lists the student's own class plus every class at a
     HIGHER level, and defaults to the suggested class. If any of these names
     changes the popup silently renders blanks, so this pins the CONTACT between
     the screen and the endpoint — not the endpoint's internal shape. */
  const cls = await makeClass();
  const student = await makeStudent(cls.id, 'Popup');

  const res = await get(`/admin/class-management/students/${student.id}/promotion-options`);
  assert.equal(res.status, 200, `options should load: ${JSON.stringify(res.body)}`);
  const opts = res.body.data;

  // The student the popup is about, named so the title can use it.
  assert.equal(opts.student.id, student.id, 'the options must name the student the popup is for');
  assert.equal(opts.student.name, student.name, 'the popup titles itself with this name');

  // The "current class and year" lines.
  assert.equal(opts.currentYear.label, currentYear.label, 'the popup prints the current year label');
  assert.equal(opts.currentClass.label, cls.label, 'the popup prints the current class label');

  // The read-only "Academic year" line: a later year, labelled, with a real id.
  assert.ok(opts.suggestedYear, 'the popup needs a suggested year to display');
  assert.ok(opts.suggestedYear.id && opts.suggestedYear.label, 'the suggested year needs an id and a label');
  assert.ok(
    opts.suggestedYear.startDate > currentYear.startDate,
    'the year shown must be later than the current one',
  );

  /* The dropdown. The popup keeps the student's OWN class (to repeat the year) and
     every class at a higher level, and drops the rest. It needs `order` and
     `section` to sort them, and `label` to show them — so all three must be
     present on the rows it filters. */
  const own = opts.classes.find((c) => c.id === cls.id);
  assert.ok(own, 'the student\'s own class must be in the list, so it can be chosen to stay back');
  assert.ok(own.order !== undefined && own.section !== undefined, 'a class row needs order and section to sort');
  const higher = opts.classes.filter((c) => c.order > own.order);
  assert.ok(higher.length > 0, 'a middle-level class must have classes above it to offer');
  assert.ok(
    higher.every((c) => c.label && c.id),
    'every class the dropdown can show needs an id and a label',
  );

  // The default selection the popup pre-picks.
  assert.ok(opts.suggestedClass?.id, 'the popup needs a suggested class to preselect');
});

/* ══════════════════════════════════════════════════════════════════════════
   Defaults are unchanged — no year, no class means what it always meant
   ══════════════════════════════════════════════════════════════════════════ */

test('promoting a student with NO chosen target still lands in the next year and the next class', async () => {
  const cls = await makeClass();
  const student = await makeStudent(cls.id, 'Default');
  const res = await post(`/admin/class-management/students/${student.id}/move`, { action: 'promote' });
  assert.equal(res.status, 200, `the default promotion should succeed: ${JSON.stringify(res.body)}`);
  const data = res.body.data;

  assert.equal(data.toAcademicYearLabel, laterYears()[0].label, 'the default year must be the next one in the calendar');
  // The default class is the next LEVEL in the chain, with the same section: the
  // same rule the overview applies, so compare against IT rather than a wording.
  const opts = await optionsForClass(cls.id);
  assert.equal(data.targetClassLabel, opts.suggestedClass.label, 'the default class must be the automatic next class');
  assert.equal(data.rollNumber ?? null, null, 'a promoted student carries no roll number');
});

/* ══════════════════════════════════════════════════════════════════════════
   Choosing the year
   ══════════════════════════════════════════════════════════════════════════ */

test('a student can be promoted into a CHOSEN later year', async () => {
  const later = laterYears();
  assert.ok(later.length >= 2, 'this test needs a year further out than the next one');
  const chosen = later[later.length - 1]; // the furthest one offered

  const cls = await makeClass();
  const student = await makeStudent(cls.id, 'ChosenYear');
  const res = await post(`/admin/class-management/students/${student.id}/move`, {
    action: 'promote',
    toAcademicYearId: chosen.id,
  });
  assert.equal(res.status, 200, `a chosen later year should be accepted: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.data.toAcademicYearId, chosen.id, 'the seat must be written in the chosen year');
  assert.equal(res.body.data.toAcademicYearLabel, chosen.label);

  // The chosen year is learnable through the class list, which proves the seat is real.
  const classes = (await get(`/admin/class-management/years/${chosen.id}/classes`)).body.data;
  const landing = classes.find((c) => c.id === res.body.data.targetClassId);
  assert.ok(landing, 'the class the student landed in must appear in the chosen year');
  assert.ok(landing.historyCount > 0, 'the chosen year must now show that class as having run');
});

test('a PAST year is refused with a clear reason', async () => {
  const past = years
    .filter((y) => y.startDate < currentYear.startDate)
    .sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
  assert.ok(past, 'the seed must have a finished year to refuse');

  const cls = await makeClass();
  const student = await makeStudent(cls.id, 'PastYear');
  const res = await post(`/admin/class-management/students/${student.id}/move`, {
    action: 'promote',
    toAcademicYearId: past.id,
  });
  assert.equal(res.status, 409, `a past year must be refused: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, 'YEAR_NOT_LATER');
  // `sendError` carries the wording in `message` (not `error`).
  assert.ok(/later/i.test(res.body.message), `the message must tell the admin to choose a later year: ${res.body.message}`);

  // Nothing moved: the child is still in the class, and holds no seat in that past year.
  assert.equal(await currentClassOf(student.id), cls.id, 'a refused move must write nothing');
});

test('the SAME year is refused with a clear reason', async () => {
  const cls = await makeClass();
  const student = await makeStudent(cls.id, 'SameYear');
  const res = await post(`/admin/class-management/students/${student.id}/move`, {
    action: 'promote',
    toAcademicYearId: currentYear.id,
  });
  assert.equal(res.status, 409, `the current year must be refused: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, 'YEAR_NOT_LATER');
  assert.equal(await currentClassOf(student.id), cls.id, 'a refused move must write nothing');
});

test('an unknown year id is refused', async () => {
  const cls = await makeClass();
  const student = await makeStudent(cls.id, 'BadYear');
  const res = await post(`/admin/class-management/students/${student.id}/move`, {
    action: 'promote',
    toAcademicYearId: 'ay-does-not-exist',
  });
  assert.equal(res.status, 400, `an unknown year must be refused: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, 'UNKNOWN_YEAR');
});

/* ══════════════════════════════════════════════════════════════════════════
   Choosing the class
   ══════════════════════════════════════════════════════════════════════════ */

test('a keeping-back action ignores a class and stays in the same class for a CHOSEN year', async () => {
  const chosen = laterYears()[0];
  const cls = await makeClass();
  const elsewhere = await makeClass(); // a real class, sent on purpose
  const student = await makeStudent(cls.id, 'KeepYear');
  const res = await post(`/admin/class-management/students/${student.id}/move`, {
    action: 'keep',
    toAcademicYearId: chosen.id,
    // A class is sent on purpose: repeating the year cannot change the class, so
    // this must be ignored rather than honoured.
    toClassId: elsewhere.id,
  });
  assert.equal(res.status, 200, `keeping back should succeed: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.data.kind, 'kept');
  assert.equal(res.body.data.targetClassId, cls.id, 'a repeat year stays in the SAME class');
  assert.equal(res.body.data.toAcademicYearId, chosen.id, 'but the chosen year is honoured');
});

test('an unknown class id is refused', async () => {
  const cls = await makeClass();
  const student = await makeStudent(cls.id, 'BadClass');
  const res = await post(`/admin/class-management/students/${student.id}/move`, {
    action: 'promote',
    toClassId: 'cls-does-not-exist',
  });
  assert.equal(res.status, 400, `an unknown class must be refused: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, 'UNKNOWN_CLASS');
  // Still where they were.
  assert.equal(await currentClassOf(student.id), cls.id, 'a refused move must write nothing');
});

/* ══════════════════════════════════════════════════════════════════════════
   One seat per (student, year)
   ══════════════════════════════════════════════════════════════════════════ */

test('a second move for the same student this cycle is refused — one seat per year', async () => {
  const cls = await makeClass();
  const student = await makeStudent(cls.id, 'DupSeat');
  const target = laterYears()[0];

  const first = await post(`/admin/class-management/students/${student.id}/move`, {
    action: 'promote',
    toAcademicYearId: target.id,
  });
  assert.equal(first.status, 200, `the first move should succeed: ${JSON.stringify(first.body)}`);

  /* A student already holding a seat in a later year must never be seated twice:
     the second move is refused, and whichever guard fires (already-handled, or the
     seat check itself), nothing new is written. */
  const second = await post(`/admin/class-management/students/${student.id}/move`, {
    action: 'promote',
    toAcademicYearId: target.id,
  });
  assert.equal(second.status, 409, `a second move must be refused: ${JSON.stringify(second.body)}`);
  assert.ok(
    ['ALREADY_HANDLED', 'DUPLICATE_SEAT'].includes(second.body.code),
    `the refusal must name a seat conflict: ${JSON.stringify(second.body)}`,
  );
});

/* ══════════════════════════════════════════════════════════════════════════
   Whole-class
   ══════════════════════════════════════════════════════════════════════════ */

test('a whole class can be promoted into a CHOSEN year, all in one transaction', async () => {
  const chosenYear = laterYears()[0];
  const cls = await makeClass();
  const a = await makeStudent(cls.id, 'BatchA');
  const b = await makeStudent(cls.id, 'BatchB');

  const res = await post(`/admin/class-management/classes/${cls.id}/promote`, {
    confirm: [a.id, b.id],
    toAcademicYearId: chosenYear.id,
  });
  assert.equal(res.status, 200, `the chosen-target batch should succeed: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.data.toAcademicYearId, chosenYear.id, 'the batch must land in the chosen year');
  assert.equal(res.body.data.movedCount, 2, 'exactly the two confirmed students must move');

  // Both have LEFT the class: the current-class pointer moves. (The old year's
  // roster keeps their closed seats — that register is the record of the year.)
  assert.equal(await currentClassOf(a.id), res.body.data.targetClassId, 'the first student must be in the target class now');
  assert.equal(await currentClassOf(b.id), res.body.data.targetClassId, 'the second student must be in the target class now');
  const left = (await roster(cls.id)).filter((r) => r.studentId === a.id || r.studentId === b.id);
  assert.ok(left.every((r) => r.status === 'promoted'), 'their seats in the old year must be closed as promoted');
});

test('a batch with one unreviewable student refuses the WHOLE class, leaving the clean student where they were', async () => {
  /* All-or-nothing on a rule that fires per student INSIDE the batch. A student
     whose identity cannot be verified must be confirmed or excluded before anything
     moves; until then the whole batch is refused, so the class never ends up
     half-promoted.

     `murky` is NOT confirmed here on purpose: confirming a student is precisely how
     the admin says "I have looked at this one", and that is what lets them through.
     The API refuses to create an unverifiable record, so the blank guardian fields
     are written directly — they stand for a child admitted before that rule existed,
     which is the case this guard is for. Everything asserted goes through the HTTP
     boundary. */
  const chosenYear = laterYears()[0];
  const cls = await makeClass();
  const clean = await makeStudent(cls.id, 'CleanMove');
  const murky = await makeStudent(cls.id, 'Murky');
  await prisma.student.update({
    where: { id: murky.id },
    data: { parentName: null, guardianContact: null },
  });

  const res = await post(`/admin/class-management/classes/${cls.id}/promote`, {
    confirm: [clean.id], // the clean one only; `murky` is deliberately left unreviewed
    toAcademicYearId: chosenYear.id,
  });
  assert.equal(res.status, 409, `the batch must be refused: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, 'UNREVIEWED_STUDENTS');
  assert.ok(res.body.message.includes('Murky'), `the message must name the student who needs review: ${res.body.message}`);

  // The clean student did NOT move: the batch is all-or-nothing.
  assert.equal(await currentClassOf(clean.id), cls.id, 'a refused batch must leave the clean student exactly where they were');
  assert.equal(await currentClassOf(murky.id), cls.id, 'and the flagged student too');
});

test('a whole class whose students were ALL moved this cycle is refused with nothing written', async () => {
  /* A student who already holds a seat in a later year is not actionable — that
     seat is the proof they were handled. A batch of only such students has nothing
     to do, and the whole action is refused rather than reporting a hollow success. */
  const chosenYear = laterYears()[0];
  const cls = await makeClass();
  const w = await makeStudent(cls.id, 'HandledW');
  const x = await makeStudent(cls.id, 'HandledX');

  // Both moved out of the class already, into the chosen year.
  for (const s of [w, x]) {
    const r = await post(`/admin/class-management/students/${s.id}/move`, {
      action: 'promote',
      toAcademicYearId: chosenYear.id,
    });
    assert.equal(r.status, 200, `preparing ${s.name} should succeed: ${JSON.stringify(r.body)}`);
  }

  // They are gone from the class pointer, so the batch is empty.
  assert.notEqual(await currentClassOf(w.id), cls.id, 'moved students must leave the class pointer');
  assert.notEqual(await currentClassOf(x.id), cls.id, 'moved students must leave the class pointer');

  const res = await post(`/admin/class-management/classes/${cls.id}/promote`, {
    confirm: [],
    toAcademicYearId: chosenYear.id,
  });
  assert.equal(res.status, 409, `an empty batch must be refused: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, 'NOTHING_TO_PROMOTE');
});

test('a whole class can be moved into a CHOSEN class as well as a chosen year', async () => {
  /* The admin may pick any real class, not only the automatic next one. Here the
     batch is moved into a DIFFERENT real class — which the automatic "next level"
     could never express. */
  const chosenYear = laterYears()[0];
  const cls = await makeClass();
  const elsewhere = await makeClass();
  const a = await makeStudent(cls.id, 'ChosenCls');

  const res = await post(`/admin/class-management/classes/${cls.id}/promote`, {
    confirm: [a.id],
    toAcademicYearId: chosenYear.id,
    toClassId: elsewhere.id,
  });
  assert.equal(res.status, 200, `a chosen class should be accepted: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.data.targetClassId, elsewhere.id, 'the batch must land in the class the admin chose');
  assert.equal(res.body.data.toAcademicYearId, chosenYear.id);
});

test('a whole class promoted with NO chosen target still uses the next year and the next class', async () => {
  const cls = await makeClass();
  const a = await makeStudent(cls.id, 'BatchDefault');
  const before = await optionsForClass(cls.id);

  const res = await post(`/admin/class-management/classes/${cls.id}/promote`, {
    confirm: [a.id],
  });
  assert.equal(res.status, 200, `the default batch should succeed: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.data.toAcademicYearId, laterYears()[0].id, 'the default year must be the next one');
  assert.equal(res.body.data.targetClassLabel, before.suggestedClass.label, 'the default class must be the automatic next one');
});
