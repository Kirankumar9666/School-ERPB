/**
 * Option sets that the database schema does not own.
 *
 * Everything else the UI offers in a select is derived, not listed:
 *   - Role / Gender / EmploymentType / AccountStatus / AttendanceStatus /
 *     LeaveType / LeaveStatus come straight from the Prisma enums in
 *     `prisma/schema.prisma` (see `services/options.js`).
 *   - Classes and sections come from the `classes` table.
 *   - Subjects are free text (admin-defined per exam).
 *
 * These two lists are validated by zod rather than by the schema, so they live
 * here — the one definition shared by the request schemas and by the
 * `/school/options` endpoint that feeds the UI selects.
 *
 * Order matters: the first entry is what the corresponding form defaults to.
 */

/** Announcement categories (announcements schema + UI select) */
const ANNOUNCEMENT_CATEGORIES = ['general', 'event', 'exam', 'holiday', 'meeting'];

/** Achievement types (achievements schema + UI select) */
const ACHIEVEMENT_TYPES = ['academic', 'sports', 'cultural', 'other'];

module.exports = { ANNOUNCEMENT_CATEGORIES, ACHIEVEMENT_TYPES };