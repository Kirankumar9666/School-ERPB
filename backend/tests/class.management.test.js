/**
 * Class Management — academic years, promotion, pass-out, class history and
 * "Enter Past Data".
 *
 * Written against the HTTP API rather than the service functions on purpose: the
 * bugs that matter here (a route wired to the wrong service, a filter that reads
 * the current class instead of the year's, a transaction that half-applies) only
 * exist at that boundary. Several real bugs in this feature were found by these
 * assertions after the service looked finished.
 *
 * Nothing about the school is written into this file. Which class is the top grade,
 * what the years are called, who is in a class — all of it is read from the API
 * first, so the suite keeps passing when the seed or the class structure changes.
 *
 * ## Why the references are captured in `before`
 *
 * Tests run in declaration order and share the database, so anything re-derived
 * after the promotion tests is looking at a class that has just been emptied. The
 * class, the target class and the individual students are therefore pinned once,
 * up front, and every later test refers to those. Re-querying "who is in 9-B" after
 * 9-B was promoted would find nobody, which reads as a broken assertion rather than
 * the stale query it actually is.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');
const prisma = require('../src/services/prisma');
const enrollment = require('../src/services/enrollment');

let server;
let base;
let token;

/* Pinned in `before`, stable for the whole run. */
let overview;
let years;
let currentYear;
let pastYear;
let src; // the class that can be promoted
let top; // the graduating class
let srcRoster; // the students in `src` this year, before promotion
let victim; // one of them, followed through promotion, backfill and profile reads
let victimRecord; // that child as /admin/students reports them, for identity fields
let promotedTotal = null; // how many the promotion test moved, read by the test after it

before(async () => {
  ({ server, base } = await startServer());
  token = (await login(base, 'admin', 'Admin@123')).accessToken;

  overview = (await request(base, '/admin/class-management/overview', { token })).body.data;
  years = (await request(base, '/admin/class-management/years', { token })).body.data;

  currentYear = overview.currentAcademicYear;
  // The most recent year that has actually finished, rather than a named one.
  pastYear = years
    .filter((y) => y.endDate < currentYear.startDate)
    .sort((a, b) => b.startDate.localeCompare(a.startDate))[0];

  src = overview.classes.find((c) => c.action === 'promote');
  top = overview.classes.find((c) => c.action === 'passed_out');
  assert.ok(src && top && pastYear, 'the school must have a promotable class, a top class and a finished year');

  srcRoster = (await request(
    base,
    `/admin/class-management/years/${currentYear.id}/classes/${src.id}/roster`,
    { token },
  )).body.data;
  assert.ok(srcRoster.length > 0, 'the promotable class must have students to promote');
  victim = srcRoster[0];

  // The roster is the year-scoped view; the identity triple lives on the student.
  victimRecord = (await request(base, '/admin/students', { token })).body.data
    .find((s) => s.id === victim.studentId);
  assert.ok(victimRecord.parentName && victimRecord.guardianContact,
    'the student followed through this suite must have a full identity triple');
});

after(async () => { await stopServer(server); });

const get = (path) => request(base, path, { token });
const post = (path, body) => request(base, path, { method: 'POST', token, body });

/** The overview as it stands right now, re-read rather than reused. */
const freshOverview = async () => (await get('/admin/class-management/overview')).body.data;

/** The seeded student list as it stands right now. */
const students = async () => (await get('/admin/students')).body.data;

/* ══════════════════════════════════════════════════════════════════════════
   Academic years and the derived top grade
   ══════════════════════════════════════════════════════════════════════════ */

test('the top grade is derived from real classes, reported with its basis, and only it graduates', async () => {
  assert.ok(overview.topGrade > 0, 'a top grade must be derived from the class list, not configured');
  assert.ok(['classes_with_students', 'all_classes'].includes(overview.topGradeBasis));

  const grades = overview.classes.map((c) => c.grade);
  assert.equal(Math.max(...grades), overview.topGrade, 'topGrade must be the highest grade actually listed');

  const graduating = overview.classes.filter((c) => c.action === 'passed_out');
  assert.ok(graduating.length > 0, 'the top class must offer to pass out rather than promote');
  graduating.forEach((c) => assert.equal(c.grade, overview.topGrade, `${c.label} must be at the top grade`));

  overview.classes.filter((c) => c.action === 'promote').forEach((c) => {
    assert.ok(c.grade < overview.topGrade, `${c.label} is below the top grade and must be promotable`);
    // The target is computed from the class's OWN grade and section, never typed in.
    // Named levels arrive in a later session; for now the next level is the next number.
    assert.equal(c.targetClassLabel, `Class ${c.grade + 1}${c.section}`);
    assert.equal(c.targetClassId, `cls-${c.grade + 1}${c.section}`);
  });

  // An empty class can offer neither action — promising a move that cannot happen.
  overview.classes.filter((c) => c.studentCount === 0).forEach((c) => assert.equal(c.action, 'none'));
});

