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
    assert.equal(res.body.message, '3 students added'); // derived, not hardcoded

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
      body: JSON.stringify({ students: [{ name: 'Json Kid', class: '6', section: 'A' }] }),
    });
    assert.equal(res.status, 201);
    const { data } = await res.json();
    assert.equal(data.created[0].rollNumber, `STU-${new Date().getFullYear()}-001`);
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