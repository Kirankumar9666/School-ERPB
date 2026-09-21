const express = require('express');
const { z } = require('zod');
const authMiddleware = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { ROLES, EMPLOYEE_ROLES } = require('../../constants/roles');
const { sendSuccess, sendError, sendValidationError } = require('../../utils/response');
const prisma = require('../../services/prisma');
const cache = require('../../utils/cache');
const { toDateStr, monthRange, schoolToday } = require('../../services/mappers');
const { enumOptions, classOptions } = require('../../services/options');

const router = express.Router();
router.use(authMiddleware);

const newId = (prefix) => `${prefix}-${Date.now()}`;
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

/**
 * GET /api/v1/school/announcements
 * Filters announcements by the requesting user's role AND the show window:
 * a circular is only returned while today — the school's real current date,
 * recomputed on every request — falls inside [showFrom, showUntil] (both
 * inclusive). Once showUntil has passed the circular disappears from every
 * portal on its own; nothing needs to be deleted or hidden manually.
 * Newest first: by showFrom, then posted date.
 */
router.get('/announcements', async (req, res) => {
  const rows = await prisma.announcement.findMany({
    where: { targetRoles: { has: req.user.role } },
    orderBy: [{ showFrom: 'desc' }, { createdAt: 'desc' }],
  });

  // Date-string comparison against each row's own stored window (the rows are
  // few; the DB session timezone can't shift a DATE column, so comparing the
  // 'YYYY-MM-DD' strings is exact and TZ-proof).
  const today = schoolToday();
  const visible = rows.filter((a) => toDateStr(a.showFrom) <= today && toDateStr(a.showUntil) >= today);

  return sendSuccess(res, visible.map((a) => ({
    id: a.id,
    title: a.title,
    body: a.body,
    targetRoles: a.targetRoles,
    createdAt: a.createdAt.toISOString(),
    category: a.category,
  })));
});

/* ---------- Reminders (private, per signed-in user) ---------- */

/**
 * A reminder is a date + title the logged-in user sets for themselves. Every
 * route is scoped to req.user.id — a student only ever sees their own
 * reminders, an employee theirs, an admin theirs; no user can read, create
 * under or delete another user's reminders.
 */
const reminderSchema = z.object({
  date: dateStr,
  title: z.string().trim().min(1, 'Title is required').max(120, 'Title too long (max 120 chars)'),
});

const mapReminder = (r) => ({ id: r.id, date: toDateStr(r.date), title: r.title });

/** GET /api/v1/school/reminders — the signed-in user's own reminders, soonest first */
router.get('/reminders', async (req, res) => {
  const rows = await prisma.reminder.findMany({
    where: { userId: req.user.id },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
  });
  return sendSuccess(res, rows.map(mapReminder));
});

/** POST /api/v1/school/reminders — set a reminder for yourself */
router.post('/reminders', async (req, res) => {
  const parsed = reminderSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const created = await prisma.reminder.create({
    data: { id: newId('rem'), userId: req.user.id, date: new Date(`${parsed.data.date}T00:00:00.000Z`), title: parsed.data.title },
  });
  return sendSuccess(res, mapReminder(created), 'Reminder set', 201);
});

/** DELETE /api/v1/school/reminders/:id — delete one of your own reminders.
 *  The userId condition is part of the lookup: another user's reminder (or an
 *  unknown id) resolves to P2025 → 404, never to someone else's data. */
router.delete('/reminders/:id', async (req, res) => {
  try {
    await prisma.reminder.delete({ where: { id: req.params.id, userId: req.user.id } });
    return sendSuccess(res, { id: req.params.id }, 'Reminder deleted');
  } catch (err) {
    if (err.code === 'P2025') return sendError(res, 'Reminder not found', 404, 'NOT_FOUND');
    throw err;
  }
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
 * GET /api/v1/school/options — reference data that fills the UI selects.
 *
 * `enums` is derived from the Prisma schema enums (plus the two zod-validated
 * lists in constants/options.js), so no screen keeps its own copy of a domain
 * list. `classes` is read from the classes table — returned to the roles that
 * manage admissions, timetables and syllabus (admin + employees) only.
 */
router.get('/options', async (req, res) => {
  const managesClasses = req.user.role === ROLES.ADMIN || EMPLOYEE_ROLES.includes(req.user.role);
  const classes = managesClasses ? await classOptions() : [];
  return sendSuccess(res, { enums: enumOptions(), classes });
});

/**
 * GET /api/v1/school/summary (Admin dashboard stats)
 */
router.get('/summary', requireRole([ROLES.ADMIN]), async (req, res) => {
  // 30s cache: five counts/aggregates per hit; cleared by any admin mutation
  // (same underlying counters as GET /admin/reports/summary).
  const cached = cache.get('summary:school');
  if (cached) return sendSuccess(res, cached);

  const [totalStudents, totalEmployees, feeAgg, totalAnnouncements, totalHolidays] = await Promise.all([
    prisma.student.count(),
    prisma.employee.count(),
    prisma.student.aggregate({ _sum: { feeDues: true } }),
    prisma.announcement.count(),
    prisma.holiday.count(),
  ]);

  const summary = {
    totalStudents,
    totalEmployees,
    totalFeeDues: feeAgg._sum.feeDues || 0,
    totalAnnouncements,
    totalHolidays,
  };
  cache.set('summary:school', summary);
  return sendSuccess(res, summary);
});

module.exports = router;
