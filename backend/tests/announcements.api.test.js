/**
 * Integration tests: announcement targeting + PDF attachments.
 *
 * Covers the three ways a circular can be addressed (broad Audience publish,
 * one class, all employees), that the audience is enforced SERVER-side (an
 * out-of-audience circular and its PDF are 404, not "hidden in the UI"), and
 * that a teacher's push is limited to their own classes and attributed to them.
 *
 * Seed state used here: ann-001..ann-004 are role-scoped broadcasts, and
 * ann-005 is a CLASS-scoped push to cls-10A by emp-001 (Priya Sharma) with a
 * generated PDF attached. stu-001 is in cls-10A; stu-002 is not.
 *
 * A teacher's push scope is the SAME shared timetable rule as Attendance and
 * Marks Entry (`services/timetableScope.js`): emp-001 has a period only in
 * cls-10A, so cls-9B (which the seed assigns without a period) is not targetable.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

let ctx;
let admin;
let teacher; // emp-001 — has a timetable period only in cls-10A
let accountant; // emp-002 — no classes
let student; // stu-001 — class cls-10A

/** Bytes that start like a real PDF — the server checks the `%PDF-` magic. */
const PDF_BYTES = '%PDF-1.4\n%announcement-attachment-test\n%%EOF\n';

/**
 * Multipart POST — mirrors what the browser's FormData post sends.
 * An array value appends the field once per entry, which is how a repeated
 * form field (`targetRoles`) arrives as an array after urlencoded parsing.
 */
async function postForm(base, path, token, fields, file) {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => {
    if (v === undefined) return;
    (Array.isArray(v) ? v : [v]).forEach((one) => fd.append(k, one));
  });
  if (file) fd.append('file', new Blob([file.buffer], { type: file.mime }), file.name);
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

/** 'YYYY-MM-DD' for today and +30d, so a window that is live right now. */
const iso = (days) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
};

const baseFields = (over = {}) => ({
  title: 'Test circular body text long enough',
  body: 'This announcement body is definitely longer than ten characters.',
  category: 'general',
  showUntil: iso(30),
  ...over,
});

test('setup — boot API and log in all roles', async () => {
  ctx = await startServer();
  admin = await login(ctx.base, 'admin', 'Admin@123');
  teacher = await login(ctx.base, 'teacher', 'Teacher@123');
  accountant = await login(ctx.base, 'accountant', 'Accounts@123');
  student = await login(ctx.base, 'student', 'Student@123');
});

test('announcement send routes reject unauthenticated and wrong-role callers', async () => {
  for (const path of ['/admin/announcements/targeted', '/employees/emp-001/announcements']) {
    const anon = await request(ctx.base, path, { method: 'POST', body: baseFields() });
    assert.equal(anon.status, 401, `${path} must reject an anonymous caller`);

    const asStudent = await request(ctx.base, path, {
      method: 'POST', token: student.accessToken, body: baseFields(),
    });
    assert.equal(asStudent.status, 403, `${path} must reject a student`);
  }
});

/* ---------- Broad Audience publish (unchanged behaviour) ---------- */

