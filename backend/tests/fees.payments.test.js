/**
 * Payments — where a payment goes, proven by the records it leaves behind.
 *
 * The point of this file is that the PREVIEW and the SAVE are the same rule: the
 * modal's sentence and the rows actually written must agree, so the assertions
 * below read both and compare them. It also proves each payment record carries
 * the academic year and class it settled — read from the fee rows, never typed in.
 *
 * Figures are derived from whatever the seed left behind rather than hardcoded:
 * the earlier year's balance is read from the API before anything is paid.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

let server;
let base;
let token;

/** Promoted student: one earlier year still owing, and a fresh current year. */
const STUDENT = 'stu-003';

let previousBalance = 0;
let currentYearLabel = '';
let previousYearLabel = '';
let previousClassLabel = '';

const detail = async (studentId = STUDENT) => {
  const res = await request(base, `/fees/students/${studentId}`, { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};

const allocate = async (studentId, body) => request(base, `/fees/students/${studentId}/allocate`, {
  method: 'POST', token, body,
});

const pay = async (studentId, body) => request(base, `/fees/students/${studentId}/payments`, {
  method: 'POST', token, body,
});

before(async () => {
  ({ server, base } = await startServer());
  token = (await login(base, 'admin', 'Admin@123')).accessToken;

  const move = await request(base, `/admin/class-management/students/${STUDENT}/move`, {
    method: 'POST', token, body: { action: 'promote' },
  });
  assert.equal(move.status, 200, JSON.stringify(move.body));

  const summary = (await detail()).summary;
  previousBalance = summary.previousDues;
  assert.ok(previousBalance > 0, 'the promotion must leave a balance to carry forward');

  // Give the current year a fee, so there are TWO open years to split across.
  const totalAmount = previousBalance * 3;
  const set = await request(base, `/fees/students/${STUDENT}/amount`, {
    method: 'PUT', token, body: { amount: totalAmount },
  });
  assert.equal(set.status, 200, JSON.stringify(set.body));

  const { rows, currentAcademicYearId } = await detail();
  const current = rows.find((r) => r.isCurrent);
  const previous = rows.find((r) => !r.isCurrent && r.balance > 0);
  currentYearLabel = current.academicYearLabel;
  previousYearLabel = previous.academicYearLabel;
  previousClassLabel = previous.classLabel;
  assert.equal(current.balance, totalAmount);
  assert.equal(current.total, totalAmount);
});

after(async () => {
  await stopServer(server);
});

test('the ledger names every year, its class, and what is still due', async () => {
  const { rows, outstanding, currentAcademicYearId } = await detail();

  const current = rows.find((r) => r.academicYearId === currentAcademicYearId);
  const previous = rows.find((r) => r.academicYearId !== currentAcademicYearId && r.balance > 0);

  assert.ok(current, 'the student’s own year is in the ledger');
  assert.equal(current.isSet, true);
  assert.ok(previous, 'the carried-forward year is in the ledger');
  assert.equal(previous.balance, previousBalance);
  // Every row carries the class the child was in that year.
  assert.equal(previous.classLabel, previousClassLabel);
  assert.equal(outstanding, previous.balance + current.balance, 'outstanding is the sum of the open rows');
});

test('a preview follows oldest-first and says how much will remain', async () => {
  const first = await allocate(STUDENT, { amount: Math.floor(previousBalance / 2) });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const body = first.body.data;
  assert.equal(body.allocations.length, 1, 'a small payment reaches only the oldest year');
  assert.equal(body.allocations[0].academicYearLabel, previousYearLabel);
  assert.equal(body.allocations[0].remainingAfter, previousBalance - body.allocations[0].amount);
  assert.match(body.message, /will be applied to/);
  assert.match(body.message, new RegExp(previousClassLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(body.message, /will remain/);
});

test('a preview that spans years is split, and says which year each part goes to', async () => {
  const spanning = await allocate(STUDENT, { amount: previousBalance + 1000 });
  assert.equal(spanning.status, 200, JSON.stringify(spanning.body));
  const { allocations, message } = spanning.body.data;

  assert.equal(allocations.length, 2);
  assert.equal(allocations[0].academicYearLabel, previousYearLabel, 'the oldest year is taken first');
  assert.equal(allocations[0].amount, previousBalance);
  assert.equal(allocations[0].remainingAfter, 0, 'the oldest year is cleared');
  assert.equal(allocations[1].amount, 1000);
  // The message names both years — the split is reported, not implied.
  assert.match(message, new RegExp(previousYearLabel.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')));
  assert.match(message, new RegExp(currentYearLabel.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')));
});

test('a payment larger than the outstanding total is refused with a field error', async () => {
  const tooBig = await allocate(STUDENT, { amount: previousBalance * 100 });
  assert.equal(tooBig.status, 409, 'the rule is not the old 400 field error');
  assert.equal(tooBig.body.code, 'AMOUNT_EXCEEDS_DUES');
  assert.ok(tooBig.body.message);
});

test('naming a year applies the whole payment to that year alone', async () => {
  const detailRows = (await detail()).rows;
  const currentRow = detailRows.find((r) => r.isCurrent);

  const targeted = await allocate(STUDENT, { amount: 500, feeId: currentRow.id });
  assert.equal(targeted.status, 200, JSON.stringify(targeted.body));
  const { allocations } = targeted.body.data;
  assert.equal(allocations.length, 1, 'a named year takes the whole payment');
  assert.equal(allocations[0].academicYearLabel, currentYearLabel);
  assert.equal(allocations[0].selected, true);

  // More than THAT year owes is refused rather than spilling into another year.
  const overRow = await allocate(STUDENT, { amount: currentRow.balance + 1, feeId: currentRow.id });
  assert.equal(overRow.status, 409);
  assert.equal(overRow.body.code, 'AMOUNT_EXCEEDS_ROW');
});

test('a saved payment is recorded against the year and class it settled', async () => {
  const spanning = previousBalance + 1000;
  const saved = await pay(STUDENT, {
    amount: spanning, paidOn: '2026-10-01', note: 'part payment',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const { allocations, message } = saved.body.data;
  assert.equal(allocations.length, 2, 'one receipt, one row per year it settled');
  assert.match(message, new RegExp(previousClassLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(message, new RegExp(currentYearLabel.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')));

  const { rows } = await detail();
  const previousRow = rows.find((r) => r.academicYearLabel === previousYearLabel);
  const currentRow = rows.find((r) => r.academicYearLabel === currentYearLabel);

  const previousPayment = previousRow.payments.find((p) => p.amount === previousBalance);
  assert.ok(previousPayment, 'the earlier year holds its own payment row');
  // The class and year come from the fee row the payment hangs off.
  assert.equal(previousPayment.academicYearLabel, previousYearLabel);
  assert.equal(previousPayment.classLabel, previousClassLabel);
  assert.equal(previousPayment.chosenYear, false, 'oldest-first is not a manual choice');
  assert.equal(previousPayment.paidOn, '2026-10-01');
  assert.equal(previousPayment.note, 'part payment');

  const currentPayment = currentRow.payments.find((p) => p.amount === 1000);
  assert.ok(currentPayment, 'the spill-over is recorded against the current year');
  assert.equal(currentPayment.academicYearLabel, currentYearLabel);
});

test('a year chosen by hand is recorded as a manual choice', async () => {
  const before = await detail();
  const currentRow = before.rows.find((r) => r.isCurrent);

  const manual = await pay(STUDENT, { amount: 500, paidOn: '2026-10-02', feeId: currentRow.id });
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  assert.match(manual.body.data.message, new RegExp(currentYearLabel.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')));

  const after = await detail();
  const row = after.rows.find((r) => r.isCurrent);
  const manualPayment = row.payments.find((p) => p.amount === 500);
  assert.ok(manualPayment, 'the payment is listed against the current year');
  assert.equal(manualPayment.chosenYear, true, 'and flagged as a hand-picked year');
});

test('the student’s own read of their fee ledger shows the same rows', async () => {
  const res = await request(base, `/students/${STUDENT}/fees`, { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { rows, outstanding } = res.body.data;

  const office = await detail();
  assert.equal(outstanding, office.outstanding, 'the family sees the same total');
  const paidYears = rows.filter((r) => r.payments.length).map((r) => r.academicYearLabel);
  assert.ok(paidYears.includes(previousYearLabel) && paidYears.includes(currentYearLabel),
    'both years show payments, each with the year it paid');
  for (const row of rows) {
    for (const p of row.payments) {
      assert.equal(p.academicYearLabel, row.academicYearLabel, 'a payment belongs to the year of its fee row');
      assert.equal(p.classLabel, row.classLabel);
    }
  }
});