test('promotion targets the academic year immediately after the current one', async () => {
  const ascending = [...years].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const i = ascending.findIndex((y) => y.id === currentYear.id);
  assert.ok(i >= 0, 'the current year must appear in the year list');
  assert.equal(overview.nextAcademicYear.id, ascending[i + 1].id, 'the target year must be the next one in the calendar');
  assert.ok(overview.nextAcademicYear.startDate > currentYear.endDate, 'the target year must start after this one ends');
});

test('every academic year comes from the database with a real, non-overlapping range', async () => {
  assert.ok(years.length > 1);
  assert.equal(years.filter((y) => y.isCurrent).length, 1, 'exactly one year may be current');

  for (const y of years) {
    assert.match(y.label, /^\d{4}-\d{2}$/, `year label "${y.label}" must be the YYYY-YY form`);
    assert.ok(y.startDate < y.endDate, `${y.label} must start before it ends`);
  }

  const ascending = [...years].sort((a, b) => a.startDate.localeCompare(b.startDate));
  for (let i = 1; i < ascending.length; i += 1) {
    assert.ok(
      ascending[i - 1].endDate < ascending[i].startDate,
      `${ascending[i - 1].label} and ${ascending[i].label} overlap, so neither could be "the current year"`,
    );
  }
});

test('schema enums reach the UI through the options endpoint, not a hand-written list', async () => {
  const opts = (await get('/school/options')).body.data;
  ['enrollmentStatuses', 'recordSources', 'matchConfidences'].forEach((key) => {
    assert.ok(Array.isArray(opts.enums[key]) && opts.enums[key].length > 0, `${key} must be served from the schema`);
  });
  assert.ok(opts.enums.recordSources.includes('historical'), 'backfilled records must be distinguishable by provenance');
  assert.ok(opts.enums.enrollmentStatuses.includes('passed_out'));
  assert.ok(opts.enums.enrollmentStatuses.includes('promoted'), 'Class History needs to say where a student went');
});

/* ══════════════════════════════════════════════════════════════════════════
   Class History — the structure as it was
   ══════════════════════════════════════════════════════════════════════════ */

test('a year with no records reports an empty structure, not today\'s classes as history', async () => {
  const classes = (await get(`/admin/class-management/years/${pastYear.id}/classes`)).body.data;
  assert.ok(classes.length > 0, 'the class list must not be empty');
  classes.forEach((c) => {
    assert.equal(c.existed, c.historyCount > 0, `${c.label}: existed must follow its own history count`);
  });
  // Nothing has been backfilled yet, so this year genuinely has no history. That is
  // the empty state the feature asks for, not a failure.
  assert.ok(classes.every((c) => c.historyCount === 0));
});

test('an empty year and class returns an empty roster rather than an error', async () => {
  const res = await get(`/admin/class-management/years/${pastYear.id}/classes/${src.id}/roster`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, []);
});

/* ══════════════════════════════════════════════════════════════════════════
   Identity matching
   ══════════════════════════════════════════════════════════════════════════ */

test('a student is found by name fragment, by guardian name, and by contact', async () => {
  const withGuardian = (await students()).find((s) => s.parentName && s.guardianContact);
  assert.ok(withGuardian, 'the seed must have a student with a full identity triple');

  const byName = (await get(
    `/admin/class-management/students/search?name=${encodeURIComponent(withGuardian.name.split(' ')[0])}`,
  )).body.data;
  assert.ok(byName.some((c) => c.studentId === withGuardian.id), 'a name fragment must find the student');

  const byGuardian = (await get(
    `/admin/class-management/students/search?parentName=${encodeURIComponent(withGuardian.parentName)}`,
  )).body.data;
  assert.ok(byGuardian.some((c) => c.studentId === withGuardian.id), 'a guardian name must find the student');

  // The same subscriber, written a second way. The stored shape is '+91-…', so the
  // bare national number is the variant a retyped register will carry.
  const retyped = withGuardian.guardianContact.replace(/^\+91-/, '');
  const byContact = (await get(
    `/admin/class-management/students/search?guardianContact=${encodeURIComponent(retyped)}`,
  )).body.data;
  assert.ok(byContact.some((c) => c.studentId === withGuardian.id), 'a retyped contact must still match');

  // All three fields together must grade better than a fragment.
  const exact = (await get(
    `/admin/class-management/students/search?name=${encodeURIComponent(withGuardian.name)}`
    + `&parentName=${encodeURIComponent(withGuardian.parentName)}`
    + `&guardianContact=${encodeURIComponent(withGuardian.guardianContact)}`,
  )).body.data;
  assert.equal(exact[0].tier, 'exact', 'all three fields agreeing must grade as an exact match');
  assert.equal(exact[0].studentId, withGuardian.id);
});

test('searching for nothing is refused, and searching for something absent returns nothing', async () => {
  const empty = await get('/admin/class-management/students/search');
  assert.equal(empty.status, 400, 'an empty search must be refused, not return the whole school');
  assert.ok(empty.body.errors, 'the refusal must name the field to fill');

  const none = await get(`/admin/class-management/students/search?name=${encodeURIComponent('Nobody By That Name')}`);
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.data, []);
});

