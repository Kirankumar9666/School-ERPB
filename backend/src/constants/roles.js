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

/** All authenticated roles */
const ALL_ROLES = Object.values(ROLES);

module.exports = { ROLES, EMPLOYEE_ROLES, ALL_ROLES };
