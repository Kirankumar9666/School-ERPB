/**
 * Student Management screens — Create Class, Add Level, class delete, and the
 * student-login removal on delete.
 *
 * ## DO NOT RUN THIS AGAINST THE LIVE DATABASE
 *
 * `tests/helpers.js` boots against `DATABASE_URL` (the same database the dev
 * server uses) and `seed()` WIPES every table. There is still no separate test
 * database. See the handoff note in the repo root. This file is written for the
 * day that separation exists, and is the API-level mirror of what the live
 * verification proved.
 *
 * Everything is derived from the level and class ROWS, so a school with Playgroup
 * or Class 12 passes unchanged.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

let server;
let base;
let token;
let levels;
const created = { classes: [], students: [], levels: [] };

/** A section no seeded class uses, so the test never collides with real data. */
const SEC = String.fromCharCode(81 + Math.floor(Math.random() * 8))
  + String.fromCharCode(65 + Math.floor(Math.random() * 26));

before(async () => {
  ({ server, base } = await startServer());
  token = (await login(base, 'admin', 'Admin@123')).accessToken;
  levels = (await request(base, '/admin/class-levels', { token })).body.data;
  assert.ok(levels.length > 0, 'the seed must leave levels');
});

after(async () => {
  for (const id of created.students) {
    await request(base, `/admin/students/${id}`, { method: 'DELETE', token }).catch(() => {});
  }
  for (const id of created.classes) {
    await request(base, `/admin/classes/${id}`, { method: 'DELETE', token }).catch(() => {});
  }
  for (const id of created.levels) {
    await request(base, `/admin/class-levels/${id}`, { method: 'DELETE', token }).catch(() => {});
  }
  await stopServer(server);
});

const post = (path, body) => request(base, path, { method: 'POST', token, body });
const get = (path) => request(base, path, { token });

/* ── Create Class ─────────────────────────────────────────────────────────── */

test('the level dropdown reads from the table, in order, with no order shown', async () => {
  const res = await get('/admin/class-levels');
  assert.equal(res.status, 200);
  const orders = res.body.data.map((l) => l.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  // No level is exposed with only its order: the name is the display value.
  res.body.data.forEach((l) => {
    assert.ok(typeof l.name === 'string' && l.name.trim().length);
  });
});

test('a class can be created, and reports the message the toast shows', async () => {
  const level = levels[0];
  const res = await post('/admin/classes', { levelId: level.id, section: SEC });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  // The toast names the class exactly as every screen spells it, derived from the
  // level rather than hardcoded: "LKG B created" for a named level, "Class 5B
  // created" for a numbered one.
  const want = /^\d+$/.test(level.name) ? `Class ${level.name}${SEC}` : `${level.name} ${SEC}`;
  assert.equal(res.body.message, `${want} created`, 'the toast names the class exactly');
  created.classes.push(res.body.data.id);
});

test('the same level and section is refused with "already exists"', async () => {
  const level = levels.find((l) => l.name === 'LKG') || levels[0];
  const made = await post('/admin/classes', { levelId: level.id, section: SEC });
  // If the previous test created on another level, this is a fresh create.
  if (made.status === 201) {
    created.classes.push(made.body.data.id);
  }
  const dupe = await post('/admin/classes', { levelId: level.id, section: SEC });
  assert.equal(dupe.status, 409, JSON.stringify(dupe.body));
  assert.equal(dupe.body.code, 'DUPLICATE');
  assert.match(dupe.body.message, /already exists/);
});

test('a new class shows as a card with 0 students, 0 dues and no marks', async () => {
  const rows = (await get('/admin/students/by-class')).body.data;
  const mine = rows.find((r) => r.section === SEC);
  assert.ok(mine, `the new class must appear as a card, got ${rows.map((r) => r.class).join(',')}`);
  assert.equal(mine.totalStudents, 0);
  assert.equal(mine.feeDues, 0);
  assert.equal(mine.avgMarks, null, 'no marks recorded yet');
  // The card carries the real class id, so it can be acted on.
  assert.ok(mine.id && mine.id !== mine.key);
});

test('the new class appears in the shared class list every dropdown reads', async () => {
  const classes = (await get('/school/options')).body.data.classes;
  const mine = classes.find((c) => c.section === SEC);
  assert.ok(mine, 'the shared list must include it');
  assert.equal(mine.studentCount, 0);
});

/* ── Add Level ─────────────────────────────────────────────────────────────── */

test('a level can be added between two others, and everything below moves', async () => {
  const ukgg = levels.find((l) => l.name === 'UKG');
  const added = await post('/admin/class-levels', { name: 'Playgroup', afterId: ukgg.id });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  created.levels.push(added.body.data.id);

  const after = (await get('/admin/class-levels')).body.data;
  const names = after.map((l) => l.name);
  assert.equal(names.indexOf('Playgroup'), names.indexOf('UKG') + 1, 'it sits after UKG');

  const orders = after.map((l) => l.order);
  assert.ok(orders.every((o, i) => i === 0 || orders[i - 1] < o), 'orders stay unique');

  const one = after.find((l) => l.name === '1');
  const beforeOne = levels.find((l) => l.name === '1');
  assert.equal(one.order, beforeOne.order + 1, 'Class 1 moved down one');
});

test('a duplicate level name is refused, ignoring case', async () => {
  const res = await post('/admin/class-levels', { name: 'playgroup' });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'DUPLICATE_LEVEL');
});