test('broad publish still works over JSON and lands on the audience roles', async () => {
  const created = await request(ctx.base, '/admin/announcements', {
    method: 'POST',
    token: admin.accessToken,
    body: { ...baseFields({ title: 'Broad broadcast' }), targetRoles: ['accountant'] },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.targetScope, 'ROLES');
  assert.equal(created.body.data.hasAttachment, false);

  const list = await request(ctx.base, '/admin/announcements', { token: admin.accessToken });
  assert.ok(list.body.data.some((a) => a.id === created.body.data.id));

  const feed = await request(ctx.base, '/school/announcements', { token: accountant.accessToken });
  assert.ok(feed.body.data.some((a) => a.id === created.body.data.id), 'accountant sees it');
  const stuFeed = await request(ctx.base, '/school/announcements', { token: student.accessToken });
  assert.ok(!stuFeed.body.data.some((a) => a.id === created.body.data.id), 'student does not');

  const del = await request(ctx.base, `/admin/announcements/${created.body.data.id}`, {
    method: 'DELETE', token: admin.accessToken,
  });
  assert.equal(del.status, 200);
});

/* ---------- PDF attachment on the broad publish ---------- */

test('broad publish accepts a real PDF and rejects a non-PDF', async () => {
  // A single audience tag is sent as ONE multipart field (a bare string, not
  // an array) — the normalise step must accept that shape too.
  const ok = await postForm(
    ctx.base, '/admin/announcements', admin.accessToken,
    { ...baseFields({ title: 'With attachment' }), targetRoles: ['student'] },
    { buffer: Buffer.from(PDF_BYTES), mime: 'application/pdf', name: 'Notice board.pdf' },
  );
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.hasAttachment, true);
  assert.equal(ok.body.data.attachmentName, 'Notice board');
  assert.deepEqual(ok.body.data.targetRoles, ['student']);

  // A renamed .txt: right extension-free MIME claim is not enough, the magic
  // bytes must agree too.
  const fake = await postForm(
    ctx.base, '/admin/announcements', admin.accessToken,
    { ...baseFields({ title: 'Fake attachment' }), targetRoles: ['student'] },
    { buffer: Buffer.from('not a pdf at all'), mime: 'application/pdf', name: 'fake.pdf' },
  );
  assert.equal(fake.status, 400);
  assert.equal(fake.body.code, 'BAD_REQUEST');

  // The PDF is downloadable by a recipient, and the list never ships the bytes.
  const feed = await request(ctx.base, '/school/announcements', { token: student.accessToken });
  const mine = feed.body.data.find((a) => a.id === ok.body.data.id);
  assert.ok(mine, 'the attached circular is in the student feed');
  assert.equal(mine.hasAttachment, true);
  assert.equal(mine.pdfData, undefined, 'list responses must not include the PDF bytes');

  const dl = await fetch(`${ctx.base}/school/announcements/${ok.body.data.id}/pdf`, {
    headers: { Authorization: `Bearer ${student.accessToken}` },
  });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'the real PDF bytes come back');
});

/* ---------- Targeted send: one class ---------- */

