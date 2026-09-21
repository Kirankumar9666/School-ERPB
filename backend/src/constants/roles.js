/**
 * Role constants — single source of truth for all role strings.
 * Never use raw strings like 'admin' in logic; use ROLES.ADMIN.
 */
const ROLES = Object.freeze({
  ADMIN: 'admin',
  TEACHER: 'teacher',
  ACCOUNTANT: 'accountant',
  LIBRARIAN: 'librarian',
  STUDENT: 'student',
  PARENT: 'parent',
});

/** Employee-type roles (all employees share common routes) */
const EMPLOYEE_ROLES = [ROLES.TEACHER, ROLES.ACCOUNTANT, ROLES.LIBRARIAN];

/**
 * Roles allowed to mark student attendance for the classes they teach.
 * Attendance is class-scoped, so only teaching staff qualify — an accountant
 * or librarian has no roster to mark. Enforced server-side on every
 * `/employees/:id/attendance/*` route.
 */
const TEACHER_ROLES = [ROLES.TEACHER];

/** All authenticated roles */
const ALL_ROLES = Object.values(ROLES);

module.exports = { ROLES, EMPLOYEE_ROLES, TEACHER_ROLES, ALL_ROLES };
