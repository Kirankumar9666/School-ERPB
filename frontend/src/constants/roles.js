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

/**
 * Roles that teach classes. Only these see the "Mark Attendance" flow in the
 * employee portal — a librarian or accountant has no class roster to mark.
 * Mirrors `TEACHER_ROLES` in the backend role constants.
 */
export const TEACHER_ROLES = [ROLES.TEACHER];
