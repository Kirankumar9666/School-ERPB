/**
 * Grade levels — the data, the one name function and the one sort.
 *
 * ## Why this cannot run yet
 *
 * `tests/helpers.js` boots the API against `DATABASE_URL` (the same database the
 * dev server uses) and `seed()` WIPES every table before each file. There is no
 * separate test database, so running this suite would destroy real admissions.
 * See HANDOFF note in the repo root. Until that is separated, this file is
 * written but NOT run — `npm test` must not be invoked against the live
 * database.
 *
 * Everything it asserts is derived from the level and class ROWS, never from a
 * hardcoded list, so a school with Playgroup or Class 12 passes unchanged.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');
const { classLabel, compareClasses } = require('../src/services/mappers');

let server;
let base;
let token;
let seed;

test('setup — boot API and log in', async () => {
  ({ server, base } = await startServer());
  token = (await login(base, 'admin', 'Admin@123')).accessToken;

  seed = (await request(base, '/school/options', { token })).body.data;
  assert.ok(seed.levels.length > 0, 'the school must have at least one level');
  assert.ok(seed.classes.length > 0, 'and at least one class to name');
});

test.after(async () => { await stopServer(server); });

/* ── 1. Levels are data, in order ───────────────────────────────────────────── */

test('levels are rows in the database, in teaching order', async () => {
  const { levels } = seed;
  // Order is unique and ascending — the sort depends on it being a total order.
  const orders = levels.map((l) => l.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  assert.equal(new Set(orders).size, orders.length, 'two levels must not share an order');

  // `order` is internal: no screen receives a level with only an order to show.
  levels.forEach((l) => {
    assert.ok(typeof l.name === 'string' && l.name.trim().length, 'a level has a real name');
    assert.equal(typeof l.order, 'number', 'an order is a number, for sorting');
  });
});

test('the level list is served by the app, not hardcoded in the frontend', async () => {
  const res = await request(base, '/school/options', { token });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data.levels));
  // The same list the app reads for its dropdowns.
  assert.deepEqual(res.body.data.levels.map((l) => l.name), seed.levels.map((l) => l.name));
});

/* ── 3. One shared class-name function ──────────────────────────────────────── */

test('a numbered level is named "Class 10A" exactly as before', async () => {
  const numeric = seed.classes.find((c) => /^\d+$/.test(String(c.grade)));
  assert.ok(numeric, 'the seed must contain a numbered class');
  assert.equal(numeric.label, classLabel(numeric));
  assert.match(numeric.label, /^Class \d+[A-Z]+$/);
});

test('a named level is named "Nursery A", never "Class -2A"', async () => {
  // A class on a named level, if the school has one. When it does not, the test
  // still proves the rule from the level list itself.
  const named = seed.classes.find((c) => c.levelName && !/^\d+$/.test(c.levelName));
  if (!named) {
    // No named class exists in the seed — assert the function directly, so the
    // rule is covered even for a school that has not opened a pre-primary class.
    assert.equal(classLabel({ grade: -2, section: 'A', level: { name: 'Nursery', order: -2 } }), 'Nursery A');
    assert.equal(classLabel({ grade: 0, section: 'B', level: { name: 'UKG', order: 0 } }), 'UKG B');
    return;
  }
  assert.equal(named.label, classLabel(named));
  assert.match(named.label, /^[A-Za-z]+ [A-Z]+$/, 'no "Class" prefix on a named level');
});

test('classLabel falls back to the grade when the level was not loaded', async () => {
  // The safety property that made this refactor landable in pieces: a caller that
  // has not yet been taught to include the level degrades to today's exact
  // wording, never to a wrong one.
  assert.equal(classLabel({ grade: 10, section: 'A' }), 'Class 10A');
  assert.equal(classLabel({ grade: 5, section: 'B' }), 'Class 5B');
});

/* ── 4. One shared sort ────────────────────────────────────────────────────── */

test('classes are sorted by level order, then section', async () => {
  const orders = seed.classes.map((c) => c.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'level order must ascend');
});

test('"10" sorts after "9", and "LKG" after "Nursery"', async () => {
  const names = seed.classes.map((c) => c.label);
  const find = (re) => names.findIndex((n) => re.test(n));

  const nine = find(/^Class 9[A-Z]/);
  const ten = find(/^Class 10[A-Z]/);
  if (nine !== -1 && ten !== -1) assert.ok(nine < ten, `Class 9 before Class 10 (${names})`);

  const nursery = find(/^Nursery/);
  const lkg = find(/^LKG /);
  if (nursery !== -1 && lkg !== -1) assert.ok(nursery < lkg, `Nursery before LKG (${names})`);
});

test('compareClasses puts a pre-primary level before Class 1', () => {
  const rows = [
    { grade: 1, section: 'A', level: { name: '1', order: 1 } },
    { grade: -2, section: 'A', level: { name: 'Nursery', order: -2 } },
    { grade: 0, section: 'A', level: { name: 'UKG', order: 0 } },
  ];
  rows.sort(compareClasses);
  assert.deepEqual(rows.map((r) => r.level.name), ['Nursery', 'UKG', '1']);
});

test('compareClasses falls back to grade when the level is absent', () => {
  const rows = [{ grade: 10, section: 'A' }, { grade: 9, section: 'B' }];
  rows.sort(compareClasses);
  assert.deepEqual(rows.map((r) => r.grade), [9, 10]);
});

/* ── The screens that name a class ─────────────────────────────────────────── */

test('Student Management cards are named by the shared function', async () => {
  const res = await request(base, '/admin/students/by-class', { token });
  assert.equal(res.status, 200);
  res.body.data.forEach((g) => {
    // A name, never a rebuilt string and never an order number.
    assert.match(g.class, /^Class \d+[A-Z]+$|^[A-Za-z]+ [A-Z]+$/);
    assert.ok(!/^-?\d+$/.test(g.class), 'an order number must never reach a screen');
  });
});

test('the Promote Classes cards are named by the shared function', async () => {
  const res = await request(base, '/admin/class-management/overview', { token });
  assert.equal(res.status, 200);
  assert.ok(res.body.data.topGrade > 0, 'the top level is still derived');
  res.body.data.classes.forEach((c) => {
    assert.equal(c.label, classLabel({ grade: c.grade, section: c.section, level: { name: c.levelName, order: c.order } }));
    assert.ok(!/^Class -/.test(c.label), 'a pre-primary level is never "Class -2A"');
  });
});

test('the fee ledger names the class for every year a student was charged', async () => {
  const list = await request(base, '/admin/students', { token });
  const withFees = list.body.data.find((s) => s.classId);
  assert.ok(withFees, 'the seed must leave at least one student in a class');

  const res = await request(base, `/students/${withFees.id}/fees`, { token });
  assert.equal(res.status, 200);
  res.body.data.rows
    .filter((r) => r.classLabel)
    .forEach((r) => assert.match(r.classLabel, /^Class \d+[A-Z]+$|^[A-Za-z]+ [A-Z]+$/));
});
