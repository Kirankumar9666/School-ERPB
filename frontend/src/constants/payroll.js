/**
 * Salary components shared by the admin Payroll month editor and the employee
 * Add/Edit form's "Salary / Compensation" section.
 *
 * The keys are the PayrollRecord / Employee columns the API accepts (the
 * schema is a fixed set of 7 whole-rupee amounts, not an extensible list of
 * line items), and the labels are display strings only.
 */

/** ₹ formatter — used everywhere salary amounts are displayed. */
export const formatINR = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

/**
 * A payroll month's status, as the API derives it from the payment rows (never a
 * stored flag — see backend/src/services/payroll.js):
 *
 *   pending — nothing paid yet
 *   partial — some paid, some outstanding  ← what several instalments produce
 *   paid    — the payments have reached the net salary
 *
 * `partial` needs a label of its own: "Pending" on a month with money already
 * transferred against it is the thing this feature exists to stop. The badge
 * tone is deliberately the same gold `pending` uses, since both mean "not
 * finished", and the payslip PDF prints the same three states.
 */
export const PAYROLL_STATUS_BADGE = {
  paid: 'badge-active',
  partial: 'badge-pending',
  pending: 'badge-pending',
};

export const PAYROLL_STATUS_LABEL = {
  paid: 'Paid',
  partial: 'Partially paid',
  pending: 'Pending',
};

export const SALARY_EARNINGS = [
  { key: 'basicPay', label: 'Basic Pay', required: true },
  { key: 'hra', label: 'HRA' },
  { key: 'transportAllowance', label: 'Transport Allowance' },
  { key: 'medicalAllowance', label: 'Medical Allowance' },
];

export const SALARY_DEDUCTIONS = [
  { key: 'providentFund', label: 'Provident Fund (PF)' },
  { key: 'professionalTax', label: 'Professional Tax' },
  { key: 'tds', label: 'TDS' },
];