/* ══════════════════════════════════════════════════════════════════════════
   Promotion review
   ══════════════════════════════════════════════════════════════════════════ */

test('the promotion plan changes nothing and covers the whole class', async () => {
  const plan = (await get(`/admin/class-management/classes/${src.id}/promotion-plan`)).body.data;

  assert.equal(plan.kind, 'promote');
  assert.equal(plan.sourceClass.id, src.id);
  assert.equal(plan.totalStudents, src.studentCount, 'the plan must cover every student in the class');
  assert.equal(plan.students.length, srcRoster.length);
  assert.equal(plan.toAcademicYear.id, overview.nextAcademicYear.id);
  assert.equal(plan.targetClass.label, src.targetClassLabel);

  plan.students.forEach((s) => {
    assert.equal(typeof s.needsReview, 'boolean');
    assert.ok(s.identity, 'each student must show the triple that was checked');
    assert.equal(typeof s.identity.name, 'string');
    assert.ok(Array.isArray(s.flags.rivals), 'rival records must be reported, not silently dropped');
  });

  // Reading a plan must not have moved anybody.
  const after = await freshOverview();
  assert.equal(after.classes.find((c) => c.id === src.id).studentCount, src.studentCount);
});

test('promotion is refused for the graduating class, and for a class that does not exist', async () => {
  const res = await post(`/admin/class-management/classes/${top.id}/promote`, {});
  assert.equal(res.status, 409);
  assert.match(res.body.message, /passed out/i, 'the refusal must point at the action that does apply');

  const missing = await get('/admin/class-management/classes/cls-NOPE/promotion-plan');
  assert.equal(missing.status, 404);
});

test('a duplicate record and a record with no guardian are both flagged, and the batch is blocked until each is resolved', async () => {
  // Two real data faults, both of which a school has. One is another row carrying
  // this child's whole identity (phone typed the other way, which must still grade
  // exact — same subscriber); the other has no guardian details at all, so there is
  // nothing to check it against.
  //
  // The duplicate is written straight to the database, NOT through
  // POST /admin/students: that route now refuses an identity that is already on
  // file, which is exactly the rule this feature is for. A duplicate that reaches
  // the promotion review has therefore arrived some other way — a legacy file
  // imported before the rule existed — and the review screen still has to catch
  // it. Writing it directly is how that case is reproduced.
  const twinRow = await prisma.student.create({
    data: {
      id: `stu-twin-${Date.now()}`,
      name: victimRecord.name,
      parentName: victimRecord.parentName,
      // Deliberately the other spelling of the same subscriber: the stored shape
      // is '+91-…', so the bare national number must still grade as the same child.
      guardianContact: victimRecord.guardianContact.replace(/^\+91-/, ''),
      classId: src.id,
      rollNumber: 'STU-TWIN-001',
      address: 'duplicate record, deliberately created',
    },
  });
  await enrollment.syncLiveEnrollment(prisma, twinRow.id);
  const twinId = twinRow.id;

  // The guardianless record is a LEGACY row: it is written straight to the
  // database exactly like the twin above, because Add Student now requires both
  // guardian fields. Records like this still exist — admitted before the rule,
  // or imported from a register that never had them — and the promotion review
  // must still flag them as unverifiable rather than silently approving them.
  const noGuardianRow = await prisma.student.create({
    data: {
      id: `stu-noguardian-${Date.now()}`,
      name: 'Priya Nair',
      parentName: null,
      guardianContact: null,
      classId: src.id,
      address: 'no guardian details, deliberately created',
    },
  });
  await enrollment.syncLiveEnrollment(prisma, noGuardianRow.id);
  const noGuardianId = noGuardianRow.id;

  const plan = (await get(`/admin/class-management/classes/${src.id}/promotion-plan`)).body.data;
  const byId = new Map(plan.students.map((s) => [s.studentId, s]));

  // Both halves of the duplicate are suspect — either could be the wrong record.
  assert.equal(byId.get(twinId).flags.duplicate, true, 'a duplicate identity must be flagged as such');
  assert.equal(byId.get(victim.studentId).flags.duplicate, true, 'and the original must be flagged too');
  assert.equal(byId.get(noGuardianId).flags.unverifiable, true, 'a record with no guardian cannot be verified');
  assert.deepEqual(
    byId.get(noGuardianId).flags.missingFields.sort(),
    ['guardianContact', 'parentName'],
    'the missing fields must be named so the office knows what to fill in',
  );
  // A record nobody disputes must NOT be dragged into the review.
  assert.equal(plan.needsReviewCount, 3, 'only the three disputed records need a decision');

  const blocked = await post(`/admin/class-management/classes/${src.id}/promote`, { confirm: [] });
  assert.equal(blocked.status, 409, 'a batch with unresolved flags must be refused outright');
  assert.equal(blocked.body.code, 'UNREVIEWED_STUDENTS');
  // Named individually: a count sends the admin hunting through a list they read.
  assert.match(blocked.body.message, /Priya Nair/);
  assert.match(blocked.body.message, new RegExp(victim.name));

  // Confirming some but not all must not proceed — including only one half of the
  // duplicate pair, which is the mistake that leaves two identical children a grade
  // apart.
  const partial = await post(`/admin/class-management/classes/${src.id}/promote`, { confirm: [twinId] });
  assert.equal(partial.status, 409);
  const stillBlocked = /Priya Nair/.test(partial.body.message);
  assert.ok(stillBlocked, 'the unconfirmed unverifiable record must still stop the batch');

  /* The twin was written straight into the database to have a duplicate that the
     API would refuse to create. It has now served its purpose and is removed, so
     the tests after this one are not editing a record that shadows the victim's
     own identity. */
  await prisma.student.deleteMany({ where: { id: twinId } });
});

