/**
 * Duplicate students — the identity rule, applied on every path that creates or
 * changes a student.
 *
 * A duplicate is the same PERSON: name + guardian name + guardian contact, after
 * normalisation. Roll number and class take no part, so the same child sitting in
 * two different classes is a duplicate, and a child who moved class and was
 * re-typed is not a new student.
 *
 * These are HTTP-level on purpose: the rule is useless if any route forgets to
 * call it, and the only way to see that is to drive the routes.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request, auth } = require('./helpers');

let server;
let base;
let admin;

/** The seeded student this suite works against, read live rather than hardcoded. */
let seedStudent;

const addStudent = (body) => request(base, '/admin/students', {
  method: 'POST', token: admin.accessToken, body,
});

const CSV_HEADER = 'Name,Class,Section,RollNumber,ParentGuardian,Contact,FeeDues';

/** Multipart POST of a file buffer → { status, body } */
async function upload(buffer, filename, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mime }), filename);
  const res = await fetch(`${base}/admin/students/bulk`, { method: 'POST', headers: auth(admin.accessToken), body: fd });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const basePayload = () => ({
  name: seedStudent.name,
  class: seedStudent.class,
  section: seedStudent.section,
  parentName: seedStudent.parentName,
  guardianContact: seedStudent.guardianContact,
});

before(async () => {
  ({ server, base } = await startServer());
  admin = await login(base, 'admin', 'Admin@123');

  const list = await request(base, '/admin/students', { token: admin.accessToken });
  assert.equal(list.status, 200);
  seedStudent = list.body.data[0];
  assert.ok(seedStudent, 'the seed must leave at least one student to test against');
});

after(async () => {
  await stopServer(server);
});

/* ── the rule itself ───────────────────────────────────────────────────────── */

test('the same person in the same class is refused, naming the existing student', async () => {
  const res = await addStudent(basePayload());
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'DUPLICATE_IDENTITY');
  // Names the student who is already on file, with guardian and contact.
  assert.match(res.body.message, /already exists in Class/);
  assert.match(res.body.message, /guardian /);
  assert.match(res.body.message, /\d{10}/);
});

test('the same person in a DIFFERENT class is still refused', async () => {
  const other = (await request(base, '/admin/class-management/overview', { token: admin.accessToken }))
    // The student's own name comes from the shared classLabel; "different" is
    // simply not that class, however the level happens to be named.
    .body.data.classes.find((c) => c.label !== seedStudent.classLabel);

  const res = await addStudent({ ...basePayload(), class: String(other.grade), section: other.section });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'DUPLICATE_IDENTITY');
});

