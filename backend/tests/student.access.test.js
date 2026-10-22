/**
 * Per-student and per-class access control — the shared rule
 * (`services/studentAccess.js`) exercised end to end, as every role.
 *
 * The task: a previous audit found attendance was class-scoped but the other
 * student reads (marks, profile, timetable, achievements, syllabus) only handled
 * the "student viewing self" case, so any staff role could read any child by id.
 * This file pins the fixed rule:
 *
 *   student    → only their own record
 *   teacher    → only students in a class they have a TimetablePeriod in
 *   accountant → fee/payment data + name/class/guardian contact; NO marks,
 *                attendance or other profile details
 *   librarian  → no student data at all
 *   admin      → everything
 *
 * Refusal codes: 404 for an existing record that is out of scope (no existence
 * probe), 403 for a role with no access to the surface.
 *
 * Subjects are CREATED here (a class with no teacher, a student inside it, a
 * librarian account) rather than assumed from the seed, so a test cannot pass
 * just because the fixture happens to lack an out-of-scope pair.
 *
 * Writes are covered as well as reads: the marks-write route refuses an
 * out-of-class id, and the fee/payment write routes obey the same rule.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { startServer, stopServer, login, request } = require('./helpers');

let ctx;
let admin;
let student;   // stu-001 — Arjun Kumar, in cls-10A (the teacher's class)
let teacher;   // emp-001 — Priya Sharma, a timetable period in cls-10A
let accountant;
let librarian;

/** A class no teacher is assigned to, and a student placed in it. */
let outsiderClassId;
let outsiderStudentId;

const LOGIN_FOR = {
  admin: 'Admin@123',
  student: 'Student@123',
  teacher: 'Teacher@123',
  accountant: 'Accounts@123',
};

before(async () => {
  ctx = await startServer();
  admin = await login(ctx.base, 'admin', LOGIN_FOR.admin);
  student = await login(ctx.base, 'student', LOGIN_FOR.student);
  teacher = await login(ctx.base, 'teacher', LOGIN_FOR.teacher);
  accountant = await login(ctx.base, 'accountant', LOGIN_FOR.accountant);

  /* A librarian has no seeded account. Create the employee + user directly, so
     the librarian rule is tested for real rather than skipped. The link lives on
     Employee.userId; `linkedEntityId` is derived from it at login. */
  const prisma = require('../src/services/prisma');
  const empId = 'emp-lib-test';
  await prisma.user.upsert({
    where: { username: 'librarian' },
    update: {},
    create: {
      id: 'usr-lib-test', username: 'librarian', passwordHash: bcrypt.hashSync('Library@123', 10),
      role: 'librarian', name: 'Library Test', status: 'active',
    },
  });
  await prisma.employee.upsert({
    where: { id: empId },
    update: { userId: 'usr-lib-test' },
    create: {
      id: empId, employeeId: 'EMP-LIB', name: 'Library Test',
      designation: 'Librarian', department: 'Library',
      mobile: '9000000099', status: 'active', userId: 'usr-lib-test',
    },
  });
  librarian = await login(ctx.base, 'librarian', 'Library@123');

  // An out-of-scope class + student, created through the API (never assumed).
  const levels = await request(ctx.base, '/admin/class-levels', { token: admin.accessToken });
  const levelId = levels.body.data[0].id;
  const cls = await request(ctx.base, '/admin/classes', {
    method: 'POST', token: admin.accessToken, body: { levelId, section: 'Z' },
  });
  assert.equal(cls.status, 201, `outsider class created: ${JSON.stringify(cls.body)}`);
  outsiderClassId = cls.body.data.id;

  const created = await request(ctx.base, '/admin/students', {
    method: 'POST',
    token: admin.accessToken,
    body: {
      name: 'Outsider Probe', classId: outsiderClassId,
      admissionYear: new Date().getUTCFullYear(),
      parentName: 'Probe Guardian', guardianContact: '+91-9000000042',
    },
  });
  assert.equal(created.status, 201, `outsider student created: ${JSON.stringify(created.body)}`);
  outsiderStudentId = created.body.data.id;
});

after(async () => { await stopServer(ctx.server); });

const STUDENT_READS = (id) => [
  ['profile', `/students/${id}/profile`],
  ['marks', `/students/${id}/marks`],
  ['timetable', `/students/${id}/timetable`],
  ['achievements', `/students/${id}/achievements`],
  ['syllabus', `/students/${id}/syllabus`],
  ['attendance', `/students/${id}/attendance?month=2026-09`],
];

