/**
 * Student & class access control — the ONE rule for "may this caller see this
 * student / this class?".
 *
 * ## Why it exists
 *
 * A previous audit found that student reads were only half-gated: the student
 * case ("am I this student?") was handled, but any staff role could read any
 * child's profile, marks, timetable, achievements or syllabus by naming their id
 * directly — the role gate let staff through and the URL id was the only thing
 * standing between them and someone else's child. Attendance had already been
 * scoped to the teacher's own classes; everything else had not.
 *
 * Rather than re-derive that rule in each route (which is how the two halves of
 * the surface drifted apart in the first place), every route that takes a
 * student id or a class id calls into this module. One rule, one refusal, one
 * place to change it.
 *
 * ## The rule
 *
 *   admin      → everything.
 *   accountant → a student's NAME, CLASS and GUARDIAN CONTACT, plus their fee
 *                and payment data. No marks, no attendance, no timetable,
 *                syllabus, achievements or documents. (The accountant is the
 *                fee desk: their job needs to know who owes what and how to
 *                reach the family, and nothing else about the child.)
 *   teacher    → only students in a class the teacher has a period in, in the
 *                timetable.
 *   librarian  → no student data at all.
 *   student /  → only their own linked record.
 *   parent
 *
 * ## The teacher's classes
 *
 * The schema holds two different links between a teacher and a class:
 * `TeachingAssignment` (employeeId + classId) and `TimetablePeriod.teacherName`
 * matched to the employee by name. They can disagree — an assignment row can
 * name a class with no period, and a period can exist with no assignment row —
 * so a screen reading one and a gate reading the other could show different
 * classes.
 *
 * The whole employee portal now answers "which classes is this teacher on?" from
 * ONE place: `services/timetableScope.js`, which derives it from
 * `TimetablePeriod` alone. `services/marks.js` (Marks Entry), `services/
 * attendance.js` (Mark Attendance) and this module all consume that same
 * derivation, so the timetable page, the marks page, the attendance page and
 * every permission check agree by construction. `TeachingAssignment` remains a
 * table and still scopes everything else it scoped; it is no longer the source
 * of any teacher class list.
 *
 * ## The refusal
 *
 * Two distinct refusals, because they mean two different things:
 *
 *   - 404 NOT_FOUND — the record exists but is OUT OF SCOPE for this caller
 *     (a teacher naming a student in a class they do not teach). Answering 404
 *     rather than 403 stops the endpoint being used to probe which ids exist:
 *     "you cannot see it" and "it does not exist" are indistinguishable.
 *   - 403 FORBIDDEN — the caller's ROLE has no business at this surface at all
 *     (a librarian asking for any student). That is an authorization fact about
 *     the role, not a fact about the record, so it does not leak anything and
 *     is the honest answer.
 *
 * `requireStudentAccess` / `requireClassAccess` send the response themselves and
 * return false, so callers read as a plain guard:
 *
 *   if (!(await requireStudentAccess(req, res, id))) return undefined;
 */
const { ROLES, EMPLOYEE_ROLES } = require('../constants/roles');
const { sendError } = require('../utils/response');
const prisma = require('./prisma');
const { teacherTeachesClass, teacherTimetableClasses } = require('./timetableScope');

/** What a caller is allowed to see about a student, once access is granted. */
const INTENTS = Object.freeze({
  /** Guardian/name/class fields only — the accountant's view. */
  BASIC: 'basic',
  /** Everything (a teacher of the class, the student themselves, an admin). */
  FULL: 'full',
});

/** Roles that may reach this module's surfaces with a role-level grant. */
const STAFF_ROLES = EMPLOYEE_ROLES;

/**
 * The decision, with no HTTP side effects — the single source of truth the
 * guards below render as responses, and the function tests can call directly.
 *
 * @param {object} user     req.user ({ role, linkedEntityId, id, username })
 * @param {string} studentId
 * @param {object} [opts]
 * @param {string} [opts.intent=INTENTS.FULL] 'basic' admits the accountant for
 *   name/class/guardian fields; 'full' is everything else.
 * @returns {Promise<{ allowed: boolean, reason?: 'not_found'|'forbidden', scope?: 'admin'|'self'|'teacher'|'office'|'basic', student?: object }>}
 */
