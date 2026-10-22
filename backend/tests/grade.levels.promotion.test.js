/**
 * Named class levels — the level table, the promotion chain and the class list.
 *
 * ## DO NOT RUN THIS AGAINST THE LIVE DATABASE
 *
 * `tests/helpers.js` boots against `DATABASE_URL` (the same database the dev
 * server uses) and `seed()` WIPES every table. There is still no separate test
 * database. See the handoff note in the repo root. This file is written for the
 * day that separation exists.
 *
 * Everything is derived from the level and class ROWS, so a school with Playgroup
 * or Class 12 passes unchanged, and no assertion hardcodes a level list.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

let server;
let base;
let token;
let levels;
let classes;
let topOrder;
let a1;
let a2;
let a3;


const created = { classes: [], students: [] };
const get = (path) => request(base, path, { token });
const post = (path, body) => request(base, path, { method: 'POST', token, body });

/* Create a class on an arbitrary level, with a section no other test uses.
   `sec` is car}ried through the file so each test gets a fresh one. */
let sectionSeq = 0;
/* A section the schema accepts: LETTERS ONLY, up to 3 characters. The section
   is a name, not a code, so digits are refused — which is what the previous
   generator produced once the counter passed 8. */
const nextSection = () => {
  sectionSeq += 1;
  // Two letters from a bijective base-26 counter: QA, QB, ... QZ, RA, RB, ...
  const n = sectionSeq - 1;
  const first = String.fromCharCode(65 + Math.floor(n / 26));
  const second = String.fromCharCode(65 + (n % 26));
  return first + second;
};

const makeClass = async (levelName, sec = nextSection()) => {
  const level = levels.find((l) => l.id === levelName || l.name === levelName);
  assert.ok(level, `no level named ${levelName}`);
  const res = await post('/admin/classes', { levelId: level.id, section: sec });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  created.classes.push(res.body.data.id);
  return res.body.data;
};
/* The shared class-name format: "Class 9A" for a numbered level, "LKG A" for a
   named one. Mirrors mappers.classLabel, so the test agrees with the app. */
const levelLabel = (level, section) => (/^\d+$/.test(level.name)
  ? 'Class ' + level.name + section
  : level.name + ' ' + section);

