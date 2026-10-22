/**
 * Bulk student upload (CSV/XLSX) tests — POST /api/v1/admin/students/bulk.
 * Covers server-side parsing, header enforcement, per-row/per-column
 * validation, atomic rejection, roll-number auto-generation and the
 * class-summary re-read. Node built-in test runner, zero extra deps.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { startServer, stopServer, login, auth } = require('./helpers');

/** Multipart POST of a file buffer → { status, body } */
async function upload(base, token, buffer, filename, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mime }), filename);
  const res = await fetch(`${base}/admin/students/bulk`, { method: 'POST', headers: auth(token), body: fd });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const CSV_HEADER = 'Name,Class,Section,RollNumber,ParentGuardian,Contact,FeeDues';

test('students bulk upload: CSV, auto roll numbers, atomic rejection, XLSX', async (t) => {
  const { server, base } = await startServer();
  const admin = await login(base, 'admin', 'Admin@123');

  const listStudents = async () => {
    const res = await fetch(`${base}/admin/students`, { headers: auth(admin.accessToken) });
    return (await res.json()).data;
  };
  const byClass = async () => {
    const res = await fetch(`${base}/admin/students/by-class`, { headers: auth(admin.accessToken) });
    return (await res.json()).data;
  };
  const countOf = (rows, key) => rows.find((r) => r.key === key)?.totalStudents ?? 0;

  const before = await listStudents();
  const summaryBefore = await byClass();

  await t.test('CSV with blank RollNumbers → created, roll numbers auto-generated per class/section', async () => {
    const csv = [
      CSV_HEADER,
      'Aarav Rao,10,A,,Kavita Rao,+91-9812345670,2500', // 10-A: continues STU-2022-002
      'Diya Sharma,10,A,,Sunita Sharma,+91-9812345671,0', // 10-A: blank RollNumber → auto-generated next
      'Ishaan Nair,8,C,,Meera Nair,+91-9812345672,1000', // brand-new group → current year, 001
    ].join('\r\n');
    const res = await upload(base, admin.accessToken, csv, 'students.csv', 'text/csv');

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.count, 3); // computed from inserted rows
    assert.equal(res.body.data.accountsCreated, 3); // one login per student
    assert.equal(
      res.body.message,
      '3 students added · 3 login accounts created (initial password = guardian contact — '
      + 'returned in this response only, it cannot be retrieved afterwards)',
    ); // derived, not hardcoded

    const created = res.body.data.created;
    const group10A = before.filter((s) => s.class === '10' && s.section === 'A');
    const maxExisting10A = Math.max(...group10A.map((s) => Number(s.rollNumber.split('-').pop())));
    const year10A = group10A[0].rollNumber.split('-')[1];
    assert.equal(created[0].rollNumber, `STU-${year10A}-${String(maxExisting10A + 1).padStart(3, '0')}`);
    assert.equal(created[1].rollNumber, `STU-${year10A}-${String(maxExisting10A + 2).padStart(3, '0')}`);
    assert.equal(created[2].rollNumber, `STU-${new Date().getFullYear()}-001`);

    /* list and class summary re-read from actual data */
    const after = await listStudents();
    assert.equal(after.length, before.length + 3);
    const summaryAfter = await byClass();
    assert.equal(countOf(summaryAfter, '10-A'), countOf(summaryBefore, '10-A') + 2);
    assert.equal(countOf(summaryAfter, '8-C'), 1);
    const newGroup = summaryAfter.find((r) => r.key === '8-C');
    assert.equal(newGroup.feeDues, 1000); // derived from inserted rows
    const tenAAfter = summaryAfter.find((r) => r.key === '10-A');
    const tenABefore = summaryBefore.find((r) => r.key === '10-A');
    assert.equal(tenAAfter.feeDues - tenABefore.feeDues, 2500);
  });

  await t.test('one invalid row rejects the whole file (atomic) and names the rows/columns', async () => {
    const csv = [
      CSV_HEADER,
      'Good Student,9,B,,Parent One,+91-9812345690,500',
      ',9,B,,Parent Two,+91-9812345691,500', // missing Name
      'Bad Fees,9,B,,Parent Three,+91-9812345692,abc', // FeeDues not numeric
    ].join('\r\n');
    const res = await upload(base, admin.accessToken, csv, 'bad.csv', 'text/csv');

    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'VALIDATION_ERROR');
    assert.ok(res.body.errors.row_3.Name, 'row 3 reports missing Name');
    assert.ok(res.body.errors.row_4.FeeDues, 'row 4 reports bad FeeDues');

    const after = await listStudents();
    assert.equal(after.length, before.length + 3, 'nothing from the rejected file was saved');
  });

  await t.test('wrong header row → 400 with the expected header', async () => {
    const res = await upload(base, admin.accessToken, 'Name,Class,Section\nA,9,B', 'wrong.csv', 'text/csv');
    assert.equal(res.status, 400);
    assert.match(res.body.errors.file, /Name, Class, Section, RollNumber, ParentGuardian, Contact, FeeDues/);
  });

  await t.test('XLSX upload parses server-side', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Students');
    sheet.addRow(['Name', 'Class', 'Section', 'RollNumber', 'ParentGuardian', 'Contact', 'FeeDues']);
    sheet.addRow(['Excel Kid, Jr.', '9', 'b', '', 'Parent X', '+91-9812345680', '750']);
    const buf = await book.xlsx.writeBuffer();
    const res = await upload(
      base,
      admin.accessToken,
      buf,
      'students.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );

    assert.equal(res.status, 201);
    const [created] = res.body.data.created;
    assert.equal(created.name, 'Excel Kid, Jr.'); // comma inside the name survived parsing
    assert.equal(created.section, 'B'); // normalized
    const group9B = before.filter((s) => s.class === '9' && s.section === 'B');
    const year9B = group9B[0].rollNumber.split('-')[1];
    assert.equal(created.rollNumber, `STU-${year9B}-002`);
    // username sanitization: 'Excel Kid, Jr.' → 'excel.kid.jr' (comma/space → dot)
    assert.equal(res.body.data.accounts[0].username, 'excel.kid.jr');
  });

  await t.test('unsupported extension and missing file are rejected', async () => {
    const bad = await upload(base, admin.accessToken, 'x', 'students.txt', 'text/plain');
    assert.equal(bad.status, 400);
    const none = await fetch(`${base}/admin/students/bulk`, { method: 'POST', headers: auth(admin.accessToken) });
    assert.equal(none.status, 400);
  });

  await t.test('JSON fallback applies the same rules', async () => {
    const res = await fetch(`${base}/admin/students/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(admin.accessToken) },
      body: JSON.stringify({
        students: [{
          name: 'Json Kid', class: '6', section: 'A',
          parentName: 'Json Guardian', guardianContact: '+91-9000000009',
        }],
      }),
    });
    assert.equal(res.status, 201);
    const { data } = await res.json();
    assert.equal(data.created[0].rollNumber, `STU-${new Date().getFullYear()}-001`);
    // The contact is what the password derives from, so a contact means an account.
    assert.equal(data.accountsCreated, 1);
    assert.equal(data.accounts[0].username, 'json.kid');
  });

  await t.test('the JSON fallback refuses a row missing a guardian field, naming it', async () => {
    const res = await fetch(`${base}/admin/students/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(admin.accessToken) },
      body: JSON.stringify({ students: [{ name: 'No Guardian Kid', class: '6', section: 'A' }] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.errors.row_1.parentName, 'a blank guardian name must be named');
    assert.ok(body.errors.row_1.guardianContact, 'a blank contact must be named');
  });

  await t.test('bulk-created students get logins: username from name, contact as password', async () => {
    const csv = [
      CSV_HEADER,
      'Kavya Nair,7,A,,Anil Nair,+91-9000000001,500',
      'Kavya Nair,7,A,,Anil Nair,+91-9000000002,500', // same name → collision suffix
    ].join('\r\n');
    const res = await upload(base, admin.accessToken, csv, 'students.csv', 'text/csv');
    assert.equal(res.status, 201);
    assert.equal(res.body.data.accountsCreated, 2);
    const [first, second] = res.body.data.accounts;
    assert.equal(first.username, 'kavya.nair'); // first claimant gets the clean base
    assert.equal(second.username, 'kavya.nair.2'); // suffix disambiguates, never fails
    assert.match(res.body.message, /2 login accounts created/);

    // BOTH logins actually work, each with its own guardian contact
    const one = await login(base, 'kavya.nair', '+91-9000000001');
    assert.ok(one.accessToken);
    const two = await login(base, 'kavya.nair.2', '+91-9000000002');
    assert.ok(two.accessToken);

    // User Accounts picks the accounts up automatically, tied to the students
    const users = await (await fetch(`${base}/admin/users`, { headers: auth(admin.accessToken) })).json();
    const kavya = users.data.find((u) => u.username === 'kavya.nair');
    assert.equal(kavya.role, 'student');
    assert.ok(kavya.linkedEntityId, 'account is linked to the student record');
  });

  await t.test('single Add Student also auto-creates the login, and guardian fields are now required', async () => {
    const post = (body) => fetch(`${base}/admin/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(admin.accessToken) },
      body: JSON.stringify(body),
    });

    const withContact = await (await post({
      name: 'Rohit Verma', class: '7', section: 'A',
      parentName: 'Rohit Guardian', guardianContact: '+91-9000000003',
    })).json();
    assert.equal(withContact.data.account.username, 'rohit.verma');
    // The derivation rule is stated in the create response and NOWHERE else —
    // this is the one-time handover moment; no later read returns it.
    assert.ok(
      withContact.message.startsWith('Student created. Login: rohit.verma (initial password = guardian contact'),
      `create message should state the initial password once — got: ${withContact.message}`,
    );
    assert.match(withContact.message, /cannot be retrieved afterwards/);
    const studentLogin = await login(base, 'rohit.verma', '+91-9000000003'); // contact works as the password
    assert.equal(studentLogin.user.mustChangePassword, true,
      'a login provisioned from the guardian contact must be forced to change it');

    // the student's profile exposes the username for the admin to hand out
    const prof = await fetch(`${base}/students/${withContact.data.id}/profile`, { headers: auth(admin.accessToken) });
    assert.equal(prof.status, 200);
    assert.equal((await prof.json()).data.username, 'rohit.verma');

    // A guardian name or contact may no longer be left blank on Add Student:
    // they are the identity the duplicate rule matches on and what the initial
    // password is derived from.
    const parsed = async (promise) => {
      const res = await promise;
      return { status: res.status, body: await res.json() };
    };
    const without = await parsed(post({ name: 'No Contact Kid', class: '7', section: 'A' }));
    assert.equal(without.status, 400);
    assert.ok(without.body.errors.parentName, 'a blank guardian name is refused');
    assert.ok(without.body.errors.guardianContact, 'a blank contact is refused');

    const shortContact = await parsed(post({
      name: 'Short Contact Kid', class: '7', section: 'A', parentName: 'Somebody', guardianContact: '98765',
    }));
    assert.equal(shortContact.status, 400);
    assert.ok(shortContact.body.errors.guardianContact, 'a short contact is refused');
    const nothing = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'no.contact.kid', password: 'whatever' }),
    });
    assert.equal(nothing.status, 401, 'no student — and no account — was created for the refused payload');
  });

  /* Bulk Add's roll-number generation deliberately walks EVERY student — roll
     numbering is per class, so finding the next free number means seeing each
     class's existing sequence. It read `s.class.grade` unguarded, and
     `Student.classId` is nullable now: one graduate anywhere in the school made
     this file 500 before a single row had been validated, so Bulk Add would
     simply stop working the moment anyone graduated a class. */
  await t.test('a file still uploads after a class has been passed out', async () => {
    const overview = (await (await fetch(`${base}/admin/class-management/overview`,
      { headers: auth(admin.accessToken) })).json()).data;
    const top = overview.classes.find((c) => c.action === 'passed_out');
    assert.ok(top, 'the school must have a graduating class for this to prove anything');

    const out = await fetch(`${base}/admin/class-management/classes/${top.id}/pass-out`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(admin.accessToken) },
      body: '{}',
    });
    assert.equal(out.status, 200, `pass out should succeed: ${await out.text()}`);

    const grads = (await listStudents()).filter((s) => s.class === null);
    assert.ok(grads.length > 0, 'the pass-out must have produced students with no class');

    const csv = [
      CSV_HEADER,
      'Zoya Iyer,7,A,,Farhan Iyer,+91-9000000005,0',
    ].join('\r\n');
    const res = await upload(base, admin.accessToken, csv, 'students.csv', 'text/csv');
    assert.equal(res.status, 201,
      `bulk add must survive a school containing graduates: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.data.count, 1);
  });

  await t.test('non-admin callers are rejected', async () => {
    const student = await login(base, 'student', 'Student@123');
    const res = await fetch(`${base}/admin/students/bulk`, { method: 'POST', headers: auth(student.accessToken) });
    assert.equal(res.status, 403);
  });

  await t.test('teardown — stop server', async () => {
    await stopServer(server);
  });
});