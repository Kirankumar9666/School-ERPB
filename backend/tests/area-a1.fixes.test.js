/**
 * Area A1 fixes — the findings this session was asked to repair.
 *
 * One file per session, one test per finding, so a regression names the finding
 * it broke. Everything is asserted through the API against the SEEDED test
 * database (tests/helpers.js refuses to run anywhere whose name lacks the `test`
 * marker), and no test writes to the app's database.
 *
 *   QA-A1-001  Bulk Add is wired: the template and the upload both answer.
 *   QA-A1-010  A rejected field names itself (server `errors` are surfaced).
 *   QA-A1-011  A future date of birth is refused.
 *   QA-A1-013  A decimal fee is refused, not silently rounded.
 *   QA-A1-016  A named level reads as its NAME ("LKG A"), never its order.
 *   QA-A1-017  Opening the promotion review writes nothing.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

let server;
let base;
let token;
let levels;

const get = (path) => request(base, path, { token });
const post = (path, body) => request(base, path, { method: 'POST', token, body });

const newContact = () => `97${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`.slice(0, 10);

/** Create a class on a level (by name/id), returning its API row. */
const makeClass = async (levelName, section) => {
  const level = levels.find((l) => l.id === levelName || l.name === levelName);
  assert.ok(level, `no level named ${levelName}`);
  const res = await post('/admin/classes', { levelId: level.id, section });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};

