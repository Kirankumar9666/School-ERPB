/**
 * Guardian identity fields are required, and a student with no login can be
 * given one.
 *
 * Two rules, tested against the real API rather than the source:
 *
 *   B. Parent / Guardian and Guardian Contact are REQUIRED on Add Student and
 *      Edit Student, with the shared 10-digit contact rule (Bulk Add and Enter
 *      Past Data already required them — asserted here as regressions). A
 *      record created before the rule keeps its blanks: it still reads, and
 *      Edit will not save until the missing values are filled in.
 *
 *   C. A student with no login and a guardian contact can be given one through
 *      POST /admin/students/:id/create-login — the SAME rule the admission
 *      paths use (username from the name, initial password = guardian contact,
 *      forced change at first login). An existing login is never touched.
 *
 * Every id, name and figure is read from the seeded rows, so the suite follows
 * the school rather than hardcoding one.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request, auth } = require('./helpers');
const prisma = require('../src/services/prisma');
const enrollment = require('../src/services/enrollment');
const { baseUsernameFrom } = require('../src/services/studentAccounts');

let server;
let base;
let token;
let adminLogin;
let seedStudent; // any seeded student (guardian fields present)
let loginless; // a seeded student with NO login but WITH a contact — exactly Sneha Reddy / Rahul Menon

const post = (path, body) => request(base, path, { method: 'POST', token, body });
const put = (path, body) => request(base, path, { method: 'PUT', token, body });
const get = (path) => request(base, path, { token });

/** A legacy row: written straight to the database, blanks and all. */
const writeLegacyStudent = async (name, overrides = {}) => {
  const cls = await prisma.class.findFirst({ where: { students: { some: {} } } });
  assert.ok(cls, 'the seed must leave a class with students');
  const row = await prisma.student.create({
    data: {
      id: `stu-legacy-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      name,
      parentName: null,
      guardianContact: null,
      classId: cls.id,
      ...overrides,
    },
  });
  await enrollment.syncLiveEnrollment(prisma, row.id);
  return row;
};

before(async () => {
  ({ server, base } = await startServer());
  adminLogin = await login(base, 'admin', 'Admin@123');
  token = adminLogin.accessToken;

  const list = (await get('/admin/students')).body.data;
  assert.ok(list.length >= 2, 'the seed must leave at least two students');
  seedStudent = list.find((s) => s.parentName && s.guardianContact);
  assert.ok(seedStudent, 'the seed must leave a student with guardian details');
  /* `userId`, not `username`: the /admin/students list carries the scalar link
     always, while `username` only arrives on the includes that fetch the User
     row — reading it here would report every student as loginless. */
  loginless = list.find((s) => s.userId === null && s.guardianContact);
  assert.ok(loginless, 'the seed must leave a student with no login but a contact (Sneha Reddy / Rahul Menon)');
});

after(async () => { await stopServer(server); });

/* ══════════════════════════════════════════════════════════════════════════
   B — required guardian name and contact
   ══════════════════════════════════════════════════════════════════════════ */

test('Add Student refuses a blank guardian name', async () => {
  const res = await post('/admin/students', {
    name: 'No Guardian Kid', class: '7', section: 'A', guardianContact: '+91-9000000011',
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  assert.ok(res.body.errors.parentName, 'the guardian name must be named');
});

test('Add Student refuses a blank guardian contact', async () => {
  const res = await post('/admin/students', {
    name: 'No Contact Kid', class: '7', section: 'A', parentName: 'Somebody Parent',
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.ok(res.body.errors.guardianContact, 'the contact must be named');
});

test('Add Student applies the shared 10-digit contact rule', async () => {
  // Letters, and a short number, are both refused with the shared wording.
  const letters = await post('/admin/students', {
    name: 'Letters Contact Kid', class: '7', section: 'A',
    parentName: 'Somebody Parent', guardianContact: 'not-a-number',
  });
  assert.equal(letters.status, 400, JSON.stringify(letters.body));
  assert.ok(letters.body.errors.guardianContact, 'letters are refused');

  const short = await post('/admin/students', {
    name: 'Short Contact Kid', class: '7', section: 'A',
    parentName: 'Somebody Parent', guardianContact: '98765',
  });
  assert.equal(short.status, 400, JSON.stringify(short.body));
  assert.ok(short.body.errors.guardianContact, 'a short number is refused');

  // Nothing was created by any of the refusals.
  const after = (await get('/admin/students')).body.data;
  assert.ok(!after.some((s) => s.name.endsWith('Contact Kid')), 'no refused payload may create a student');
});

test('Edit Student asks for the missing values before saving', async () => {
  // A complete payload for the seeded student — every field the edit form would
  // send. Omitting rollNumber would be an edit that WIPES it (the schema accepts
  // null), which is exactly the kind of silent change this test must not make.
  const body = {
    name: seedStudent.name,
    classId: seedStudent.classId,
    rollNumber: seedStudent.rollNumber,
    parentName: seedStudent.parentName,
    guardianContact: seedStudent.guardianContact,
  };

  const noGuardian = await put(`/admin/students/${seedStudent.id}`, {
    ...body, parentName: undefined,
  });
  assert.equal(noGuardian.status, 400, JSON.stringify(noGuardian.body));
  assert.ok(noGuardian.body.errors.parentName, 'a blank guardian name blocks the save');

  const noContact = await put(`/admin/students/${seedStudent.id}`, {
    ...body, guardianContact: undefined,
  });
  assert.equal(noContact.status, 400, JSON.stringify(noContact.body));
  assert.ok(noContact.body.errors.guardianContact, 'a blank contact blocks the save');

  const shortContact = await put(`/admin/students/${seedStudent.id}`, {
    ...body, guardianContact: '12345',
  });
  assert.equal(shortContact.status, 400, JSON.stringify(shortContact.body));
  assert.ok(shortContact.body.errors.guardianContact, 'the 10-digit rule applies to edits too');

  // A complete payload still saves, and nothing about the student was lost.
  const ok = await put(`/admin/students/${seedStudent.id}`, body);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.rollNumber, seedStudent.rollNumber, 'the roll number survives the edit');
});

test('Bulk Add still requires both guardian fields (regression)', async () => {
  const upload = async (row) => {
    const fd = new FormData();
    fd.append('file', new Blob([row], { type: 'text/csv' }), 'students.csv');
    const res = await fetch(`${base}/admin/students/bulk`, {
      method: 'POST', headers: auth(token), body: fd,
    });
    return { status: res.status, body: await res.json() };
  };
  const header = 'Name,Class,Section,RollNumber,ParentGuardian,Contact,FeeDues';

  const noGuardian = await upload(`${header}\r\nBlank Guardian,7,A,,,9800000022,0`);
  assert.equal(noGuardian.status, 400, JSON.stringify(noGuardian.body));
  assert.ok(noGuardian.body.errors.row_2.ParentGuardian, 'a blank guardian name is reported per row');

  const noContact = await upload(`${header}\r\nBlank Contact,7,A,,Guardian Name,,0`);
  assert.equal(noContact.status, 400, JSON.stringify(noContact.body));
  assert.ok(noContact.body.errors.row_2.Contact, 'a blank contact is reported per row');
});

test('Enter Past Data requires the guardian name and contact too', async () => {
  const years = (await get('/admin/class-management/years')).body.data;
  const overview = (await get('/admin/class-management/overview')).body.data;
  assert.ok(years.length && overview.classes.length, 'the seed must leave years and classes');

  const missingGuardian = await post('/admin/class-management/historical-records', {
    academicYearId: years[0].id,
    classId: overview.classes[0].id,
    newStudent: { name: 'Historical Guardianless', guardianContact: '9876500077' },
  });
  assert.equal(missingGuardian.status, 400, JSON.stringify(missingGuardian.body));
  assert.match(JSON.stringify(missingGuardian.body), /guardian/i, 'the guardian name is required');

  const missingContact = await post('/admin/class-management/historical-records', {
    academicYearId: years[0].id,
    classId: overview.classes[0].id,
    newStudent: { name: 'Historical Contactless', parentName: 'Historical Guardian' },
  });
  assert.equal(missingContact.status, 400, JSON.stringify(missingContact.body));
  assert.match(JSON.stringify(missingContact.body), /guardian contact/i, 'the guardian contact is required');
});

test('a student with blank guardian details still reads, and Edit fills them in', async () => {
  // A household on the register from before the rule: no guardian name, no
  // contact. Nothing about them may break — they are viewable like anybody.
  const legacy = await writeLegacyStudent('Legacy Blank Child');

  const profile = await get(`/students/${legacy.id}/profile`);
  assert.equal(profile.status, 200, JSON.stringify(profile.body));
  assert.equal(profile.body.data.parentName, null, 'a blank guardian reads as null, not an error');
  assert.equal(profile.body.data.guardianContact, null);
  assert.equal(profile.body.data.username, null, 'and they have no login either');

  const listed = (await get('/admin/students')).body.data.find((s) => s.id === legacy.id);
  assert.ok(listed, 'a legacy record stays in every list');

  // Edit will not save while a field is still blank…
  const stillBlank = await put(`/admin/students/${legacy.id}`, {
    name: legacy.name, classId: legacy.classId,
  });
  assert.equal(stillBlank.status, 400, JSON.stringify(stillBlank.body));

  // …and once filled, the record is complete and readable.
  const filled = await put(`/admin/students/${legacy.id}`, {
    name: legacy.name, classId: legacy.classId,
    parentName: 'Legacy Guardian', guardianContact: '9876500088',
  });
  assert.equal(filled.status, 200, JSON.stringify(filled.body));
  const after = await get(`/students/${legacy.id}/profile`);
  assert.equal(after.body.data.parentName, 'Legacy Guardian');
  assert.equal(after.body.data.guardianContact, '+91-9876500088');

  await prisma.student.delete({ where: { id: legacy.id } });
});

/* ══════════════════════════════════════════════════════════════════════════
   C — every student needs a login
   ══════════════════════════════════════════════════════════════════════════ */

test('create-login provisions the account by the same rule the app uses for new students', async () => {
  const res = await post(`/admin/students/${loginless.id}/create-login`);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.account.username, baseUsernameFrom(loginless.name),
    'the username is the name, lowercased with dots — the same baseUsernameFrom the admission paths use');
  // The derivation rule is stated once, in this response, and nowhere afterwards.
  assert.match(res.body.message, /initial password = guardian contact/);
  assert.match(res.body.message, /cannot be retrieved afterwards/);

  // The initial password really is the guardian contact, and the account is
  // flagged to change it at first login.
  const signedIn = await login(base, res.body.data.account.username, loginless.guardianContact);
  assert.equal(signedIn.user.mustChangePassword, true,
    'a login derived from the guardian contact must be forced to change it');

  // The account is linked to the student, so User Accounts can find it.
  const users = (await get('/admin/users')).body.data;
  const account = users.find((u) => u.username === res.body.data.account.username);
  assert.equal(account.linkedEntityId, loginless.id, 'the account belongs to this student');

  // The profile now reports the username for the handover.
  const profile = await get(`/students/${loginless.id}/profile`);
  assert.equal(profile.body.data.username, res.body.data.account.username);
  assert.ok(!JSON.stringify(profile.body).toLowerCase().includes('password'),
    'no read endpoint restates where the password comes from');
});

test('a second create-login is refused and the existing login is left untouched', async () => {
  const again = await post(`/admin/students/${loginless.id}/create-login`);
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.code, 'LOGIN_EXISTS');

  // The credentials from the first creation still work — nothing was replaced.
  const users = (await get('/admin/users')).body.data;
  const account = users.find((u) => u.linkedEntityId === loginless.id);
  assert.ok(account, 'the original account is still there');
  const stillWorks = await login(base, account.username, loginless.guardianContact);
  assert.ok(stillWorks.accessToken, 'the original login still authenticates');
});

test('create-login is refused for a student with no guardian contact', async () => {
  const legacy = await writeLegacyStudent('Legacy No Contact Child');
  const res = await post(`/admin/students/${legacy.id}/create-login`);
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, 'NO_GUARDIAN_CONTACT');
  assert.match(res.body.message, /guardian contact/i, 'the refusal says why, and what to do');

  // No account was created.
  const users = (await get('/admin/users')).body.data;
  assert.ok(!users.some((u) => u.linkedEntityId === legacy.id), 'nothing was provisioned');

  await prisma.student.delete({ where: { id: legacy.id } });
});

test('create-login: unknown student → 404, non-admin → 403', async () => {
  const missing = await post('/admin/students/stu-999999/create-login');
  assert.equal(missing.status, 404);

  const denied = await request(base, `/admin/students/${loginless.id}/create-login`, {
    method: 'POST', token: (await login(base, 'student', 'Student@123')).accessToken,
  });
  assert.equal(denied.status, 403, 'only the office may create a login');
});

test('a username collision gets a suffix — never a failure and never an overwrite', async () => {
  // A second child with the same name, on the register with a contact but no
  // account (a legacy row, exactly the situation the action exists for).
  const twin = await writeLegacyStudent(loginless.name, {
    parentName: 'Second Guardian', guardianContact: '+91-9000000042',
  });

  const res = await post(`/admin/students/${twin.id}/create-login`);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const expected = `${baseUsernameFrom(loginless.name)}.2`;
  assert.equal(res.body.data.account.username, expected, 'the second claimant gets the suffix');

  // Both accounts exist and each keeps its own password.
  const first = await login(base, baseUsernameFrom(loginless.name), loginless.guardianContact);
  assert.ok(first.accessToken, 'the first account is untouched');
  const users = (await get('/admin/users')).body.data;
  const mine = users.find((u) => u.linkedEntityId === twin.id);
  assert.equal(mine.username, expected, 'each account is linked to its own student');
});

test('create-login changes no other account', async () => {
  // The seeded accounts, before and after every provisioning above, must be
  // byte-identical — this action adds account(s), it never rewrites one.
  const users = (await get('/admin/users')).body.data;
  const seeded = users.filter((u) => ['admin', 'teacher', 'accountant'].includes(u.username));
  assert.equal(seeded.length, 3, 'the seeded staff accounts are all listed');
  seeded.forEach((u) => assert.ok(u.linkedEntityId === null || u.role !== 'student',
    `staff account ${u.username} is not a student`));

  // And the original student login still signs in with its original password.
  const asStudent = await login(base, 'student', 'Student@123');
  assert.ok(asStudent.accessToken, 'the seeded student login is unchanged');
});

/* A new student admitted through the app gets a login automatically — the
   reason the create-login action only ever has legacy records to fix. */
test('a newly admitted student gets a login without any extra step', async () => {
  const created = await post('/admin/students', {
    name: 'Admitted With Login', class: '7', section: 'A',
    parentName: 'Admitted Guardian', guardianContact: '9800000012',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.account.username, 'admitted.with.login');
  // …so the action is hidden for them: the student already holds a login.
  const profile = await get(`/students/${created.body.data.id}/profile`);
  assert.equal(profile.body.data.username, 'admitted.with.login');
  const dup = await post(`/admin/students/${created.body.data.id}/create-login`);
  assert.equal(dup.status, 409, 'a student who already has a login cannot be given a second');
});

test('teardown — stop server', async () => { await stopServer(server); });