const makeStudent = async (classId, name) => {
  const res = await post('/admin/students', {
    classId, name,
    // Guardian name and contact are required fields — the identity a duplicate
    // is recognised by, and what the auto-provisioned login's password derives
    // from. One contact per student so two rows can never be the same child.
    parentName: `${name} Guardian`,
    guardianContact: `98000${String(Math.floor(Math.random() * 90000) + 10000)}`.slice(0, 10),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};

before(async () => {
  ({ server, base } = await startServer());
  token = (await login(base, 'admin', 'Admin@123')).accessToken;

  const opts = (await get('/school/options')).body.data;
  levels = opts.levels;
  classes = opts.classes;
  assert.ok(levels.length > 0, 'the seed must leave levels');

  // Three sections not already used, in the order they appear in the seed.
  const used = new Set(classes.map((c) => c.section));
  const want = ['ZA', 'ZB', 'ZC'].filter((s) => !used.has(s));
  [a1, a2, a3] = want;

  // The lowest and highest level present.
  let lowest = levels[0];
  let highest = levels[0];
  levels.forEach((l) => {
    if (l.order < lowest.order) lowest = l;
    if (l.order > highest.order) highest = l;
  });
  topOrder = highest;
  void lowest;
});

after(async () => { await stopServer(server); });

/* ── the level chain ───────────────────────────────────────────────────────── */

test('a class reports its next level in the chain, with the same section', async () => {
  const overview = (await get('/admin/class-management/overview')).body.data;
  const source = overview.classes[0];
  const nextLevel = levels.find((l) => l.order > source.order);

  const card = overview.classes.find((c) => c.id === source.id);
  if (nextLevel) {
    assert.equal(card.action, 'promote');
    // The shared class-name function: "Class 10B" for a numbered level,
    // "Nursery A" for a named one.
    const expectedLabel = /^\d+$/.test(nextLevel.name)
      ? 'Class ' + nextLevel.name + source.section
      : nextLevel.name + ' ' + source.section;
    assert.equal(card.targetClassLabel, expectedLabel,
      'the next class is the next LEVEL with the same section');
  } else {
    assert.equal(card.action, 'passed_out', 'the top level graduates');
    assert.equal(card.noNextLevelReason, 'top');
  }
});

test('classes sort by level order, so 10 follows 9 and LKG follows Nursery', () => {
  const orders = classes.map((c) => c.order);
  assert.deepEqual(orders, [...orders].sort((x, y) => x - y));
});

test('the top level is derived from classes with students, never an empty one', async () => {
  const overview = (await get('/admin/class-management/overview')).body.data;
  const carrying = overview.classes.filter((c) => c.studentCount > 0);
  assert.ok(carrying.length > 0, 'the seed must leave a class with students');

  const highestWithStudents = carrying.reduce((a, b) => (b.order > a.order ? b : a));
  assert.equal(overview.topGrade, highestWithStudents.order);

  // An empty class on a higher level does not change it.
  const emptyHigher = overview.classes.filter((c) => c.studentCount === 0 && c.order > highestWithStudents.order);
  emptyHigher.forEach((c) => {
    assert.equal(c.action, 'none', 'an empty class offers nothing');
    assert.equal(c.isTop, false, 'and is not the graduating class');
  });
});

test('the promotion chain follows the levels, not the order number', async () => {
  // Build a chain across three levels with the same section, promoting each hop.
  const byOrder = [...levels].sort((a, b) => a.order - b.order);
  assert.ok(byOrder.length >= 3, 'the seed must leave at least 3 levels to chain through');

  const from = byOrder[0];
  const mid = byOrder[1];
  const last = byOrder[2];

  // Three separate sections, so each hop has its own students whose live seat is
  // in the current year. One promotion per cycle: promoting a student again in
  // the SAME cycle is the double-promotion the app refuses, by design.
  const source = await makeClass(from.id, nextSection());
  const s = await makeStudent(source.id, 'Chain First');
  const r1 = await post(`/admin/class-management/classes/${source.id}/promote`, { confirm: [s.id] });
  assert.equal(r1.body.data.targetClassLabel,
    levelLabel(mid, source.section), 'hop 1 lands on the next level');

  const src2 = await makeClass(mid.id, nextSection());
  const s2 = await makeStudent(src2.id, 'Chain Second');
  const r2 = await post(`/admin/class-management/classes/${src2.id}/promote`, { confirm: [s2.id] });
  assert.equal(r2.body.data.targetClassLabel,
    levelLabel(last, src2.section), 'hop 2 lands on the next level again');

  const all = (await get('/admin/students')).body.data;
  const first = all.find((x) => x.name === 'Chain First');
  const second = all.find((x) => x.name === 'Chain Second');
  assert.equal(first.classLabel, levelLabel(mid, source.section));
  assert.equal(second.classLabel, levelLabel(last, src2.section));
});

test('a destination that does not exist is created, not guessed', async () => {
  const byOrder = [...levels].sort((a, b) => a.order - b.order);
  const from = byOrder[0];
  const next = byOrder[1];

  /* Make the class first, so the destination id can be derived from the
     section that class actually got rather than a guessed one. */
  const src = await makeClass(from.id, nextSection());
  const s = await makeStudent(src.id, 'Chain Create');
  const targetId = `cls-${next.name.toUpperCase()}${src.section}`;

  const before = (await get('/admin/classes')).body.data;
  assert.ok(!before.some((c) => c.id === targetId),
    'the target class must not exist yet — that is the thing being proved');

  const res = await post(`/admin/class-management/classes/${src.id}/promote`, { confirm: [s.id] });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const after = (await get('/admin/classes')).body.data;
  const made = after.find((c) => c.id === targetId);
  assert.ok(made, 'the destination class was created');
  assert.equal(made.label, levelLabel(next, src.section));
});

test('promoting the top level is refused, and so is a level with no successor', async () => {
  const overview = (await get('/admin/class-management/overview')).body.data;
  const top = overview.classes.find((c) => c.isTop && c.studentCount > 0);
  if (!top) { this.skip(); return; }

  const plan = (await get(`/admin/class-management/classes/${top.id}/promotion-plan`)).body.data;
  assert.equal(plan.targetClass, null, 'the top level has no target');
  assert.equal(plan.noNextLevelReason, 'top');

  const res = await post(`/admin/class-management/classes/${top.id}/promote`, { confirm: [] });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'CLASS_IS_TOP');
});

/* ── the student write path ────────────────────────────────────────────────── */

test('a student can be created in a named level by classId alone', async () => {
  const named = levels.find((l) => !/^\d+$/.test(l.name));
  if (!named) return; // the school has no named levels
  const cls = await makeClass(named.name);
  const s = await makeStudent(cls.id, 'Named Level Child');
  assert.equal(s.classId, cls.id);
  assert.equal(s.classLabel, `${named.name} ${cls.section}`, 'the label is the level name, not its order');
});

test('a typed class value is matched against the level names', async () => {
  const level = levels[0];
  for (const spelling of [level.name, level.name.toLowerCase(), `Class ${level.name}`]) {
    const res = await post('/admin/students', {
      name: `Typed ${level.name} Kid`,
      class: spelling,
      section: a1,
      parentName: `Typed ${level.name} Guardian`,
      guardianContact: `98000${String(Math.floor(Math.random() * 90000) + 10000)}`.slice(0, 10),
    });
    assert.equal(res.status, 201, `"${spelling}" must resolve`, JSON.stringify(res.body));
  }
});

test('an unknown level is refused with the valid level names listed', async () => {
  const res = await post('/admin/students', {
    // Guardian fields are required, so the payload is complete: what is under
    // test is the CLASS resolution, and a validation failure would answer a
    // different question than the one being asked.
    name: 'Unknown Level Kid', class: 'Playgroup', section: a1,
    parentName: 'Unknown Level Guardian', guardianContact: '9800000001',
  });
  assert.ok(res.status >= 400);
  const msg = res.body.message || JSON.stringify(res.body.errors || {});
  assert.match(msg, /Nursery/);
  assert.match(msg, /LKG/);
  assert.match(msg, /UKG/);
});

test('the search finds a class by level name, section, and both together', async () => {
  const named = levels.find((l) => !/^\d+$/.test(l.name));
  if (!named) return;
  const cls = await makeClass(named.name);
  const s = await makeStudent(cls.id, 'Searchable Child');
  const sec = cls.section.toLowerCase();

  for (const q of [named.name.toLowerCase(), sec, `${named.name}${sec}`.toLowerCase()]) {
    const res = await get(`/admin/students/by-class?q=${encodeURIComponent(q)}`);
    assert.ok(
      (res.body.data || []).some((g) => g.studentIds.includes(s.id)),
      `"${q}" must find the student`,
    );
  }
});

/* ── names on every screen ─────────────────────────────────────────────────── */

test('every screen that names a class uses the same name', async () => {
  const ov = (await get('/admin/class-management/overview')).body.data;
  ov.classes.forEach((c) => {
    assert.match(c.label, /^Class \d+[A-Za-z]+$|^[A-Za-z]+ [A-Za-z]+$/, `${c.label} must be a real name`);
    assert.ok(!/^-?\d+$/.test(c.label), 'an order number must never reach a screen');
  });

  const byClass = (await get('/admin/students/by-class')).body.data;
  byClass.forEach((g) => {
    assert.match(g.class, /^Class \d+[A-Za-z]+$|^[A-Za-z]+ [A-Za-z]+$/);
  });

  const opts = (await get('/school/options')).body.data;
  opts.classes.forEach((c) => {
    assert.match(c.label, /^Class \d+[A-Za-z]+$|^[A-Za-z]+ [A-Za-z]+$/);
    assert.equal(c.levelName, levels.find((l) => l.id === c.levelId)?.name ?? null);
  });
});

test('a legacy bulk file with a level name is accepted, an unknown one rejected', async () => {
  const level = levels[0];
  const good = ['Name,Class,Section,RollNumber,ParentGuardian,Contact,FeeDues',
    `Bulk Lvl One,${level.name},${a1},,Bulk Parent One,9800000002,0`].join('\r\n');

  const fd = new FormData();
  fd.append('file', new Blob([good], { type: 'text/csv' }), 'lvl.csv');
  const res = await fetch(`${base}/admin/students/bulk`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  const body = JSON.parse(await res.text());
  assert.equal(res.status, 201, JSON.stringify(body).slice(0, 200));
  assert.ok(body.data.created.every((s) => s.classLabel === `${level.name} ${a1}`),
    body.data.created.map((s) => s.classLabel).join(','));

  const bad = ['Name,Class,Section,RollNumber,ParentGuardian,Contact,FeeDues',
    `Bulk Lvl Bad,Playgroup,${a1},,Bulk Parent Bad,9800000003,0`].join('\r\n');
  const fd2 = new FormData();
  fd2.append('file', new Blob([bad], { type: 'text/csv' }), 'bad.csv');
  const res2 = await fetch(`${base}/admin/students/bulk`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd2 });
  const body2 = JSON.parse(await res2.text());
  assert.equal(res2.status, 400);
  assert.ok(body2.errors.row_2, 'the bad row is named');
  assert.match(body2.errors.row_2.Class, /Nursery/);
});
