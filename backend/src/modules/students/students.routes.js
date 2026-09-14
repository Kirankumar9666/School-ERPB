const express = require('express');
const authMiddleware = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { ROLES, EMPLOYEE_ROLES } = require('../../constants/roles');
const { sendSuccess, sendError } = require('../../utils/response');
const prisma = require('../../services/prisma');
const {
  mapStudent,
  mapAchievement,
  mapPeriod,
  buildAttendanceRecords,
  monthRange,
} = require('../../services/mappers');
const { summarizeAttendance } = require('../../utils/attendance');

const router = express.Router();

// All student routes require authentication
router.use(authMiddleware);

/* Shared include: student + class (for denormalized class/section labels) */
const STUDENT_INCLUDE = { class: true };

/**
 * GET /api/v1/students/:id/profile
 * Returns student profile. Student can only access own profile.
 */
router.get('/:id/profile', requireRole([ROLES.ADMIN, ROLES.STUDENT, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;

  // Students can only view their own profile
  if (req.user.role === ROLES.STUDENT && req.user.linkedEntityId !== id) {
    return sendError(res, 'Access denied', 403, 'FORBIDDEN');
  }

  const student = await prisma.student.findUnique({ where: { id }, include: STUDENT_INCLUDE });
  if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  return sendSuccess(res, mapStudent(student));
});

/**
 * GET /api/v1/students/:id/attendance?month=YYYY-MM
 */
router.get('/:id/attendance', requireRole([ROLES.ADMIN, ROLES.STUDENT, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;
  const month = req.query.month || new Date().toISOString().slice(0, 7); // default current month

  if (req.user.role === ROLES.STUDENT && req.user.linkedEntityId !== id) {
    return sendError(res, 'Access denied', 403, 'FORBIDDEN');
  }

  const range = monthRange(month);
  const rows = range
    ? await prisma.studentAttendance.findMany({
      where: { studentId: id, date: { gte: range.gte, lt: range.lt } },
      orderBy: { date: 'asc' },
    })
    : [];
  const records = buildAttendanceRecords(rows, false);

  return sendSuccess(res, { studentId: id, month, records, summary: summarizeAttendance(records) });
});

/**
 * GET /api/v1/students/:id/marks
 * Marks grouped per exam, ordered by exam date (oldest first).
 */
router.get('/:id/marks', requireRole([ROLES.ADMIN, ROLES.STUDENT, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;

  if (req.user.role === ROLES.STUDENT && req.user.linkedEntityId !== id) {
    return sendError(res, 'Access denied', 403, 'FORBIDDEN');
  }

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
  const student = await prisma.student.findUnique({ where: { id }, include: STUDENT_INCLUDE });
  if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  const periods = await prisma.timetablePeriod.findMany({
    where: { classId: student.classId },
    orderBy: { period: 'asc' },
  });

  return sendSuccess(res, {
    class: String(student.class.grade),
    section: student.class.section,
    periods: periods.map(mapPeriod),
  });
});

/**
 * GET /api/v1/students/:id/achievements
 */
router.get('/:id/achievements', requireRole([ROLES.ADMIN, ROLES.STUDENT, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;
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
  const student = await prisma.student.findUnique({ where: { id } });
  if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  const syllabus = await prisma.syllabusEntry.findMany({
    where: { classId: student.classId },
    orderBy: { subject: 'asc' },
  });
  return sendSuccess(res, syllabus.map((s) => ({
    subject: s.subject,
    topics: s.topics,
    completedPercent: s.completedPercent,
  })));
});

module.exports = router;
