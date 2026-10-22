/**
 * Leave constants and text helpers shared by the Employee Portal's Leave History
 * and the Admin Panel's Leave Approval screen.
 *
 * They live apart from the components that use them on purpose: a module that
 * exports both components and plain values defeats React Fast Refresh, so editing
 * `LeaveReason.jsx` would reload the page instead of hot-swapping the component.
 */

export const LEAVE_REASON_MAX = 500;

/** LeaveStatus enum → the app's status badge. One map, so the two portals cannot diverge. */
export const LEAVE_STATUS_BADGE = {
  pending: 'badge-pending',
  approved: 'badge-approved',
  rejected: 'badge-rejected',
};

/**
 * The reason text, normalised — the client's half of the contract.
 *
 * This mirrors `normalizeReason` in `backend/src/modules/employees/employees.routes.js`
 * step for step, and the two MUST stay identical:
 *
 *   1. `\r\n` and lone `\r` → `\n`. A `<textarea>` submits CRLF when typed on
 *      Windows, so counting the raw value would count 2 characters per line
 *      break that the server then stores as 1 — the counter would stop agreeing
 *      with the server's validation as soon as someone typed a multi-line reason.
 *   2. Trim leading/trailing whitespace only.
 *   3. Interior newlines are left completely alone.
 *
 * Because the counter below measures THIS value, and the server measures the same
 * one after normalising, the number on screen is exactly the number the server
 * validates. There is deliberately no HTML escaping here: the text is rendered as
 * React children, which escape it, so `5 < 10` displays correctly and no markup
 * can execute. Escaping on input as well would corrupt an honest reason.
 */
export const normalizeReason = (raw) => String(raw ?? '').replace(/\r\n?/g, '\n').trim();
