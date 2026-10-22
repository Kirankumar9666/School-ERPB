/**
 * Reference options for form selects — served by `GET /api/v1/school/options`.
 *
 * Nothing here is a hand-written list of domain values: the enum sets are read
 * from the generated Prisma client (so `prisma/schema.prisma` is the single
 * source and a schema change propagates to the UI automatically), and the class
 * list is a real query against the `classes` table.
 */
const {
  Role,
  Gender,
  EmploymentType,
  AccountStatus,
  AttendanceStatus,
  LeaveType,
  LeaveStatus,
  EmploymentEndReason,
  EnrollmentStatus,
  RecordSource,
  MatchConfidence,
} = require('@prisma/client');
const { ANNOUNCEMENT_CATEGORIES, ACHIEVEMENT_TYPES } = require('../constants/options');
const prisma = require('./prisma');
const { statusToApi } = require('./mappers');
const { classLabel } = require('./mappers');
const cache = require('../utils/cache');

/**
 * Enum-backed option lists, in the spelling the API accepts
 * (the DB stores `half_day`, the API contract uses `half-day`).
 * @returns {object} option arrays keyed by the form field they fill
 */
const enumOptions = () => ({
  roles: Object.values(Role),
  genders: Object.values(Gender),
  employmentTypes: Object.values(EmploymentType),
  accountStatuses: Object.values(AccountStatus),
  /* Why an employment ended. Read from the enum, so the End Employment modal's
     dropdown is the schema's own list and a new reason cannot need a UI edit. */
  employmentEndReasons: Object.values(EmploymentEndReason),
  attendanceStatuses: Object.values(AttendanceStatus).map(statusToApi),
  leaveTypes: Object.values(LeaveType),
  leaveStatuses: Object.values(LeaveStatus),
  announcementCategories: ANNOUNCEMENT_CATEGORIES,
  achievementTypes: ACHIEVEMENT_TYPES,
  /* Class Management reads these from the schema for the same reason as
     employmentEndReasons: a new enrollment outcome or provenance value must not
     need a UI edit to be selectable, and a value the UI invents must not exist
     where the database cannot store it. */
  enrollmentStatuses: Object.values(EnrollmentStatus),
  recordSources: Object.values(RecordSource),
  matchConfidences: Object.values(MatchConfidence),
});

/**
 * The classes that actually exist, with a live headcount per class.
 *
 * Cached (60s TTL): this endpoint is fetched on nearly every admin/employee
 * page mount, and the classes table changes only via admin mutations — which
 * invalidate the cache (see `invalidateClassOptions` + the admin mutation
 * hook). Callers therefore never see a class list older than the last
 * mutation.
 *
 * The label is the shared `classLabel` (mappers), so a named level reads
 * 'Nursery A' here and everywhere else. `order` is shipped so the frontend can
 * sort by the ONE shared rule instead of parsing a grade out of a class id,
 * which it used to do and which a named level would have broken.
 *
 * @returns {Promise<Array<{id: string, order: number, grade: string, section: string, levelId: string|null, levelName: string|null, label: string, studentCount: number}>>}
 */
const CLASS_OPTIONS_TTL_MS = 60_000;

const classOptions = async () => {
  const cached = cache.get('options:classes');
  if (cached) return cached;

  const rows = await prisma.class.findMany({
    include: { _count: { select: { students: true } }, level: true },
    // `grade` holds the level's order, so this IS the shared sort — see
    // compareClasses in mappers.js for why the two cannot drift.
    orderBy: [{ grade: 'asc' }, { section: 'asc' }],
  });
  const options = rows.map((c) => ({
    id: c.id,
    order: c.level ? c.level.order : c.grade,
    grade: String(c.grade),
    section: c.section,
    levelId: c.levelId,
    levelName: c.level ? c.level.name : null,
    label: classLabel(c),
    studentCount: c._count.students,
  }));

  cache.set('options:classes', options, CLASS_OPTIONS_TTL_MS);
  return options;
};

/** Drop the cached class list (called when classes or student counts change). */
const invalidateClassOptions = () => cache.del('options:');

module.exports = { enumOptions, classOptions, invalidateClassOptions };