/* ══════════════════════════════════════════════════════════════════════════
   Promotion
   ══════════════════════════════════════════════════════════════════════════ */

test('promotion is atomic: the whole class moves and the prior year survives intact', async () => {
  const plan = (await get(`/admin/class-management/classes/${src.id}/promotion-plan`)).body.data;
  // Read the roster HERE, not from `before` — the flags test added students to this
  // class since then, so the earlier snapshot is no longer the batch being moved.
  const beforeRows = (await get(
    `/admin/class-management/years/${currentYear.id}/classes/${src.id}/roster`,
  )).body.data;
  assert.equal(beforeRows.length, plan.totalStudents, 'the plan and the roster must agree on the batch');

  const res = await post(`/admin/class-management/classes/${src.id}/promote`, {
    confirm: plan.students.map((s) => s.studentId),
  });
  assert.equal(res.status, 200, `promotion should succeed: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.data.movedCount, plan.totalStudents, 'every student in the batch must move — no partial state');
  assert.equal(res.body.data.targetClassLabel, src.targetClassLabel);
  promotedTotal = res.body.data.movedCount;

  // The source class now holds nobody.
  const after = await freshOverview();
  assert.equal(after.classes.find((c) => c.id === src.id).studentCount, 0, 'the promoted class must be left empty');

  // ...but its own year is still fully readable, with everyone still in it.
  const oldRoster = (await get(
    `/admin/class-management/years/${currentYear.id}/classes/${src.id}/roster`,
  )).body.data;
  assert.equal(oldRoster.length, beforeRows.length, 'the promoted year must not lose anybody');
  oldRoster.forEach((row) => {
    const before = beforeRows.find((b) => b.studentId === row.studentId);
    assert.ok(before, `${row.name} must still appear in the year they were promoted out of`);
    assert.equal(row.status, 'promoted', `${row.name} must read as promoted out, not as deleted`);
    assert.equal(row.rollNumber, before.rollNumber, 'the roll number they held that year must be preserved');
  });

  // The new year holds them, each recording where they came from.
  const newRoster = (await get(
    `/admin/class-management/years/${overview.nextAcademicYear.id}/classes/${src.targetClassId}/roster`,
  )).body.data;
  assert.equal(newRoster.length, plan.totalStudents);
  newRoster.forEach((row) => {
    assert.equal(row.source, 'promoted', 'a promoted row must be distinguishable from a live one');
    assert.equal(row.promotedFromClassId, src.id);
    assert.equal(row.promotedFromLabel, src.label, 'the source class must be readable, not a bare id');
    assert.equal(row.rollNumber, null, 'a new year gets a fresh roll number, not the old one');
  });

  // The emptied class must remain selectable for the year it actually ran.
  const structure = (await get(`/admin/class-management/years/${currentYear.id}/classes`)).body.data;
  assert.equal(structure.find((c) => c.id === src.id).existed, true,
    'a class that ran this year must stay in this year\'s selector');
});

test('the promoted students are in the new class as far as the rest of the app is concerned', async () => {
  const after = await freshOverview();
  const target = after.classes.find((c) => c.id === src.targetClassId);
  assert.ok(target, 'the target class must exist after the promotion');
  assert.equal(target.grade, src.grade + 1);

  const list = await students();
  const inTarget = list.filter((s) => s.section === target.section && String(s.class) === String(target.grade));
  assert.equal(inTarget.length, promotedCount(), 'the ordinary students list and the class headcount must agree');

  // ...and the individual child we pinned at the start must be one of them.
  const promoted = list.find((s) => s.id === victim.studentId);
  assert.equal(String(promoted.class), String(target.grade), 'the child must be in the promoted class');
  assert.equal(promoted.section, target.section);
  assert.equal(promoted.rollNumber, null, 'the old roll number must not travel into the new year');
});

test('passing out the top class empties it and keeps every year readable', async () => {
  const before = (await get(
    `/admin/class-management/years/${currentYear.id}/classes/${top.id}/roster`,
  )).body.data;
  assert.ok(before.length > 0, 'the graduating class must have students');

  const res = await post(`/admin/class-management/classes/${top.id}/pass-out`, {});
  assert.equal(res.status, 200, `pass out should succeed: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.data.passedOutCount, before.length);

  // No student holds that class any more...
  const list = await students();
  before.forEach((row) => {
    const s = list.find((x) => x.id === row.studentId);
    assert.equal(s.class, null, `${row.name} must hold no current class after passing out`);
    assert.equal(s.section, null);
  });

  // ...and every register in the app drops them, with no other query having changed.
  const after = await freshOverview();
  assert.equal(after.classes.find((c) => c.id === top.id).studentCount, 0);
  assert.equal(after.classes.find((c) => c.id === top.id).action, 'none', 'an emptied class offers neither action');

  // Their year survives, labelled as finished rather than active.
  const stillThere = (await get(
    `/admin/class-management/years/${currentYear.id}/classes/${top.id}/roster`,
  )).body.data;
  assert.equal(stillThere.length, before.length, 'every graduate must remain in their final year');
  stillThere.forEach((row) => {
    assert.equal(row.status, 'passed_out');
    assert.equal(row.currentClassLabel, null, 'a graduate holds no current class');
    assert.equal(row.isCurrentlyHere, false);
  });
});

