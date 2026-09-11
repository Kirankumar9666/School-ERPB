/**
 * Role constants — mirrors the backend. Never use raw strings.
 */
export const ROLES = Object.freeze({
  ADMIN: 'admin',
  TEACHER: 'teacher',
  ACCOUNTANT: 'accountant',
  LIBRARIAN: 'librarian',
  STUDENT: 'student',
  PARENT: 'parent',
});

export const EMPLOYEE_ROLES = [ROLES.TEACHER, ROLES.ACCOUNTANT, ROLES.LIBRARIAN];
