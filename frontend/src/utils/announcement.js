/**
 * Announcement form rules.
 *
 * The client-side half of the server's zod contract in
 * `backend/src/services/announcements.js`, so a bad form never round-trips.
 * The server still validates everything — this only saves the user a failed
 * save, and the wording is deliberately the same as the server's.
 */

/**
 * @param {{title: string, body: string, showFrom: string, showUntil: string}} value
 * @returns {string|null} the first problem, or null when the form is good
 */
export function validateAnnouncement(value) {
  if (!value.title || value.title.trim().length < 3) return 'Title is required (min 3 characters).';
  if (!value.body || value.body.trim().length < 10) return 'Body is required (min 10 characters).';
  if (!value.showUntil) return '"Show until" is required — it is the last day the circular is visible.';
  if (value.showFrom && value.showFrom > value.showUntil) return '"Show until" must be on or after "Show from".';
  return null;
}
