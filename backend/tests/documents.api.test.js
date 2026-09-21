/**
 * Integration tests: document records — employee documents (existing surface)
 * and the per-student document surface used by the reworked Document
 * Management screen (Students / Employees tabs).
 * Seed state: emp-001 has 4 documents, emp-002 none; stu-001 has 2,
 * stu-002/stu-003 none.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

let ctx;
let admin;
let teacher; // emp-001
let student; // stu-001

/** Bytes that start like a real PDF — the server checks the `%PDF-` magic. */
const PDF_BYTES = '%PDF-1.4\n%minimal-test-document\n';

/**
 * Multipart upload helper — mirrors exactly what the browser's
 * `FormData` post sends through the axios instance.
 */
async function upload(base, token, path, buffer, filename, mime, type = 'ID Card') {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mime }), filename);
  fd.append('type', type);
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

test('setup — boot API and log in all roles', async () => {
  ctx = await startServer();
  admin = await login(ctx.base, 'admin', 'Admin@123');
  teacher = await login(ctx.base, 'teacher', 'Teacher@123');
  student = await login(ctx.base, 'student', 'Student@123');
});

test('admin document routes reject non-admin callers', async () => {
  for (const path of ['/admin/students/stu-001/documents', '/admin/student-documents/sdoc-001']) {
    const anon = await request(ctx.base, path);
    assert.equal(anon.status, 401);

    const studentRes = await request(ctx.base, path, { token: student.accessToken });
    assert.equal(studentRes.status, 403);

    const teacherRes = await request(ctx.base, path, { token: teacher.accessToken });
    assert.equal(teacherRes.status, 403);
  }
});

test('seeded per-student documents are listed newest first, strictly scoped', async () => {
  const res = await request(ctx.base, '/admin/students/stu-001/documents', { token: admin.accessToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 2);
  assert.ok(res.body.data.every((d) => d.studentId === 'stu-001'));
  assert.equal(res.body.data[0].fileName, 'tc_previous_school.pdf'); // 2022-06-05 newer
  assert.equal(res.body.data[0].type, 'Transfer Certificate');

  // A student with none gets an empty list (the UI renders its empty state)
  const none = await request(ctx.base, '/admin/students/stu-002/documents', { token: admin.accessToken });
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.data, []);

  const missing = await request(ctx.base, '/admin/students/stu-999/documents', { token: admin.accessToken });
  assert.equal(missing.status, 404);
});

test('student documents: upload persists into that student\'s file only', async () => {
  const badPayload = await request(ctx.base, '/admin/students/stu-002/documents', {
    method: 'POST', token: admin.accessToken,
    body: { type: 'x' }, // schema requires 2+ chars
  });
  assert.equal(badPayload.status, 400);
  assert.equal(badPayload.body.code, 'VALIDATION_ERROR');

  // No file attached at all
  const noFile = await request(ctx.base, '/admin/students/stu-002/documents', {
    method: 'POST', token: admin.accessToken,
    body: { type: 'ID Card' },
  });
  assert.equal(noFile.status, 400);
  assert.equal(noFile.body.code, 'BAD_REQUEST');

  // A text file renamed/typed with a .pdf name is rejected — extension alone lies
  const fakeExt = await upload(ctx.base, admin.accessToken,
    '/admin/students/stu-002/documents', 'plain text, not a pdf', 'id_card.pdf', 'text/plain');
  assert.equal(fakeExt.status, 400);
  assert.equal(fakeExt.body.message, 'Only PDF files are allowed');

  // pdf MIME + .pdf extension but wrong magic bytes (bypass attempt) — rejected
  const fakeMagic = await upload(ctx.base, admin.accessToken,
    '/admin/students/stu-002/documents', 'MZnot-a-pdf', 'forged.pdf', 'application/pdf');
  assert.equal(fakeMagic.status, 400);
  assert.equal(fakeMagic.body.message, 'Only PDF files are allowed');

  // Unknown student with a *valid* upload — still 404
  const unknownStudent = await upload(ctx.base, admin.accessToken,
    '/admin/students/stu-999/documents', PDF_BYTES, 'id_card.pdf', 'application/pdf');
  assert.equal(unknownStudent.status, 404);

  // Happy path: a real PDF — the stored name is DERIVED from the uploaded file
  const created = await upload(ctx.base, admin.accessToken,
    '/admin/students/stu-002/documents', PDF_BYTES, 'sneha_id_card.pdf', 'application/pdf');
  assert.equal(created.status, 201);
  assert.equal(created.body.data.studentId, 'stu-002');
  assert.equal(created.body.data.fileName, 'sneha_id_card', 'name comes from the file, extension stripped');
  assert.equal(created.body.data.type, 'ID Card');
  const stu2DocId = created.body.data.id;
  assert.ok(stu2DocId.startsWith('sdoc-'), 'student doc ids are sdoc-prefixed');

  // Exactly one record for stu-002; stu-001 (and the employee surface) untouched
  const list = await request(ctx.base, '/admin/students/stu-002/documents', { token: admin.accessToken });
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].id, stu2DocId);

  const stu1 = await request(ctx.base, '/admin/students/stu-001/documents', { token: admin.accessToken });
  assert.equal(stu1.body.data.length, 2);
});