/* The pass-out test above just left every graduate holding `classId: null`. That
   is the correct, intended state for an alumnus — but `Student.classId` was
   non-nullable before this feature, and several admin queries read across the
   WHOLE student table while dereferencing `s.class.grade` unguarded.

   One graduate anywhere in the school turned `GET /admin/students/by-class`
   into a 500. Because the Student Management page loads that endpoint inside an
   unguarded `Promise.all` alongside two healthy requests, the single failure
   abandoned the `.then` entirely and the page rendered a confident
   "0 students across 0 classes" over a school that was fully populated — which
   reads as data loss, not as a broken request.

   So this pins the family rather than one call site: every query that spans
   students of every class must tolerate one who belongs to none. */
test('a school that contains graduates still answers the queries spanning every student', async () => {
  const all = await students();
  const classless = all.filter((s) => s.class === null);
  assert.ok(classless.length > 0,
    'the pass-out test must have left graduates behind, or this proves nothing');

  // The class-card grid must still answer...
  const grouped = await get('/admin/students/by-class');
  assert.equal(grouped.status, 200,
    `by-class must not crash on a classless student: ${JSON.stringify(grouped.body)}`);
  const rows = grouped.body.data;
  assert.ok(rows.length > 0, 'the classes that still hold students must still be listed');

  // ...and must put only students who actually have a class into a class card.
  const groupedIds = rows.flatMap((r) => r.studentIds);
  groupedIds.forEach((id) => {
    const s = all.find((x) => x.id === id);
    assert.ok(s, 'every grouped id must be a real student');
    assert.notEqual(s.class, null, `${s.name} is grouped under a class but holds none`);
  });
  classless.forEach((s) => {
    assert.ok(!groupedIds.includes(s.id),
      `${s.name} holds no current class and must appear in no class card`);
  });

  // The only students outside a card are exactly the ones with no class — so the
  // page's headcount and its grid can never disagree about who was counted.
  const ungrouped = all.filter((s) => !groupedIds.includes(s.id));
  assert.equal(ungrouped.length, classless.length,
    'the sole students outside a class group are the ones with no class');

  // The ?q= branch dereferences `s.class.grade` too — searching a graduate's
  // name by hand is the second way this route used to 500.
  const hit = await get(`/admin/students/by-class?q=${encodeURIComponent(classless[0].name)}`);
  assert.equal(hit.status, 200,
    `by-class must survive a search over a classless student: ${JSON.stringify(hit.body)}`);

  // And the raw list still reports everyone, so the graduates remain addressable
  // rather than quietly dropped from the one endpoint that sees the whole school.
  assert.equal(all.length, groupedIds.length + classless.length,
    'every student is either in a class card or has no class — none are lost');
});

test('an empty class can neither be promoted nor passed out', async () => {
  const empty = (await freshOverview()).classes.find((c) => c.action === 'none');
  assert.ok(empty, 'the overview must contain an empty class by now');

  const out = await post(`/admin/class-management/classes/${empty.id}/pass-out`, {});
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'NOTHING_TO_PASS_OUT');

  const up = await post(`/admin/class-management/classes/${empty.id}/promote`, {});
  assert.equal(up.status, 409);
  assert.equal(up.body.code, 'NOTHING_TO_PROMOTE');
});

/* ══════════════════════════════════════════════════════════════════════════
   Enter Past Data
   ══════════════════════════════════════════════════════════════════════════ */

