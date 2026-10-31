/**
 * H1 — the stored "final class" for the school.
 *
 * The school's last year used to be DERIVED in four places using three different
 * rules, which disagreed with each other the moment a class existed above the top
 * one. It is now a fact stored on the level (`GradeLevel.isFinal`), read by all
 * four, with the old derivation as the fallback when nothing is marked.
 *
 * ## DO NOT RUN THIS AGAINST THE LIVE DATABASE
 *
 * `tests/helpers.js` loads `.env.test` and the guard in `src/config/test-env.js`
 * refuses any URL that is not a test database, so the wipe in `seed()` cannot
 * reach the app's data. Never point this at the live Supabase database.
 *
 * Nothing here hardcodes a level list or a class name: every level is read from
 * `/admin/class-levels` and every class is created through the API.
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
const put = (path, body) => request(base, path, { method: 'PUT', token, body });
const del = (path, body) => request(base, path, { method: 'DELETE', token, body });

/* One section per class this file makes, so nothing collides with the seed or
   with another test. Sections are letters only, up to three characters. */
let sectionSeq = 0;
const nextSection = () => {
  sectionSeq += 1;
  const n = sectionSeq - 1;
  return String.fromCharCode(70 + Math.floor(n / 26)) + String.fromCharCode(65 + (n % 26));
};

/** The shared class-name rule: 'Class 9A' for a number, 'LKG A' for a name. */
const levelLabel = (level, section) => (/^\d+$/.test(level.name)
  ? `Class ${level.name}${section}`
  : `${level.name} ${section}`);

const refreshLevels = async () => {
  levels = (await get('/admin/class-levels')).body.data;
  return levels;
};

const setFinal = (levelId) => put('/admin/class-levels/final', { levelId });

const clearFinal = async () => {
  const res = await setFinal(null);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res;
};

const overview = async () => (await get('/admin/class-management/overview')).body.data;

/* Levels this file CREATED, so they can be removed again in `after`. The seeded
   levels are never deleted by this file: `seed()` recreates only what is missing
   and the level rows outlive a wipe, so removing a fixture level would leave the
   rest of the suite (and every later run) pointing at a hole — which is exactly
   the failure this file caused in its first draft. A level this test makes is
   also a level it can safely remove. */
const madeLevels = [];

const makeLevel = async (name, afterId = null, allowAboveFinal = false) => {
  const res = await post('/admin/class-levels', { name, afterId, allowAboveFinal });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  madeLevels.push(res.body.data.id);
  /* Re-read the list: inserting in the middle RENUMBERS every level below the
     insertion point, so any `levels` snapshot taken earlier is stale from here on
     — including the order of the level just created. */
  await refreshLevels();
  return res.body.data;
};

const makeClass = async (levelId, sec = nextSection(), allowAboveFinal = false) => {
  const res = await post('/admin/classes', { levelId, section: sec, allowAboveFinal });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};

/* A unique, valid 10-digit guardian contact per student this file makes. The
   create route requires exactly 10 digits, and a deterministic counter keeps the
   file repeatable while still never colliding with a seed number. */
let contactSeq = 0;
const nextContact = () => {
  contactSeq += 1;
  return `98${String(700000000 + contactSeq).slice(0, 8)}`;
};