test('student document delete removes exactly one record, scoped by unique id', async () => {
  // Upload one more for stu-002 so the delete target is unambiguous
  const another = await upload(ctx.base, admin.accessToken,
    '/admin/students/stu-002/documents', PDF_BYTES, 'report_card_term1.pdf', 'application/pdf', 'Report Card');
  assert.equal(another.status, 201);

  const del = await request(ctx.base, `/admin/student-documents/${another.body.data.id}`, {
    method: 'DELETE', token: admin.accessToken,
  });
  assert.equal(del.status, 200);

  const list = await request(ctx.base, '/admin/students/stu-002/documents', { token: admin.accessToken });
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].type, 'ID Card'); // the other record survived

  // stu-001's two seeded records were never in scope
  const stu1 = await request(ctx.base, '/admin/students/stu-001/documents', { token: admin.accessToken });
  assert.equal(stu1.body.data.length, 2);

  const bogus = await request(ctx.base, '/admin/student-documents/sdoc-999', {
    method: 'DELETE', token: admin.accessToken,
  });
  assert.equal(bogus.status, 404);
});

test('employee documents: existing surface still works end to end', async () => {
  const all = await request(ctx.base, '/admin/documents', { token: admin.accessToken });
  assert.equal(all.status, 200);
  assert.equal(all.body.data.length, 4); // seed: all four belong to emp-001
  assert.equal(all.body.data[0].employeeName, 'Priya Sharma');

  // Admin can read one employee's list through the employees router
  const own = await request(ctx.base, '/employees/emp-001/documents', { token: teacher.accessToken });
  assert.equal(own.status, 200);
  assert.equal(own.body.data.length, 4);
  const asAdmin = await request(ctx.base, '/employees/emp-001/documents', { token: admin.accessToken });
  assert.equal(asAdmin.status, 200);

  // Upload for the employee who had none
  const created = await upload(ctx.base, admin.accessToken,
    '/admin/employees/emp-002/documents', PDF_BYTES, 'ravi_contract.pdf', 'application/pdf', 'Contract');
  assert.equal(created.status, 201);
  assert.equal(created.body.data.fileName, 'ravi_contract');

  const after = await request(ctx.base, '/employees/emp-002/documents', { token: admin.accessToken });
  assert.equal(after.status, 200);
  assert.equal(after.body.data.length, 1);

  // Delete scoped to that record; emp-001 untouched
  const del = await request(ctx.base, `/admin/documents/${created.body.data.id}`, {
    method: 'DELETE', token: admin.accessToken,
  });
  assert.equal(del.status, 200);
  const emp1After = await request(ctx.base, '/employees/emp-001/documents', { token: teacher.accessToken });
  assert.equal(emp1After.body.data.length, 4);
});

test('teardown — stop server', async () => { await stopServer(ctx.server); });