test('a historical record for a past year never touches the current class or roll number', async () => {
  const before = (await students()).find((s) => s.id === victim.studentId);

  const res = await post('/admin/class-management/historical-records', {
    academicYearId: pastYear.id,
    classId: src.id,
    existingStudentId: victim.studentId,
    rollNumber: 'ARCHIVE-1',
    attendance: { workingDays: 200, daysPresent: 180, daysAbsent: 12 },
    marks: [
      { examName: 'Annual Exam', subject: 'Mathematics', maxMarks: 80, obtained: 61 },
      { examName: 'Annual Exam', subject: 'Science', maxMarks: 80, obtained: 70 },
      { examName: 'Unit Test 1', subject: 'Mathematics', maxMarks: 40, obtained: 33 },
    ],
  });
  assert.equal(res.status, 200, `backfill should save: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.data.marksSaved, 3);
  assert.equal(res.body.data.createdStudent, false, 'an existing child must be attached, not duplicated');

  const after = (await students()).find((s) => s.id === victim.studentId);
  assert.equal(after.class, before.class, 'a past-year record says nothing about where a child is today');
  assert.equal(after.rollNumber, before.rollNumber, 'nor about their current roll number');

  // The backfilled year now reads back as a real, populated year.
  const structure = (await get(`/admin/class-management/years/${pastYear.id}/classes`)).body.data;
  assert.equal(structure.find((c) => c.id === src.id).existed, true, 'the class must now be selectable for that year');

  const roster = (await get(`/admin/class-management/years/${pastYear.id}/classes/${src.id}/roster`)).body.data;
  assert.equal(roster.length, 1);
  assert.equal(roster[0].source, 'historical', 'a backfilled row must be distinguishable from a live one');
  assert.equal(roster[0].rollNumber, 'ARCHIVE-1', 'the roll number must be the one recorded FOR THAT YEAR');
});

test('the year-scoped profile shows that year only, and separates live from backfilled attendance', async () => {
  const view = (await get(
    `/admin/class-management/students/${victim.studentId}/years/${pastYear.id}`,
  )).body.data;

  assert.equal(view.academicYear.id, pastYear.id);
  assert.equal(view.enrollment.classLabel, src.label, 'the class must be the one they were in THAT year');
  assert.equal(view.enrollment.source, 'historical');
  assert.equal(view.enrollment.rollNumber, 'ARCHIVE-1');

  // Backfilled totals are present, and are yearly figures rather than daily rows.
  assert.deepEqual(view.attendance.backfilled, { workingDays: 200, daysPresent: 180, daysAbsent: 12 });
  assert.equal(view.attendance.daily.recorded, false, 'a backfilled year has no daily rows, and must say so');
  assert.equal(view.attendance.daily.total, 0);

  // Three subject rows belong to TWO exams, not three.
  assert.equal(view.marks.length, 3);
  assert.equal(new Set(view.marks.map((m) => m.examName)).size, 2, 'three subjects across two exams');
  view.marks.forEach((m) => {
    assert.ok(m.obtained <= m.maxMarks);
    assert.equal(m.examSource, 'historical', 'backfilled exams must be marked as such');
    assert.ok(m.enteredBy, 'a backfilled mark must be attributed to whoever typed it');
  });

  // Their real year must not leak into the archived one, and vice versa.
  const live = (await get(
    `/admin/class-management/students/${victim.studentId}/years/${overview.nextAcademicYear.id}`,
  )).body.data;
  assert.equal(live.enrollment.classLabel, src.targetClassLabel, 'the live year shows the class they are in now');
  assert.equal(live.enrollment.rollNumber, null);
  assert.equal(live.marks.length, 0, 'the archived results must not appear against this year');
  assert.equal(live.attendance.backfilled, null, 'a live year has no backfilled summary');
});

test('a historical student can be created, is findable next year by identity, and holds no current class', async () => {
  const res = await post('/admin/class-management/historical-records', {
    academicYearId: pastYear.id,
    classId: src.id,
    newStudent: { name: 'Test Archived Child', parentName: 'Test Archived Guardian', guardianContact: '9876500011' },
    rollNumber: 'R-9',
    attendance: { workingDays: 190, daysPresent: 190, daysAbsent: 0 },
    marks: [{ examName: 'Annual Exam', subject: 'English', maxMarks: 50, obtained: 41 }],
  });
  assert.equal(res.status, 200, `creating a historical student should work: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.data.createdStudent, true);

  const created = (await students()).find((s) => s.id === res.body.data.studentId);
  assert.equal(created.class, null, 'a child recorded only for a past year belongs to no live register');
  assert.equal(created.section, null);

  // The three identity fields are exactly what makes the match work NEXT year, so
  // the search must find this child by a differently-typed contact.
  const found = (await get(
    '/admin/class-management/students/search?guardianContact=09876500011',
  )).body.data;
  assert.ok(found.some((c) => c.studentId === res.body.data.studentId), 'a retyped contact must find the new child');

  // Attaching a second year to the same child must reuse them, not duplicate them.
  const older = years
    .filter((y) => y.endDate < pastYear.startDate)
    .sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
  assert.ok(older, 'the school must have an earlier year still to record');

  const second = await post('/admin/class-management/historical-records', {
    academicYearId: older.id,
    classId: src.id,
    existingStudentId: res.body.data.studentId,
    attendance: { workingDays: 180, daysPresent: 170, daysAbsent: 5 },
  });
  assert.equal(second.status, 200, `a second year for the same child should work: ${JSON.stringify(second.body)}`);
  assert.equal(second.body.data.studentId, res.body.data.studentId, 'the child must be reused, not duplicated');

  const view = (await get(
    `/admin/class-management/students/${res.body.data.studentId}/years/${older.id}`,
  )).body.data;
  assert.equal(view.enrollment.classLabel, src.label);
  assert.equal(view.attendance.backfilled.workingDays, 180);

  // Both years must now show in that child's Class History footprint.
  const thisYear = (await get(`/admin/class-management/years/${pastYear.id}/classes/${src.id}/roster`)).body.data;
  assert.equal(thisYear.filter((r) => r.studentId === res.body.data.studentId).length, 1);
});

