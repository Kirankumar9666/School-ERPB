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

test('document downloads: stored bytes round-trip and stay access-scoped', async () => {
  /** Binary GET — downloads aren't JSON, so the raw body + headers are kept */
  const raw = async (path, token) => {
    const res = await fetch(`${ctx.base}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
  };

  // Anonymous and wrong-role callers are rejected on every download surface
  for (const path of ['/admin/documents/doc-001/download', '/admin/student-documents/sdoc-001/download']) {
    assert.equal((await raw(path)).status, 401);
    assert.equal((await raw(path, student.accessToken)).status, 403);
    assert.equal((await raw(path, teacher.accessToken)).status, 403);
  }
  assert.equal((await raw('/employees/emp-001/documents/doc-001/download')).status, 401);
  assert.equal((await raw('/employees/emp-001/documents/doc-001/download', student.accessToken)).status, 403);

  // Seeded employee doc: the teacher downloads one of their OWN records
  const own = await raw('/employees/emp-001/documents/doc-001/download', teacher.accessToken);
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'application/pdf');
  assert.equal(own.headers.get('content-disposition'), 'attachment; filename="appointment_letter.pdf"');
  assert.ok(String(own.headers.get('cache-control')).includes('no-store'));
  assert.ok(own.buf.length > 300, 'seeded demo PDF has real content');
  assert.equal(own.buf.subarray(0, 5).toString('latin1'), '%PDF-');

  // Uploaded student doc: the bytes survive the round trip exactly
  const created = await upload(ctx.base, admin.accessToken,
    '/admin/students/stu-002/documents', PDF_BYTES, 'roundtrip.pdf', 'application/pdf', 'Other');
  assert.equal(created.status, 201);
  const dl = await raw(`/admin/student-documents/${created.body.data.id}/download`, admin.accessToken);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/pdf');
  assert.equal(dl.headers.get('content-disposition'), 'attachment; filename="roundtrip.pdf"');
  assert.ok(dl.buf.equals(Buffer.from(PDF_BYTES, 'utf8')));

  // Same bytes through the employees surface (admin fetching for emp-002)
  const empDoc = await upload(ctx.base, admin.accessToken,
    '/admin/employees/emp-002/documents', PDF_BYTES, 'roundtrip_emp.pdf', 'application/pdf', 'Other');
  assert.equal(empDoc.status, 201);
  const viaEmployees = await raw(`/employees/emp-002/documents/${empDoc.body.data.id}/download`, admin.accessToken);
  assert.equal(viaEmployees.status, 200);
  assert.ok(viaEmployees.buf.equals(Buffer.from(PDF_BYTES, 'utf8')));

  // Scoping: emp-001 naming emp-002's doc id on the employees route → 404
  const foreign = await raw(`/employees/emp-001/documents/${empDoc.body.data.id}/download`, teacher.accessToken);
  assert.equal(foreign.status, 404);

  // Unknown ids on all three surfaces
  assert.equal((await raw('/admin/documents/doc-999/download', admin.accessToken)).status, 404);
  assert.equal((await raw('/admin/student-documents/sdoc-999/download', admin.accessToken)).status, 404);
  assert.equal((await raw('/employees/emp-001/documents/doc-999/download', teacher.accessToken)).status, 404);

  // Metadata-only row (created before the bytes column existed) → NO_FILE
  const prisma = require('../src/services/prisma');
  await prisma.studentDocument.create({
    data: { id: 'sdoc-metaonly', studentId: 'stu-002', type: 'Legacy Record', fileName: 'pre_migration_record' },
  });
  const metaOnly = await raw('/admin/student-documents/sdoc-metaonly/download', admin.accessToken);
  assert.equal(metaOnly.status, 404);
  assert.equal(JSON.parse(metaOnly.buf.toString('utf8')).code, 'NO_FILE');

  // Lists stay metadata-only — the byte column never ships in a list response
  const adminList = await request(ctx.base, '/admin/documents', { token: admin.accessToken });
  assert.ok(adminList.body.data.length > 0);
  assert.ok(adminList.body.data.every((d) => !('data' in d)));
  const stuList = await request(ctx.base, '/admin/students/stu-001/documents', { token: admin.accessToken });
  assert.ok(stuList.body.data.every((d) => !('data' in d)));
  const empList = await request(ctx.base, '/employees/emp-001/documents', { token: teacher.accessToken });
  assert.ok(empList.body.data.every((d) => !('data' in d)));
});

test('teardown — stop server', async () => { await stopServer(ctx.server); });

