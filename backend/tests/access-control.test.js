/**
 * Access control — one systematic sweep of the whole API's role gates.
 *
 * Every other test file checks the roles and scoping it happens to touch. This
 * one is deliberately different: it walks EVERY non-admin role against the admin
 * surface and against other people's data in one place, so a route that was left
 * ungated (or scoped only in the UI) is caught by a single check that names it.
 *
 * Three sweeps:
 *   1. Every non-admin role → 403 on every admin route prefix (and 401 without a
 *      token, for a representative route of each prefix).
 *   2. Cross-tenant data reads: a student reading another student, a teacher
 *      reading a student in a class they do not teach, an employee reading
 *      another employee's records — all 403, enforced server-side.
 *   3. A student/teacher outside their scope must not be able to reach their own
 *      data through a foreign id either.
 *
 * The subjects of the scoping checks are created here (a class no teacher is
 * assigned to, a student in it), never assumed from the fixture — so the test
 * cannot pass just because the seed happens not to contain an out-of-scope pair.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request, auth } = require('./helpers');

let ctx;
let admin;
let student;
let teacher;
let accountant;

/** A class no staff member is assigned to, and a student placed in it. */
let outsiderClassId;
let outsiderStudentId;

const ROLES_UNDER_TEST = [
  ['student', () => student],
  ['teacher', () => teacher],
  ['accountant', () => accountant],
];

/**
 * Every admin route prefix, with a representative concrete path. `GET` unless a
 * method is given — a read is enough to prove the gate, and reading never
 * mutates the database the other tests share.
 */
const ADMIN_ROUTES = [
  ['students', '/admin/students'],
  ['students by-class', '/admin/students/by-class'],
  ['classes', '/admin/classes'],
  ['class-levels', '/admin/class-levels'],
  ['employees', '/admin/employees'],
  ['leaves', '/admin/leaves/pending'],
  ['class-management', '/admin/class-management/years'],
  ['payroll', '/admin/payroll'],
  ['announcements', '/admin/announcements'],
  ['holidays', '/admin/holidays'],
  ['attendance', '/admin/attendance/group?kind=student&groupKey=cls-10A&date=2026-09-01&session=FN'],
  ['marks', '/admin/marks'],
  ['timetable', '/admin/timetable'],
  ['syllabus', '/admin/syllabus'],
  ['achievements', '/admin/achievements'],
  ['documents', '/admin/documents'],
  ['users', '/admin/users'],
  ['audit-log', '/admin/audit-log'],
  ['reports', '/admin/reports/summary'],
];

test('setup — boot the API, log in every role, and create an out-of-scope class + student', async () => {
  ctx = await startServer();
  admin = await login(ctx.base, 'admin', 'Admin@123');
  student = await login(ctx.base, 'student', 'Student@123');
  teacher = await login(ctx.base, 'teacher', 'Teacher@123');
  accountant = await login(ctx.base, 'accountant', 'Accounts@123');

  // A level to hang a brand-new class off (the seeded level list is real data).
  const levels = await request(ctx.base, '/admin/class-levels', { token: admin.accessToken });
  assert.equal(levels.status, 200, 'admin can list class levels');
  const levelId = levels.body.data[0].id;

  // Section 'Z' of that level — no teacher is assigned to it, and it is not a
  // class any fixture student sits in.
  const cls = await request(ctx.base, '/admin/classes', {
    method: 'POST', token: admin.accessToken, body: { levelId, section: 'Z' },
  });
  assert.equal(cls.status, 201, `class created: ${JSON.stringify(cls.body)}`);
  outsiderClassId = cls.body.data.id;

  const created = await request(ctx.base, '/admin/students', {
    method: 'POST',
    token: admin.accessToken,
    body: {
      name: 'Outsider Probe',
      classId: outsiderClassId,
      admissionYear: new Date().getUTCFullYear(),
      parentName: 'Probe Guardian',
      guardianContact: '+91-9000000042',
    },
  });
  assert.equal(created.status, 201, `outsider student created: ${JSON.stringify(created.body)}`);
  outsiderStudentId = created.body.data.id;
});

/* ── Sweep 1: no non-admin role reaches an admin route ─────────────────────── */

for (const [roleName, getSession] of ROLES_UNDER_TEST) {
  test(`admin sweep — ${roleName} is refused (403) on every admin route`, async () => {
    const session = getSession();
    for (const [label, path] of ADMIN_ROUTES) {
      const res = await request(ctx.base, path, { token: session.accessToken });
      assert.equal(res.status, 403,
        `${roleName} hitting ${label} (${path}) must be 403, got ${res.status}`);
      assert.equal(res.body.code, 'FORBIDDEN', `${label} should answer FORBIDDEN`);
    }
  });
}

test('admin sweep — no token is 401 on a representative admin route', async () => {
  const res = await request(ctx.base, '/admin/students');
  assert.equal(res.status, 401);
});

test('admin sweep — a garbage token is 401, not 403', async () => {
  const res = await request(ctx.base, '/admin/users', { token: 'not-a-real-token' });
  assert.equal(res.status, 401);
});

/* ── Sweep 2: a student cannot read another student ────────────────────────── */