test('re-saving a year corrects it in place rather than duplicating the record', async () => {
  const res = await post('/admin/class-management/historical-records', {
    academicYearId: pastYear.id,
    classId: src.id,
    existingStudentId: victim.studentId,
    attendance: { workingDays: 200, daysPresent: 175, daysAbsent: 10 },
  });
  assert.equal(res.status, 200);

  const roster = (await get(`/admin/class-management/years/${pastYear.id}/classes/${src.id}/roster`)).body.data;
  assert.equal(roster.filter((r) => r.studentId === victim.studentId).length, 1, 'one row per student per year');

  const view = (await get(
    `/admin/class-management/students/${victim.studentId}/years/${pastYear.id}`,
  )).body.data;
  assert.equal(view.attendance.backfilled.daysPresent, 175, 'the corrected total must replace the old one');
});

test('a historical record is refused when it would be wrong, naming the field', async () => {
  const cases = [
    ['a new child with no guardian', {
      academicYearId: pastYear.id,
      classId: src.id,
      newStudent: { name: 'No Guardian At All' },
    }, /guardian/i],
    ['both an existing and a new child', {
      academicYearId: pastYear.id,
      classId: src.id,
      existingStudentId: victim.studentId,
      newStudent: { name: 'A', parentName: 'B', guardianContact: '9876500099' },
    }, /existing student, or add one/],
    ['present plus absent beyond the term', {
      academicYearId: pastYear.id,
      classId: src.id,
      existingStudentId: victim.studentId,
      attendance: { workingDays: 10, daysPresent: 9, daysAbsent: 8 },
    }, /cannot exceed/i],
    ['a partial attendance summary', {
      academicYearId: pastYear.id,
      classId: src.id,
      existingStudentId: victim.studentId,
      attendance: { workingDays: 10, daysPresent: 8 },
    }, /days absent is required/i],
    ['obtained above the maximum', {
      academicYearId: pastYear.id,
      classId: src.id,
      existingStudentId: victim.studentId,
      marks: [{ examName: 'X', subject: 'Maths', maxMarks: 10, obtained: 11 }],
    }, /between 0 and 10/i],
    ['a mark with no subject', {
      academicYearId: pastYear.id,
      classId: src.id,
      existingStudentId: victim.studentId,
      marks: [{ examName: 'X', maxMarks: 10, obtained: 5 }],
    }, /subject/i],
    ['no class chosen', { academicYearId: pastYear.id, existingStudentId: victim.studentId }, /class/i],
    ['an unknown academic year', { academicYearId: 'ay-nope', classId: src.id, existingStudentId: victim.studentId }, null],
  ];

  for (const [label, body, pattern] of cases) {
    const res = await post('/admin/class-management/historical-records', body);
    assert.ok(res.status >= 400, `${label} must be refused (got ${res.status}: ${JSON.stringify(res.body)})`);
    if (pattern) assert.match(JSON.stringify(res.body), pattern, `${label} must explain itself`);
    /* A bad payload is reported the way every other route in this app reports one:
       400 with a per-field message the form can focus. Anything the database's
       state makes impossible is a 409 carrying its own code instead — asserting the
       status is what pins that distinction down. */
    if (label === 'an unknown academic year') assert.equal(res.status, 404);
    else assert.equal(res.status, 400, `${label} is a malformed request`);
  }

  // None of those refusals may have written anything.
  const roster = (await get(`/admin/class-management/years/${pastYear.id}/classes/${src.id}/roster`)).body.data;
  assert.equal(roster.filter((r) => r.studentId === victim.studentId).length, 1, 'a refused save must touch nothing');
});

