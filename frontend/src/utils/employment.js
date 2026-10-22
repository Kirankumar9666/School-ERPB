/**
 * Employment lifecycle constants and text helpers — the client half of the
 * contract defined in `backend/src/services/employment.js`.
 *
 * They live apart from the components that use them on purpose, exactly as
 * `utils/leave.js` explains: a module that exports both components and plain
 * values defeats React Fast Refresh, so editing a modal would reload the page
 * instead of hot-swapping it.
 *
 * Nothing here is a list of domain VALUES: the reason dropdown is fed by
 * `/school/options` (the `EmploymentEndReason` enum itself). This module only
 * supplies the English wording for values the server owns.
 */

/**
 * The length the SERVER will measure on the termination description.
 *
 * Kept beside the mirror of its own normalisation rather than imported from
 * anywhere, so the number the counter shows and the number the route validates
 * are read from the same declaration. `backend/src/services/employment.js` holds
 * the authoritative copy; if they ever disagree the counter would stop agreeing
 * with the limit at exactly the moment someone types a multi-line note.
 */
export const EMPLOYMENT_DESCRIPTION_MAX = 500;

/**
 * The termination description, normalised — the client's half of the contract.
 *
 * Mirrors `normalizeDescription` in `backend/src/services/employment.js` step for
 * step, and the two MUST stay identical:
 *
 *   1. `\r\n` and lone `\r` → `\n`. A `<textarea>` submits CRLF when typed on
 *      Windows, so counting the raw value would count 2 characters per line break
 *      that the server then stores as 1 — the counter would stop agreeing with
 *      the server's limit as soon as someone typed a multi-line description.
 *   2. Trim leading/trailing whitespace only.
 *   3. Interior newlines are left completely alone.
 *
 * As on the leave side there is deliberately no HTML escaping: the text is
 * rendered as React children, which escape it, so `5 < 10` displays correctly and
 * no markup can execute.
 */
export const normalizeDescription = (raw) => String(raw ?? '').replace(/\r\n?/g, '\n').trim();

/**
 * `EmploymentEndReason` → the wording the status pill and dropdown show.
 *
 * `contract_ended` is the only value that does not survive a naive
 * `snake_case → Space case` rewrite intact, so it is spelled out rather than
 * generated. A value with no entry here still renders (via the fallback in
 * `employmentReasonLabel`), so a reason added to the Prisma enum can never make
 * the UI show a blank pill.
 */
const REASON_LABELS = {
  resigned: 'Resigned',
  terminated: 'Terminated',
  retired: 'Retired',
  contract_ended: 'Contract Ended',
  other: 'Other',
};

/**
 * The reason an employment ended, in words.
 * @param {string} reason an `EmploymentEndReason` value
 * @returns {string}
 */
export const employmentReasonLabel = (reason) =>
  REASON_LABELS[reason] || String(reason || '').replace(/_/g, ' ');

/**
 * `dependentRecords[].key` → what that row is called in the UI.
 *
 * These keys are the ones `services/employment.js` queries, so the census in the
 * details view is named from a table rather than from a hand-written sentence.
 * `marksEntered` is listed too even though it never blocks, because its count is
 * the honest answer to "would my marks survive?" and the details view shows it
 * under a separate heading that says so.
 */
const DEPENDENT_RECORD_LABELS = {
  payroll: 'Payroll months',
  attendance: 'Attendance records',
  leaveRequests: 'Leave applications',
  documents: 'Documents',
  classesTaught: 'Class & subject assignments',
  classesInCharge: 'Classes in charge',
  announcementsSent: 'Announcements sent',
  leaveBalance: 'Leave balance',
  marksEntered: 'Marks entries recorded',
};

/**
 * What a dependent-record row is called in the UI.
 * @param {string} key
 * @returns {string}
 */
export const dependentRecordLabel = (key) => DEPENDENT_RECORD_LABELS[key] || key;

/**
 * The pill an employee row wears, from their status and (when they are off staff)
 * why they left.
 *
 * Derived from the timeline rather than stored, so a reactivated employee reads
 * "Active" again without anything having to be reset — there is no separate
 * "current reason" field that could survive the reactivation and contradict the
 * status beside it.
 *
 * @param {object} employee a mapped Employee row (needs `status` + `employment`)
 * @returns {{text:string, className:string}}
 */
export const employmentStatusBadge = (employee) => {
  if (employee.status === 'active' || !employee.employment) {
    return { text: 'Active', className: 'badge-active' };
  }
  // A muted pill, not the green one: this employee is off the staff list, and the
  // reason beside it ("Resigned") says why without borrowing the attention the
  // active badge reserves for people currently teaching.
  return {
    text: employmentReasonLabel(employee.employment.reason),
    className: 'badge-inactive',
  };
};