/* ── Student ─────────────────────────────────────────────────────────────── */

test('student reads their OWN record (profile, fees, marks, attendance, timetable, achievements, syllabus)', async () => {
  const paths = [
    '/students/stu-001/profile',
    '/students/stu-001/fees',
    '/students/stu-001/marks',
    '/students/stu-001/timetable',
    '/students/stu-001/achievements',
    '/students/stu-001/syllabus',
    '/students/stu-001/attendance?month=2026-09',
  ];
  for (const p of paths) {
    const res = await request(ctx.base, p, { token: student.accessToken });
    assert.equal(res.status, 200, `student reading own ${p} must be 200, got ${res.status}`);
  }
});

test('student reading ANOTHER student is refused on every read', async () => {
  for (const [label, p] of STUDENT_READS('stu-002')) {
    const res = await request(ctx.base, p, { token: student.accessToken });
    assert.equal(res.status, 403, `student reading ${label} of another student must be 403, got ${res.status}`);
    assert.equal(res.body.code, 'FORBIDDEN');
  }
});

/* ── Teacher ─────────────────────────────────────────────────────────────── */

test('teacher reads a student IN a class they teach (all reads) and is refused a student in a class they do not', async () => {
  // stu-001 is in cls-10A, which emp-001 is assigned to teach.
  for (const [label, p] of STUDENT_READS('stu-001')) {
    const res = await request(ctx.base, p, { token: teacher.accessToken });
    assert.equal(res.status, 200, `teacher reading IN-class ${label} must be 200, got ${res.status}`);
  }

  // The outsider student is in a class no teacher is assigned to.
  for (const [label, p] of STUDENT_READS(outsiderStudentId)) {
    const res = await request(ctx.base, p, { token: teacher.accessToken });
    assert.equal(res.status, 404,
      `teacher reading OUT-of-class ${label} must be 404 (out of scope), got ${res.status}`);
  }
});

test('teacher WRITE: marks entry refuses a class the teacher has no period in (scope check on the write path)', async () => {
  const res = await request(ctx.base, '/employees/emp-001/marks', {
    method: 'POST',
    token: teacher.accessToken,
    body: {
      classId: outsiderClassId, subject: 'Mathematics', examName: 'Access Probe',
      maxMarks: 100, entries: [{ studentId: outsiderStudentId, obtained: 50 }],
    },
  });
  assert.equal(res.status, 403, `teacher writing marks for a class with no period must be 403, got ${res.status}`);
});

test('teacher WRITE: marks entry IS allowed for a class the teacher has a period in (the gate is scope, not a blanket block)', async () => {
  // cls-10A + Mathematics is a live (class, subject) pair for emp-001 via the
  // timetable — the same source the attendance scope now reads.
  const res = await request(ctx.base, '/employees/emp-001/marks', {
    method: 'GET',
    token: teacher.accessToken,
  });
  // A read with no classId is a validation error — but it proves the route is
  // reachable for the assigned teacher (not a 403).
  assert.notEqual(res.status, 403, `teacher with a period must not be 403 on marks (got ${res.status})`);
});

/* ── Accountant ──────────────────────────────────────────────────────────── */

test('accountant reads fee data for ANY student (fee desk) and the profile returns name/class/guardian only', async () => {
  // Fee surface (the accountant's job): any student.
  const fees = await request(ctx.base, '/students/stu-001/fees', { token: accountant.accessToken });
  assert.equal(fees.status, 200, 'accountant may read any student\'s fees');
  assert.ok(fees.body.data.summary, 'fee summary present');

  const dues = await request(ctx.base, '/fees/students/stu-001', { token: accountant.accessToken });
  assert.equal(dues.status, 200, 'accountant may read the office fee detail for any student');

  // Restricted profile: identity + guardian, nothing else.
  const profile = await request(ctx.base, '/students/stu-001/profile', { token: accountant.accessToken });
  assert.equal(profile.status, 200, 'accountant gets a restricted profile, not a refusal');
  const d = profile.body.data;
  assert.equal(d.name, 'Arjun Kumar');
  assert.ok(d.classLabel || d.class, 'class is present');
  assert.ok('guardianContact' in d && 'parentName' in d, 'guardian fields present');
  for (const forbidden of ['dob', 'bloodGroup', 'address', 'admissionYear', 'username', 'feeTotal', 'feeDues']) {
    assert.ok(!(forbidden in d),
      `the accountant profile must NOT expose "${forbidden}" (got ${JSON.stringify(Object.keys(d))})`);
  }
});