const makeStudent = async (classId, name) => {
  const res = await post('/admin/students', {
    classId, name, parentName: `${name} Guardian`, guardianContact: newContact(),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};

let sectionSeq = 0;
const nextSection = () => {
  sectionSeq += 1;
  const n = sectionSeq - 1;
  return String.fromCharCode(65 + Math.floor(n / 26)) + String.fromCharCode(65 + (n % 26));
};

before(async () => {
  ({ server, base } = await startServer());
  token = (await login(base, 'admin', 'Admin@123')).accessToken;
  levels = (await get('/school/options')).body.data.levels;
  assert.ok(levels.length > 0, 'the seed must leave levels');
});

after(async () => { await stopServer(server); });

/* ── QA-A1-001 — Bulk Add is wired end to end ──────────────────────────────── */

test('QA-A1-001: the bulk template downloads and a bulk upload creates students', async () => {
  const cls = await makeClass('1', nextSection());

  // What the (now reachable) Bulk Add modal asks for first: the class template.
  // It answers with a FILE (xlsx by default), not JSON — so check the response
  // itself rather than the JSON helper.
  const tplRes = await fetch(`${base}/admin/students/bulk-template?classId=${cls.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(tplRes.status, 200, 'the bulk template must download');
  assert.ok((tplRes.headers.get('content-type') || '').length > 0, 'and carry a content type');

  // Then the upload itself. The scoped template carries no Class/Section column
  // because the class is chosen on screen, so the CSV matches that shape.
  const csv = [
    'Name,RollNumber,ParentGuardian,Contact,FeeDues',
    `Bulk Reachable,1,Bulk Parent,${newContact()},0`,
  ].join('\r\n');
  const fd = new FormData();
  fd.append('classId', cls.id);
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'bulk.csv');
  const res = await fetch(`${base}/admin/students/bulk?classId=${cls.id}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
  });
  const body = JSON.parse(await res.text());
  assert.equal(res.status, 201, JSON.stringify(body).slice(0, 300));
  assert.ok(body.data.created.some((s) => s.name === 'Bulk Reachable'));
});

/* ── QA-A1-016 — a named level reads as its name, never its order ──────────── */

test('QA-A1-016: Class History labels a named level by name, not by order', async () => {
  // The named levels the seed always provides; their orders are -1 and 0, which
  // is exactly what used to leak to the screen as "-1 A" and "Class 0A".
  const lkg = levels.find((l) => l.name === 'LKG');
  const ukga = levels.find((l) => l.name === 'UKG');
  const nursery = levels.find((l) => l.name === 'Nursery');
  assert.ok(lkg && ukga && nursery, 'the seed must provide Nursery / LKG / UKG');

  for (const level of [lkg, ukga, nursery]) {
    const sec = nextSection();
    const cls = await makeClass(level.id, sec);
    await makeStudent(cls.id, `${level.name} History Child`);

    // Promote it so a "promoted from <source> — now in <target>" pair exists;
    // both ends of that sentence come from the roster/plan labels under test.
    const plan = (await get(`/admin/class-management/classes/${cls.id}/promotion-plan`)).body.data;
    assert.ok(plan.fromAcademicYear && plan.toAcademicYear, 'a promotion cycle must exist');

    // The Class History roster for THIS year must name the class by its name.
    const roster = (await get(
      `/admin/class-management/years/${plan.fromAcademicYear.id}/classes/${cls.id}/roster`,
    )).body.data;
    const me = roster.find((r) => r.name === `${level.name} History Child`);
    assert.ok(me, 'the child must appear on the current-year roster');
    assert.equal(me.currentClassLabel, `${level.name} ${sec}`,
      `a ${level.name} class must read "${level.name} ${sec}", not its order`);
    assert.doesNotMatch(String(me.currentClassLabel), /-?\d/, 'no order number may leak into a label');
  }
});

test('QA-A1-016: the promote plan labels a named destination by name too', async () => {
  const lkg = levels.find((l) => l.name === 'LKG');
  const sec = nextSection();
  const cls = await makeClass(lkg.id, sec);

  const plan = (await get(`/admin/class-management/classes/${cls.id}/promotion-plan`)).body.data;
  assert.ok(plan.targetClass, 'LKG has a next level (UKG)');
  assert.equal(plan.targetClass.label, `UKG ${sec}`, 'the destination is named, not numbered');
});

test('QA-A1-016: the promote roster (Students review) labels by name', async () => {
  const ukga = levels.find((l) => l.name === 'UKG');
  const sec = nextSection();
  const cls = await makeClass(ukga.id, sec);
  const child = await makeStudent(cls.id, 'Named Roster Child');

  const roster = (await get(`/admin/class-management/classes/${cls.id}/students`)).body.data;
  const me = roster.students.find((s) => s.studentId === child.id);
  assert.ok(me, 'the child must be on the review roster');
  if (roster.targetClass) {
    assert.match(roster.targetClass.label, /^Class \d/, 'UKG promotes into a numbered class');
  }
  assert.doesNotMatch(String(me.promotedFromLabel || ''), /-?\d/);
});

/* ── QA-A1-017 — the preview must not write ────────────────────────────────── */

test('QA-A1-017: opening the promotion review creates no class; cancelling leaves the count unchanged', async () => {
  const lkg = levels.find((l) => l.name === 'LKG');
  const sec = nextSection();
  const cls = await makeClass(lkg.id, sec);
  await makeStudent(cls.id, 'No Orphan Child');

  // A destination id derived the same way the app derives it.
  const targetId = `cls-${String('UKG').toUpperCase()}${sec}`;
  const before = (await get('/admin/classes')).body.data;
  assert.ok(!before.some((c) => c.id === targetId), 'the destination must not exist yet');

  // Open the review (Students) AND the plan — the two read paths. Neither may write.
  const plan = await get(`/admin/class-management/classes/${cls.id}/promotion-plan`);
  const roster = await get(`/admin/class-management/classes/${cls.id}/students`);
  assert.equal(plan.status, 200);
  assert.equal(roster.status, 200);

  // Both report the class WILL be created (so the UI can say so) ...
  assert.equal(plan.body.data.targetClass?.willBeCreated, true, 'the plan says it will be created');
  assert.equal(roster.body.data.targetClass?.willBeCreated, true, 'the roster says it will be created');

  // ... and neither wrote it. "Cancel" is simply not confirming.
  const afterRead = (await get('/admin/classes')).body.data;
  assert.equal(afterRead.length, before.length, 'viewing the review must not change the class count');
  assert.ok(!afterRead.some((c) => c.id === targetId), 'no orphan class was created by viewing');

  // Confirming DOES create it, in the same transaction as the move.
  const child = roster.body.data.students[0];
  const done = await post(`/admin/class-management/classes/${cls.id}/promote`, { confirm: [child.studentId] });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const afterConfirm = (await get('/admin/classes')).body.data;
  assert.ok(afterConfirm.some((c) => c.id === targetId), 'confirming creates the destination class');
});

/* ── QA-A1-010 — the offending field is named ──────────────────────────────── */

test('QA-A1-010: a rejected field comes back with its own message, not a bare "Validation failed"', async () => {
  const cls = await makeClass('1', nextSection());
  const res = await post('/admin/students', {
    classId: cls.id,
    name: 'Negative Fee Child',
    parentName: 'Negative Fee Guardian',
    guardianContact: newContact(),
    feeTotal: -5,
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  assert.equal(res.body.message, 'Validation failed');
  // The per-field map the form now surfaces. This is what QA-A1-010 could not see.
  assert.ok(res.body.errors?.feeTotal, 'the offending field must be named in `errors`');
  assert.match(String(res.body.errors.feeTotal), /too small|>=0|0/i);
});

/* ── the DOB and decimal-fee findings ──────────────────────────────────────── */

test('a future date of birth is refused with "Date of birth cannot be in the future"', async () => {
  const cls = await makeClass('1', nextSection());
  const future = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const res = await post('/admin/students', {
    classId: cls.id,
    name: 'Future Child',
    parentName: 'Future Guardian',
    guardianContact: newContact(),
    dob: future,
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.errors?.dob), /Date of birth cannot be in the future/);
});

test('a today date of birth is accepted (the boundary is inclusive)', async () => {
  const cls = await makeClass('1', nextSection());
  const today = new Date().toISOString().slice(0, 10);
  const res = await post('/admin/students', {
    classId: cls.id,
    name: 'Today Child',
    parentName: 'Today Guardian',
    guardianContact: newContact(),
    dob: today,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
});

test('a decimal fee is refused with "Enter a whole rupee amount"', async () => {
  const cls = await makeClass('1', nextSection());
  const res = await post('/admin/students', {
    classId: cls.id,
    name: 'Decimal Fee Child',
    parentName: 'Decimal Fee Guardian',
    guardianContact: newContact(),
    feeDues: 12.75,
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.errors?.feeDues), /Enter a whole rupee amount/);
});

test('a whole-rupee fee is accepted unchanged', async () => {
  const cls = await makeClass('1', nextSection());
  const res = await post('/admin/students', {
    classId: cls.id,
    name: 'Whole Fee Child',
    parentName: 'Whole Fee Guardian',
    guardianContact: newContact(),
    feeDues: 13000,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.feeDues, 13000, 'the figure the office typed is the figure stored');
});

/* ── Roll numbers after a promotion ─────────────────────────────────────────── */

/* A roll number is unique per (class, year) on the ENROLLMENT, and a promotion
   CLOSES a student's old seat rather than deleting it — that closed row is the
   year's register and still occupies its number. The number enumerator used to
   count students by their CURRENT class pointer, which after a promotion no
   longer includes the children who left. So the number it handed the next
   admission was a number the closed seat still held, and the admission died on
   the unique constraint. This is the exact sequence: fill a class, promote it
   empty, then admit into it again. */

test('a class can admit a new student after its students were promoted out of it', async () => {
  const cls = await makeClass('1', nextSection());

  const first = await makeStudent(cls.id, 'Promoted Away One');
  const second = await makeStudent(cls.id, 'Promoted Away Two');
  assert.ok(first.rollNumber && second.rollNumber, 'both admissions must get a roll number');

  const overview = (await get('/admin/class-management/overview')).body.data;
  const yearId = overview.currentAcademicYear.id;

  // Promote the whole class out. Their seats in this class for this year stay on
  // file (closed), each still holding the roll number it was given.
  const promote = await post(`/admin/class-management/classes/${cls.id}/promote`, {
    confirm: [first.id, second.id],
    exclude: [],
    toAcademicYearId: overview.nextAcademicYear.id,
  });
  assert.equal(promote.status, 200, `promoting the class must succeed: ${JSON.stringify(promote.body)}`);
  assert.equal(promote.body.data.movedCount, 2, 'both students must have moved');

  // The room is now empty of children, but their seats for this year still exist.
  const roster = (await get(`/admin/class-management/years/${yearId}/classes/${cls.id}/roster`)).body.data;
  assert.equal(roster.length, 2, 'the closed seats must remain as this year\'s register');

  // The admission that used to fail: a new child into the same class, same year.
  const admitted = await makeStudent(cls.id, 'Admitted After Promotion');
  assert.ok(admitted.rollNumber, 'the new admission must be given a roll number');

  // And that number must be genuinely free in this class and year.
  const numbers = roster.map((r) => r.rollNumber).filter(Boolean);
  assert.ok(
    !numbers.includes(admitted.rollNumber),
    `the new roll number "${admitted.rollNumber}" is already used by a closed seat: ${JSON.stringify(numbers)}`,
  );
});
