/**
 * Integration tests: admin payroll API (/api/v1/admin/payroll*).
 * Seed state: emp-001 has 2026-08 (paid) + 2026-09 (pending); emp-002 has none.
 * The helpers re-seed per file, so the mutations below are safe.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

let ctx;
let admin;
let teacher;
let student;

test('setup — boot API and log in all roles', async () => {
  ctx = await startServer();
  admin = await login(ctx.base, 'admin', 'Admin@123');
  teacher = await login(ctx.base, 'teacher', 'Teacher@123');
  student = await login(ctx.base, 'student', 'Student@123');
});

test('payroll routes reject unauthenticated and non-admin callers', async () => {
  const anon = await request(ctx.base, '/admin/payroll');
  assert.equal(anon.status, 401);

  for (const token of [teacher.accessToken, student.accessToken]) {
    const denied = await request(ctx.base, '/admin/payroll', { token });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'FORBIDDEN');
  }
});

test('GET /admin/payroll lists every employee with derived statuses', async () => {
  const res = await request(ctx.base, '/admin/payroll', { token: admin.accessToken });
  assert.equal(res.status, 200);

  const emp1 = res.body.data.find((e) => e.id === 'emp-001');
  assert.ok(emp1, 'seed teacher is listed');
  assert.equal(emp1.name, 'Priya Sharma');
  assert.equal(emp1.employeeId, 'EMP-2020-001');
  assert.equal(emp1.payroll.length, 2);

  // Status is DERIVED from paidOn, never stored
  const aug = emp1.payroll.find((p) => p.month === '2026-08');
  const sep = emp1.payroll.find((p) => p.month === '2026-09');
  assert.equal(aug.status, 'paid');
  assert.equal(aug.paidOn, '2026-08-31');
  assert.equal(sep.status, 'pending');
  assert.equal(sep.paidOn, null);
  assert.equal(aug.netSalary, 48650);
  assert.equal(aug.monthLabel, 'August 2026');

  const emp2 = res.body.data.find((e) => e.id === 'emp-002');
  assert.ok(emp2, 'employees without payroll are still listed');
  assert.deepEqual(emp2.payroll, []);
});

test('PUT /admin/payroll/:id/:month — validation and shape errors', async () => {
  const badMonth = await request(ctx.base, '/admin/payroll/emp-002/2026-13', {
    method: 'PUT', token: admin.accessToken,
    body: { basicPay: 40000 },
  });
  assert.equal(badMonth.status, 400);
  assert.equal(badMonth.body.code, 'VALIDATION_ERROR');

  const badComponent = await request(ctx.base, '/admin/payroll/emp-002/2026-10', {
    method: 'PUT', token: admin.accessToken,
    body: { basicPay: -1 },
  });
  assert.equal(badComponent.status, 400);
  assert.equal(badComponent.body.code, 'VALIDATION_ERROR');

  const unknownEmployee = await request(ctx.base, '/admin/payroll/emp-999/2026-10', {
    method: 'PUT', token: admin.accessToken,
    body: { basicPay: 40000 },
  });
  assert.equal(unknownEmployee.status, 404);

  const deductionsTooBig = await request(ctx.base, '/admin/payroll/emp-002/2026-10', {
    method: 'PUT', token: admin.accessToken,
    body: { basicPay: 1000, providentFund: 5000 },
  });
  assert.equal(deductionsTooBig.status, 400);
  assert.equal(deductionsTooBig.body.code, 'INVALID_PAYROLL');
});

test('PUT cannot edit an already-paid month → 409 ALREADY_PAID', async () => {
  const res = await request(ctx.base, '/admin/payroll/emp-001/2026-08', {
    method: 'PUT', token: admin.accessToken,
    body: { basicPay: 99999 },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ALREADY_PAID');
});

test('PUT creates a record and recomputes netSalary server-side', async () => {
  const res = await request(ctx.base, '/admin/payroll/emp-002/2026-10', {
    method: 'PUT', token: admin.accessToken,
    // netSalary: 999 is NOT part of the schema — proves the client can't
    // dictate the net; server computes 40000+8000+1000+500-4800-200-0 = 44500
    body: {
      basicPay: 40000, hra: 8000, transportAllowance: 1000, medicalAllowance: 500,
      providentFund: 4800, professionalTax: 200, tds: 0, netSalary: 999,
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.netSalary, 44500);
  assert.equal(res.body.data.status, 'pending');
  assert.equal(res.body.data.monthLabel, 'October 2026');
  assert.deepEqual(res.body.data.allowances, { hra: 8000, transportAllowance: 1000, medicalAllowance: 500 });
  assert.deepEqual(res.body.data.deductions, { providentFund: 4800, professionalTax: 200, tds: 0 });

  // Upsert: same month updated, not duplicated
  const again = await request(ctx.base, '/admin/payroll/emp-002/2026-10', {
    method: 'PUT', token: admin.accessToken,
    body: { basicPay: 42000, hra: 8000 },
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.data.netSalary, 50000); // omitted components default to 0
  assert.equal(again.body.data.id, res.body.data.id, 'upsert reuses the same record');
});

test('mark-paid: requires an existing record, then locks the month', async () => {
  const missing = await request(ctx.base, '/admin/payroll/emp-002/2026-11/mark-paid', {
    method: 'POST', token: admin.accessToken,
    body: { paidDate: '2026-11-30' },
  });
  assert.equal(missing.status, 404);

  const badDate = await request(ctx.base, '/admin/payroll/emp-002/2026-10/mark-paid', {
    method: 'POST', token: admin.accessToken,
    body: { paidDate: '31-10-2026' },
  });
  assert.equal(badDate.status, 400);
  assert.equal(badDate.body.code, 'VALIDATION_ERROR');

  const paid = await request(ctx.base, '/admin/payroll/emp-002/2026-10/mark-paid', {
    method: 'POST', token: admin.accessToken,
    body: { paidDate: '2026-10-31' },
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.data.status, 'paid');
  assert.equal(paid.body.data.paidOn, '2026-10-31');

  const already = await request(ctx.base, '/admin/payroll/emp-002/2026-10/mark-paid', {
    method: 'POST', token: admin.accessToken,
    body: { paidDate: '2026-11-01' },
  });
  assert.equal(already.status, 409);
  assert.equal(already.body.code, 'ALREADY_PAID');

  // And the now-paid month is immutable
  const edit = await request(ctx.base, '/admin/payroll/emp-002/2026-10', {
    method: 'PUT', token: admin.accessToken,
    body: { basicPay: 1 },
  });
  assert.equal(edit.status, 409);
  assert.equal(edit.body.code, 'ALREADY_PAID');
});

test('GET reflects the new record as paid in the list', async () => {
  const res = await request(ctx.base, '/admin/payroll', { token: admin.accessToken });
  const emp2 = res.body.data.find((e) => e.id === 'emp-002');
  assert.equal(emp2.payroll.length, 1);
  assert.equal(emp2.payroll[0].status, 'paid');
  assert.equal(emp2.payroll[0].netSalary, 50000);
});

test('teardown — stop server', async () => { await stopServer(ctx.server); });