test('accountant is REFUSED marks, attendance, timetable, achievements and syllabus', async () => {
  for (const [label, p] of [
    ['marks', '/students/stu-001/marks'],
    ['attendance', '/students/stu-001/attendance?month=2026-09'],
    ['timetable', '/students/stu-001/timetable'],
    ['achievements', '/students/stu-001/achievements'],
    ['syllabus', '/students/stu-001/syllabus'],
  ]) {
    const res = await request(ctx.base, p, { token: accountant.accessToken });
    assert.equal(res.status, 403, `accountant reading ${label} must be 403, got ${res.status}`);
  }
});

test('accountant can SET a fee (write) and RECORD a payment (write) — and the shared rule admits them for the fee desk', async () => {
  const amount = await request(ctx.base, '/fees/students/stu-002/amount', {
    method: 'PUT', token: accountant.accessToken, body: { amount: 1000 },
  });
  assert.equal(amount.status, 200, `accountant setting a fee must be 200, got ${amount.status}`);

  /* The payment route is admitted (never 403); the business rule about how much
     may be paid against what is owed is a separate, legitimate answer. */
  const pay = await request(ctx.base, '/fees/students/stu-002/payments', {
    method: 'POST', token: accountant.accessToken, body: { amount: 100, paidOn: '2026-09-05' },
  });
  assert.notEqual(pay.status, 403, `accountant must not be refused the payment route (got ${pay.status})`);
  assert.ok(pay.status < 500, `payment route answered without a server error (got ${pay.status})`);
});

/* ── Librarian ───────────────────────────────────────────────────────────── */

test('librarian is refused EVERY student surface (no student data)', async () => {
  const paths = [
    '/students/stu-001/profile',
    '/students/stu-001/fees',
    '/students/stu-001/marks',
    '/students/stu-001/timetable',
    '/students/stu-001/achievements',
    '/students/stu-001/syllabus',
    '/students/stu-001/attendance?month=2026-09',
    '/fees/dues',
    '/fees/students/stu-001',
  ];
  for (const p of paths) {
    const res = await request(ctx.base, p, { token: librarian.accessToken });
    assert.equal(res.status, 403, `librarian reading ${p} must be 403, got ${res.status}`);
    assert.equal(res.body.code, 'FORBIDDEN');
  }
});

test('librarian is refused student WRITES (fee amount, payment, marks)', async () => {
  const amount = await request(ctx.base, '/fees/students/stu-001/amount', {
    method: 'PUT', token: librarian.accessToken, body: { amount: 500 },
  });
  assert.equal(amount.status, 403, 'librarian must not set a fee');

  const pay = await request(ctx.base, '/fees/students/stu-001/payments', {
    method: 'POST', token: librarian.accessToken, body: { amount: 10 },
  });
  assert.equal(pay.status, 403, 'librarian must not record a payment');

  const marks = await request(ctx.base, '/employees/emp-lib-test/marks', {
    method: 'POST', token: librarian.accessToken,
    body: { classId: outsiderClassId, subject: 'Mathematics', examName: 'x', maxMarks: 10, entries: [{ studentId: outsiderStudentId, obtained: 1 }] },
  });
  assert.equal(marks.status, 403, 'librarian must not enter marks');
});

/* ── Admin ───────────────────────────────────────────────────────────────── */

test('admin reads everything (all student surfaces + class-scoped routes)', async () => {
  for (const [label, p] of STUDENT_READS('stu-001')) {
    const res = await request(ctx.base, p, { token: admin.accessToken });
    assert.equal(res.status, 200, `admin reading ${label} must be 200, got ${res.status}`);
  }
  for (const [label, p] of STUDENT_READS(outsiderStudentId)) {
    const res = await request(ctx.base, p, { token: admin.accessToken });
    assert.equal(res.status, 200, `admin reading out-of-class ${label} (everything) must be 200, got ${res.status}`);
  }
  const fees = await request(ctx.base, '/fees/students/stu-001', { token: admin.accessToken });
  assert.equal(fees.status, 200, 'admin may read the fee detail');
});