test('classes of a renumbered level follow their level', async () => {
  const added = (await get('/admin/class-levels')).body.data.find((l) => l.name === 'Playgroup');
  assert.ok(added, 'the added level must still be there');
  const classes = (await get('/admin/classes')).body.data;
  const levelOrders = new Map((await get('/admin/class-levels')).body.data.map((l) => [l.id, l.order]));
  const drifted = classes.filter((c) => c.level && c.order !== levelOrders.get(c.levelId));
  assert.deepEqual(drifted, [], 'every class grade must equal its level order');
});

/* ── Delete ────────────────────────────────────────────────────────────────── */

test('an empty class can be deleted', async () => {
  const classes = (await get('/admin/classes')).body.data;
  const empty = classes.find((c) => c.studentCount === 0);
  assert.ok(empty, 'the seed must leave an empty class');
  const res = await request(base, `/admin/classes/${empty.id}`, { method: 'DELETE', token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(!(await get('/admin/classes')).body.data.some((c) => c.id === empty.id));
});

test('a class with students cannot be deleted, and says why', async () => {
  const busy = (await get('/admin/classes')).body.data.find((c) => c.studentCount > 0);
  assert.ok(busy, 'the seed must leave a class with students');
  const res = await request(base, `/admin/classes/${busy.id}`, { method: 'DELETE', token });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'CLASS_HAS_RECORDS');
  assert.match(res.body.message, /students/);
});

test('a level that has classes cannot be deleted', async () => {
  const withClasses = (await get('/admin/class-levels')).body.data.find((l) => l.classCount > 0);
  assert.ok(withClasses, 'the seed must leave a level with classes');
  const res = await request(base, `/admin/class-levels/${withClasses.id}`, { method: 'DELETE', token });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'LEVEL_HAS_CLASSES');
});

/* ── Student login on delete ───────────────────────────────────────────────── */

test('deleting a student removes their login account', async () => {
  const cls = (await get('/admin/classes')).body.data.find((c) => c.studentCount > 0);
  const made = await post('/admin/students', {
    classId: cls.id, name: 'Login Probe One',
    parentName: 'Login Probe One Guardian', guardianContact: '9800001234',
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.ok(made.body.data.account, 'the student must have a login');

  const del = await request(base, `/admin/students/${made.body.data.id}`, { method: 'DELETE', token });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body.data.accountRemoved, true);
});

test('a student with no login at all still deletes cleanly', async () => {
  const cls = (await get('/admin/classes')).body.data.find((c) => c.studentCount > 0);
  /* A legacy record with no guardian and no login: written straight to the
     database exactly the way such a row exists in a real school (admitted
     before guardian fields were required, or imported from a register without
     them). Add Student can no longer produce one, so the delete path's handling
     of an accountless student is exercised on the shape that actually remains. */
  const prisma = require('../src/services/prisma');
  const row = await prisma.student.create({
    data: {
      id: `stu-nologin-${Date.now()}`,
      name: 'Login Probe Two',
      classId: cls.id,
    },
  });
  const enrollment = require('../src/services/enrollment');
  await enrollment.syncLiveEnrollment(prisma, row.id);

  const del = await request(base, `/admin/students/${row.id}`, { method: 'DELETE', token });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body.data.accountRemoved, false, 'a student with no login has no account to remove');
});
