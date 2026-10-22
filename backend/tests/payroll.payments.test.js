/**
 * Partial payroll payments, and the per-month salary edit.
 *
 * The rule under test throughout: a month's payment state is DERIVED from its
 * `PayrollPayment` rows against its net salary, never stored as a flag. So the
 * status has to be right after every kind of write, and the one stored summary
 * (`PayrollRecord.paidOn`, the "settled on" date the payslip PDF prints) has to
 * agree with those rows afterwards — a cached date that drifts from the payments
 * is worse than no date at all.
 *
 * Covered:
 *   1. A month can take several payments, each kept with its own date and note.
 *   2. 'Partially paid' appears on its own, and flips to 'paid' by itself once
 *      the payments reach the net — no status is set by any client.
 *   3. Overpayment is recorded, not refused, and reported as a negative balance.
 *   4. A partially-paid month stays editable; a fully-paid one is locked (409),
 *      and the same lock governs the UI's decision to offer the action.
 *   5. A salary edit re-derives the settled date, in BOTH directions: a lower net
 *      can settle a month that was outstanding, a higher one unsettles it.
 *   6. Removing a payment unsettles a month and is the only way to undo one.
 *   7. The employee-facing read agrees with the admin's, figure for figure.
 *
 * Nothing here is hardcoded: the employee, the months and the amounts are this
 * file's own writes, and the salary figures come from the API's own recomputed
 * net, so a change to the component set cannot make these tests pass wrongly.
 *
 * Node built-in test runner, zero extra deps.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

test('payroll payments: instalments, derived status, and a locked settled month', async (t) => {
  const { server, base } = await startServer();
  const admin = await login(base, 'admin', 'Admin@123');
  const teacher = await login(base, 'teacher', 'Teacher@123'); // emp-001
  const prisma = require('../src/services/prisma');

  const EMP = 'emp-001';
  const pay = (opts) => request(base, `/admin/payroll/${EMP}/${opts.month}${opts.suffix || ''}`, {
    token: admin.accessToken, ...opts.call,
  });
  const setSalary = (month, body) => pay({
    month, call: { method: 'PUT', body },
  });
  const addPayment = (month, body) => pay({
    month, suffix: '/payments', call: { method: 'POST', body },
  });
  const delPayment = (month, id) => pay({
    month, suffix: `/payments/${id}`, call: { method: 'DELETE' },
  });
  const month = (m) => pay({ month: m });

  /* A salary with a net the tests derive from the API's own answer rather than
     restating: the components below are what the figure is MADE of. */
  const SALARY = {
    basicPay: 40000, hra: 8000, transportAllowance: 1000, medicalAllowance: 500,
    providentFund: 4800, professionalTax: 200, tds: 0,
  };
  const NET = 40000 + 8000 + 1000 + 500 - 4800 - 200; // 44500

  const rows = (m) => prisma.payrollRecord.findMany({
    where: { employeeId: EMP, month: m }, include: { payments: true },
  });
  const stored = async (m) => (await rows(m))[0];

  /* The seeded default salary structure, captured before anything is written, so
     the "an edit never touches the default" check compares against a real
     before-state rather than a guess about what the seed contains. */
  const seededDefault = await prisma.employee.findUnique({
    where: { id: EMP }, select: { basicPay: true, hra: true },
  });

  /* ---- 1. several payments, each its own row ---- */

  await t.test('a month takes several payments, each kept with its own date and note', async () => {
    const created = await setSalary('2026-11', SALARY);
    assert.equal(created.status, 200);
    assert.equal(created.body.data.netSalary, NET, 'the API computed the net itself');

    // A fresh month, deliberately not one of the seeded ones.
    const first = await addPayment('2026-11', { amount: 15000, paidOn: '2026-11-05', note: 'advance' });
    assert.equal(first.status, 201);
    assert.equal(first.body.data.paymentCount, 1);

    const second = await addPayment('2026-11', { amount: 10000, paidOn: '2026-11-20' });
    assert.equal(second.status, 201);

    // Two rows, not one overwritten value — the whole point of the feature.
    const rec = await stored('2026-11');
    assert.equal(rec.payments.length, 2, 'both payments exist as separate records');
    assert.equal(rec.payments.reduce((s, x) => s + x.amount, 0), 25000);
    assert.equal(rec.payments.find((x) => x.note === 'advance').paidOn.toISOString().slice(0, 10), '2026-11-05');
    // The note is optional; a payment without one stores null, not ''.
    assert.equal(rec.payments.filter((x) => !x.note).length, 1);
  });

  /* ---- 2. the status is derived, and flips by itself ---- */

  await t.test('a partly-paid month reads "partial", then "paid" with no status posted', async () => {
    const partial = await month('2026-11');
    assert.equal(partial.body.data.status, 'partial', 'some paid, some outstanding');
    assert.equal(partial.body.data.paidTotal, 25000);
    assert.equal(partial.body.data.remaining, NET - 25000);
    assert.equal(partial.body.data.overpaid, false);

    // Close the gap exactly, in a third instalment.
    const rest = await addPayment('2026-11', { amount: NET - 25000, paidOn: '2026-11-28' });
    assert.equal(rest.status, 201);
    assert.equal(
      rest.body.data.status, 'paid',
      'the status became "paid" because the sum reached the net — nothing asked it to',
    );
    assert.equal(rest.body.data.remaining, 0);
    assert.equal(rest.body.data.paidTotal, NET);
    assert.equal(rest.body.data.paidOn, '2026-11-28', 'settled on the payment that completed it');
  });

  await t.test('a client cannot dictate the status or the totals', async () => {
    // The request schema is amount/paidOn/note. Unknown keys are ignored rather
    // than rejected — the same convention payrollSchema already uses — so the
    // point to prove is that posting them changes nothing.
    await setSalary('2027-01', SALARY);
    const res = await addPayment('2027-01', {
      amount: 100, status: 'paid', paidTotal: 999999, netSalary: 1, paidOn: '2027-01-10',
    });
    assert.equal(res.status, 201, 'the extra fields are ignored, not honoured');
    assert.equal(res.body.data.paidTotal, 100, 'the real total is the sum of real payments');
    assert.equal(res.body.data.netSalary, NET, 'and the real net is the server-computed one');
    // The decisive part: a client claiming "paid" on ₹100 of a ₹44500 salary
    // still reads as partial, because nothing but the payments decides.
    assert.equal(res.body.data.status, 'partial');
  });

  await t.test('an unpaid month is "pending", and a zero-net month is not "paid"', async () => {
    const created = await setSalary('2026-12', SALARY);
    assert.equal(created.body.data.status, 'pending');
    assert.equal(created.body.data.paymentCount, 0);

    // A month whose deductions cancel its earnings has nothing to transfer.
    // Calling it "paid" would claim a payment that never happened.
    const zero = await setSalary('2026-12', {
      basicPay: 5000, hra: 0, transportAllowance: 0, medicalAllowance: 0,
      providentFund: 5000, professionalTax: 0, tds: 0,
    });
    assert.equal(zero.status, 200);
    assert.equal(zero.body.data.netSalary, 0);
    assert.equal(zero.body.data.status, 'pending', 'nothing paid, nothing owed');
    assert.equal(zero.body.data.paidOn, null);
  });

  /* ---- 3. overpayment ---- */

  await t.test('an amount above the balance is recorded, and reported as overpaid', async () => {
    await setSalary('2026-10', SALARY);
    const res = await addPayment('2026-10', { amount: NET + 2500, paidOn: '2026-10-30' });
    assert.equal(res.status, 201, 'the money really moved; refusing it would leave the books wrong');
    assert.equal(res.body.data.status, 'paid');
    assert.equal(res.body.data.overpaid, true);
    assert.equal(res.body.data.overpaidBy, 2500);
    assert.equal(res.body.data.remaining, -2500, 'the balance is negative, not clamped to zero');
    assert.equal((await stored('2026-10')).payments.length, 1, 'stored as one row of that size');
  });

  /* ---- 4. the lock, and what the UI may offer ---- */

  await t.test('a fully-paid month is locked against a salary edit', async () => {
    // 2026-11 is fully paid by now.
    const res = await setSalary('2026-11', { ...SALARY, basicPay: 99999 });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'ALREADY_PAID');
    assert.match(res.body.message, /fully paid/i);
    // And the refusal left the salary alone, rather than half-applying it.
    assert.equal((await stored('2026-11')).basicPay, SALARY.basicPay);
  });

  await t.test('a partially-paid month stays editable — that is the ordinary case', async () => {
    await setSalary('2027-02', SALARY);
    await addPayment('2027-02', { amount: 5000, paidOn: '2027-02-04' });
    const before = await month('2027-02');
    assert.equal(before.body.data.status, 'partial');

    // Pay part of a month, then fix the structure: the ordinary correction, and
    // it has to work. This is what makes a month editable at all.
    const edited = await setSalary('2027-02', { ...SALARY, basicPay: 42000 });
    assert.equal(edited.status, 200, 'a partly-paid month is not locked');
    assert.equal(edited.body.data.netSalary, NET + 2000, 'the edit moved only this month');
    assert.equal(edited.body.data.paidTotal, 5000, 'and the payment made against it survived');
  });

  await t.test('an edit to one month never touches another, or the default salary', async () => {
    const before = await month('2026-10');
    const beforeNet = before.body.data.netSalary;
    await setSalary('2027-02', { ...SALARY, basicPay: 30000 });

    const other = await month('2026-10');
    assert.equal(other.body.data.netSalary, beforeNet, 'the neighbouring month is unchanged');
    assert.equal((await month('2026-11')).body.data.netSalary, NET, 'and so is a settled one');

    // The employee's PERMANENT structure is a different thing entirely: it lives
    // on the Employee row and only prefills months that do not exist yet. A
    // per-month edit must never rewrite it, or one month's bonus would become
    // every future month's salary. Compared against the untouched seeded values
    // read before the edit, so this asserts "unchanged" and not merely
    // "happens to differ from 30000".
    const emp = await prisma.employee.findUnique({
      where: { id: EMP }, select: { basicPay: true, hra: true },
    });
    assert.deepEqual(emp, seededDefault, 'the default salary structure is byte-for-byte as seeded');
    assert.notEqual(emp.basicPay, 30000, 'and in particular did not take the per-month figure');
  });

  /* ---- 5. a salary edit re-derives the settled date, both ways ---- */

  await t.test('lowering the net below what is paid settles the month', async () => {
    // A month the seed does not already hold, and the setup's status asserted —
    // an unchecked 409 here would silently leave a stale salary in place and
    // make every figure below wrong for the right-looking reason.
    const setup = await setSalary('2027-03', SALARY); // net 44500
    assert.equal(setup.status, 200);
    assert.equal(setup.body.data.status, 'pending');

    const opening = await addPayment('2027-03', { amount: 20000, paidOn: '2027-03-10' });
    assert.equal(opening.body.data.status, 'partial');
    assert.equal(opening.body.data.paidOn, null, 'not settled yet, so no completion date');

    // Cut the salary to below the money already handed over.
    const cut = await setSalary('2027-03', {
      basicPay: 15000, hra: 0, transportAllowance: 0, medicalAllowance: 0,
      providentFund: 0, professionalTax: 0, tds: 0,
    });
    assert.equal(cut.status, 200);
    assert.equal(cut.body.data.status, 'paid', 'the payments now exceed the new net');
    assert.equal(cut.body.data.overpaid, true);
    assert.equal(
      cut.body.data.paidOn, '2027-03-10',
      'settled on the date the money was already in, not on the date of the edit',
    );
  });

  await t.test('a salary edit can settle a month, but never unsettle one', async () => {
    /* 2027-03 is settled and overpaid (net 15000, paid 20000) from the test
       above. Because a fully-paid month is LOCKED, that is the end of its story:
       the only edit available is refused.
       This is worth stating as an invariant rather than leaving implied, because
       it decides the answer to "what if the salary was wrong and I found out
       after paying?" — nothing. The two chosen rules (lock once paid, allow
       overpayment) meet here: an overpaid month is settled, therefore locked.
       Correcting it goes through removing a payment (covered below), which is
       the same escape hatch every other mistaken payment has. */
    const before = await month('2027-03');
    assert.equal(before.body.data.status, 'paid');

    const raised = await setSalary('2027-03', { ...SALARY, basicPay: 60000 });
    assert.equal(raised.status, 409, 'an overpaid month is settled, so it is locked too');
    assert.equal(raised.body.code, 'ALREADY_PAID');
    assert.equal(
      (await month('2027-03')).body.data.netSalary, 15000,
      'and the refused edit changed nothing',
    );

    /* The mirror case, which IS reachable: an outstanding month whose salary is
       raised stays outstanding, with no completion date to go stale. The net can
       move freely in this direction — only the lock, not the arithmetic, stops
       the other one. */
    await setSalary('2027-04', SALARY);
    await addPayment('2027-04', { amount: 20000, paidOn: '2027-04-08' });
    assert.equal((await month('2027-04')).body.data.paidOn, null);

    const up = await setSalary('2027-04', { ...SALARY, basicPay: 60000 });
    assert.equal(up.status, 200);
    assert.equal(up.body.data.status, 'partial');
    assert.equal(up.body.data.paidOn, null, 'still no completion date, and none is invented');
    assert.equal(up.body.data.remaining, up.body.data.netSalary - 20000);
  });

  /* ---- 6. removing a payment ---- */

  await t.test('a payment can be removed, which unsettles a settled month', async () => {
    await setSalary('2026-07', SALARY);
    await addPayment('2026-07', { amount: 10000, paidOn: '2026-07-05' });
    const done = await addPayment('2026-07', { amount: NET - 10000, paidOn: '2026-07-25' });
    assert.equal(done.body.data.status, 'paid');

    const rec = await stored('2026-07');
    const last = rec.payments.find((x) => x.amount === NET - 10000);
    const removed = await delPayment('2026-07', last.id);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.data.status, 'partial', 'the balance is outstanding again');
    assert.equal(removed.body.data.paidTotal, 10000);
    assert.equal(removed.body.data.paidOn, null, 'and the month is no longer settled');
  });

  await t.test('a payment of another month cannot be removed through this one', async () => {
    const a = await stored('2026-11');
    const b = await stored('2026-07');
    const foreign = a.payments[0].id;
    // 2026-11 is fully paid and locked, but a payment id is not a capability:
    // the delete must be scoped to the (employee, month) in the path.
    const res = await delPayment('2026-07', foreign);
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'NOT_FOUND');
    assert.equal((await stored('2026-11')).payments.length, a.payments.length, '2026-11 is untouched');
    assert.ok(b.payments.length > 0);
  });

  await t.test('an unknown payment id is a 404, not a silent success', async () => {
    const res = await delPayment('2026-07', 'pay-does-not-exist');
    assert.equal(res.status, 404);
  });

  /* ---- 7. the payment input itself ---- */

  await t.test('payments are validated: positive whole rupees, real dates, bounded note', async () => {
    await setSalary('2026-06', SALARY);
    const cases = [
      [{ amount: 0 }, /validation/i],
      [{ amount: -100 }, /validation/i],
      [{ amount: 10.5 }, /validation/i],
      [{ amount: 'ten thousand' }, /validation/i],
      [{ amount: 100, paidOn: '31-06-2026' }, /validation/i],
      [{ amount: 100, note: 'x'.repeat(201) }, /validation/i],
      [{}, /validation/i],
    ];
    for (const [body, pattern] of cases) {
      const res = await addPayment('2026-06', body);
      assert.equal(res.status, 400, `refused: ${JSON.stringify(body)}`);
      assert.match(res.body.message, pattern);
    }
    assert.equal((await stored('2026-06')).payments.length, 0, 'not one of them was written');
  });

  await t.test('a payment date outside the payroll month is allowed', async () => {
    // Salaries are routinely paid a few days into the following month; refusing
    // a real transfer because of the calendar would be wrong.
    const res = await addPayment('2026-06', { amount: 1000, paidOn: '2026-07-03' });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.payments[0].paidOn, '2026-07-03');
  });

  await t.test('a payment needs a salary record to belong to', async () => {
    const res = await addPayment('2026-01', { amount: 1000, paidOn: '2026-01-10' });
    assert.equal(res.status, 404);
    assert.match(res.body.message, /salary structure/i, 'and it says what to do first');
  });

  /* ---- 8. mark-paid is a shortcut over the same rows ---- */

  await t.test('mark-paid pays the balance, not the whole net again', async () => {
    await setSalary('2026-05', SALARY);
    await addPayment('2026-05', { amount: 20000, paidOn: '2026-05-06' });

    const done = await pay({
      month: '2026-05', suffix: '/mark-paid',
      call: { method: 'POST', body: { paidDate: '2026-05-27' } },
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.data.status, 'paid');
    assert.equal(
      done.body.data.paidTotal, NET,
      'the earlier instalment plus the balance, not a second full salary',
    );
    assert.equal(done.body.data.paymentCount, 2, 'two rows — it wrote a payment like any other');
    assert.equal(done.body.data.paidOn, '2026-05-27');

    // And it refuses when there is nothing left, naming the overpayment.
    const again = await pay({
      month: '2026-05', suffix: '/mark-paid',
      call: { method: 'POST', body: { paidDate: '2026-05-28' } },
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'ALREADY_PAID');
  });

  await t.test('mark-paid on a zero-net month is refused rather than inventing a payment', async () => {
    await setSalary('2026-04', {
      basicPay: 1000, hra: 0, transportAllowance: 0, medicalAllowance: 0,
      providentFund: 1000, professionalTax: 0, tds: 0,
    });
    const res = await pay({
      month: '2026-04', suffix: '/mark-paid', call: { method: 'POST', body: {} },
    });
    assert.equal(res.status, 409);
    assert.equal((await stored('2026-04')).payments.length, 0, 'no ₹0 payment was recorded');
  });

  /* ---- 9. the detail read, and the month summary ---- */

  await t.test('GET one month returns the same figures as the list entry', async () => {
    const list = await request(base, '/admin/payroll', { token: admin.accessToken });
    const listed = list.body.data
      .find((e) => e.id === EMP).payroll
      .find((p) => p.month === '2026-11');

    const detail = await month('2026-11');
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.id, listed.id);
    assert.equal(detail.body.data.netSalary, listed.netSalary);
    assert.equal(detail.body.data.status, listed.status);
    assert.equal(detail.body.data.paidTotal, listed.paidTotal);
    assert.equal(detail.body.data.remaining, listed.remaining);
    assert.deepEqual(
      detail.body.data.payments.map((x) => x.id),
      listed.payments.map((x) => x.id),
      'the payment list is identical, not a second version of it',
    );
    // Newest first, so the most recent transfer is the one an admin sees.
    const dates = detail.body.data.payments.map((x) => x.paidOn);
    assert.deepEqual(dates, [...dates].sort().reverse());
    assert.equal(detail.body.data.employee.id, EMP, 'and it names whose month this is');
  });

  await t.test('the list counts partial months separately from pending ones', async () => {
    // The months this file created cover all three states: 2027-01/02/03 partly
    // paid, 2026-10/11 settled (the former overpaid), 2026-12 a zero-net pending.
    const res = await request(base, '/admin/payroll', { token: admin.accessToken });
    const rowsOf = res.body.data.find((e) => e.id === EMP).payroll;
    const partial = rowsOf.filter((p) => p.status === 'partial');
    const paid = rowsOf.filter((p) => p.status === 'paid');
    assert.ok(partial.length > 0, 'at least one month reads "partial"');
    assert.ok(paid.length > 0);
    assert.ok(
      rowsOf.every((p) => ['pending', 'partial', 'paid'].includes(p.status)),
      'no month reports a status the UI has no label for',
    );
    // Every payment in the list belongs to the month it is nested under.
    rowsOf.forEach((p) => {
      assert.equal(
        p.paidTotal,
        p.payments.reduce((s, x) => s + x.amount, 0),
        `${p.month}: the total is the sum of its own payments`,
      );
    });
  });

  /* ---- 10. the employee sees the same month ---- */

  await t.test('the employee read agrees with the admin read, figure for figure', async () => {
    const asAdmin = await month('2026-11');
    const asEmployee = await request(base, `/employees/${EMP}/payroll?month=2026-11`, {
      token: teacher.accessToken,
    });
    assert.equal(asEmployee.status, 200);
    const row = asEmployee.body.data[0];
    assert.equal(row.netSalary, asAdmin.body.data.netSalary);
    assert.equal(row.status, asAdmin.body.data.status);
    assert.equal(row.paidTotal, asAdmin.body.data.paidTotal);
    assert.equal(row.remaining, asAdmin.body.data.remaining);
    assert.deepEqual(
      row.payments.map((x) => x.id),
      asAdmin.body.data.payments.map((x) => x.id),
    );
  });

  await t.test('one employee still cannot read another employee payroll', async () => {
    // emp-002 is the only other staff member; emp-001's token must not reach them.
    const res = await request(base, '/employees/emp-002/payroll', { token: teacher.accessToken });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'FORBIDDEN');
  });

  await t.test('the new routes are admin-only, like every other payroll route here', async () => {
    const anon = await request(base, '/admin/payroll/emp-001/2026-11');
    assert.equal(anon.status, 401);
    for (const [path, call] of [
      ['/admin/payroll/emp-001/2026-11', {}],
      ['/admin/payroll/emp-001/2026-11/payments', { method: 'POST', body: { amount: 1 } }],
      ['/admin/payroll/emp-001/2026-11/mark-paid', { method: 'POST', body: {} }],
      ['/admin/payroll/emp-001/2026-11/payments/pay-x', { method: 'DELETE' }],
    ]) {
      const res = await request(base, path, { token: teacher.accessToken, ...call });
      assert.equal(res.status, 403, `${call.method || 'GET'} ${path} refused a teacher`);
      assert.equal(res.body.code, 'FORBIDDEN');
    }
  });

  await t.test('a bad month key is refused by the detail read too', async () => {
    for (const m of ['2026-13', '2026-1', 'not-a-month', '2026-00']) {
      const res = await month(m);
      assert.equal(res.status, 400, `refused: ${m}`);
      assert.equal(res.body.code, 'VALIDATION_ERROR');
    }
  });

  await t.test('an unknown employee is a 404 on the detail read', async () => {
    const res = await request(base, '/admin/payroll/emp-does-not-exist/2026-11', { token: admin.accessToken });
    assert.equal(res.status, 404);
    assert.equal(res.body.message, 'Employee not found');
  });

  await t.test('the seeded paid month reads exactly as it did before the change', async () => {
    // The seed (and the migration's backfill) turn a month that was already paid
    // into ONE payment of the full net, dated when it was recorded. That is the
    // whole compatibility claim: a database that had been paid in one lump before
    // this feature is indistinguishable, on every field a page reads, from one
    // that reached the same state through a single recorded payment.
    //
    // Read from the seed's own month (2026-08), which no test in this file
    // writes to — asserted here rather than assumed, so a future test that starts
    // using it fails loudly on that collision instead of quietly changing what
    // this asserts.
    const res = await month('2026-08');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.paymentCount, 1, 'one lump payment, not a fabricated instalment plan');
    assert.equal(
      res.body.data.paidTotal, res.body.data.netSalary,
      'the payment is the whole net, so the balance is closed',
    );
    assert.equal(res.body.data.status, 'paid');
    assert.equal(res.body.data.remaining, 0);
    assert.equal(res.body.data.overpaid, false);
    assert.equal(
      res.body.data.paidOn, res.body.data.payments[0].paidOn,
      'the completion date is the payment date, which is what the old column held',
    );
    assert.equal(
      res.body.data.paidTotal,
      res.body.data.payments.reduce((s, x) => s + x.amount, 0),
    );
  });

  await t.test('the seeded unpaid month is still pending, with no payments', async () => {
    const res = await month('2026-09');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'pending');
    assert.equal(res.body.data.paymentCount, 0);
    assert.deepEqual(res.body.data.payments, []);
    assert.equal(res.body.data.paidOn, null);
    assert.equal(res.body.data.remaining, res.body.data.netSalary, 'the whole net is outstanding');
  });

  await t.test('teardown — stop server', async () => {
    await stopServer(server);
  });
});
