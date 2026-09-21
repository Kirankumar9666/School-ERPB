const express = require('express');
const { z } = require('zod');
const { LeaveType } = require('@prisma/client');
const authMiddleware = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { ROLES, EMPLOYEE_ROLES, TEACHER_ROLES } = require('../../constants/roles');
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
const { buildPayslipPdf, payslipFilename } = require('../../services/payslip');
const {
  bulkAttendanceSchema,
  loadAttendanceRoster,
  saveBulkAttendance,
  teacherClassGroups,
  teacherTeachesClass,
} = require('../../services/attendance');

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
 * GET /api/v1/employees/:id/payroll/:month/slip — server-generated PDF payslip.
 *
 * The PDF is composed at request time from the employee's profile row and that
 * month's PayrollRecord (nothing stored or pre-built), streamed back as a
 * binary download with a descriptive filename. Same access rules as the
 * payroll read: an employee may fetch only their own slips, admin any.
 */
router.get('/:id/payroll/:month/slip', requireRole([ROLES.ADMIN, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id, month } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return sendError(res, 'month must be YYYY-MM', 400, 'VALIDATION_ERROR');
  }

  const [employee, record] = await Promise.all([
    prisma.employee.findUnique({ where: { id } }),
    prisma.payrollRecord.findUnique({
      where: { employeeId_month: { employeeId: id, month } },
    }),
  ]);
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');
  if (!record) return sendError(res, `No payroll record for ${month}`, 404, 'NOT_FOUND');

  const pdf = await buildPayslipPdf(employee, record);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', pdf.length);
  res.setHeader('Content-Disposition', `attachment; filename="${payslipFilename(employee, month)}"`);
  return res.end(pdf);
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

/* ---------- Teacher attendance marking (Mark Attendance tab) ----------
 * The teacher-facing half of the class attendance flow: identical records and
 * identical rules as the admin panel (both call services/attendance.js), but
 * restricted to teaching staff and scoped to the classes this employee is
 * actually assigned to teach. The scoping is enforced here — a request naming a
 * class the teacher does not teach is rejected even when sent directly to the
 * API, not just hidden in the UI.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Guard: the class must be one this employee is assigned to teach. */
const assertOwnClass = async (req, res, employeeId, classId) => {
  if (!classId) {
    sendError(res, 'classId is required', 400, 'VALIDATION_ERROR');
    return false;
  }
  if (await teacherTeachesClass(employeeId, classId)) return true;
  sendError(res, 'This class is not assigned to you', 403, 'FORBIDDEN');
  return false;
};

/**
 * GET /api/v1/employees/:id/attendance/classes
 * The classes this teacher can mark — derived live from their assignments.
 */
router.get('/:id/attendance/classes', requireRole([...TEACHER_ROLES]), async (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const employee = await prisma.employee.findUnique({ where: { id }, select: { id: true } });
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  return sendSuccess(res, await teacherClassGroups(id));
});

/**
 * GET /api/v1/employees/:id/attendance/group?groupKey=...&date=YYYY-MM-DD
 * Roster + saved statuses + edit-window state for one of the teacher's classes.
 * `groupKey` is the same query name the admin endpoint uses, so the shared
 * MarkAttendance component drives both callers unchanged; `classId` is still
 * accepted as an alias.
 */
router.get('/:id/attendance/group', requireRole([...TEACHER_ROLES]), async (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const classId = String(req.query.groupKey || req.query.classId || '').trim();
  const date = String(req.query.date || '').trim();
  if (!(await assertOwnClass(req, res, id, classId))) return undefined;
  if (!ISO_DATE.test(date)) return sendError(res, 'date must be YYYY-MM-DD', 400, 'VALIDATION_ERROR');

  const roster = await loadAttendanceRoster('student', classId, date);
  if (!roster) return sendError(res, 'Class not found', 404, 'NOT_FOUND');

  return sendSuccess(res, roster);
});

/**
 * GET /api/v1/employees/:id/attendance/students?groupKey=...
 * Students of one of the teacher's classes (the "Check student" selector).
 * Accepts the same `groupKey` query name as the group endpoint (`classId`
 * alias kept).
 */
router.get('/:id/attendance/students', requireRole([...TEACHER_ROLES]), async (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const classId = String(req.query.groupKey || req.query.classId || '').trim();
  if (!(await assertOwnClass(req, res, id, classId))) return undefined;

  const klass = await prisma.class.findUnique({ where: { id: classId } });
  if (!klass) return sendError(res, 'Class not found', 404, 'NOT_FOUND');

  const students = await prisma.student.findMany({
    where: { classId },
    orderBy: { rollNumber: 'asc' },
  });

  // Same row shape the admin screens use, so the roster table renders identically.
  return sendSuccess(res, students.map((s) => ({
    id: s.id,
    name: s.name,
    rollNumber: s.rollNumber,
    class: String(klass.grade),
    section: klass.section,
    parentName: s.parentName,
    guardianContact: s.guardianContact,
  })));
});

/**
 * POST /api/v1/employees/:id/attendance/bulk
 * Save attendance for one of the teacher's classes — same endpoint contract and
 * same tables as the admin panel, so the records appear there unchanged.
 */
router.post('/:id/attendance/bulk', requireRole([...TEACHER_ROLES]), async (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const parsed = bulkAttendanceSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  // Attendance marking is a student-class flow; staff groups stay admin-only.
  if (parsed.data.kind !== 'student') {
    return sendError(res, 'Only class attendance can be marked here', 400, 'VALIDATION_ERROR');
  }
  if (!(await assertOwnClass(req, res, id, parsed.data.groupKey))) return undefined;

  const result = await saveBulkAttendance({ ...parsed.data, markedBy: req.user?.username || null });
  if (!result.ok) return sendError(res, result.message, result.status, result.code);

  return sendSuccess(res, result.data, 'Attendance confirmed', 201);
});

module.exports = router;
