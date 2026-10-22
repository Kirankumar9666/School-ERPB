/**
 * Bulk Add — the class-first flow, the per-class templates, and the roll-number
 * rule that Add Student and Bulk Add now share.
 *
 * ## The tests never touch the app's database
 *
 * `tests/helpers.js` loads `.env.test` and judges the URL by the guard in
 * src/config/test-env.js before anything can delete. `seed()` wipes, so it only
 * ever runs against the disposable test database. See the handoff note in the
 * repo root.
 *
 * Everything is derived from the level and class ROWS, so a school with Playgroup
 * or Class 12 passes unchanged. No class name, template or count is hardcoded.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { startServer, stopServer, login, request } = require('./helpers');

const HEADER_SCOPED = 'Name,RollNumber,ParentGuardian,Contact,FeeDues';
const HEADER_LEGACY = 'Name,Class,Section,RollNumber,ParentGuardian,Contact,FeeDues';

let server;
let base;
let token;
let levels;
let namedLevel;
let numLevel;

/** Sections the schema accepts. The section is a NAME, not a code, so digits are
    refused — which is what an earlier generator produced past the 8th value. */
let sectionSeq = 0;
const SEC = () => {
  sectionSeq += 1;
  const n = sectionSeq - 1;
  // Two letters from a bijective base-26 counter: QA, QB, ... QZ, RA, RB, ...
  return String.fromCharCode(65 + Math.floor(n / 26)) + String.fromCharCode(65 + (n % 26));
};

const created = { classes: [], students: [] };

const upload = (csv, classId) => {
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'u.csv');
  if (classId) fd.append('classId', classId);
  return fetch(`${base}/admin/students/bulk`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
  }).then(async (r) => ({ status: r.status, body: JSON.parse(await r.text()) }));
};

const get = (path) => request(base, path, { token });
const post = (path, body) => request(base, path, { method: 'POST', token, body });

before(async () => {
  ({ server, base } = await startServer());
  token = (await login(base, 'admin', 'Admin@123')).accessToken;

  const opts = (await request(base, '/admin/class-levels', { token })).body.data;
  levels = opts;
  numLevel = levels.find((l) => /^\d+$/.test(l.name));
  namedLevel = levels.find((l) => !/^\d+$/.test(l.name));
  assert.ok(numLevel && namedLevel, 'the seed must leave a named and a numbered level');
});

after(async () => {
  for (const id of created.students) {
    await request(base, `/admin/students/${id}`, { method: 'DELETE', token }).catch(() => {});
  }
  for (const id of created.classes) {
    await request(base, `/admin/classes/${id}`, { method: 'DELETE', token }).catch(() => {});
  }
  await stopServer(server);
});

/** A fresh class on a level, tracked for cleanup. */
const makeClass = async (level) => {
  const res = await post('/admin/classes', { levelId: level.id, section: SEC() });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  created.classes.push(res.body.data.id);
  return res.body.data;
};

/* ── templates ─────────────────────────────────────────────────────────────── */

test('the template for a named level names the class, the file and the columns', async () => {
  const cls = await makeClass(namedLevel);
  // The file name upper-cases the level, so it reads the same whatever casing
  // the school stored ('Nursery' and 'nursery' both give NURSERY).
  const want = `students-template-${namedLevel.name.toUpperCase()}-${cls.section}.csv`;

  const res = await fetch(`${base}/admin/students/bulk-template?classId=${cls.id}&format=csv`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const disposition = /filename="?([^";]+)"?/i.exec(res.headers.get('content-disposition') || '');
  assert.equal(disposition && disposition[1], want, 'the file name carries the class');
  const csv = await res.text();
  assert.equal(csv.split('\r\n')[0], HEADER_SCOPED, 'no Class or Section columns');
  assert.match(csv, /fee/i, 'the fee column is unchanged');
});

