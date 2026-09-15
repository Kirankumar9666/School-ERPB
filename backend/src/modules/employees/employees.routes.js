const express = require('express');
const { z } = require('zod');
const { LeaveType } = require('@prisma/client');
const authMiddleware = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { ROLES, EMPLOYEE_ROLES } = require('../../constants/roles');
const { sendSuccess, sendError, sendValidationError } = require('../../utils/response');
const prisma = require('../../services/prisma');
const cache = require('../../utils/cache');
const {
  mapEmployee,
  mapLeave,
  mapPayroll,
  mapPeriod,
  buildAttendanceRecords,
  monthRange,
  toIso,
} = require('../../services/mappers');
const { summarizeAttendance } = require('../../utils/attendance');

const router = express.Router();
router.use(authMiddleware);

/* Shared include: employee + teaching assignments (with class + student counts) */
const EMPLOYEE_INCLUDE = {
  classesTaught: { include: { class: { include: { _count: { select: { students: true } } } } } },
};

/** Helper: verify employee access (employee sees own data, admin sees all) */
const canAccessEmployee = (req, empId) => {
  if (req.user.role === ROLES.ADMIN) return true;
  return req.user.linkedEntityId === empId;
};

/**
 * GET /api/v1/employees/:id/profile
 */
router.get('/:id/profile', requireRole([ROLES.ADMIN, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const employee = await prisma.employee.findUnique({ where: { id }, include: EMPLOYEE_INCLUDE });
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  // Never return passwordHash or sensitive auth fields
  return sendSuccess(res, mapEmployee(employee));
});

/**
 * GET /api/v1/employees/:id/attendance?month=YYYY-MM
 */
router.get('/:id/attendance', requireRole([ROLES.ADMIN, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const range = monthRange(month);
  const rows = range
    ? await prisma.employeeAttendance.findMany({
      where: { employeeId: id, date: { gte: range.gte, lt: range.lt } },
      orderBy: { date: 'asc' },
    })
    : [];
  const records = buildAttendanceRecords(rows, true);

  return sendSuccess(res, { employeeId: id, month, records, summary: summarizeAttendance(records) });
});

/**
 * GET /api/v1/employees/:id/leaves
 */
router.get('/:id/leaves', requireRole([ROLES.ADMIN, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const [balance, history] = await Promise.all([
    prisma.leaveBalance.findUnique({ where: { employeeId: id } }),
    prisma.leaveRequest.findMany({ where: { employeeId: id }, orderBy: { appliedAt: 'desc' } }),
  ]);

  return sendSuccess(res, {
    balance: balance
      ? { casual: balance.casual, sick: balance.sick, earned: balance.earned }
      : {},
    history: history.map(mapLeave),
  });
});

/** Apply leave schema */
const applyLeaveSchema = z.object({
  type: z.enum(Object.values(LeaveType)),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  reason: z.string().min(5, 'Reason must be at least 5 characters').max(500),
});

/**
 * POST /api/v1/employees/:id/leaves/apply
 */
router.post('/:id/leaves/apply', requireRole([...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const parsed = applyLeaveSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const { type, fromDate, toDate, reason } = parsed.data;
  const created = await prisma.leaveRequest.create({
    data: {
      employeeId: id,
      type,
      fromDate: new Date(`${fromDate}T00:00:00.000Z`),
      toDate: new Date(`${toDate}T00:00:00.000Z`),
      reason,
    },
  });
  // A new pending leave changes the summary counters — drop that cache
  // (leaves are applied outside the admin router, so the admin mutation
  // hook doesn't cover this route).
  cache.del('summary');

  return sendSuccess(res, mapLeave(created), 'Leave application submitted', 201);
});

/**
 * GET /api/v1/employees/:id/payroll?month=YYYY-MM
 */
router.get('/:id/payroll', requireRole([ROLES.ADMIN, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const { month } = req.query;
  const records = await prisma.payrollRecord.findMany({
    where: { employeeId: id, ...(month ? { month } : {}) },
    orderBy: { month: 'asc' },
  });
  return sendSuccess(res, records.map(mapPayroll));
});

/**
 * GET /api/v1/employees/:id/timetable
 * All timetable periods where this teacher's name matches.
 */
router.get('/:id/timetable', requireRole([ROLES.ADMIN, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;
  const employee = await prisma.employee.findUnique({ where: { id } });
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  const periods = await prisma.timetablePeriod.findMany({
    where: { teacherName: employee.name },
    orderBy: [{ classId: 'asc' }, { period: 'asc' }],
  });

  return sendSuccess(res, periods.map((p) => ({ ...mapPeriod(p), classKey: p.classId })));
});

/**
 * GET /api/v1/employees/:id/assigned-classes
 */
router.get('/:id/assigned-classes', requireRole([ROLES.ADMIN, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;
  const employee = await prisma.employee.findUnique({ where: { id }, include: EMPLOYEE_INCLUDE });
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  return sendSuccess(res, mapEmployee(employee).assignedClasses);
});

/**
 * GET /api/v1/employees/:id/documents
 */
router.get('/:id/documents', requireRole([ROLES.ADMIN, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const docs = await prisma.employeeDocument.findMany({
    where: { employeeId: id },
    orderBy: { uploadedAt: 'desc' },
  });
  return sendSuccess(res, docs.map((d) => ({
    id: d.id,
    type: d.type,
    fileName: d.fileName,
    uploadedAt: toIso(d.uploadedAt),
  })));
});

module.exports = router;
