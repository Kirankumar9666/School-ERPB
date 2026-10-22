const express = require('express');
const authMiddleware = require('../../middleware/auth.middleware');
const requirePasswordChange = require('../../middleware/passwordGate.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { ROLES, EMPLOYEE_ROLES } = require('../../constants/roles');
const { sendSuccess, sendError } = require('../../utils/response');
const prisma = require('../../services/prisma');
const {
  mapStudent,
  mapAchievement,
  mapPeriod,
  monthRange,
  normalizeSyllabusTopics,
  classLabel,
} = require('../../services/mappers');
const { summarizeAttendance, buildDayRecords } = require('../../utils/attendance');
const { getWeeklyOffDays } = require('../../services/settings');
const fees = require('../../services/fees');
const { wrapAsync } = require('../../utils/asyncRoute');
const {
  INTENTS,
  canViewStudent,
  requireStudentAccess,
} = require('../../services/studentAccess');

const router = wrapAsync(express.Router());

// All student routes require authentication
router.use(authMiddleware);
// A student/staff account still on its initial password may change it (POST
// /auth/change-password) but may not read anything else yet.
router.use(requirePasswordChange);

/* Shared include: student + class (for denormalized class/section labels)
   + the linked login account's username (null when the student has none) */
// The level rides along so a student's class is named by the shared `classLabel`
// ("Nursery A"), never rebuilt from the order by each caller.
const STUDENT_INCLUDE = {
  class: { include: { level: true } },
  user: { select: { username: true } },
};

/**
 * Can this caller read THIS student's record?
 *
 * The rule — and the two refusal codes — live in one place,
 * `services/studentAccess.js`, so every student/class route in the API agrees:
 * a student sees only their own record, a teacher only students in a class they
 * are assigned to teach, the accountant the identity + fee picture (the
 * `INTENTS.BASIC` read), the librarian nothing, the admin anything.
 *
 * Local wrapper kept so the routes below read as a plain guard and so the
 * accountant-projection lives next to the payload it shapes.
 */
const assertCanReadStudent = (req, res, studentId) =>
  requireStudentAccess(req, res, studentId);

/**
 * The accountant's student payload: name, class and guardian contact ONLY. No
 * dob, blood group, address, admission year, login account or fee-cache
 * columns. Built by allow-listing the fields the fee desk needs, never by
 * deleting from the full map — a new field added to `mapStudent` later must not
 * leak here by default.
 */
const basicStudentPayload = (student) => ({
  id: student.id,
  name: student.name,
  rollNumber: student.rollNumber,
  class: student.class ? String(student.class.grade) : null,
  section: student.class ? student.class.section : null,
  classLabel: student.class ? classLabel(student.class) : null,
  parentName: student.parentName,
  guardianContact: student.guardianContact,
});

/**
 * GET /api/v1/students/:id/profile
 * Returns student profile. A student sees only their own; a teacher only a
 * student in a class they teach; the accountant a name/class/guardian-contact
 * projection (no marks, attendance or other profile details); the librarian
 * nothing; the admin anything.
 */
router.get('/:id/profile', requireRole([ROLES.ADMIN, ROLES.STUDENT, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;

  /* The accountant is admitted only for the identity + fee projection. The
     decision carries no student, so the lookup below is the single existence
     check for every caller. */
  const decision = await canViewStudent(req.user, id, { intent: INTENTS.BASIC });
  if (!decision.allowed) {
    return requireStudentAccess(req, res, id, { intent: INTENTS.BASIC });
  }

  const student = await prisma.student.findUnique({ where: { id }, include: STUDENT_INCLUDE });
  if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  // The accountant sees the child's name, class and guardian contact only; a
  // teacher/admin/student gets the full mapped record.
  if (decision.scope === 'office') return sendSuccess(res, basicStudentPayload(student));

  return sendSuccess(res, mapStudent(student));
});

/**
 * GET /api/v1/students/:id/fees
 *
 * The student's fee picture: the current year's amount and balance, every
 * previous year still carrying a balance (labelled with its class and year), and
 * the total. Readable by the office, the accountant, and the student themselves
 * for their own record — a student must be able to see what is still owed.
 */
router.get('/:id/fees', requireRole([ROLES.ADMIN, ROLES.ACCOUNTANT, ROLES.STUDENT]), async (req, res) => {
  const { id } = req.params;

  // The accountant is the fee desk — an office role, not a class teacher — so it
  // reads any student's fee picture (the BASIC intent). A student still sees only
  // their own record.
  if (!(await requireStudentAccess(req, res, id, { intent: INTENTS.BASIC }))) return undefined;

  const student = await prisma.student.findUnique({ where: { id }, select: { id: true } });
  if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  const [summary, ledger] = await Promise.all([
    fees.feeSummaryFor(prisma, id),
    fees.feeLedgerFor(prisma, id),
  ]);
  return sendSuccess(res, {
    summary,
    // Every fee year with its payments, oldest first — the same rows the office's
    // Fee Dues page reads, so a parent sees exactly which year a due belongs to.
    rows: ledger.rows,
    currentAcademicYearId: ledger.currentAcademicYearId,
    outstanding: ledger.outstanding,
  });
});

/**
 * GET /api/v1/students/:id/attendance?month=YYYY-MM
 */
router.get('/:id/attendance', requireRole([ROLES.ADMIN, ROLES.STUDENT, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;
  const month = req.query.month || new Date().toISOString().slice(0, 7); // default current month

  // Same rule as every other student read: a student sees only their own, staff
  // only a class they teach, admin anything (see assertCanReadStudent).
  if (!(await assertCanReadStudent(req, res, id))) return undefined;

  const range = monthRange(month);
  const rows = range
    ? await prisma.studentAttendance.findMany({
      where: { studentId: id, date: { gte: range.gte, lt: range.lt } },
      orderBy: { date: 'asc' },
    })
    : [];
  const records = buildDayRecords(rows, false);
  // The school's real weekly off days drive the working-day count, so a
  // Saturday is a normal working day and never silently reduces attendance.
  const weeklyOffDays = await getWeeklyOffDays();

  return sendSuccess(res, {
    studentId: id, month, records, weeklyOffDays,
    summary: summarizeAttendance(records, weeklyOffDays),
  });
});

/**
 * GET /api/v1/students/:id/marks
 * Marks grouped per exam, ordered by exam date (oldest first).
 */
router.get('/:id/marks', requireRole([ROLES.ADMIN, ROLES.STUDENT, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;

  if (!(await assertCanReadStudent(req, res, id))) return undefined;

  const entries = await prisma.marksEntry.findMany({
    where: { studentId: id },
    include: { exam: true },
    orderBy: { exam: { date: 'asc' } },
  });

  // Group entries by exam → [{ examId, examName, date, subjects: [...] }]
  const byExam = new Map();
  entries.forEach((e) => {
    if (!byExam.has(e.examId)) {
      byExam.set(e.examId, {
        examId: e.examId,
        examName: e.exam.name,
        date: e.exam.date.toISOString().slice(0, 10),
        subjects: [],
      });
    }
    byExam.get(e.examId).subjects.push({
      subject: e.subject,
      maxMarks: e.maxMarks,
      obtained: e.obtained,
    });
  });

  return sendSuccess(res, [...byExam.values()]);
});

/**
 * GET /api/v1/students/:id/timetable
 */
router.get('/:id/timetable', requireRole([ROLES.ADMIN, ROLES.STUDENT, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;
  if (!(await assertCanReadStudent(req, res, id))) return undefined;

  const student = await prisma.student.findUnique({ where: { id }, include: STUDENT_INCLUDE });
  if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  const periods = await prisma.timetablePeriod.findMany({
    where: { classId: student.classId },
    orderBy: { period: 'asc' },
  });

  /* A student with no current class (passed out, or a record that only ever
     belonged to a past year) has `class: null` here. Their timetable is
     legitimately empty — there is no class to fetch periods for — so the header
     reports that honestly instead of throwing a TypeError at the one student
     who is not in a class. */
  return sendSuccess(res, {
    class: student.class ? String(student.class.grade) : null,
    section: student.class ? student.class.section : null,
    // The display name, so the Student Portal shows "Nursery A" rather than
    // assembling "Class -2-A" from the order. `class`/`section` stay for the
    // screens that still key off them.
    classLabel: student.class ? classLabel(student.class) : null,
    periods: periods.map(mapPeriod),
  });
});

/**
 * GET /api/v1/students/:id/achievements
 */
router.get('/:id/achievements', requireRole([ROLES.ADMIN, ROLES.STUDENT, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;
  if (!(await assertCanReadStudent(req, res, id))) return undefined;
  const rows = await prisma.achievement.findMany({
    where: { studentId: id },
    orderBy: { date: 'desc' },
  });
  return sendSuccess(res, rows.map(mapAchievement));
});

/**
 * GET /api/v1/students/:id/syllabus
 */
router.get('/:id/syllabus', requireRole([ROLES.ADMIN, ROLES.STUDENT, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;
  if (!(await assertCanReadStudent(req, res, id))) return undefined;
  const student = await prisma.student.findUnique({ where: { id } });
  if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  const syllabus = await prisma.syllabusEntry.findMany({
    where: { classId: student.classId },
    orderBy: { subject: 'asc' },
  });
  return sendSuccess(res, syllabus.map((s) => ({
    subject: s.subject,
    // [{ topic, done }] — the client derives the completion percent live
    topics: normalizeSyllabusTopics(s.topics),
  })));
});

module.exports = router;
