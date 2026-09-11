const express = require('express');
const authMiddleware = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { ROLES } = require('../../constants/roles');
const { sendSuccess } = require('../../utils/response');
const { MOCK_ANNOUNCEMENTS, MOCK_HOLIDAYS } = require('../../mock/school');
const { MOCK_STUDENTS } = require('../../mock/students');
const { MOCK_EMPLOYEES } = require('../../mock/employees');

const router = express.Router();
router.use(authMiddleware);

/**
 * GET /api/v1/school/announcements
 * Filters announcements by the requesting user's role.
 */
router.get('/announcements', (req, res) => {
  const userRole = req.user.role;
  const filtered = MOCK_ANNOUNCEMENTS.filter((a) => a.targetRoles.includes(userRole));
  return sendSuccess(res, filtered);
});

/**
 * GET /api/v1/school/holidays?month=YYYY-MM
 */
router.get('/holidays', (req, res) => {
  const { month } = req.query;
  const holidays = month
    ? MOCK_HOLIDAYS.filter((h) => h.date.startsWith(month))
    : MOCK_HOLIDAYS;
  return sendSuccess(res, holidays);
});

/**
 * GET /api/v1/school/summary (Admin dashboard stats)
 */
router.get('/summary', requireRole([ROLES.ADMIN]), (req, res) => {
  const totalStudents = MOCK_STUDENTS.length;
  const totalEmployees = MOCK_EMPLOYEES.length;
  const totalFeeDues = MOCK_STUDENTS.reduce((sum, s) => sum + (s.feeDues || 0), 0);

  return sendSuccess(res, {
    totalStudents,
    totalEmployees,
    totalFeeDues,
    totalAnnouncements: MOCK_ANNOUNCEMENTS.length,
    totalHolidays: MOCK_HOLIDAYS.length,
  });
});

module.exports = router;
