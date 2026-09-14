const express = require('express');
const authMiddleware = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { ROLES } = require('../../constants/roles');
const { sendSuccess } = require('../../utils/response');
const prisma = require('../../services/prisma');
const { toDateStr, monthRange } = require('../../services/mappers');

const router = express.Router();
router.use(authMiddleware);

/**
 * GET /api/v1/school/announcements
 * Filters announcements by the requesting user's role.
 */
router.get('/announcements', async (req, res) => {
  const rows = await prisma.announcement.findMany({
    where: { targetRoles: { has: req.user.role } },
    orderBy: { createdAt: 'desc' },
  });
  return sendSuccess(res, rows.map((a) => ({
    id: a.id,
    title: a.title,
    body: a.body,
    targetRoles: a.targetRoles,
    createdAt: a.createdAt.toISOString(),
    category: a.category,
  })));
});

/**
 * GET /api/v1/school/holidays?month=YYYY-MM
 */
router.get('/holidays', async (req, res) => {
  const { month } = req.query;
  const range = month ? monthRange(month) : null;
  const rows = await prisma.holiday.findMany({
    where: range ? { date: { gte: range.gte, lt: range.lt } } : undefined,
    orderBy: { date: 'asc' },
  });
  return sendSuccess(res, rows.map((h) => ({ id: h.id, date: toDateStr(h.date), name: h.name })));
});

/**
 * GET /api/v1/school/summary (Admin dashboard stats)
 */
router.get('/summary', requireRole([ROLES.ADMIN]), async (req, res) => {
  const [totalStudents, totalEmployees, feeAgg, totalAnnouncements, totalHolidays] = await Promise.all([
    prisma.student.count(),
    prisma.employee.count(),
    prisma.student.aggregate({ _sum: { feeDues: true } }),
    prisma.announcement.count(),
    prisma.holiday.count(),
  ]);

  return sendSuccess(res, {
    totalStudents,
    totalEmployees,
    totalFeeDues: feeAgg._sum.feeDues || 0,
    totalAnnouncements,
    totalHolidays,
  });
});

module.exports = router;