test('targeted class send reaches only that class, and reports a real count', async () => {
  const sent = await postForm(ctx.base, '/admin/announcements/targeted', admin.accessToken, {
    ...baseFields({ title: 'Class 9B only notice' }),
    targetScope: 'CLASS',
    targetClassId: 'cls-9B',
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.data.targetScope, 'CLASS');
  assert.equal(sent.body.data.targetClassId, 'cls-9B');
  assert.equal(sent.body.data.targetClassLabel, 'Class 9B');
  // The class headcount comes from the students table, not from the client.
  assert.equal(sent.body.data.reached, 1);
  // The roles are derived server-side from the scope.
  assert.deepEqual(sent.body.data.targetRoles, ['student']);

  // stu-001 is in cls-10A → the cls-9B circular must not reach them.
  const stuFeed = await request(ctx.base, '/school/announcements', { token: student.accessToken });
  assert.ok(
    !stuFeed.body.data.some((a) => a.id === sent.body.data.id),
    'a student of another class must not receive it',
  );

  // Even with the id in hand, the body is a 404 for the wrong audience.
  const direct = await request(ctx.base, `/school/announcements/${sent.body.data.id}/pdf`, {
    token: student.accessToken,
  });
  assert.equal(direct.status, 404, 'out-of-audience id is 404, not a readable record');

  // The admin manages it from the same list as a broadcast.
  const list = await request(ctx.base, '/admin/announcements', { token: admin.accessToken });
  const row = list.body.data.find((a) => a.id === sent.body.data.id);
  assert.ok(row, 'targeted circulars appear in the admin list');
  assert.equal(row.targetScope, 'CLASS');
  assert.equal(row.targetClassLabel, 'Class 9B');

  const del = await request(ctx.base, `/admin/announcements/${sent.body.data.id}`, {
    method: 'DELETE', token: admin.accessToken,
  });
  assert.equal(del.status, 200);
});

test('a targeted class send without a class, or for a missing class, is rejected', async () => {
  const noClass = await postForm(ctx.base, '/admin/announcements/targeted', admin.accessToken, {
    ...baseFields(), targetScope: 'CLASS',
  });
  assert.equal(noClass.status, 400);
  assert.ok(noClass.body.errors?.targetClassId, 'reports which field is missing');

  const ghost = await postForm(ctx.base, '/admin/announcements/targeted', admin.accessToken, {
    ...baseFields(), targetScope: 'CLASS', targetClassId: 'cls-999',
  });
  assert.equal(ghost.status, 404);
});

/* ---------- Targeted send: all employees ---------- */

test('targeted employees send reaches every employee role and no students', async () => {
  const sent = await postForm(ctx.base, '/admin/announcements/targeted', admin.accessToken, {
    ...baseFields({ title: 'All staff notice' }),
    targetScope: 'EMPLOYEES',
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.data.targetScope, 'EMPLOYEES');
  assert.equal(sent.body.data.reached, 2, 'employee count comes from the employees table');
  assert.deepEqual(sent.body.data.targetRoles.sort(), ['accountant', 'librarian', 'teacher']);

  for (const who of [teacher, accountant]) {
    const feed = await request(ctx.base, '/school/announcements', { token: who.accessToken });
    assert.ok(feed.body.data.some((a) => a.id === sent.body.data.id), 'employee sees it');
  }
  const stuFeed = await request(ctx.base, '/school/announcements', { token: student.accessToken });
  assert.ok(!stuFeed.body.data.some((a) => a.id === sent.body.data.id), 'students do not');

  const del = await request(ctx.base, `/admin/announcements/${sent.body.data.id}`, {
    method: 'DELETE', token: admin.accessToken,
  });
  assert.equal(del.status, 200);
});

/* ---------- Employee Portal push ---------- */

test('teacher push lists exactly the classes they teach (timetable-scoped)', async () => {
  const res = await request(ctx.base, '/employees/emp-001/announcement/classes', { token: teacher.accessToken });
  assert.equal(res.status, 200);
  const ids = res.body.data.map((c) => c.id).sort();
  // The same shared timetable rule as Attendance and Marks Entry: emp-001 has a
  // period only in cls-10A (the seed's cls-9B assignment carries no period).
  assert.deepEqual(ids, ['cls-10A']);
  assert.ok(res.body.data.every((c) => typeof c.studentCount === 'number'));

  // The class list is a teaching-staff surface only, exactly like the
  // attendance one: a non-teacher employee is refused before any lookup.
  const asAccountant = await request(ctx.base, '/employees/emp-002/announcement/classes', { token: accountant.accessToken });
  assert.equal(asAccountant.status, 403);

  // Another teacher's list is not readable either.
  const foreign = await request(ctx.base, '/employees/emp-001/announcement/classes', { token: accountant.accessToken });
  assert.equal(foreign.status, 403);
});

test('teacher push is attributed to them and reaches only their class students', async () => {
  const sent = await postForm(
    ctx.base, '/employees/emp-001/announcements', teacher.accessToken,
    { ...baseFields({ title: 'Homework reminder from teacher' }), targetScope: 'CLASS', targetClassId: 'cls-10A' },
    { buffer: Buffer.from(PDF_BYTES), mime: 'application/pdf', name: 'worksheet.pdf' },
  );
  assert.equal(sent.status, 201);
  assert.equal(sent.body.data.targetClassId, 'cls-10A');
  assert.equal(sent.body.data.reached, 2, 'cls-10A really has two students (stu-001, stu-002)');
  assert.equal(sent.body.data.hasAttachment, true);
  assert.equal(sent.body.data.authorName, 'Priya Sharma', 'attributed to the pushing employee');
  assert.equal(sent.body.data.isTeacherPush, true);

  // stu-001 is in cls-10A → they see it, attributed.
  const feed = await request(ctx.base, '/school/announcements', { token: student.accessToken });
  const mine = feed.body.data.find((a) => a.id === sent.body.data.id);
  assert.ok(mine, 'the class sees its own teacher push');
  assert.equal(mine.fromTeacher, true);
  assert.equal(mine.authorName, 'Priya Sharma');
  assert.equal(mine.hasAttachment, true);
  assert.equal(mine.targetClassLabel, 'Class 10A');

  // Their teacher can download the attachment they attached — the author keeps
  // access to what they sent, even though the audience is one class of students.
  const dl = await fetch(`${ctx.base}/school/announcements/${sent.body.data.id}/pdf`, {
    headers: { Authorization: `Bearer ${teacher.accessToken}` },
  });
  assert.equal(dl.status, 200);
  assert.equal(Buffer.from(await dl.arrayBuffer()).subarray(0, 5).toString('latin1'), '%PDF-');

  // …but an unrelated employee is not in the audience and gets nothing.
  const otherStaff = await fetch(`${ctx.base}/school/announcements/${sent.body.data.id}/pdf`, {
    headers: { Authorization: `Bearer ${accountant.accessToken}` },
  });
  assert.equal(otherStaff.status, 404);

  // Their own send history lists it.
  const sentList = await request(ctx.base, '/employees/emp-001/announcements', { token: teacher.accessToken });
  assert.equal(sentList.status, 200);
  assert.ok(sentList.body.data.some((a) => a.id === sent.body.data.id));

  const del = await request(ctx.base, `/admin/announcements/${sent.body.data.id}`, {
    method: 'DELETE', token: admin.accessToken,
  });
  assert.equal(del.status, 200);
});

test('teacher cannot target a class they do not teach, nor all employees', async () => {
  // emp-001 has a period only in cls-10A; create a class they have no period in
  // (same approach as the teacher-attendance scoping test).
  const prisma = require('../src/services/prisma');
  const foreignClassId = 'cls-8C';
  await prisma.class.create({ data: { id: foreignClassId, grade: 8, section: 'C' } });
  await prisma.student.create({
    data: { id: 'stu-foreign', name: 'Foreign Student', classId: foreignClassId, rollNumber: 'STU-2023-F01' },
  });

  const other = await postForm(ctx.base, '/employees/emp-001/announcements', teacher.accessToken, {
    ...baseFields({ title: 'Sneaky class target' }), targetScope: 'CLASS', targetClassId: foreignClassId,
  });
  assert.equal(other.status, 403, "a class outside the teacher's assignments is rejected");
  assert.equal(other.body.code, 'FORBIDDEN');

  // Nothing was written for the rejected target.
  const leaked = await request(ctx.base, '/admin/announcements', { token: admin.accessToken });
  assert.ok(!leaked.body.data.some((a) => a.title === 'Sneaky class target'));

  // The all-employees scope is not even expressible on this route.
  const everyone = await postForm(ctx.base, '/employees/emp-001/announcements', teacher.accessToken, {
    ...baseFields({ title: 'Sneaky staff send' }), targetScope: 'EMPLOYEES',
  });
  assert.equal(everyone.status, 400, 'the all-employees scope is rejected for a teacher');
  assert.ok(everyone.body.errors?.targetScope);

  // An admin, by contrast, may target that same class.
  const byAdmin = await postForm(ctx.base, '/admin/announcements/targeted', admin.accessToken, {
    ...baseFields({ title: 'Admin to the other class' }), targetScope: 'CLASS', targetClassId: foreignClassId,
  });
  assert.equal(byAdmin.status, 201);
  assert.equal(byAdmin.body.data.reached, 1);
  const del = await request(ctx.base, `/admin/announcements/${byAdmin.body.data.id}`, {
    method: 'DELETE', token: admin.accessToken,
  });
  assert.equal(del.status, 200);
});

/* ---------- Seeded targeted circular ---------- */

test('the seeded class-scoped circular only reaches its own class', async () => {
  const list = await request(ctx.base, '/admin/announcements', { token: admin.accessToken });
  const seeded = list.body.data.find((a) => a.id === 'ann-005');
  assert.ok(seeded, 'the seeded targeted circular is listed for the admin');
  assert.equal(seeded.targetScope, 'CLASS');
  assert.equal(seeded.targetClassLabel, 'Class 10A');
  assert.equal(seeded.hasAttachment, true, 'it ships a real generated PDF');

  // stu-001 is in cls-10A.
  const feed = await request(ctx.base, '/school/announcements', { token: student.accessToken });
  const mine = feed.body.data.find((a) => a.id === 'ann-005');
  assert.ok(mine, 'cls-10A students see it');
  assert.equal(mine.authorName, 'Priya Sharma');
  assert.equal(mine.hasAttachment, true);

  const dl = await fetch(`${ctx.base}/school/announcements/ann-005/pdf`, {
    headers: { Authorization: `Bearer ${student.accessToken}` },
  });
  assert.equal(dl.status, 200);
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'the seeded PDF is a real file');
  assert.ok(bytes.length > 200, 'and it has real content');

  // An accountant (an employee, but not a student of that class) does not.
  const staffFeed = await request(ctx.base, '/school/announcements', { token: accountant.accessToken });
  assert.ok(!staffFeed.body.data.some((a) => a.id === 'ann-005'));
});

test('teardown', async () => {
  await stopServer(ctx.server);
});
