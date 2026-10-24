/**
 * Integration tests: employee API endpoints (/api/v1/employees/:id/*).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

let ctx;
let admin;
let teacher; // emp-001
let accountant; // emp-002
let student;

test('setup — boot API and log in all roles', async () => {
  ctx = await startServer();
  admin = await login(ctx.base, 'admin', 'Admin@123');
  teacher = await login(ctx.base, 'teacher', 'Teacher@123');
  accountant = await login(ctx.base, 'accountant', 'Accounts@123');
  student = await login(ctx.base, 'student', 'Student@123');
});

test('employee can view own profile', async () => {
  const res = await request(ctx.base, '/employees/emp-001/profile', { token: teacher.accessToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.name, 'Priya Sharma');
  assert.equal(res.body.data.role, 'teacher');
  assert.equal(res.body.data.assignedClasses.length, 2);
});

test('employee cannot view another employee profile → 403', async () => {
  const res = await request(ctx.base, '/employees/emp-002/profile', { token: teacher.accessToken });
  assert.equal(res.status, 403);
});

test('admin can view any employee profile; student role is rejected', async () => {
  const ok = await request(ctx.base, '/employees/emp-002/profile', { token: admin.accessToken });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.name, 'Ravi Patel');

  const denied = await request(ctx.base, '/employees/emp-001/profile', { token: student.accessToken });
  assert.equal(denied.status, 403);
});

test('employee attendance returns records plus summary (hours + percent)', async () => {
  const res = await request(ctx.base, '/employees/emp-001/attendance?month=2026-09', { token: teacher.accessToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.records['2026-09-01'].status, 'present');
  assert.equal(res.body.data.summary.hours, 55);
  assert.equal(res.body.data.summary.percent, 87.5);
});

test('leaves endpoint returns balance and history', async () => {
  const res = await request(ctx.base, '/employees/emp-001/leaves', { token: teacher.accessToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.balance.casual, 8);
  assert.equal(res.body.data.history.length, 2);
});

test('payroll: filtered by month and full list', async () => {
  const one = await request(ctx.base, '/employees/emp-001/payroll?month=2026-08', { token: teacher.accessToken });
  assert.equal(one.status, 200);
  assert.equal(one.body.data.length, 1);
  assert.equal(one.body.data[0].netSalary, 48650);

  const all = await request(ctx.base, '/employees/emp-001/payroll', { token: teacher.accessToken });
  assert.equal(all.body.data.length, 2);
});

test('employee timetable lists assigned periods by teacher name', async () => {
  const res = await request(ctx.base, '/employees/emp-001/timetable', { token: teacher.accessToken });
  assert.equal(res.status, 200);
  assert.ok(res.body.data.length >= 1);
  assert.ok(res.body.data.every((p) => p.teacher === 'Priya Sharma'));
  assert.ok(res.body.data.some((p) => p.classKey === 'cls-10A'));
});

test('assigned classes and documents endpoints', async () => {
  const classes = await request(ctx.base, '/employees/emp-001/assigned-classes', { token: teacher.accessToken });
  assert.equal(classes.status, 200);
  assert.equal(classes.body.data.length, 2);

  const docs = await request(ctx.base, '/employees/emp-001/documents', { token: teacher.accessToken });
  assert.equal(docs.status, 200);
  assert.equal(docs.body.data.length, 4);
});

test('apply leave: happy path appends a pending record', async () => {
  const res = await request(ctx.base, '/employees/emp-001/leaves/apply', {
    method: 'POST',
    token: teacher.accessToken,
    body: { type: 'casual', fromDate: '2026-12-01', toDate: '2026-12-02', reason: 'Family event out of town' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.status, 'pending');

  const leaves = await request(ctx.base, '/employees/emp-001/leaves', { token: teacher.accessToken });
  assert.equal(leaves.body.data.history.length, 3);
});

test('apply leave: validation (short reason, bad dates) → 400', async () => {
  const res = await request(ctx.base, '/employees/emp-001/leaves/apply', {
    method: 'POST',
    token: teacher.accessToken,
    body: { type: 'casual', fromDate: 'bad-date', toDate: '2026-12-02', reason: 'hi' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('apply leave: an impossible fromDate is 400, not 500', async () => {
  const res = await request(ctx.base, '/employees/emp-001/leaves/apply', {
    method: 'POST',
    token: teacher.accessToken,
    body: { type: 'casual', fromDate: '2026-13-40', toDate: '2026-12-02', reason: 'Family event out of town' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  assert.ok(res.body.errors?.fromDate, 'the field error names fromDate');
});

test('apply leave: admin is not allowed (employee-only) → 403', async () => {
  const res = await request(ctx.base, '/employees/emp-001/leaves/apply', {
    method: 'POST',
    token: admin.accessToken,
    body: { type: 'casual', fromDate: '2026-12-01', toDate: '2026-12-02', reason: 'Admin trying to apply' },
  });
  assert.equal(res.status, 403);
});

test('apply leave: employee cannot apply for someone else → 403', async () => {
  const res = await request(ctx.base, '/employees/emp-002/leaves/apply', {
    method: 'POST',
    token: teacher.accessToken,
    body: { type: 'sick', fromDate: '2026-12-01', toDate: '2026-12-02', reason: 'Applying for a colleague' },
  });
  assert.equal(res.status, 403);
});

/**
 * The reason is multi-line free text. These tests pin the storage contract the
 * Employee Portal's clamped cell and the Admin Panel's "Leave Reason" popup both
 * depend on: the author's line breaks must survive the round trip, or the 2-line
 * clamp collapses the text into one flowing paragraph and no "View more" link is
 * ever offered for a reason that genuinely needs one.
 */