test('a sibling with the same guardian and contact but a different name is allowed', async () => {
  const res = await addStudent({
    ...basePayload(),
    name: `${seedStudent.name} Sibling`,
    class: seedStudent.class,
    section: seedStudent.section,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  // Clean up: it is a real row now, and later tests count students.
  assert.equal((await request(base, `/admin/students/${res.body.data.id}`, {
    method: 'DELETE', token: admin.accessToken, raw: true,
  })).status, 200);
});

test('the contact is compared on its last ten digits', async () => {
  // The same number in the shapes the office actually types. Each is accepted by
  // the contact schema, and each must normalise to the stored student's number.
  const digits = String(seedStudent.guardianContact).replace(/\D+/g, '').slice(-10);
  const variants = [
    digits,
    `+91${digits}`,
    `+91-${digits}`,
    `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`,
    `(${digits.slice(0, 5)}) ${digits.slice(5)}`,
  ];
  for (const contact of variants) {
    const res = await addStudent({ ...basePayload(), guardianContact: contact });
    assert.equal(res.status, 409, `"${contact}" must read as ${seedStudent.guardianContact}`);
    assert.equal(res.body.code, 'DUPLICATE_IDENTITY');
  }
});

test('a different contact and a different name is a genuinely new student', async () => {
  const res = await addStudent({
    name: `${seedStudent.name} Distinct`,
    class: seedStudent.class,
    section: seedStudent.section,
    parentName: `Other ${seedStudent.parentName}`,
    guardianContact: '9876500012',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  await request(base, `/admin/students/${res.body.data.id}`, {
    method: 'DELETE', token: admin.accessToken, raw: true,
  });
});

/* ── Edit Student ───────────────────────────────────────────────────────────── */

test('editing a student is not a duplicate of itself', async () => {
  const row = (await request(base, '/admin/students', { token: admin.accessToken })).body.data[0];
  const res = await request(base, `/admin/students/${row.id}`, {
    method: 'PUT', token: admin.accessToken, body: {
      name: row.name, class: row.class, section: row.section,
      parentName: row.parentName, guardianContact: row.guardianContact,
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test('editing a student into an existing identity is refused', async () => {
  const list = (await request(base, '/admin/students', { token: admin.accessToken })).body.data;
  assert.ok(list.length >= 2, 'the seed must leave two students to collide');
  const [target, other] = list;

  const res = await request(base, `/admin/students/${other.id}`, {
    method: 'PUT', token: admin.accessToken, body: {
      name: target.name, class: target.class, section: target.section,
      parentName: target.parentName, guardianContact: target.guardianContact,
    },
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'DUPLICATE_IDENTITY');
  assert.match(res.body.message, /already exists in Class/);
});

/* ── Bulk Add ──────────────────────────────────────────────────────────────── */

test('a bulk file with a duplicate inside itself is rejected with both row numbers', async () => {
  const p = basePayload();
  const digits = String(p.guardianContact).replace(/\D+/g, '').slice(-10);
  // Two spellings of one child: different case, spacing, punctuation and two
  // contact formats. Under the identity rule all of them are the same student.
  const csv = [
    CSV_HEADER,
    `${p.name},${p.class},${p.section},,${p.parentName},${p.guardianContact},500`,
    `${p.name.replace(/\s+/g, '  ').toUpperCase()},${p.class},${p.section},,${p.parentName.toLowerCase()},+91${digits},500`,
  ].join('\r\n');

  const res = await upload(csv, 'dupes.csv', 'text/csv');
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  // Both rows are named, and the message points at the identity that collides.
  // Row numbers count the header, so these are the file's 2nd and 3rd lines.
  assert.ok(res.body.errors.row_2, 'row 2 is flagged');
  assert.ok(res.body.errors.row_3, 'row 3 is flagged');
  assert.match(String(res.body.errors.row_2.Name || res.body.errors.row_2), /already on file|same student/i);
  assert.match(String(res.body.errors.row_3.Name || res.body.errors.row_3), /already on file|same student/i);

  // Atomic — neither row of the refused file exists afterwards.
  const after = (await request(base, '/admin/students', { token: admin.accessToken })).body.data;
  const withThisGuardian = after.filter((s) => s.parentName === p.parentName);
  assert.equal(withThisGuardian.length, 1, 'only the seeded student carries this identity');
});

test('a bulk row that duplicates a database student is rejected with the row number', async () => {
  const p = basePayload();
  const csv = [
    CSV_HEADER,
    `Bulk Dupe Good,${p.class === '10' ? '9' : '10'},B,,Parent Good,9876500013,0`,
    `${p.name},9,C,,${p.parentName},${p.guardianContact},0`, // already on file, different class
  ].join('\r\n');

  const res = await upload(csv, 'against-db.csv', 'text/csv');
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.ok(res.body.errors.row_3, 'row 3 is the duplicate');
  assert.match(String(res.body.errors.row_3.Name || res.body.errors.row_3), /already exists in Class/i);

  // Atomicity: the perfectly valid row 1 was not saved either.
  const after = (await request(base, '/admin/students', { token: admin.accessToken })).body.data;
  assert.ok(!after.some((s) => s.name === 'Bulk Dupe Good'), 'nothing from a rejected file is saved');
});

test('a bulk file with no duplicates still uploads', async () => {
  const csv = [
    CSV_HEADER,
    `Bulk One,${seedStudent.class === '10' ? '9' : '10'},B,,Parent Bulk,9876500014,0`,
    `Bulk Two,${seedStudent.class === '10' ? '9' : '10'},B,,Parent Bulk Two,9876500015,0`,
  ].join('\r\n');
  const res = await upload(csv, 'clean.csv', 'text/csv');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.count, 2);
});