const makeStudent = async (classId, name) => {
  const res = await post('/admin/students', {
    classId,
    name,
    parentName: `${name} Guardian`,
    guardianContact: nextContact(),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};

before(async () => {
  ({ server, base } = await startServer());
  token = (await login(base, 'admin', 'Admin@123')).accessToken;
  await refreshLevels();
  assert.ok(levels.length >= 3, 'the seed must leave at least three levels');
  // Every file starts from a school with no final class — the fixture seed resets
  // the flag rather than leaving the previous run's setting behind.
  await clearFinal();
  await refreshLevels();
});

after(async () => {
  await clearFinal();
  /* Remove anything this file added, so the level table is exactly as the file
     found it.

     A level this file put CLASSES on cannot be deleted through the API — the
     route refuses with LEVEL_HAS_CLASSES, and the `.catch` below would swallow it,
     leaving the probe level (and its classes) behind to poison later runs. The
     level table is deliberately NEVER wiped (`fixture-seed.wipe.js` leaves the
     rows alone), so a leak here is permanent. So the classes are removed first,
     directly, then the level rows. */
  const prisma = require('../src/services/prisma');
  for (const id of madeLevels.reverse()) {
    /* A student may have been moved INTO a class on a probe level (the explicit
       promote in the derived-top test does exactly that), and `Student.classId` is
       a foreign key — so the classes cannot be deleted while a child points at
       them. Detach the children first: the class pointer is nulled and this year's
       enrollment seat is removed, both of which the next file's wipe would do
       anyway; the point here is only to leave no dangling reference behind. */
    const classes = await prisma.class.findMany({ where: { levelId: id }, select: { id: true } });
    const classIds = classes.map((c) => c.id);
    if (classIds.length) {
      await prisma.studentEnrollment.deleteMany({ where: { classId: { in: classIds } } });
      await prisma.student.updateMany({ where: { classId: { in: classIds } }, data: { classId: null } });
    }
    await prisma.class.deleteMany({ where: { levelId: id } });
    await del(`/admin/class-levels/${id}`, { confirmed: true }).catch(() => {});
  }
  await stopServer(server);
});

/* ══════════════════════════════════════════════════════════════════════════
   The flag itself
   ══════════════════════════════════════════════════════════════════════════ */

test('final class: only one level can be final at a time', async () => {
  const [first, second] = levels;
  assert.ok(first && second, 'this test needs two levels');

  const one = await setFinal(first.id);
  assert.equal(one.status, 200, JSON.stringify(one.body));

  const two = await setFinal(second.id);
  assert.equal(two.status, 200, JSON.stringify(two.body));

  // The one that mattered: the FIRST level gave the flag up. Setting the second
  // did not leave two finals behind.
  const after = await refreshLevels();
  const finals = after.filter((l) => l.isFinal);
  assert.equal(finals.length, 1, 'exactly one level may be final');
  assert.equal(finals[0].id, second.id, 'and it is the one most recently set');
  assert.equal(after.find((l) => l.id === first.id).isFinal, false, 'the previous final was cleared');

  // Asking for the SAME level again is idempotent, not a conflict: clear-then-set
  // inside the transaction means re-marking never trips the unique index.
  const again = await setFinal(second.id);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal((await refreshLevels()).filter((l) => l.isFinal).length, 1);

  await clearFinal();
});

test('final class: clearing it returns the school to the derived behaviour', async () => {
  await setFinal(levels[0].id);
  assert.equal((await refreshLevels()).filter((l) => l.isFinal).length, 1);

  const cleared = await clearFinal();
  assert.equal(cleared.body.data, null, 'clearing returns no level');
  assert.equal((await refreshLevels()).filter((l) => l.isFinal).length, 0);

  // And the overview falls back, unchanged, to the rule it used before the flag
  // existed — the basis is one of the two derived values, never 'final_class'.
  const ov = await overview();
  assert.notEqual(ov.topGradeBasis, 'final_class');
  assert.ok(
    ['classes_with_students', 'all_classes'].includes(ov.topGradeBasis),
    `an unset final class must fall back to a derived basis, got ${ov.topGradeBasis}`,
  );
});

test('final class: setting an unknown level is a 404, not a silent success', async () => {
  const res = await setFinal('gl-does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'NOT_FOUND');
});

/* ══════════════════════════════════════════════════════════════════════════
   No flag = today's behaviour, exactly
   ══════════════════════════════════════════════════════════════════════════ */

test('no flag: the derived top grade is exactly what it was before the flag', async () => {
  const ov = await overview();
  const carrying = ov.classes.filter((c) => c.studentCount > 0);
  assert.ok(carrying.length > 0, 'the seed must leave a class with students');

  const highestWithStudents = carrying.reduce((a, b) => (b.order > a.order ? b : a));
  assert.equal(ov.topGrade, highestWithStudents.order, 'the highest level with students still wins');
  assert.equal(ov.topGradeBasis, 'classes_with_students');

  // The action split is the same rule as before: the top graduates, the rest promote.
  ov.classes.forEach((c) => {
    if (c.studentCount === 0) assert.equal(c.action, 'none');
    else if (c.order === ov.topGrade) assert.equal(c.action, 'passed_out');
    else if (c.studentCount > 0) assert.equal(c.action, 'promote');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   The empty class above the top — the case the four places disagreed on
   ══════════════════════════════════════════════════════════════════════════ */

test('empty class above the top: the flag makes all four surfaces agree', async () => {
  /* The shape the QA pass found: students up to a level, and an EMPTY class on a
     level above it. Before the flag the four surfaces disagreed, and they
     disagreed in the PERMISSIVE direction: the overview (highest level WITH
     STUDENTS) said the populated class graduates, while the promote guard
     compared against the table-wide max grade — the empty class above — so it did
     NOT refuse, and the children were auto-moved into a class nobody teaches.
     The flag makes the populated level the final class outright, so all four now
     agree it graduates. The unset case is covered by the derived-basis test. */
  const ordered = [...levels].sort((a, b) => a.order - b.order);

  /* Put the seed's own students' level in the middle: build a populated class on
     the SECOND-highest level and an empty class on the highest, so the empty one
     sits strictly above a real one. */
  const populatedLevel = ordered[ordered.length - 2];
  const emptyLevel = ordered[ordered.length - 1];

  const populated = await makeClass(populatedLevel.id);
  const child = await makeStudent(populated.id, 'Agreement Probe Child');
  const empty = await makeClass(emptyLevel.id);

  // The empty class really is empty — otherwise this proves nothing.
  const before = await overview();
  assert.equal(before.classes.find((c) => c.id === empty.id).studentCount, 0);
  assert.equal(before.classes.find((c) => c.id === populated.id).studentCount, 1);

  /* Mark the POPULATED level as final. This is the whole point: the school's last
     year is the one with students, not the empty row above it. */
  await setFinal(populatedLevel.id);

  const ov = await overview();
  assert.equal(ov.topGradeBasis, 'final_class');
  assert.equal(ov.topGrade, populatedLevel.order, 'the stored final decides, not the empty row above');
  assert.equal(ov.topLevelLabel, populatedLevel.name);

  const populatedCard = ov.classes.find((c) => c.id === populated.id);
  const emptyCard = ov.classes.find((c) => c.id === empty.id);
  // Surface 1 — the overview.
  assert.equal(populatedCard.isTop, true);
  assert.equal(populatedCard.action, 'passed_out');
  assert.equal(populatedCard.targetClassId, null);
  assert.equal(populatedCard.noNextLevelReason, 'top');
  assert.equal(emptyCard.action, 'none', 'the empty class above offers nothing');

  // Surface 4 — the roster re-reads the overview and must say the same thing.
  const roster = (await get(`/admin/class-management/classes/${populated.id}/students`)).body.data;
  assert.equal(roster.isTop, true, 'the roster agrees the final class graduates');
  assert.equal(roster.targetClass, null);
  assert.equal(roster.noNextLevelReason, 'top');

  // Surface 3 — the target resolver, via the promotion plan.
  const plan = (await get(`/admin/class-management/classes/${populated.id}/promotion-plan`)).body.data;
  assert.equal(plan.targetClass, null, 'no target above the final class');
  assert.equal(plan.noNextLevelReason, 'top');

  // Surface 2 — the write guard. Refused, and refused as the FINAL class.
  const refused = await post(`/admin/class-management/classes/${populated.id}/promote`, {
    confirm: [child.id],
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'CLASS_IS_TOP');

  /* Now the other half: move the flag DOWN one level, so the populated class is
     no longer the final one and the empty class sits above it. The guard must now
     ALLOW the move — which it refused before the flag existed, because it compared
     against the empty row's grade. */
  await setFinal(ordered[ordered.length - 3].id);
  const allowed = await post(`/admin/class-management/classes/${populated.id}/promote`, {
    confirm: [child.id],
    toClassId: empty.id, // an explicit destination, so the "no next level" path is not what is tested
  });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));

  await clearFinal();
});

/* ══════════════════════════════════════════════════════════════════════════
   Above the final class — OFFERED, never hidden
   ══════════════════════════════════════════════════════════════════════════ */

test('above the final class: levels stay offered and are never deleted or renumbered', async () => {
  const ordered = [...levels].sort((a, b) => a.order - b.order);
  const finalLevel = ordered[ordered.length - 2];
  const above = ordered[ordered.length - 1];

  const ordersBefore = new Map(levels.map((l) => [l.id, l.order]));
  const classesBefore = (await get('/admin/classes')).body.data;

  await setFinal(finalLevel.id);
  const after = await refreshLevels();

  /* The level above the final class is NOT hidden. The app's contract is the one
     `CreateClassModal` implements: every level is listed (marked "above the final
     class"), and choosing it asks for an explicit confirmation. An earlier version
     of this test asserted a filter it built itself — a rule the app never had. */
  assert.equal(after.length, levels.length, 'no level row was removed');
  assert.ok(after.some((l) => l.id === above.id), 'the level above is still listed');
  assert.equal(after.find((l) => l.id === above.id).order, ordersBefore.get(above.id), 'orders unchanged');
  assert.equal(after.find((l) => l.id === above.id).isFinal, false, 'only the chosen level is final');

  const classesAfter = (await get('/admin/classes')).body.data;
  assert.equal(classesAfter.length, classesBefore.length, 'no class was deleted either');

  // Offered, but deliberate: the API refuses a class on it until the caller opts in.
  const sec = nextSection();
  const refused = await post('/admin/classes', { levelId: above.id, section: sec });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'ABOVE_FINAL_CONFIRM');

  const allowed = await post('/admin/classes', { levelId: above.id, section: sec, allowAboveFinal: true });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
  assert.equal(allowed.body.data.label, levelLabel(above, sec), 'the class was created on the level above');

  /* Clearing the flag removes the warning — the level is unchanged, and the same
     create now succeeds without the opt-in. */
  await clearFinal();
  const restored = await refreshLevels();
  assert.equal(restored.filter((l) => l.isFinal).length, 0);
  assert.equal(restored.find((l) => l.id === above.id).order, ordersBefore.get(above.id));
  const noWarning = await post('/admin/classes', { levelId: above.id, section: nextSection() });
  assert.equal(noWarning.status, 201, JSON.stringify(noWarning.body));
});

/* ══════════════════════════════════════════════════════════════════════════
   Deleting the final level
   ══════════════════════════════════════════════════════════════════════════ */

test('deleting the level marked final warns, and only proceeds once confirmed', async () => {
  /* The level is one this test CREATES, not a seeded one. Two reasons, and both
     matter more than they look:

       - a fixture level must not be deleted, because the seed recreates only what
         is missing and the level rows outlive a wipe — removing one would leave a
         hole the whole rest of the suite trips over;
       - a throwaway level is also the honest shape of the scenario: the office
         adds a level, marks it final, then decides it was wrong and removes it.

     Appended at the end (`afterId: null`), so nothing already on file is
     renumbered by its creation or by its removal. */
  const before = await refreshLevels();
  const ordersBefore = new Map(before.map((l) => [l.id, l.order]));

  const target = await makeLevel(`ZZ Final Probe ${before.length}`);

  await setFinal(target.id);
  assert.equal((await refreshLevels()).find((l) => l.id === target.id).isFinal, true, 'the probe level is final');

  // First attempt: refused, with a code the caller can act on, and the level is
  // still there.
  const warned = await del(`/admin/class-levels/${target.id}`);
  assert.equal(warned.status, 409, JSON.stringify(warned.body));
  assert.equal(warned.body.code, 'FINAL_LEVEL_CONFIRM');
  assert.match(warned.body.message, /final class/i, 'the warning says what will be cleared');
  assert.ok((await refreshLevels()).some((l) => l.id === target.id), 'the refusal deleted nothing');

  // Second attempt, confirmed: it goes through, and the message says the setting
  // was cleared rather than quietly dropping it.
  const done = await del(`/admin/class-levels/${target.id}`, { confirmed: true });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.match(done.body.message, /cleared/i, 'the message reports the cleared setting');
  assert.ok(!(await refreshLevels()).some((l) => l.id === target.id), 'the level is gone');
  assert.equal((await refreshLevels()).filter((l) => l.isFinal).length, 0, 'and nothing is final now');

  /* The seeded levels are untouched: same rows, same orders. This is the
     assertion that would have caught the first draft's damage. */
  const after = await refreshLevels();
  const seeded = after.filter((l) => ordersBefore.has(l.id));
  assert.equal(seeded.length, ordersBefore.size, 'every seeded level is still on file');
  seeded.forEach((l) => {
    assert.equal(l.order, ordersBefore.get(l.id), `seeded level ${l.name} kept its order`);
  });

  // Drop it from the cleanup list too — it is already gone.
  const i = madeLevels.indexOf(target.id);
  if (i !== -1) madeLevels.splice(i, 1);
});

/* ══════════════════════════════════════════════════════════════════════════
   The flag survives a re-seed — the leak the wipe had to close
   ══════════════════════════════════════════════════════════════════════════ */

test('final class: a re-seed resets the flag, so one test file cannot leak into the next', async () => {
  const { seed } = require('../prisma/seed');
  const prisma = require('../src/services/prisma');

  await setFinal(levels[0].id);
  assert.equal((await refreshLevels()).filter((l) => l.isFinal).length, 1);

  /* A full re-seed, exactly as the next test file would experience it. The level
     ROWS survive (they always did — `seed()` inserts them with skipDuplicates),
     so the flag must be reset explicitly or the next file would start with this
     one's setting still in place. */
  await seed();

  const after = await prisma.gradeLevel.findMany();
  assert.ok(after.length > 0, 'the re-seed must leave the level rows');
  assert.equal(
    after.filter((l) => l.isFinal).length,
    0,
    'a re-seed must clear the final class, or the setting leaks across test files',
  );

  const ov = await overview();
  assert.notEqual(ov.topGradeBasis, 'final_class');
  assert.ok(['classes_with_students', 'all_classes'].includes(ov.topGradeBasis));

  await refreshLevels();
});

/* ══════════════════════════════════════════════════════════════════════════
   FIX 1 — ONE shared derived-top rule (the behaviour change)

   With NO flag set, a populated lower class and an EMPTY class above it: the
   automatic promote is now REFUSED. The old rule (table-wide max grade) let it
   through and moved children into a class nobody teaches; the shared derived top
   (highest level WITH students) refuses it. This test holds the NEW behaviour and
   proves the OLD guard would have allowed the move.
   ══════════════════════════════════════════════════════════════════════════ */

test('no flag: promoting into an EMPTY higher class is refused (the shared derived top)', async () => {
  await clearFinal(); // the whole test is about the unset case

  /* The seeded top level is already populated (Class 10A). So the empty class must
     sit on a level ABOVE everything on file — one this test creates — while the
     populated source is the seed's own highest level carrying students. That is
     exactly the shape the old rule got wrong: `source.grade (10) >= table max (11)`
     is FALSE, so the old guard allowed the move into a class nobody teaches. */
  const ovBefore = await overview();
  const carrying = ovBefore.classes.filter((c) => c.studentCount > 0);
  assert.ok(carrying.length > 0, 'the seed must leave a class with students');
  const populatedCard = carrying.reduce((a, b) => (b.order > a.order ? b : a));

  /* A student this test creates on the populated class, so the promotion roster
     (which reads the year's enrollment seats) definitely has someone to attempt to
     move — the seeded students may hold a classId without a seat row. */
  const child = await makeStudent(populatedCard.id, 'Derived Top Probe Child');

  const maxOrder = Math.max(...ovBefore.classes.map((c) => c.order));
  const emptyLevel = await makeLevel(`TopProbe ${Date.now().toString().slice(-6)}`, null, true);
  assert.ok(emptyLevel.order > maxOrder, 'the throwaway level sits above everything on file');
  const empty = await makeClass(emptyLevel.id); // created, then left empty

  // Prove the empty class really is above the populated one and holds nobody.
  const ov = await overview();
  assert.equal(ov.classes.find((c) => c.id === empty.id).studentCount, 0);
  assert.ok(ov.classes.find((c) => c.id === populatedCard.id).studentCount > 0);
  assert.ok(emptyLevel.order > populatedCard.order, 'the empty class sits above the populated one');

  /* The OLD rule, spelled out: `source.grade (populated order) >= max grade over
     ALL classes (the empty level's order)` is FALSE, so the old guard did NOT
     throw and allowed the move. This is the permissiveness the fix closes. */
  const oldMaxGrade = Math.max(...ov.classes.map((c) => c.order));
  assert.equal(
    populatedCard.order >= oldMaxGrade,
    false,
    'the old table-wide guard would NOT have refused this — proving the old behaviour was permissive',
  );

  // The shared derived top is the highest level WITH students: the populated one.
  assert.equal(ov.topGradeBasis, 'classes_with_students');
  assert.equal(ov.topGrade, populatedCard.order);

  // And the write path refuses the automatic promote with CLASS_IS_TOP.
  const refused = await post(`/admin/class-management/classes/${populatedCard.id}/promote`, {
    confirm: [child.id],
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'CLASS_IS_TOP');

  // Nothing moved: the child is still on the populated class.
  const roster = (await get(`/admin/class-management/classes/${populatedCard.id}/students`)).body.data;
  assert.ok(roster.students.some((s) => s.studentId === child.id), 'the child stayed put');

  // An EXPLICIT destination stays available — that is the deliberate path.
  const explicit = await post(`/admin/class-management/classes/${populatedCard.id}/promote`, {
    confirm: [child.id],
    toClassId: empty.id,
  });
  assert.equal(explicit.status, 200, JSON.stringify(explicit.body));
});

/* ══════════════════════════════════════════════════════════════════════════
   FIX 2 — the resolver-level guard, inherited by BOTH write paths
   ══════════════════════════════════════════════════════════════════════════ */

test('single-student move: out of the final class is refused, an explicit above-final class works', async () => {
  const ordered = [...levels].sort((a, b) => a.order - b.order);
  const finalLevel = ordered[ordered.length - 2];
  const above = ordered[ordered.length - 1];

  const finalClass = await makeClass(finalLevel.id);
  const child = await makeStudent(finalClass.id, 'Move Guard Probe Child');
  const aboveClass = await makeClass(above.id);

  await setFinal(finalLevel.id);

  /* moveStudent had NO CLASS_IS_TOP check at all before this pass — this is the
     path the resolver guard now covers. */
  const refused = await post(`/admin/class-management/students/${child.id}/move`, {
    action: 'promote',
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'CLASS_IS_TOP');

  // Explicit target above the final still works — it is the visible, deliberate path.
  const explicit = await post(`/admin/class-management/students/${child.id}/move`, {
    action: 'promote',
    toClassId: aboveClass.id,
  });
  assert.equal(explicit.status, 200, JSON.stringify(explicit.body));

  await clearFinal();
});

/* ══════════════════════════════════════════════════════════════════════════
   POLICY (B) — above-final creation is allowed, but EXPLICIT
   ══════════════════════════════════════════════════════════════════════════ */

test('above-final level: refused without the opt-in (409 ABOVE_FINAL_CONFIRM), allowed with it', async () => {
  const ordered = [...levels].sort((a, b) => a.order - b.order);
  const finalLevel = ordered[ordered.length - 2];
  await setFinal(finalLevel.id);

  const name = `AboveFinalLvl ${Date.now().toString().slice(-5)}`;

  // No opt-in: refused once, named against the final class, nothing written.
  const refused = await post('/admin/class-levels', { name, afterId: finalLevel.id });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'ABOVE_FINAL_CONFIRM');
  assert.match(refused.body.message, new RegExp(finalLevel.name, 'i'), 'the message names the final class');
  assert.match(refused.body.message, /above/i, 'and says the new level sits above it');
  assert.ok(!(await refreshLevels()).some((l) => l.name === name), 'the refusal wrote nothing');

  // With the opt-in: it goes through.
  const allowed = await post('/admin/class-levels', { name, afterId: finalLevel.id, allowAboveFinal: true });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
  madeLevels.push(allowed.body.data.id);
  assert.ok((await refreshLevels()).some((l) => l.id === allowed.body.data.id), 'the level now exists');

  await clearFinal();
});

test('above-final class: refused without the opt-in (409 ABOVE_FINAL_CONFIRM), allowed with it', async () => {
  const ordered = [...levels].sort((a, b) => a.order - b.order);
  const finalLevel = ordered[ordered.length - 2];
  const above = ordered[ordered.length - 1];

  /* A throwaway level ABOVE the final one, so the class target is genuinely
     above-final regardless of what the seed left on file. */
  const aboveLevel = await makeLevel(`AboveProbe ${Date.now().toString().slice(-6)}`, finalLevel.id, true);
  await setFinal(finalLevel.id);

  const sec = nextSection();

  const refused = await post('/admin/classes', { levelId: aboveLevel.id, section: sec });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'ABOVE_FINAL_CONFIRM');
  assert.match(refused.body.message, new RegExp(finalLevel.name, 'i'), 'the message names the final class');

  const allowed = await post('/admin/classes', { levelId: aboveLevel.id, section: sec, allowAboveFinal: true });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body));

  /* A SECOND section of the SAME already-above-final level is asked AGAIN — the
     documented choice: no standing exemption, so the decision stays visible. */
  const again = await post('/admin/classes', { levelId: aboveLevel.id, section: nextSection() });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.code, 'ABOVE_FINAL_CONFIRM', 'a second above-final class asks again');

  /* With NO final class set, nothing is above anything: no flag needed. */
  await clearFinal();
  const noFlag = await post('/admin/classes', { levelId: aboveLevel.id, section: nextSection() });
  assert.equal(noFlag.status, 201, JSON.stringify(noFlag.body));
});

/* ══════════════════════════════════════════════════════════════════════════
   FIX 4 — the attendance label uses the shared classLabel
   ══════════════════════════════════════════════════════════════════════════ */

test('attendance label: a named level does not read as its order number', async () => {
  await clearFinal(); // a final class above this level would refuse its creation
  /* LKG has order -1 and UKG order 0 — the two levels whose ORDER is not a name.
     The old hand-built label would print "-1 A" / "Class 0A"; the shared
     classLabel prints the level name. Read from the level list, never hardcoded. */
  const ordered = [...levels].sort((a, b) => a.order - b.order);
  const named = ordered.find((l) => !/^\d+$/.test(l.name));
  assert.ok(named, 'the seed must leave a named level (Nursery/LKG/UKG)');

  const today = new Date().toISOString().slice(0, 10);
  const cls = await makeClass(named.id);
  const res = await get(`/admin/attendance/group?kind=student&groupKey=${cls.id}&date=${today}&session=FN`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const label = res.body.data.label;

  assert.equal(label, `${named.name} ${cls.section}`, 'a named level reads as its own name');
  assert.ok(!/-?\d+\s*-\s*Class/.test(label), 'never the old hand-built "grade - Class X" shape');
  assert.ok(!label.includes(String(named.order)), 'never the level ORDER number for a named level');
});

test('attendance label: a numbered level reads "Class 10A"', async () => {
  await clearFinal();
  const ordered = [...levels].sort((a, b) => a.order - b.order);
  const numbered = ordered.filter((l) => /^\d+$/.test(l.name)).pop();
  assert.ok(numbered, 'the seed must leave a numbered level');

  const today = new Date().toISOString().slice(0, 10);
  const cls = await makeClass(numbered.id);
  const res = await get(`/admin/attendance/group?kind=student&groupKey=${cls.id}&date=${today}&session=FN`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.label, `Class ${numbered.name}${cls.section}`);
});

/* ══════════════════════════════════════════════════════════════════════════
   F1 — the READ surfaces use the SAME `>=` as the write guard

   The drift this file exists to prevent survived in one place: the overview and
   the roster asked `order === top`, while the guard refused `order >= top`. A
   populated class ABOVE the stored final therefore offered a Promote the server
   rejected with CLASS_IS_TOP. The shape is normal under policy (B): a school
   marks Class 10 final and still runs Class 11 above it.
   ══════════════════════════════════════════════════════════════════════════ */

test('F1: a populated class ABOVE the final reads as graduated everywhere and is refused', async () => {
  /* Re-read the level list: earlier tests insert levels in the middle, which
     renumbers those below, so a snapshot taken at boot can name the wrong order. */
  await refreshLevels();
  const ordered = [...levels].sort((a, b) => a.order - b.order);
  const finalLevel = ordered[ordered.length - 1];
  await setFinal(finalLevel.id);

  /* Two throwaway levels ABOVE the stored final: the populated class sits on the
     first, and the second exists so that `nextClassFor` really does resolve a
     target for it. Under the old `===` the overview would report
     `action: 'promote'` with that target — which is exactly the promise this test
     refuses to let the screen make. */
  const aboveLevel = await makeLevel(`AboveRead ${Date.now().toString().slice(-6)}`, null, true);
  const furtherLevel = await makeLevel(`AboveFurther ${Date.now().toString().slice(-5)}`, null, true);
  assert.ok(furtherLevel.order > aboveLevel.order, 'a level exists above the populated one too');

  const aboveClass = await makeClass(aboveLevel.id, nextSection(), true);
  const child = await makeStudent(aboveClass.id, 'Above Final Probe Child');
  const furtherClass = await makeClass(furtherLevel.id, aboveClass.section, true);

  const ov = await overview();
  assert.equal(ov.topGradeBasis, 'final_class');
  assert.equal(ov.topGrade, finalLevel.order, 'the stored final decides');

  const card = ov.classes.find((c) => c.id === aboveClass.id);
  assert.ok(card, 'the above-final class is on the overview');
  assert.ok(card.order > finalLevel.order, 'it really sits above the stored final');
  assert.ok(
    ov.classes.some((c) => c.order > card.order),
    'a further level exists, so the old equality rule WOULD have offered a target',
  );

  // Surface 1 — the overview. `===` fails all of these.
  assert.equal(card.isTop, true, 'at or above the top counts as top');
  assert.equal(card.isAboveFinal, true, 'and it is reported as above the final, not as the final itself');
  assert.equal(card.action, 'passed_out', 'never "promote" for a class the guard will refuse');
  assert.equal(card.targetClassId, null);
  assert.equal(card.targetClassLabel, null);
  assert.equal(card.targetWillBeCreated, false);
  assert.equal(card.noNextLevelReason, 'top');

  // Surface 2 — the roster.
  const roster = (await get(`/admin/class-management/classes/${aboveClass.id}/students`)).body.data;
  assert.equal(roster.isTop, true, 'the roster agrees');
  assert.equal(roster.isAboveFinal, true);
  assert.equal(roster.targetClass, null, 'no destination is offered');
  assert.equal(roster.noNextLevelReason, 'top');

  // Surface 3 — the plan behind the review screen, which reads the overview.
  const plan = (await get(`/admin/class-management/classes/${aboveClass.id}/promotion-plan`)).body.data;
  assert.equal(plan.targetClass, null);
  assert.equal(plan.noNextLevelReason, 'top');

  // Surface 4 — the write guard. Same answer, so the screens never lie.
  const refused = await post(`/admin/class-management/classes/${aboveClass.id}/promote`, {
    confirm: [child.id],
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'CLASS_IS_TOP');

  // The explicit path stays open: choosing a real class above the final works.
  const explicit = await post(`/admin/class-management/classes/${aboveClass.id}/promote`, {
    confirm: [child.id],
    toClassId: furtherClass.id,
  });
  assert.equal(explicit.status, 200, JSON.stringify(explicit.body));

  await clearFinal();
});

/* ══════════════════════════════════════════════════════════════════════════
   F3 — the single-student popup does not DEFAULT to an above-final class

   The server owns the suggestion, so the guarantee is testable at the API: a
   student at or above the final class is offered their own class as the default,
   while the above-final class stays in the list (with `aboveFinal: true`) for the
   admin to choose deliberately.
   ══════════════════════════════════════════════════════════════════════════ */

test('F3: promotion-options never defaults a student at/above the final into a class above it', async () => {
  await refreshLevels();
  const ordered = [...levels].sort((a, b) => a.order - b.order);
  const finalLevel = ordered[ordered.length - 1];
  await setFinal(finalLevel.id);

  const aboveLevel = await makeLevel(`AboveDefault ${Date.now().toString().slice(-6)}`, null, true);
  const furtherLevel = await makeLevel(`AboveDefault2 ${Date.now().toString().slice(-5)}`, null, true);
  assert.ok(furtherLevel.order > aboveLevel.order);

  // The student AT the final class: the naive suggestion would be the class on
  // the next level, which is above the final.
  const atFinal = await makeClass(finalLevel.id);
  const atFinalChild = await makeStudent(atFinal.id, 'At Final Default Child');
  const aboveClass = await makeClass(aboveLevel.id, atFinal.section, true);
  const furtherClass = await makeClass(furtherLevel.id, atFinal.section, true);

  const atOptions = (await get(
    `/admin/class-management/students/${atFinalChild.id}/promotion-options`,
  )).body.data;

  assert.equal(atOptions.currentClass.id, atFinal.id);
  assert.equal(atOptions.currentClass.aboveFinal, false, 'the final class is not above itself');
  assert.ok(atOptions.suggestedClass, 'there is still a default to show');
  assert.equal(
    atOptions.suggestedClass.id,
    atFinal.id,
    'the default is the student\'s own class — "stay back" — not the above-final class',
  );
  assert.notEqual(atOptions.suggestedClass.id, aboveClass.id);
  assert.notEqual(atOptions.suggestedClass.id, furtherClass.id);

  // The above-final class is still OFFERED — the explicit path stays visible.
  const offeredAbove = atOptions.classes.find((c) => c.id === aboveClass.id);
  assert.ok(offeredAbove, 'the class above the final is still in the dropdown');
  assert.equal(offeredAbove.aboveFinal, true);

  // A student already ABOVE the final gets the same treatment: own class, never a
  // further class above them.
  const aboveChild = await makeStudent(aboveClass.id, 'Above Final Default Child');
  const aboveOptions = (await get(
    `/admin/class-management/students/${aboveChild.id}/promotion-options`,
  )).body.data;
  assert.equal(aboveOptions.suggestedClass.id, aboveClass.id, 'default is the student\'s own class');
  assert.notEqual(aboveOptions.suggestedClass.id, furtherClass.id);

  await clearFinal();
});

/* ══════════════════════════════════════════════════════════════════════════
   Bulk graduation must respect decisions already made this cycle
   ══════════════════════════════════════════════════════════════════════════ */

/* A child kept back to repeat the year still holds the class pointer — that is
   what "keep back in the same class" means — but their newest active seat is in
   the NEXT year. `passOutClass` used to graduate every pointer, so the one child
   the office deliberately retained had their new seat flipped to `passed_out`
   and their class cleared: the bulk button silently undid a human decision.

   This pins both halves of the fix: the write skips later-year seats, and the
   confirmation counts the same batch (`passOutCount`) instead of the headcount. */
test('bulk graduation: a child already kept back for the new year is left alone', async () => {
  await refreshLevels();
  const ordered = [...levels].sort((a, b) => a.order - b.order);
  const finalLevel = ordered[ordered.length - 1];
  await setFinal(finalLevel.id);

  const cls = await makeClass(finalLevel.id);
  const repeater = await makeStudent(cls.id, 'Kept Back Child');
  const leaver = await makeStudent(cls.id, 'Graduating Child');

  const before = await overview();
  const yearId = before.currentAcademicYear.id;
  const beforeClass = before.classes.find((c) => c.id === cls.id);
  assert.equal(beforeClass.studentCount, 2);
  assert.equal(beforeClass.passOutCount, 2, 'both children start in the graduating batch');

  const keep = await post(`/admin/class-management/students/${repeater.id}/move`, { action: 'keep' });
  assert.equal(keep.status, 200, JSON.stringify(keep.body));

  const afterKeep = (await overview()).classes.find((c) => c.id === cls.id);
  assert.equal(afterKeep.studentCount, 2, 'the repeater still points at the class — that is the point of keeping them');
  assert.equal(afterKeep.remainingCount, 1);
  assert.equal(
    afterKeep.passOutCount,
    1,
    'the confirmation must count only the child still to decide, not the whole class',
  );

  const out = await post(`/admin/class-management/classes/${cls.id}/pass-out`, {});
  assert.equal(out.status, 200, `bulk graduation should succeed: ${JSON.stringify(out.body)}`);
  assert.equal(out.body.data.passedOutCount, 1, 'exactly one child graduates');
  assert.equal(out.body.data.students[0].studentId, leaver.id, 'and it is the one who was still to decide');

  const prisma = require('../src/services/prisma');

  // The graduate: no current class, and this year's seat is closed.
  const grad = await prisma.student.findUnique({ where: { id: leaver.id } });
  assert.equal(grad.classId, null);
  const gradSeat = await prisma.studentEnrollment.findFirst({
    where: { studentId: leaver.id, academicYearId: yearId },
  });
  if (gradSeat) assert.equal(gradSeat.status, 'passed_out');

  // The repeater: pointer untouched, and their next-year seat is still open.
  const kept = await prisma.student.findUnique({ where: { id: repeater.id } });
  assert.equal(kept.classId, cls.id, 'the kept-back child must keep their class');
  const keptSeats = await prisma.studentEnrollment.findMany({
    where: { studentId: repeater.id, status: 'active' },
  });
  assert.equal(keptSeats.length, 1, 'the repeated year stays active');
  assert.equal(keptSeats[0].classId, cls.id);

  // And the class is not left offering a button that would graduate nobody.
  const end = (await overview()).classes.find((c) => c.id === cls.id);
  assert.equal(end.passOutCount, 0);
  await clearFinal();
});
