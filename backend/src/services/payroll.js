const { mapPayroll, mapPayrollPayment } = require('./mappers');

/**
 * Payroll payment arithmetic — the ONE place a month's payment state is decided.
 *
 * A month is settled by a list of `PayrollPayment` rows against its
 * `PayrollRecord.netSalary`, and everything the admin page, the employee page
 * and the payslip PDF show about "how much of this month is paid" is derived from
 * that list. Nothing here is stored as a status: a `status` column would have to
 * be kept in step with every payment write, and the day it wasn't, the page
 * would disagree with the bank.
 *
 * `PayrollRecord.paidOn` is the one stored summary, and it is deliberately
 * DERIVED — `settledOn()` recomputes it from the payments, and every route that
 * changes either a payment or the net salary rewrites it in the same
 * transaction. It exists only because the payslip PDF wants a single scalar to
 * print.
 */

/** Stable ordering for a record's payments: by the money's date, then by when
 *  the row was written. Two payments on one date must still have a defined
 *  order, or the completion date would depend on the database's whim. */
const byPaymentOrder = (a, b) => {
  const d = a.paidOn.getTime() - b.paidOn.getTime();
  if (d !== 0) return d;
  const c = a.createdAt.getTime() - b.createdAt.getTime();
  if (c !== 0) return c;
  return String(a.id).localeCompare(String(b.id));
};

/**
 * A month's status, from its net salary and the sum of its payments.
 *
 *   pending — nothing paid yet
 *   partial — some paid, some outstanding   ← the state this feature added
 *   paid    — the sum has reached the net salary
 *
 * Overpayment is not a fourth state: a sum ABOVE the net is still 'paid' (the
 * employee has their money), and the overpaid amount surfaces as a negative
 * `remaining` so the page can show it rather than hide it.
 *
 * A zero-net month with no payments reads as 'pending'. There is nothing to pay,
 * but "paid" would claim a transfer that never happened.
 */
const payrollStatus = (netSalary, paidTotal) => {
  if (paidTotal <= 0) return 'pending';
  if (paidTotal < netSalary) return 'partial';
  return 'paid';
};

/**
 * The date the month became fully settled: the payment on which the running
 * total first reached the net salary, or null while anything is outstanding.
 *
 * Recomputed from scratch on every write rather than nudged by the payment that
 * happened to be added. Adding a payment dated before an existing one can settle
 * a month at an EARLIER date than the previous answer, and deleting a payment
 * can unsettle it — only a full re-derivation gets both right.
 *
 * @param {number} netSalary
 * @param {Array<{id:string, amount:number, paidOn:Date, createdAt:Date}>} payments
 * @returns {Date|null}
 */
const settledOn = (netSalary, payments) => {
  let sum = 0;
  const ordered = [...payments].sort(byPaymentOrder);
  for (const p of ordered) {
    sum += p.amount;
    if (sum >= netSalary) return p.paidOn;
  }
  return null;
};

/**
 * Everything a UI needs about one month's payments, computed from the rows.
 *
 * @param {{netSalary:number}} record
 * @param {Array} payments
 * @returns {{status:'pending'|'partial'|'paid', paidTotal:number,
 *   remaining:number, overpaid:boolean, overpaidBy:number,
 *   paymentCount:number, lastPaymentOn:Date|null}}
 */
const summarizePayments = (record, payments) => {
  const paidTotal = payments.reduce((sum, p) => sum + p.amount, 0);
  const remaining = record.netSalary - paidTotal;
  const latest = payments.length
    ? [...payments].sort(byPaymentOrder).at(-1).paidOn
    : null;
  return {
    status: payrollStatus(record.netSalary, paidTotal),
    paidTotal,
    remaining,
    overpaid: remaining < 0,
    overpaidBy: remaining < 0 ? -remaining : 0,
    paymentCount: payments.length,
    lastPaymentOn: latest,
  };
};

/**
 * A PayrollRecord plus its payment rows → the wire shape, with every payment
 * figure derived in one pass.
 *
 * This is the ONE serialiser for a payroll month, so the admin list, the admin
 * month detail, the employee's own payroll read and the admin's text slip cannot
 * describe the same month four different ways. It composes with `mapPayroll`
 * from services/mappers.js rather than restating the salary components.
 *
 * `paidOn` inside the mapped record is the derived "fully settled on" date; the
 * status beside it is computed from the payments, NOT read back from that column,
 * so a stale cache can never change what any page shows.
 *
 * @param {object} record PayrollRecord row.
 * @param {Array} payments Its PayrollPayment rows. Pass them in the order the
 *   query returned (newest first) or not — the arithmetic re-sorts internally.
 */
const payrollShape = (record, payments) => ({
  id: record.id,
  ...mapPayroll(record),
  ...summarizePayments(record, payments),
  payments: (payments || []).map(mapPayrollPayment),
});

module.exports = {
  payrollStatus,
  settledOn,
  summarizePayments,
  payrollShape,
  byPaymentOrder,
};