test('one child cannot be filed under two classes in the same year', async () => {
  // A class other than the one they are recorded in, taken from the live overview
  // rather than named, so this follows the school.
  const other = (await freshOverview()).classes.find((c) => c.id !== src.id);
  assert.ok(other, 'there must be another class to collide with');

  const res = await post('/admin/class-management/historical-records', {
    academicYearId: pastYear.id,
    classId: other.id,
    existingStudentId: victim.studentId,
  });
  assert.equal(res.status, 409, `expected a conflict, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, 'ALREADY_RECORDED_IN_OTHER_CLASS');

  /* The refusal must name the class they are ALREADY in — the one the office has
     to go and delete — not the one just picked from the dropdown, which is the
     thing the admin obviously already knows. */
  assert.ok(
    res.body.message.includes(src.label),
    `the refusal must name the class already on file ("${src.label}"): ${res.body.message}`,
  );
  assert.ok(
    !res.body.message.includes(other.label) || other.label === src.label,
    'and must not blame the class that was just chosen',
  );
  assert.match(res.body.message, new RegExp(victim.name), 'and must name the child');
});

/* ══════════════════════════════════════════════════════════════════════════
   Admission keeps the history in step
   ══════════════════════════════════════════════════════════════════════════ */

test('a newly admitted student is immediately promotable and visible in their year', async () => {
  /* Admitted into a section that does not exist yet, which is the case that
     exercises both halves at once: the class row has to be created, and the
     enrollment written alongside it. The grade is derived as one BELOW the
     school's top grade so the new class is genuinely promotable afterwards —
     hardcoding a grade here would be the thing this whole feature refuses to do. */
  const topGrade = (await freshOverview()).topGrade;
  const grade = String(Math.max(1, topGrade - 1));

  const created = await post('/admin/students', {
    class: grade,
    section: 'C',
    name: 'Freshly Admitted',
    parentName: 'Fresh Guardian',
    guardianContact: '9876500044',
    address: 'admitted through the API',
  });
  assert.equal(created.status, 201, `admission should succeed: ${JSON.stringify(created.body)}`);
  assert.equal(created.body.data.class, grade);
  assert.equal(created.body.data.section, 'C');

  const classId = `cls-${grade}C`;

  // The Promote tab reads enrollments, so an admitted student with no enrollment row
  // would simply not be there to promote — the most likely thing to break.
  const roster = (await get(
    `/admin/class-management/years/${currentYear.id}/classes/${classId}/roster`,
  )).body.data;
  const row = roster.find((r) => r.studentId === created.body.data.id);
  assert.ok(row, 'a newly admitted student must have a seat for this year');
  assert.equal(row.source, 'live', 'an admission is a live record, not a promoted or backfilled one');
  assert.equal(row.status, 'active');

  const plan = (await get(`/admin/class-management/classes/${classId}/promotion-plan`)).body.data;
  assert.ok(
    plan.students.some((s) => s.studentId === created.body.data.id),
    'and must appear in the promotion review',
  );
  assert.equal(plan.targetClass.label, `Class ${Number(grade) + 1}C`, 'the target is computed from the new class own grade');
});

test('editing a student other than their class leaves their enrollment history untouched', async () => {
  // The child pinned in `before`, whose class the promotion moved — so this also
  // covers the awkward case: their live seat belongs to NEXT year's register now,
  // and an ordinary profile edit must not disturb it or reopen the closed one.
  const s = (await students()).find((x) => x.id === victim.studentId);
  assert.ok(s && s.class, 'the promoted child must still hold a class');

  const rosterBefore = (await get(
    `/admin/class-management/years/${overview.nextAcademicYear.id}/classes/${s.class}${s.section}/roster`,
  )).body.data.filter((r) => r.studentId === s.id);
  const closedYearBefore = (await get(
    `/admin/class-management/years/${currentYear.id}/classes/${src.id}/roster`,
  )).body.data.filter((r) => r.studentId === s.id);

  const res = await request(base, `/admin/students/${s.id}`, {
    method: 'PUT',
    token,
    body: {
      name: s.name,
      class: String(s.class),
      section: s.section,
      rollNumber: s.rollNumber,
      parentName: s.parentName,
      guardianContact: s.guardianContact,
      address: 'address edited, class untouched',
    },
  });
  assert.equal(res.status, 200, `the edit should succeed: ${JSON.stringify(res.body)}`);

  const rosterAfter = (await get(
    `/admin/class-management/years/${overview.nextAcademicYear.id}/classes/${s.class}${s.section}/roster`,
  )).body.data.filter((r) => r.studentId === s.id);
  const closedYearAfter = (await get(
    `/admin/class-management/years/${currentYear.id}/classes/${src.id}/roster`,
  )).body.data.filter((r) => r.studentId === s.id);

  assert.deepEqual(rosterAfter, rosterBefore, 'an edit that did not touch the class must not rewrite their live seat');
  assert.deepEqual(
    closedYearAfter,
    closedYearBefore,
    'and must not reopen the year they were promoted out of',
  );
  assert.equal(closedYearAfter[0].status, 'promoted', 'the closed year must stay closed');
});

/* ══════════════════════════════════════════════════════════════════════════
   Access
   ══════════════════════════════════════════════════════════════════════════ */

test('Class Management is unreachable without an admin session', async () => {
  const anon = await request(base, '/admin/class-management/overview');
  assert.equal(anon.status, 401);
});

test('a teacher cannot reach Class Management from the Employee Portal', async () => {
  const teacher = (await login(base, 'teacher', 'Teacher@123')).accessToken;
  for (const path of [
    '/admin/class-management/overview',
    '/admin/class-management/years',
    `/admin/class-management/classes/${src.id}/promotion-plan`,
  ]) {
    const res = await request(base, path, { token: teacher });
    assert.equal(res.status, 403, `a teacher must not reach ${path}`);
  }
});

/* The size of the batch the promotion test moved. Read from that test's own result
   rather than re-derived from the class, which is empty by now. */
const promotedCount = () => {
  assert.ok(promotedTotal !== null, 'the promotion test must record how many students it moved');
  return promotedTotal;
};