const express = require('express');
const { z } = require('zod');
const authMiddleware = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { ROLES, EMPLOYEE_ROLES } = require('../../constants/roles');
const { sendSuccess, sendError, sendValidationError } = require('../../utils/response');
const {
  MOCK_EMPLOYEES,
  MOCK_ATTENDANCE_EMPLOYEE,
  MOCK_LEAVES,
  MOCK_PAYROLL,
  MOCK_DOCUMENTS,
} = require('../../mock/employees');
const { MOCK_TIMETABLE } = require('../../mock/school');

const router = express.Router();
router.use(authMiddleware);

/** Helper: verify employee access (employee sees own data, admin sees all) */
const canAccessEmployee = (req, empId) => {
  if (req.user.role === ROLES.ADMIN) return true;
  return req.user.linkedEntityId === empId;
};

/**
 * GET /api/v1/employees/:id/profile
 */
router.get('/:id/profile', requireRole([ROLES.ADMIN, ...EMPLOYEE_ROLES]), (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const employee = MOCK_EMPLOYEES.find((e) => e.id === id);
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  // Never return passwordHash or sensitive auth fields
  const { ...safeEmployee } = employee;
  return sendSuccess(res, safeEmployee);
});

/**
 * GET /api/v1/employees/:id/attendance?month=YYYY-MM
 */
router.get('/:id/attendance', requireRole([ROLES.ADMIN, ...EMPLOYEE_ROLES]), (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const records = MOCK_ATTENDANCE_EMPLOYEE[id]?.[month] || {};
  return sendSuccess(res, { employeeId: id, month, records });
});

/**
 * GET /api/v1/employees/:id/leaves
 */
router.get('/:id/leaves', requireRole([ROLES.ADMIN, ...EMPLOYEE_ROLES]), (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const leaves = MOCK_LEAVES[id] || { balance: {}, history: [] };
  return sendSuccess(res, leaves);
});

/** Apply leave schema */
const applyLeaveSchema = z.object({
  type: z.enum(['casual', 'sick', 'earned']),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  reason: z.string().min(5, 'Reason must be at least 5 characters').max(500),
});

/**
 * POST /api/v1/employees/:id/leaves/apply
 */
router.post('/:id/leaves/apply', requireRole([...EMPLOYEE_ROLES]), (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const parsed = applyLeaveSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const { type, fromDate, toDate, reason } = parsed.data;
  const newLeave = {
    id: `lv-${Date.now()}`,
    type,
    fromDate,
    toDate,
    reason,
    status: 'pending',
    appliedAt: new Date().toISOString(),
  };

  // In production: insert into Supabase
  if (!MOCK_LEAVES[id]) MOCK_LEAVES[id] = { balance: {}, history: [] };
  MOCK_LEAVES[id].history.unshift(newLeave);

  return sendSuccess(res, newLeave, 'Leave application submitted', 201);
});

/**
 * GET /api/v1/employees/:id/payroll?month=YYYY-MM
 */
router.get('/:id/payroll', requireRole([ROLES.ADMIN, ...EMPLOYEE_ROLES]), (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const { month } = req.query;
  const records = MOCK_PAYROLL[id] || [];
  const result = month ? records.filter((r) => r.month === month) : records;
  return sendSuccess(res, result);
});

/**
 * GET /api/v1/employees/:id/timetable
 */
router.get('/:id/timetable', requireRole([ROLES.ADMIN, ...EMPLOYEE_ROLES]), (req, res) => {
  const { id } = req.params;
  const employee = MOCK_EMPLOYEES.find((e) => e.id === id);
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  // Gather all timetable periods assigned to this teacher
  const assignedPeriods = [];
  Object.entries(MOCK_TIMETABLE).forEach(([classKey, periods]) => {
    periods.forEach((period) => {
      if (period.teacher === employee.name) {
        assignedPeriods.push({ ...period, classKey });
      }
    });
  });

  return sendSuccess(res, assignedPeriods);
});

/**
 * GET /api/v1/employees/:id/assigned-classes
 */
router.get('/:id/assigned-classes', requireRole([ROLES.ADMIN, ...EMPLOYEE_ROLES]), (req, res) => {
  const { id } = req.params;
  const employee = MOCK_EMPLOYEES.find((e) => e.id === id);
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  return sendSuccess(res, employee.assignedClasses || []);
});

/**
 * GET /api/v1/employees/:id/documents
 */
router.get('/:id/documents', requireRole([ROLES.ADMIN, ...EMPLOYEE_ROLES]), (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const docs = MOCK_DOCUMENTS[id] || [];
  return sendSuccess(res, docs);
});

module.exports = router;
