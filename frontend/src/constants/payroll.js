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
