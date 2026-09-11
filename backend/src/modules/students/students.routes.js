const express = require('express');
const authMiddleware = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { ROLES, EMPLOYEE_ROLES } = require('../../constants/roles');
const { sendSuccess, sendError } = require('../../utils/response');
const {
  MOCK_STUDENTS,
  MOCK_ATTENDANCE_STUDENT,
  MOCK_MARKS,
  MOCK_ACHIEVEMENTS,
} = require('../../mock/students');
const { MOCK_TIMETABLE, MOCK_ANNOUNCEMENTS, MOCK_HOLIDAYS, MOCK_SYLLABUS } = require('../../mock/school');
const { summarizeAttendance } = require('../../utils/attendance');

const router = express.Router();

// All student routes require authentication
router.use(authMiddleware);

/**
 * GET /api/v1/students/:id/profile
 * Returns student profile. Student can only access own profile.
 */
router.get('/:id/profile', requireRole([ROLES.ADMIN, ROLES.STUDENT, ...EMPLOYEE_ROLES]), (req, res) => {
  const { id } = req.params;

  // Students can only view their own profile
  if (req.user.role === ROLES.STUDENT && req.user.linkedEntityId !== id) {
    return sendError(res, 'Access denied', 403, 'FORBIDDEN');
  }

  const student = MOCK_STUDENTS.find((s) => s.id === id);
  if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  return sendSuccess(res, student);
});

/**
 * GET /api/v1/students/:id/attendance?month=YYYY-MM
 */
router.get('/:id/attendance', requireRole([ROLES.ADMIN, ROLES.STUDENT, ...EMPLOYEE_ROLES]), (req, res) => {
  const { id } = req.params;
  const month = req.query.month || new Date().toISOString().slice(0, 7); // default current month

  if (req.user.role === ROLES.STUDENT && req.user.linkedEntityId !== id) {
    return sendError(res, 'Access denied', 403, 'FORBIDDEN');
  }

  const records = MOCK_ATTENDANCE_STUDENT[id]?.[month] || {};
  return sendSuccess(res, { studentId: id, month, records, summary: summarizeAttendance(records) });
});

/**
 * GET /api/v1/students/:id/marks
 */
router.get('/:id/marks', requireRole([ROLES.ADMIN, ROLES.STUDENT, ...EMPLOYEE_ROLES]), (req, res) => {
  const { id } = req.params;

  if (req.user.role === ROLES.STUDENT && req.user.linkedEntityId !== id) {
    return sendError(res, 'Access denied', 403, 'FORBIDDEN');
  }

  const marks = MOCK_MARKS[id] || [];
  return sendSuccess(res, marks);
});

/**
 * GET /api/v1/students/:id/timetable
 */
router.get('/:id/timetable', requireRole([ROLES.ADMIN, ROLES.STUDENT, ...EMPLOYEE_ROLES]), (req, res) => {
  const { id } = req.params;
  const student = MOCK_STUDENTS.find((s) => s.id === id);
  if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  const classKey = `cls-${student.class}${student.section}`;
  const timetable = MOCK_TIMETABLE[classKey] || [];
  return sendSuccess(res, { class: student.class, section: student.section, periods: timetable });
});

/**
 * GET /api/v1/students/:id/achievements
 */
router.get('/:id/achievements', requireRole([ROLES.ADMIN, ROLES.STUDENT, ...EMPLOYEE_ROLES]), (req, res) => {
  const { id } = req.params;
  const achievements = MOCK_ACHIEVEMENTS[id] || [];
  return sendSuccess(res, achievements);
});

/**
 * GET /api/v1/students/:id/syllabus
 */
router.get('/:id/syllabus', requireRole([ROLES.ADMIN, ROLES.STUDENT, ...EMPLOYEE_ROLES]), (req, res) => {
  const { id } = req.params;
  const student = MOCK_STUDENTS.find((s) => s.id === id);
  if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  const classKey = `cls-${student.class}${student.section}`;
  const syllabus = MOCK_SYLLABUS[classKey] || [];
  return sendSuccess(res, syllabus);
});

module.exports = router;