const canViewStudent = async (user, studentId, { intent = INTENTS.FULL } = {}) => {
  const { role, linkedEntityId } = user || {};

  if (role === ROLES.ADMIN) return { allowed: true, scope: 'admin' };

  if (role === ROLES.STUDENT || role === ROLES.PARENT) {
    if (linkedEntityId && linkedEntityId === studentId) return { allowed: true, scope: 'self' };
    return { allowed: false, reason: 'forbidden' };
  }

  if (role === ROLES.ACCOUNTANT && intent === INTENTS.BASIC) {
    // The office reads the child's identity + fee picture. Existence is
    // confirmed by the route's own lookup, so no existence probe happens here.
    return { allowed: true, scope: 'office' };
  }

  if (role === ROLES.TEACHER) {
    const student = await prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true, classId: true },
    });
    // A missing student is reported to the caller as "not found", never as
    // "forbidden" — a teacher is entitled to know a student is gone.
    if (!student) return { allowed: false, reason: 'not_found' };
    if (student.classId && await teacherTeachesClass(linkedEntityId, student.classId)) {
      return { allowed: true, scope: 'teacher', student };
    }
    // Exists, but not in a class this teacher is assigned to. Answered as
    // "not found" so the endpoint cannot be used to probe which ids exist —
    // "you cannot see it" and "it does not exist" are indistinguishable.
    return { allowed: false, reason: 'not_found' };
  }

  // accountant asking for FULL, librarian, and anything else: the role has no
  // business at this surface.
  return { allowed: false, reason: 'forbidden' };
};

/**
 * May this caller see this class? The class-scoped counterpart: a teacher only
 * for a class they are assigned to teach, an admin for any, the accountant for
 * any (the fee desk sets fees per class), everyone else never.
 */
const canViewClass = async (user, classId) => {
  const { role, linkedEntityId } = user || {};
  if (role === ROLES.ADMIN) return { allowed: true, scope: 'admin' };
  if (role === ROLES.ACCOUNTANT) return { allowed: true, scope: 'office' };
  if (role === ROLES.TEACHER) {
    if (!classId) return { allowed: false, reason: 'not_found' };
    const klass = await prisma.class.findUnique({ where: { id: classId }, select: { id: true } });
    if (!klass) return { allowed: false, reason: 'not_found' };
    if (await teacherTeachesClass(linkedEntityId, classId)) return { allowed: true, scope: 'teacher' };
    // Exists but not assigned to this teacher — "not found", same as students,
    // so a class id cannot be probed for existence either.
    return { allowed: false, reason: 'not_found' };
  }
  return { allowed: false, reason: 'forbidden' };
};

/** The classes a teacher may see students of (empty for anyone else). */
const visibleClassIds = async (user) => {
  if (!user) return [];
  if (user.role === ROLES.ADMIN || user.role === ROLES.ACCOUNTANT) return null; // null = every class
  if (user.role === ROLES.TEACHER) {
    const classes = await teacherTimetableClasses(user.linkedEntityId);
    return classes.map((c) => c.id);
  }
  return [];
};

/** Render a `{ allowed, reason }` decision as the one consistent refusal. */
const denyStudent = (res, decision) => {
  if (decision.reason === 'not_found') {
    sendError(res, 'Student not found', 404, 'NOT_FOUND');
  } else {
    sendError(res, 'Access denied', 403, 'FORBIDDEN');
  }
  return false;
};

const denyClass = (res, decision) => {
  if (decision.reason === 'not_found') {
    sendError(res, 'Class not found', 404, 'NOT_FOUND');
  } else {
    sendError(res, 'Access denied', 403, 'FORBIDDEN');
  }
  return false;
};

/**
 * Guard for a route that takes a student id. Sends the refusal itself and
 * resolves false; resolves true when the caller may proceed.
 * @returns {Promise<boolean|object>} true, or the decision when a caller wants
 *   the scope (e.g. to shape the payload).
 */
const requireStudentAccess = async (req, res, studentId, opts) => {
  const decision = await canViewStudent(req.user, studentId, opts);
  if (!decision.allowed) return denyStudent(res, decision);
  return true;
};

/** Guard for a route that takes a class id. Same contract as above. */
const requireClassAccess = async (req, res, classId) => {
  const decision = await canViewClass(req.user, classId);
  if (!decision.allowed) return denyClass(res, decision);
  return true;
};

module.exports = {
  INTENTS,
  STAFF_ROLES,
  canViewStudent,
  canViewClass,
  visibleClassIds,
  requireStudentAccess,
  requireClassAccess,
};
