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
} = require('@prisma/client');
const { ANNOUNCEMENT_CATEGORIES, ACHIEVEMENT_TYPES } = require('../constants/options');
const prisma = require('./prisma');
const { statusToApi } = require('./mappers');

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
  attendanceStatuses: Object.values(AttendanceStatus).map(statusToApi),
  leaveTypes: Object.values(LeaveType),
  leaveStatuses: Object.values(LeaveStatus),
  announcementCategories: ANNOUNCEMENT_CATEGORIES,
  achievementTypes: ACHIEVEMENT_TYPES,
});

/**
 * The classes that actually exist, with a live headcount per class.
 * @returns {Promise<Array<{id: string, grade: string, section: string, label: string, studentCount: number}>>}
 */
const classOptions = async () => {
  const rows = await prisma.class.findMany({
    include: { _count: { select: { students: true } } },
    orderBy: [{ grade: 'asc' }, { section: 'asc' }],
  });
  return rows.map((c) => ({
    id: c.id,
    grade: String(c.grade),
    section: c.section,
    label: `Class ${c.grade}${c.section}`,
    studentCount: c._count.students,
  }));
};

module.exports = { enumOptions, classOptions };