test('apply leave: multi-line reason keeps its line breaks verbatim', async () => {
  // 4 short lines + a blank line + indentation — the exact shape that used to
  // arrive as a single paragraph.
  const reason = 'Fever since yesterday\n\n  Doctor advised rest\nTaking medicine';
  const res = await request(ctx.base, '/employees/emp-001/leaves/apply', {
    method: 'POST',
    token: teacher.accessToken,
    body: { type: 'sick', fromDate: '2026-12-05', toDate: '2026-12-06', reason },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.reason, reason, 'every newline, blank line and indent survives');

  // Re-read through the list endpoint, not just the create response: the admin
  // panel and the employee's own history both read it from here.
  const list = await request(ctx.base, '/employees/emp-001/leaves', { token: teacher.accessToken });
  const stored = list.body.data.history.find((l) => l.id === res.body.data.id);
  assert.equal(stored.reason, reason, 'the reason read back is byte-identical');
  assert.equal(stored.reason.split('\n').length, 4, 'still 4 lines, not 1');
  assert.equal(stored.reason.includes('\r'), false, 'no stray carriage returns stored');
});

test('apply leave: CRLF and lone CR normalise to LF, ends trimmed, interior kept', async () => {
  const res = await request(ctx.base, '/employees/emp-001/leaves/apply', {
    method: 'POST',
    token: teacher.accessToken,
    body: {
      type: 'casual',
      fromDate: '2026-12-08',
      toDate: '2026-12-09',
      // A Windows textarea submits CRLF; a lone CR must not survive either.
      reason: '\n  Line one\r\nLine two\rLine three\r\n\r\nLine four  \n\n',
    },
  });
  assert.equal(res.status, 201);
  assert.equal(
    res.body.data.reason,
    'Line one\nLine two\nLine three\n\nLine four',
    'CRLF/CR → LF, only the outer whitespace trimmed, the interior blank line kept',
  );
});

test('apply leave: the 500 limit is measured on the normalised text, not the raw one', async () => {
  // 6 lines of 82 'x' separated by CRLF: 492 content + 5 newlines = 497
  // normalised (accepted), but 502 raw characters. Validating the RAW string
  // would reject this while the client's counter — which counts the normalised
  // value — still showed it within the limit, so the two would disagree.
  const line = 'x'.repeat(82);
  const within = [line, line, line, line, line, line].join('\r\n');
  assert.equal(within.length, 502, 'raw payload is over 500 (CRLF)');
  const ok = await request(ctx.base, '/employees/emp-001/leaves/apply', {
    method: 'POST',
    token: teacher.accessToken,
    body: { type: 'casual', fromDate: '2026-12-11', toDate: '2026-12-12', reason: within },
  });
  assert.equal(ok.status, 201, 'normalised length is within 500, so it is accepted');
  assert.equal(ok.body.data.reason.length, 497, 'stored as LF, so 5 newlines not 10 characters');

  // Normalised to exactly 500 is still accepted (the boundary is inclusive).
  const exact = `${within}${'y'.repeat(3)}`;
  assert.equal(exact.replace(/\r\n?/g, '\n').trim().length, 500);
  const atLimit = await request(ctx.base, '/employees/emp-001/leaves/apply', {
    method: 'POST',
    token: teacher.accessToken,
    body: { type: 'casual', fromDate: '2026-12-17', toDate: '2026-12-18', reason: exact },
  });
  assert.equal(atLimit.status, 201, 'exactly 500 normalised characters is accepted');

  // One character over on the normalised text is still rejected.
  const over = `${exact}\n!`;
  const bad = await request(ctx.base, '/employees/emp-001/leaves/apply', {
    method: 'POST',
    token: teacher.accessToken,
    body: { type: 'casual', fromDate: '2026-12-13', toDate: '2026-12-14', reason: over },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'VALIDATION_ERROR');
  assert.match(JSON.stringify(bad.body.errors), /500/, 'the error names the 500 limit');
});

test('apply leave: markup in a reason is stored as literal text, not stripped', async () => {
  // No HTML sanitising on the way in — sanitising would corrupt an honest reason
  // that merely contains an angle bracket, and would not be the security boundary
  // anyway. React escapes it at render time, so what is stored is the author's
  // bytes and what is displayed is text.
  const reason = '5 < 10 & 10 > 5\n<script>alert(1)<\/script> <img src=x onerror=alert(1)>';
  const res = await request(ctx.base, '/employees/emp-001/leaves/apply', {
    method: 'POST',
    token: teacher.accessToken,
    body: { type: 'casual', fromDate: '2026-12-15', toDate: '2026-12-16', reason },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.reason, reason, 'stored exactly as typed, markup and all');
  // It must arrive as a JSON string value, never as a parsed/serialised object.
  assert.equal(typeof res.body.data.reason, 'string');
});

test('teardown — stop server', async () => { await stopServer(ctx.server); });