test('the XLSX Instructions sheet states the class and the 10-digit rule', async () => {
  const cls = await makeClass(namedLevel);
  const res = await fetch(`${base}/admin/students/bulk-template?classId=${cls.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));

  const students = wb.worksheets[0];
  assert.deepEqual(
    students.getRow(1).values.slice(1),
    ['Name', 'RollNumber', 'ParentGuardian', 'Contact', 'FeeDues'],
    'the sheet itself carries the scoped columns',
  );

  const notes = wb.worksheets.find((w) => w.name === 'Instructions');
  assert.ok(notes, 'an Instructions sheet is present');
  const text = [];
  notes.eachRow((row) => text.push(...row.values.slice(1).map((v) => String(v ?? ''))));
  const joined = text.join('\n');
  assert.ok(joined.includes(`Class: ${namedLevel.name} ${cls.section}`), 'the class is stated at the top');
  assert.match(joined, /exactly 10 digits/, 'the contact rule is spelled out');
});

test('a numbered class gets its own file name', async () => {
  const cls = await makeClass(numLevel);
  const res = await fetch(`${base}/admin/students/bulk-template?classId=${cls.id}&format=csv`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const disposition = /filename="?([^";]+)"?/i.exec(res.headers.get('content-disposition') || '');
  assert.equal(disposition && disposition[1],
    `students-template-CLASS-${numLevel.name}${cls.section}.csv`);
});

test('a template needs a class, and refuses an unknown one', async () => {
  const none = await request(base, '/admin/students/bulk-template', { token });
  assert.equal(none.status, 400);
  const bad = await request(base, '/admin/students/bulk-template?classId=cls-nope', { token });
  assert.equal(bad.status, 404);
});

/* ── the upload itself ─────────────────────────────────────────────────────── */

test('every row of a scoped upload lands in the chosen class', async () => {
  const cls = await makeClass(namedLevel);
  const label = `${namedLevel.name} ${cls.section}`;
  const res = await upload(
    [HEADER_SCOPED, 'Bulk One,,G One,9800000101,0', 'Bulk Two,,G Two,9800000102,500'].join('\r\n'),
    cls.id,
  );
  assert.equal(res.status, 201, JSON.stringify(res.body).slice(0, 200));
  assert.equal(res.body.data.classLabel, label, 'the response names the class');
  assert.equal(res.body.data.count, 2, 'counted from the real inserted rows');
  res.body.data.created.forEach((s) => created.students.push(s.id));
  assert.ok(res.body.data.created.every((s) => s.classLabel === label));
  assert.ok(res.body.data.created.every((s) => /^STU-\d{4}-\d+$/.test(s.rollNumber)), 'roll numbers assigned');
  assert.equal(res.body.data.accountsCreated, 2, 'logins still created');
  assert.match(res.body.message, new RegExp(`to ${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`));
});

test('a duplicate inside the file is rejected, naming the row it duplicates', async () => {
  const cls = await makeClass(namedLevel);
  const res = await upload(
    [HEADER_SCOPED, 'Dup Kid,,Dup G,9800000103,0', 'Dup  Kid,,Dup G,9800000103,0'].join('\r\n'),
    cls.id,
  );
  assert.equal(res.status, 400);
  // The rule keeps the FIRST occurrence and refuses the later ones, so it is the
  // second row that is named — and it points at the row it copies.
  assert.ok(res.body.errors.row_3, 'the later duplicate is named');
  assert.match(JSON.stringify(res.body.errors.row_3 || {}), /row 2/i,
    'and it points at the row it duplicates');
});

test('a duplicate of an existing student is rejected', async () => {
  const cls = await makeClass(namedLevel);
  const first = await upload([HEADER_SCOPED, 'Existing Kid,,EG,9800000104,0'].join('\r\n'), cls.id);
  first.body.data.created.forEach((s) => created.students.push(s.id));

  const again = await upload([HEADER_SCOPED, 'Existing Kid,,EG,9800000104,0'].join('\r\n'), cls.id);
  assert.equal(again.status, 400);
  assert.match(JSON.stringify(again.body.errors), /already exists/);
});

test('a legacy file is accepted only when its rows match the chosen class', async () => {
  const cls = await makeClass(namedLevel);
  const variants = [namedLevel.name, namedLevel.name.toLowerCase(), `Class ${namedLevel.name}`];

  for (const [index, v] of variants.entries()) {
    const res = await upload(
      [HEADER_LEGACY, `Leg ${v.replace(/[^A-Za-z]/g, '')},${v},${cls.section},,LG,980001000${index},0`].join('\r\n'),
      cls.id,
    );
    assert.equal(res.status, 201, `${v} must be accepted: ${JSON.stringify(res.body).slice(0, 160)}`);
    res.body.data.created.forEach((s) => created.students.push(s.id));
  }

  const wrong = await upload(
    [HEADER_LEGACY, `Leg Wrong,${numLevel.name},A,,LG,9800000106,0`].join('\r\n'),
    cls.id,
  );
  assert.equal(wrong.status, 400, 'a row for another class is refused');
  assert.ok(wrong.body.errors.row_2, 'with its row number');
  const after = (await get('/admin/students')).body.data;
  assert.ok(!after.some((s) => s.name === 'Leg Wrong'), 'and nothing was saved');
});

test('per-row checks: name, guardian, contact', async () => {
  const cls = await makeClass(namedLevel);
  const cases = [
    [[HEADER_SCOPED, ',,NG,9800000107,0'], 'Name'],
    [[HEADER_SCOPED, 'NoG,,,9800000108,0'], 'ParentGuardian'],
    [[HEADER_SCOPED, 'BadContact,,BG,12345,0'], 'guardianContact'],
  ];
  for (const [rows, field] of cases) {
    const res = await upload(rows.join('\r\n'), cls.id);
    assert.equal(res.status, 400, rows[1]);
    assert.ok(res.body.errors.row_2, rows[1]);
    assert.ok(res.body.errors.row_2[field], `${field} must be named: ${JSON.stringify(res.body.errors)}`);
  }
});

test('Add Student assigns the next roll number in the chosen class', async () => {
  const cls = await makeClass(namedLevel);
  // This class is new, so the next free number is 001.
  const one = await post('/admin/students', {
    classId: cls.id, name: 'Roll One', parentName: 'Roll One Guardian', guardianContact: '9800000110',
  });
  assert.equal(one.status, 201, JSON.stringify(one.body).slice(0, 200));
  created.students.push(one.body.data.id);
  assert.ok(one.body.data.rollNumber, 'a blank roll number is filled in');

  const two = await upload([HEADER_SCOPED, 'Roll Two,,RG,9800000111,0'].join('\r\n'), cls.id);
  assert.equal(two.status, 201, JSON.stringify(two.body).slice(0, 160));
  two.body.data.created.forEach((s) => created.students.push(s.id));
  assert.notEqual(two.body.data.created[0].rollNumber, one.body.data.rollNumber,
    'a later bulk continues the sequence rather than colliding');
});