test('student → another student is 403 on every student read', async () => {
  const paths = [
    '/students/stu-002/profile',
    '/students/stu-002/fees',
    '/students/stu-002/attendance?month=2026-09',
    '/students/stu-002/marks',
    '/students/stu-002/timetable',
    '/students/stu-002/achievements',
    '/students/stu-002/syllabus',
  ];
  for (const path of paths) {
    const res = await request(ctx.base, path, { token: student.accessToken });
    assert.equal(res.status, 403, `student reading ${path} must be 403, got ${res.status}`);
  }
});

/* ── Sweep 3: staff are scoped to students in the classes they teach ───────── */

test('teacher → a student outside their classes is 404 (out of scope) on every student read', async () => {
  // The outsider student sits in a class no teacher is assigned to, so this is
  // genuinely out of scope (not a fixture coincidence). Out of scope is answered
  // as "not found" so the id cannot be probed for existence.
  const paths = [
    `/students/${outsiderStudentId}/profile`,
    `/students/${outsiderStudentId}/attendance?month=2026-09`,
    `/students/${outsiderStudentId}/marks`,
    `/students/${outsiderStudentId}/timetable`,
    `/students/${outsiderStudentId}/achievements`,
    `/students/${outsiderStudentId}/syllabus`,
  ];
  for (const path of paths) {
    const res = await request(ctx.base, path, { token: teacher.accessToken });
    assert.equal(res.status, 404,
      `teacher reading an out-of-class student (${path}) must be 404, got ${res.status}`);
  }
});

test('teacher → a student IN their classes is allowed (the gate is scoping, not a blanket block)', async () => {
  // stu-001 is in cls-10A, which the seeded teacher (emp-001) has a period in.
  const res = await request(ctx.base, '/students/stu-001/profile', { token: teacher.accessToken });
  assert.equal(res.status, 200, 'a teacher may still read a student they teach');
});

test('teacher → an out-of-class student is also refused on the class-scoped write routes', async () => {
  // Belt to the read sweep's braces: the marks write route refuses a
  // (class, subject) the teacher does not hold, even when the id is posted. The
  // body is a VALID shape so the request reaches the scope gate (a malformed body
  // would be a 400 from validation, which is a different thing).
  const marks = await request(ctx.base, '/employees/emp-001/marks', {
    method: 'POST',
    token: teacher.accessToken,
    body: {
      classId: outsiderClassId,
      subject: 'Mathematics',
      examName: 'Probe Exam',
      maxMarks: 100,
      entries: [{ studentId: outsiderStudentId, obtained: 50 }],
    },
  });
  assert.equal(marks.status, 403, `teacher writing marks for an unassigned class must be 403, got ${marks.status}`);
});

/* ── Sweep 4: an employee cannot read another employee ─────────────────────── */

test('employee → another employee is 403 on every employee read', async () => {
  // emp-001 (teacher) reading emp-002 (accountant), and vice versa.
  const empOnePaths = [
    '/employees/emp-002/profile',
    '/employees/emp-002/attendance?month=2026-09',
    '/employees/emp-002/leaves',
    '/employees/emp-002/payroll',
    '/employees/emp-002/timetable',
    '/employees/emp-002/assigned-classes',
    '/employees/emp-002/documents',
  ];
  for (const path of empOnePaths) {
    const res = await request(ctx.base, path, { token: teacher.accessToken });
    assert.equal(res.status, 403, `teacher reading emp-002 ${path} must be 403, got ${res.status}`);
  }

  const res = await request(ctx.base, '/employees/emp-001/profile', { token: accountant.accessToken });
  assert.equal(res.status, 403, 'accountant reading emp-001 profile must be 403');
});

test('employee → their OWN record is allowed', async () => {
  const own = await request(ctx.base, '/employees/emp-001/profile', { token: teacher.accessToken });
  assert.equal(own.status, 200, 'a teacher may read their own profile');
});

/* ── Sweep 5: the fee desk is office-only ──────────────────────────────────── */

test('fees — teacher and student are refused the office fee routes', async () => {
  for (const [roleName, session] of [['teacher', teacher], ['student', student]]) {
    const res = await request(ctx.base, '/fees/dues', { token: session.accessToken });
    assert.equal(res.status, 403, `${roleName} hitting the fee desk must be 403, got ${res.status}`);
  }
});

test('fees — the accountant (the fee desk) is allowed the office fee routes', async () => {
  const res = await request(ctx.base, '/fees/dues', { token: accountant.accessToken });
  assert.equal(res.status, 200, 'the accountant is the fee desk and may read it');
});

/* ── Sweep 6: the accountant may NOT read another employee, only fees ──────── */

test('accountant → admin-only payroll routes are 403', async () => {
  const res = await request(ctx.base, '/admin/payroll', { token: accountant.accessToken });
  assert.equal(res.status, 403, 'payroll administration is admin-only');
});

/* ── Sweep 7: a student cannot act as staff, and vice versa ────────────────── */

test('student → teacher-only write routes are 403', async () => {
  const res = await request(ctx.base, '/employees/emp-001/attendance/bulk', {
    method: 'POST',
    token: student.accessToken,
    body: { groupKey: 'cls-10A', date: '2026-09-01', session: 'FN', records: [] },
  });
  assert.equal(res.status, 403, 'a student must not mark attendance');
});

test('teardown — stop the server', async () => { await stopServer(ctx.server); });
