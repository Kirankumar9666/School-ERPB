const express = require('express');
const { z } = require('zod');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { parse: parseCsv } = require('csv-parse/sync');
const { LeaveType } = require('@prisma/client');
const authMiddleware = require('../../middleware/auth.middleware');
const requirePasswordChange = require('../../middleware/passwordGate.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { ROLES, EMPLOYEE_ROLES, TEACHER_ROLES } = require('../../constants/roles');
const { sendSuccess, sendError, sendValidationError } = require('../../utils/response');
const prisma = require('../../services/prisma');
const cache = require('../../utils/cache');
const {
  mapEmployee,
  mapLeave,
  mapPeriod,
  monthRange,
  toIso,
  toDateStr,
  classLabel,
} = require('../../services/mappers');
// The same payroll serialiser the Admin Panel uses, so an employee's own payroll
// read and the office's read cannot disagree about a month.
const { payrollShape, summarizePayments } = require('../../services/payroll');
const { openEmploymentEnd } = require('../../services/employment');
const { wrapAsync } = require('../../utils/asyncRoute');
const { summarizeAttendance, buildDayRecords } = require('../../utils/attendance');
const { buildPayslipPdf, payslipFilename } = require('../../services/payslip');
const { sendDocumentPdf, documentUpload, documentUploadError, checkOptionalPdf } = require('../../services/documents');
const {
  AnnouncementScope,
  AnnouncementError,
  teacherTargetedSchema,
  announcementListSelect,
  createAnnouncement,
  mapAnnouncementAdmin,
} = require('../../services/announcements');
const {
  bulkAttendanceSchema,
  loadAttendanceRoster,
  saveBulkAttendance,
  teacherClassGroups,
  teacherTeachesClass,
} = require('../../services/attendance');
const { getWeeklyOffDays } = require('../../services/settings');
const { canViewClass } = require('../../services/studentAccess');
// Marks rules shared with the admin panel — the timetable-derived teacher scope,
// the canonical subject spelling, the one atomic write path and the 48-hour
// teacher edit window.
const {
  teacherMarkAssignments,
  teacherMarkScope,
  findExamByName,
  saveMarkRows,
  marksEditWindow,
  MarksEditLockedError,
  MARKS_BULK_MAX_ROWS,
  MARKS_MAX,
  parseMarkDate,
  isHeaderRow,
} = require('../../services/marks');

const router = wrapAsync(express.Router());
router.use(authMiddleware);
// Same gate as the other business routers: no timetable, attendance, marks or
// payroll reads until an account still on its initial password changes it.
router.use(requirePasswordChange);

/* Shared include: employee + teaching assignments (with class + student counts) */
const EMPLOYEE_INCLUDE = {
  classesTaught: { include: { class: { include: { _count: { select: { students: true } } } } } },
  // So `mapEmployee`'s `employment` field is real on the employee-facing reads too
  // — a teacher who has been reactivated sees the same timeline an admin does.
  ...openEmploymentEnd,
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
  const records = buildDayRecords(rows, true);
  // The school's real weekly off days drive the working-day count (see
  // services/settings.js) — no hardcoded weekend.
  const weeklyOffDays = await getWeeklyOffDays();

  return sendSuccess(res, {
    employeeId: id, month, records, weeklyOffDays,
    summary: summarizeAttendance(records, weeklyOffDays),
  });
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

/**
 * The reason text, normalised for storage.
 *
 * A leave reason is multi-line free text: someone types it in a `<textarea>`, so
 * it routinely contains newlines and blank lines between paragraphs, and those
 * are the author's own formatting. Three rules, and only three:
 *
 *   1. `\r\n` and lone `\r` → `\n`. Browsers submit CRLF for a textarea typed on
 *      Windows; storing CRLF means the text round-trips to a different byte
 *      sequence than the client counted, and a `\r` is invisible junk if any
 *      client ever sends it. Normalising to LF is what the client counts.
 *   2. Leading/trailing whitespace trimmed — only at the ends. Indentation on an
 *      interior line and blank lines between paragraphs are preserved verbatim.
 *   3. NO interior newlines removed, collapsed or converted to spaces. This is
 *      the rule that was previously unstated and is the whole reason the display
 *      lost them.
 *
 * Note what is deliberately absent: no HTML escaping and no tag stripping. The
 * text is stored exactly as typed and rendered as text by React, which escapes
 * it at render time. Sanitising on the way *into* the database would corrupt an
 * honest reason that merely mentions an angle bracket (e.g. "5 < 10 marks") and
 * still would not be the security boundary — output encoding is. The guarantee
 * this gives is that the stored bytes are the author's bytes, and React renders
 * them as text in every surface (no `dangerouslySetInnerHTML` / `innerHTML`
 * anywhere in the app).
 */
const normalizeReason = (raw) => String(raw).replace(/\r\n?/g, '\n').trim();

/**
 * Apply leave schema.
 *
 * The `reason` bounds are checked on the NORMALISED text, not the raw input, and
 * that ordering is load-bearing: the client counts the same normalised value
 * (it trims and counts before it can reach this limit), so the two can never
 * disagree about whether a reason is too long. Validating the raw string instead
 * would count leading spaces the client has already discarded and reject a
 * reason the form still showed as within the limit.
 */
const applyLeaveSchema = z.object({
  type: z.enum(Object.values(LeaveType)),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  reason: z
    .string()
    .transform(normalizeReason)
    .refine((v) => v.length >= 5, { message: 'Reason must be at least 5 characters' })
    .refine((v) => v.length <= 500, { message: 'Reason cannot be longer than 500 characters' }),
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
      // Already normalised by the schema's transform (CRLF→LF, ends trimmed,
      // interior newlines kept) — stored exactly as the author typed it, so the
      // popup in either portal can re-render the line breaks verbatim.
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
 *
 * Carries the same derived payment summary the Admin Panel's payroll read does
 * (status, paid so far, remaining, and the individual payments), computed from
 * the same service, so an employee looking at a month half-paid sees the same
 * figures the office sees — not a "pending" that contradicts a transfer already
 * recorded against it.
 */
router.get('/:id/payroll', requireRole([ROLES.ADMIN, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const { month } = req.query;
  const records = await prisma.payrollRecord.findMany({
    where: { employeeId: id, ...(month ? { month } : {}) },
    include: { payments: { orderBy: { paidOn: 'desc' } } },
    orderBy: { month: 'asc' },
  });
  return sendSuccess(res, records.map((r) => payrollShape(r, r.payments)));
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
      include: { payments: true },
    }),
  ]);
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');
  if (!record) return sendError(res, `No payroll record for ${month}`, 404, 'NOT_FOUND');

  // The same derived summary the page shows, so a partially-paid month prints
  // "Part paid ₹X of ₹Y" instead of a flat "Payment pending".
  const pdf = await buildPayslipPdf(employee, record, summarizePayments(record, record.payments));
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
  // An employee's timetable is their own; only an admin may read anyone's.
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const employee = await prisma.employee.findUnique({ where: { id } });
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  const periods = await prisma.timetablePeriod.findMany({
    where: { teacherName: employee.name },
    // The level rides along so the label is the shared `classLabel`. The frontend
    // used to carve a name out of `classId` ('10A' → '10 A'), which a named level
    // (cls-NURSERYA) would have shown as "NURSERY A".
    include: { class: { include: { level: true } } },
    orderBy: [{ classId: 'asc' }, { period: 'asc' }],
  });

  return sendSuccess(res, periods.map((p) => ({
    ...mapPeriod(p),
    classKey: p.classId,
    classLabel: p.class ? classLabel(p.class) : null,
  })));
});

/**
 * GET /api/v1/employees/:id/assigned-classes
 */
router.get('/:id/assigned-classes', requireRole([ROLES.ADMIN, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;
  // Same rule as the timetable above: an employee's class list is their own.
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

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
    select: { id: true, type: true, fileName: true, uploadedAt: true },
    orderBy: { uploadedAt: 'desc' },
  });
  return sendSuccess(res, docs.map((d) => ({
    id: d.id,
    type: d.type,
    fileName: d.fileName,
    uploadedAt: toIso(d.uploadedAt),
  })));
});

/**
 * GET /api/v1/employees/:id/documents/:docId/download — serve the stored PDF
 * of one of THIS employee's document records. Same access rules as the list
 * above (the employee themself or admin), and the document must belong to the
 * :id in the path — another employee's doc id is a plain 404. Rows without
 * stored bytes (metadata-only legacy records) → 404 NO_FILE.
 */
router.get('/:id/documents/:docId/download', requireRole([ROLES.ADMIN, ...EMPLOYEE_ROLES]), async (req, res) => {
  const { id, docId } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const doc = await prisma.employeeDocument.findFirst({
    where: { id: docId, employeeId: id },
    select: { fileName: true, data: true },
  });
  if (!doc) return sendError(res, 'Document not found', 404, 'NOT_FOUND');
  if (!doc.data) return sendError(res, 'No stored file for this record (metadata-only)', 404, 'NO_FILE');

  return sendDocumentPdf(res, doc);
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

/** Guard: the class must be one this employee is assigned to teach.
 *
 * The class-visibility rule itself lives in services/studentAccess.js
 * (`canViewClass`) — the SAME rule every other class/student route uses — so
 * this is a thin adapter that keeps the teacher-only error wording. The
 * employee-id check is done by the caller (canAccessEmployee), because
 * `canViewClass` answers for the caller's role, not for a path id.
 */
const assertOwnClass = async (req, res, employeeId, classId) => {
  if (!classId) {
    sendError(res, 'classId is required', 400, 'VALIDATION_ERROR');
    return false;
  }
  const decision = await canViewClass(req.user, classId);
  if (!decision.allowed) {
    // An existing-but-unassigned class keeps the teacher-facing wording; a
    // missing class is a plain 404, exactly as the shared rule decides. Return
    // false (never the response object) so the caller stops.
    if (decision.reason === 'not_found') {
      sendError(res, 'Class not found', 404, 'NOT_FOUND');
      return false;
    }
    sendError(res, 'This class is not assigned to you', 403, 'FORBIDDEN');
    return false;
  }
  // Belt to the braces: canViewClass admits an admin for any class, but these
  // routes are teacher-only, so the path employee id must still be the caller.
  if (!canAccessEmployee(req, employeeId)) {
    sendError(res, 'Access denied', 403, 'FORBIDDEN');
    return false;
  }
  return true;
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
 * GET /api/v1/employees/:id/attendance/group?groupKey=...&date=YYYY-MM-DD&session=FN|AN
 * Roster + saved statuses + edit-window state for one of the teacher's classes
 * and one session of that day. `groupKey` is the same query name the admin
 * endpoint uses, so the shared MarkAttendance component drives both callers
 * unchanged; `classId` is still accepted as an alias.
 */
router.get('/:id/attendance/group', requireRole([...TEACHER_ROLES]), async (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const classId = String(req.query.groupKey || req.query.classId || '').trim();
  const date = String(req.query.date || '').trim();
  const session = String(req.query.session || '').trim();
  if (!(await assertOwnClass(req, res, id, classId))) return undefined;
  if (!ISO_DATE.test(date)) return sendError(res, 'date must be YYYY-MM-DD', 400, 'VALIDATION_ERROR');
  if (session !== 'FN' && session !== 'AN') return sendError(res, 'session must be "FN" or "AN"', 400, 'VALIDATION_ERROR');

  const roster = await loadAttendanceRoster('student', classId, date, session);
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

  const klass = await prisma.class.findUnique({ where: { id: classId }, include: { level: true } });
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

/* ---------- Push announcement (Employee Portal) ---------- */

/**
 * A teacher can push an announcement to their own students, with an optional
 * PDF, exactly like the admin's "Send To…" flow — but scoped to the classes
 * they actually teach.
 *
 * Scoping decision (the strict one, enforced here rather than in the UI):
 *   • "Select Class" is limited to this teacher's real teaching assignments.
 *     `resolveAudience` re-checks the assignment server-side, so naming a
 *     class they don't teach is a 403 even on a hand-crafted request.
 *   • "Employees" is NOT available to a teacher. The target schema below only
 *     accepts the CLASS scope on this route — there is no all-employees option
 *     in the employee's form, and a crafted `targetScope` is rejected by zod
 *     before any code runs.
 *   • The broad role-based Audience publish stays admin-only: a teacher cannot
 *     reach every student in the school, only their own classes.
 * The announcement is attributed to the employee (createdById + the name shown
 * on the portals), so students can see it came from their teacher.
 */

/** Turn a service-layer AnnouncementError into the right HTTP response. */
const sendAnnouncementError = (res, err) => {
  if (err instanceof AnnouncementError) {
    if (err.fieldErrors) return sendValidationError(res, err.fieldErrors);
    return sendError(res, err.message, err.status, err.code);
  }
  throw err;
};

/**
 * GET /api/v1/employees/:id/announcement/classes
 * The classes this teacher may target — the same real-assignment list the
 * attendance screens use, so the class picker is never a hardcoded list and
 * never offers a class the send would be rejected for.
 */
router.get('/:id/announcement/classes', requireRole([...TEACHER_ROLES]), async (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const employee = await prisma.employee.findUnique({ where: { id }, select: { id: true } });
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  return sendSuccess(res, await teacherClassGroups(id));
});

/**
 * GET /api/v1/employees/:id/announcements
 * Announcements this employee has pushed (newest first) — their own send
 * history. Scoped to the employee, so no teacher sees another teacher's sends.
 */
router.get('/:id/announcements', requireRole([...TEACHER_ROLES]), async (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const rows = await prisma.announcement.findMany({
    where: { createdById: id },
    select: announcementListSelect,
    orderBy: { createdAt: 'desc' },
  });
  return sendSuccess(res, rows.map(mapAnnouncementAdmin));
});

/**
 * POST /api/v1/employees/:id/announcements — push an announcement (multipart:
 * text fields + optional `file` PDF).
 *
 * The payload must name the CLASS scope; the all-employees scope is not in
 * `teacherTargetedSchema`, so it fails validation here rather than reaching a
 * permission check further in.
 */
router.post(
  '/:id/announcements',
  requireRole([...TEACHER_ROLES]),
  documentUpload.single('file'),
  documentUploadError,
  async (req, res) => {
    const { id } = req.params;
    if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

    const employee = await prisma.employee.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

    const parsed = teacherTargetedSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

    const pdf = checkOptionalPdf(req);
    if (pdf === 'invalid') return sendError(res, 'Only PDF files are allowed', 400, 'BAD_REQUEST');

    try {
      const { row, studentCount, classLabel } = await createAnnouncement(parsed.data, {
        scope: AnnouncementScope.CLASS,
        file: pdf === 'ok' ? req.file : null,
        sender: { role: req.user.role, employeeId: employee.id, name: employee.name },
      });
      return sendSuccess(
        res,
        { ...mapAnnouncementAdmin(row), reached: studentCount },
        `Announcement sent to ${studentCount} students in ${classLabel}`,
        201
      );
    } catch (err) {
      return sendAnnouncementError(res, err);
    }
  }
);

module.exports = router;

/* ---------- Marks Entry (Employee Portal) ---------- */

/**
 * The teacher half of the marks flow: the same Exam / MarksEntry records the
 * admin panel's Marks Entry writes (both go through `services/marks.js`), scoped
 * to the (class, subject) pairs the requesting teacher actually holds in the
 * TIMETABLE.
 *
 * The scoping is enforced here, on every route, rather than hidden in the UI: a
 * request naming a class or subject the teacher does not teach is rejected with
 * 403 even when posted straight to the API. There is no permissions table — the
 * permitted pairs are re-derived from `TimetablePeriod` on each call, so an admin
 * editing the timetable changes the teacher's access in the same request.
 */

/**
 * Template columns for the teacher's upload. Deliberately carries NO Class,
 * Section or Subject column: the page has already fixed both, and a file able to
 * contradict the page is a file able to file marks against the wrong class or
 * another teacher's subject.
 */
const TEACHER_MARKS_BULK_COLUMNS = [
  'RollNumber', 'StudentName', 'ExamName', 'ExamDate', 'MaxMarks', 'ObtainedMarks',
];

/**
 * Format placeholder row shipped in the template. Contains no student data: the
 * angle-bracket tokens cannot match a student, so uploading the untouched
 * template is rejected row-by-row instead of writing invented results.
 */
const TEACHER_MARKS_PLACEHOLDER_ROW = [
  '<RollNumber>', '<StudentName>', '<ExamName>', '<ExamDate>', '<MaxMarks>', '<ObtainedMarks>',
];

/** In-memory upload, no temp files to clean up. 5 MB cap, same as the admin's. */
const teacherMarksUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const teacherMarksSchema = z.object({
  classId: z.string().min(1),
  subject: z.string().trim().min(1).max(100),
  examName: z.string().trim().min(2).max(100),
  date: z.string().regex(ISO_DATE, 'Exam date must be YYYY-MM-DD').optional(),
  maxMarks: z.number().int().min(1).max(MARKS_MAX),
  entries: z.array(z.object({
    studentId: z.string().min(1),
    obtained: z.number().int().min(0).max(MARKS_MAX),
  })).min(1),
});

/** 'YYYY-MM-DD' → UTC-midnight Date, matching the @db.Date columns. */
const apiDate = (value) => (value ? new Date(`${value}T00:00:00.000Z`) : new Date());

/**
 * The one gate every teacher marks route passes through: the caller may only act
 * on their own employee record, and only for a (class, subject) pair that is in
 * that employee's live timetable. Returns the resolved scope — whose `canonical`
 * is the TIMETABLE's spelling of the subject and MUST be the string stored — or
 * null after having already written the error response.
 */
const assertMarkScope = async (req, res, employeeId, classId, subject) => {
  if (!canAccessEmployee(req, employeeId)) {
    sendError(res, 'Access denied', 403, 'FORBIDDEN');
    return null;
  }
  const scope = await teacherMarkScope(employeeId, classId, subject);
  if (!scope.ok) {
    sendError(res, scope.message, scope.status, scope.code);
    return null;
  }
  return scope;
};

/**
 * Answer a save that the 48-hour teacher edit window refused.
 *
 * The window is enforced inside the shared write path (services/marks.js), so
 * this is the only place its refusal becomes an HTTP response — and it reuses
 * the same 403 / EDIT_LOCKED envelope the 1-hour attendance window already
 * speaks, so a client handles one "too late" shape for the whole app. Returns
 * false when the error is something else, so the caller can hand it on.
 */
const sendMarksLockError = (res, err) => {
  if (!(err instanceof MarksEditLockedError)) return false;
  sendError(res, err.message, err.status, err.code);
  return true;
};

/**
 * GET /api/v1/employees/:id/marks/assignments
 * The (class, subject) pairs this employee may enter marks for, derived live
 * from the timetable — the "Your teaching assignments" panel, and the source of
 * both the class and subject dropdowns.
 *
 * Open to ALL employee roles on purpose: non-teaching staff (an accountant, a
 * librarian) have no timetable periods, so this returns an empty list and the
 * page shows an empty state rather than an error. A 403 here would render a
 * teacher whose timetable has not been built yet as a broken page. The WRITE
 * routes below are the strict ones — gated on TEACHER_ROLES as well as on the
 * timetable.
 */
router.get('/:id/marks/assignments', requireRole([...EMPLOYEE_ROLES]), async (req, res) => {
  const { id } = req.params;
  if (!canAccessEmployee(req, id)) return sendError(res, 'Access denied', 403, 'FORBIDDEN');

  const employee = await prisma.employee.findUnique({ where: { id }, select: { id: true } });
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  return sendSuccess(res, await teacherMarkAssignments(id));
});

/**
 * GET /api/v1/employees/:id/marks?classId=&subject=[&examName=]
 * Everything the Marks Entry grid needs, in one response:
 *
 *   - `roster`  — the selected class's students, with their existing marks for
 *                 this subject when `examName` resolves to a saved exam. Pass an
 *                 exam name to load a saved result in for correction; omit it for
 *                 a fresh exam and every `obtained` comes back null.
 *   - `exams`   — every exam of this class that already has marks for THIS
 *                 subject, newest first, with its own count / average / top. This
 *                 is the "already saved" list under the grid and the exam picker.
 *   - `subject` — the TIMETABLE's spelling, which is what a save will store.
 *
 * Every saved exam also carries its 48-hour edit window: `teacherSavedAt` (the
 * batch's real last teacher save, ISO) plus the `locked` / `editableUntil` /
 * `windowMs` derived from it and the server's clock. The client is given the
 * timestamp and recomputes the remaining time against its own clock, so a
 * countdown keeps ticking correctly across a reload rather than resetting —
 * `locked` is here so the very first paint is right, not so the UI can trust it
 * for the life of the page.
 */
router.get('/:id/marks', requireRole([...TEACHER_ROLES]), async (req, res) => {
  const { id } = req.params;
  const classId = String(req.query.classId || '').trim();
  const subject = String(req.query.subject || '').trim();
  const scope = await assertMarkScope(req, res, id, classId, subject);
  if (!scope) return undefined;

  const klass = await prisma.class.findUnique({
    where: { id: classId },
    include: { _count: { select: { students: true } } },
  });
  if (!klass) return sendError(res, 'Class not found', 404, 'NOT_FOUND');

  // Resolve the requested exam by name, case-insensitively: Exam's unique key is
  // (classId, name) and that comparison is case-SENSITIVE, so an exact match
  // would silently miss a re-typed name. See findExamByName in services/marks.js.
  const examName = String(req.query.examName || '').trim();
  const examRef = examName ? await findExamByName(classId, examName) : null;
  const exam = examRef
    ? await prisma.exam.findUnique({ where: { id: examRef.id } })
    : null;

  const [students, savedRows, examRows] = await Promise.all([
    prisma.student.findMany({
      where: { classId },
      select: { id: true, name: true, rollNumber: true },
      orderBy: { rollNumber: 'asc' },
    }),
    exam
      ? prisma.marksEntry.findMany({ where: { examId: exam.id, subject: scope.canonical } })
      : Promise.resolve([]),
    prisma.marksEntry.findMany({
      where: { subject: scope.canonical, exam: { classId } },
      include: { exam: true },
    }),
  ]);

  const byStudent = new Map(savedRows.map((r) => [r.studentId, r]));

  // Collapse this subject's rows into one summary per exam. Every read is scoped
  // to the canonical subject, so a teacher's list can never surface another
  // subject's marks even if the database holds a differently-spelled duplicate.
  // `teacherSavedAt` is folded as a MAX, not taken from whichever row came last:
  // the window is per BATCH, so correcting one student must refresh the whole
  // class's clock and the batch must still lock as one unit.
  const byExam = new Map();
  examRows.forEach((r) => {
    if (!byExam.has(r.examId)) {
      byExam.set(r.examId, { exam: r.exam, obtained: [], enteredBy: null, updatedBy: null, teacherSavedAt: null });
    }
    const group = byExam.get(r.examId);
    group.obtained.push(r.obtained);
    if (!group.enteredBy && r.enteredBy) group.enteredBy = r.enteredBy;
    if (r.updatedBy) group.updatedBy = r.updatedBy;
    if (r.teacherSavedAt && (!group.teacherSavedAt || r.teacherSavedAt > group.teacherSavedAt)) {
      group.teacherSavedAt = r.teacherSavedAt;
    }
  });

  const now = Date.now();
  const exams = [...byExam.values()]
    .map(({ exam: e, obtained, enteredBy, updatedBy, teacherSavedAt }) => ({
      examId: e.id,
      examName: e.name,
      date: toDateStr(e.date),
      saved: obtained.length,
      average: obtained.length
        ? Math.round((obtained.reduce((sum, n) => sum + n, 0) / obtained.length) * 10) / 10
        : null,
      top: obtained.length ? Math.max(...obtained) : null,
      enteredBy,
      updatedBy,
      // This batch's real edit window: the anchor, and the state derived from it.
      ...marksEditWindow(teacherSavedAt, now),
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return sendSuccess(res, {
    classId,
    classLabel: classLabel(klass),
    grade: String(klass.grade),
    section: klass.section,
    studentCount: klass._count.students ?? 0,
    subject: scope.canonical,
    exam: exam
      ? {
        examId: exam.id,
        examName: exam.name,
        date: toDateStr(exam.date),
        maxMarks: savedRows.length ? savedRows[0].maxMarks : null,
        // Same window, for the batch currently open in the grid — this is what
        // decides whether its inputs are editable or locked.
        ...marksEditWindow(
          savedRows.reduce(
            (latest, r) => (r.teacherSavedAt && (!latest || r.teacherSavedAt > latest) ? r.teacherSavedAt : latest),
            null,
          ),
          now,
        ),
      }
      : null,
    roster: students.map((s) => {
      const row = byStudent.get(s.id);
      return {
        studentId: s.id,
        name: s.name,
        rollNumber: s.rollNumber,
        obtained: row ? row.obtained : null,
        maxMarks: row ? row.maxMarks : null,
        enteredBy: row ? row.enteredBy : null,
        updatedBy: row ? row.updatedBy : null,
      };
    }),
    exams,
  });
});

/**
 * POST /api/v1/employees/:id/marks — save the whole class's marks for one
 * subject and exam, in ONE atomic request.
 *
 * "If any row is invalid, nothing is saved" is enforced before the transaction
 * even opens: every entry is checked and the whole request rejected. Rows the
 * teacher simply left blank are not sent, and are never saved as zero — an
 * absent student is not a student who scored zero, and writing 0 would record a
 * mark nobody entered.
 *
 * Entries are validated against the SERVER's roster, not the client's: a
 * hand-rolled request naming a student from another class is rejected instead of
 * filing their marks against this exam.
 *
 * `writer: 'teacher'` is what puts this route under the 48-hour edit window: the
 * save stamps the batch's teacher clock, and a batch whose window has closed is
 * refused with 403 EDIT_LOCKED before anything is written. The check lives in the
 * shared write path, so it holds for a request built by hand as well as for the
 * page — the disabled inputs are a courtesy, not the control.
 */
router.post('/:id/marks', requireRole([...TEACHER_ROLES]), async (req, res, next) => {
  const { id } = req.params;
  const parsed = teacherMarksSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const { classId, subject } = parsed.data;
  const scope = await assertMarkScope(req, res, id, classId, subject);
  if (!scope) return undefined;

  const klass = await prisma.class.findUnique({ where: { id: classId }, include: { level: true } });
  if (!klass) return sendError(res, 'Class not found', 404, 'NOT_FOUND');
  const label = classLabel(klass);

  const roster = await prisma.student.findMany({
    where: { classId },
    select: { id: true },
  });
  const classStudentIds = new Set(roster.map((s) => s.id));

  const errors = {};
  const clean = [];
  const seenStudents = new Set();
  parsed.data.entries.forEach((entry, i) => {
    const key = `entry_${i + 1}`;
    if (!classStudentIds.has(entry.studentId)) {
      errors[key] = { studentId: 'This student is not in the selected class' };
      return;
    }
    if (seenStudents.has(entry.studentId)) {
      errors[key] = { studentId: 'This student appears more than once' };
      return;
    }
    seenStudents.add(entry.studentId);
    if (entry.obtained > parsed.data.maxMarks) {
      errors[key] = { obtained: `Cannot exceed Max Marks (${parsed.data.maxMarks})` };
      return;
    }
    clean.push({ studentId: entry.studentId, obtained: entry.obtained });
  });

  if (Object.keys(errors).length) {
    const failed = Object.keys(errors).length;
    return sendValidationError(res, {
      ...errors,
      entries: `Nothing was saved — ${failed} row${failed === 1 ? '' : 's'} failed validation`,
    });
  }

  const examDate = apiDate(parsed.data.date);
  let result;
  try {
    result = await saveMarkRows(
      clean.map((e) => ({
        studentId: e.studentId,
        classId,
        examName: parsed.data.examName,
        examDate,
        // The TIMETABLE's spelling, not the request's — this is what makes the
        // saved row's subject identical to the pair that was permission-checked.
        subject: scope.canonical,
        maxMarks: parsed.data.maxMarks,
        obtained: e.obtained,
      })),
      { enteredBy: req.user?.username || null, writer: 'teacher' },
    );
  } catch (err) {
    if (sendMarksLockError(res, err)) return undefined;
    return next(err);
  }

  return sendSuccess(res, {
    saved: result.saved,
    students: result.students,
    classId,
    classLabel: label,
    subject: scope.canonical,
    examName: parsed.data.examName,
    date: toDateStr(examDate),
    maxMarks: parsed.data.maxMarks,
    notEntered: roster.length - result.saved,
    // The instant the rows were stamped, and the window it opens — so the
    // confirmation counts down from the real save time, not from receipt.
    ...marksEditWindow(result.savedAt, Date.now()),
  }, `Saved ${result.saved} ${scope.canonical} mark${result.saved === 1 ? '' : 's'} for ${label}`, 201);
});

/**
 * GET /api/v1/employees/:id/marks/bulk-template?format=xlsx|csv
 * The upload template, built with the same ExcelJS version that parses uploads
 * so the downloaded file always matches what the importer accepts.
 *
 * `format=csv` (default `xlsx`) returns a plain header + placeholder row, for
 * staff without Excel. Both are scoped to the class and subject in the query: the
 * template names that pair up front, so a teacher can see at a glance which
 * marks it belongs to.
 */
router.get('/:id/marks/bulk-template', requireRole([...TEACHER_ROLES]), async (req, res) => {
  const { id } = req.params;
  const classId = String(req.query.classId || '').trim();
  const subject = String(req.query.subject || '').trim();
  const scope = await assertMarkScope(req, res, id, classId, subject);
  if (!scope) return undefined;

  const klass = await prisma.class.findUnique({ where: { id: classId }, include: { level: true } });
  if (!klass) return sendError(res, 'Class not found', 404, 'NOT_FOUND');
  const label = classLabel(klass);

  /* ---------- CSV: header + placeholder row (CSV has no sheets to hold notes) ---------- */
  if (String(req.query.format || '').toLowerCase() === 'csv') {
    const lines = [
      TEACHER_MARKS_BULK_COLUMNS.join(','),
      TEACHER_MARKS_PLACEHOLDER_ROW.join(','),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="marks_upload_template.csv"');
    return res.end(`\uFEFF${lines.join('\r\n')}\r\n`); // BOM, so Excel opens UTF-8 correctly
  }

  /* ---------- XLSX: a 'Marks' data sheet + an 'Instructions' sheet ---------- */
  const book = new ExcelJS.Workbook();
  book.creator = 'School ERP';

  const sheet = book.addWorksheet('Marks');
  sheet.addRow(TEACHER_MARKS_BULK_COLUMNS);
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFE7D6' } };
  const placeholder = sheet.addRow(TEACHER_MARKS_PLACEHOLDER_ROW);
  placeholder.font = { italic: true, color: { argb: 'FF808080' } };
  sheet.columns.forEach((c) => { c.width = 16; });

  const notes = book.addWorksheet('Instructions');
  notes.addRow(['How to use this template']);
  notes.getRow(1).font = { bold: true, size: 13 };
  [
    '',
    `This template is for ONE class and ONE subject: ${label} · ${scope.canonical}.`,
    "1. Go to the 'Marks' tab. Row 2 is a FORMAT PLACEHOLDER — replace every <...> value with real data (keep the header row).",
    '2. Use ONE ROW PER STUDENT — not one row per class.',
    '3. There are NO Class or Subject columns. Both come from the Marks Entry page, so every row in this file is saved for that class and that subject. The subject is stored exactly as the timetable spells it.',
    `4. Students are matched by RollNumber, so it must match a student already in ${label}. A roll number from another class is rejected and nothing is saved.`,
    '5. Save as .xlsx or .csv, then upload it with "Bulk Upload" on the Marks Entry page.',
    '',
    'Column reference',
  ].forEach((line) => notes.addRow([line]));
  [
    ['RollNumber', `Required. Must belong to ${label}.`],
    ['StudentName', 'Required, for readability/cross-check only — the system matches on RollNumber.'],
    ['ExamName', 'Required. e.g. Unit Test 2.'],
    ['ExamDate', 'Required. Format dd-mm-yyyy (Excel date cells also work).'],
    ['MaxMarks', 'Required. Whole number, must be at least 1.'],
    ['ObtainedMarks', 'Required. Whole number, must be <= MaxMarks.'],
  ].forEach(([column, description]) => notes.addRow([column, description]));
  notes.addRow([]);
  [
    `- Up to ${MARKS_BULK_MAX_ROWS} rows per file.`,
    '- Rows are validated together: if any row is invalid nothing is saved (atomic upload).',
    '- Re-uploading the same exam corrects the existing marks instead of adding a second copy.',
    '- These marks are recorded under your own name and are visible to the admin in Marks Entry.',
  ].forEach((line) => notes.addRow([line]));
  notes.getColumn(1).width = 18;
  notes.getColumn(2).width = 80;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="marks_upload_template.xlsx"');
  await book.xlsx.write(res);
  return res.end();
});

/**
 * POST /api/v1/employees/:id/marks/bulk — bulk upload for the class and subject
 * the page has already fixed, which travel in the query/body. Same long-format
 * rules as the admin's own bulk marks upload (same column checks, same row
 * validation, same atomic persist) minus the Class/Subject columns.
 *
 * Every row is validated before a single write, so one bad row rejects the whole
 * file and the response names the failing row(s) and column(s). Scoped twice
 * over: the (class, subject) must be in the teacher's timetable, and only that
 * class's students are loaded, so a roll number belonging to any other class is
 * rejected rather than silently filed against this exam.
 *
 * The upload is subject to the SAME 48-hour edit window as the grid's Save
 * button, because it is the same write: a file naming an exam whose window has
 * closed is refused whole (403 EDIT_LOCKED, naming the exam), matching the
 * "nothing is saved" contract this route already has. A file naming a fresh exam
 * is unaffected — the window is per batch, not per page.
 */
router.post(
  '/:id/marks/bulk',
  requireRole([...TEACHER_ROLES]),
  teacherMarksUpload.single('file'),
  async (req, res, next) => {
    const { id } = req.params;
    if (!req.file) {
      return sendError(res, 'No file uploaded — attach a .csv or .xlsx file', 400, 'BAD_REQUEST');
    }

    const originalName = String(req.file.originalname || '').toLowerCase();
    if (!originalName.endsWith('.csv') && !originalName.endsWith('.xlsx')) {
      return sendError(res, 'Unsupported file type — upload a .csv or .xlsx file', 400, 'BAD_REQUEST');
    }

    const classId = String(req.body?.classId ?? req.query?.classId ?? '').trim();
    const subject = String(req.body?.subject ?? req.query?.subject ?? '').trim();
    if (!classId || !subject) {
      return sendValidationError(res, {
        ...(classId ? {} : { classId: 'Choose a class on the Marks Entry page before uploading' }),
        ...(subject ? {} : { subject: 'Choose a subject on the Marks Entry page before uploading' }),
      });
    }

    const scope = await assertMarkScope(req, res, id, classId, subject);
    if (!scope) return undefined;

    const klass = await prisma.class.findUnique({ where: { id: classId }, include: { level: true } });
    if (!klass) return sendError(res, 'Class not found', 404, 'NOT_FOUND');
    const label = classLabel(klass);

    /* ---------- 1. Parse the file server-side (no manual string splitting) ---------- */
    let records;
    try {
      if (originalName.endsWith('.csv')) {
        records = parseCsv(req.file.buffer, {
          bom: true,
          trim: true,
          skip_empty_lines: true,
          relax_column_count: true, // ragged rows come through so we can report them per-row
        });
      } else {
        const book = new ExcelJS.Workbook();
        await book.xlsx.load(req.file.buffer);
        if (!book.worksheets.length) return sendError(res, 'The workbook has no sheets', 400, 'BAD_REQUEST');

        // Template files carry an extra 'Instructions' sheet, so prefer the sheet
        // whose first row matches the required header; fall back to the first one.
        const hasMarksHeader = (ws) => {
          const cells = [];
          ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => { cells[col - 1] = String(cell.text ?? '').trim(); });
          return isHeaderRow(cells, TEACHER_MARKS_BULK_COLUMNS);
        };
        const sheet = book.worksheets.find(hasMarksHeader) || book.worksheets[0];

        records = [];
        sheet.eachRow((row) => {
          const cells = [];
          row.eachCell({ includeEmpty: true }, (cell, col) => {
            // Keep real Date instances (date-formatted cells) so they parse correctly
            const value = cell.value;
            cells[col - 1] = value instanceof Date ? value : (cell.text ?? '');
          });
          records.push(cells);
        });
      }
    } catch (err) {
      return sendError(res, `Could not parse the file: ${err.message}`, 400, 'BAD_REQUEST');
    }

    /* ---------- 2. Header row: required, exact column order ---------- */
    const header = (records[0] || []).map((h) => String(h ?? '').trim());
    if (!isHeaderRow(header, TEACHER_MARKS_BULK_COLUMNS)) {
      return sendValidationError(res, {
        file: `Header row must be exactly: ${TEACHER_MARKS_BULK_COLUMNS.join(', ')}`,
      });
    }

    const dataRows = records.slice(1);
    if (dataRows.length === 0) {
      return sendValidationError(res, { file: 'The file has no data rows' });
    }
    if (dataRows.length > MARKS_BULK_MAX_ROWS) {
      return sendValidationError(res, {
        file: `Up to ${MARKS_BULK_MAX_ROWS} rows per file — this file has ${dataRows.length}`,
      });
    }

    /* ---------- 3. Validate every row (nothing is written yet) ---------- */
    const students = await prisma.student.findMany({
      where: { classId },
      select: { id: true, name: true, rollNumber: true },
    });
    // Roll numbers are unique within a class (@@unique([classId, rollNumber])),
    // so inside this class the roll number alone identifies the student.
    const byRoll = new Map();
    students.forEach((s) => {
      const key = String(s.rollNumber ?? '').trim().toLowerCase();
      if (key) byRoll.set(key, s);
    });

    const errors = {};
    const entries = [];
    const seen = new Set(); // duplicate student+exam guard for this file

    dataRows.forEach((cells, i) => {
      const rowNum = i + 2; // header is row 1
      const rowErrors = {};

      if (cells.length !== TEACHER_MARKS_BULK_COLUMNS.length) {
        errors[`row_${rowNum}`] = {
          columns: `Expected ${TEACHER_MARKS_BULK_COLUMNS.length} columns, got ${cells.length}`,
        };
        return;
      }

      const raw = {};
      TEACHER_MARKS_BULK_COLUMNS.forEach((column, idx) => { raw[column] = cells[idx]; });
      const text = (column) => String(raw[column] ?? '').trim();

      // Every field must be present in every row
      TEACHER_MARKS_BULK_COLUMNS.forEach((column) => {
        if (raw[column] === undefined || raw[column] === null || text(column) === '') {
          rowErrors[column] = 'Required';
        }
      });

      // Marks numeric / whole / in range, and ObtainedMarks <= MaxMarks
      const maxMarks = Number(text('MaxMarks'));
      const obtained = Number(text('ObtainedMarks'));
      if (!rowErrors.MaxMarks && (!Number.isInteger(maxMarks) || maxMarks < 1)) {
        rowErrors.MaxMarks = 'Must be a whole number of at least 1';
      }
      if (!rowErrors.ObtainedMarks && (!Number.isInteger(obtained) || obtained < 0)) {
        rowErrors.ObtainedMarks = 'Must be a whole number of 0 or more';
      }
      if (!rowErrors.MaxMarks && !rowErrors.ObtainedMarks && obtained > maxMarks) {
        rowErrors.ObtainedMarks = `Cannot exceed MaxMarks (${maxMarks})`;
      }

      // ExamDate parses as a real calendar date
      const examDate = parseMarkDate(raw.ExamDate);
      if (!rowErrors.ExamDate && !examDate) {
        rowErrors.ExamDate = 'Must be a valid date (dd-mm-yyyy)';
      }

      // Match the student by roll number — scoped to this class. A roll number
      // that exists only in some OTHER class is rejected right here.
      const student = byRoll.get(text('RollNumber').toLowerCase()) || null;
      if (!student) {
        rowErrors.RollNumber = `No student with this roll number in ${label}`;
      }

      // One row per student per exam — duplicates are ambiguous
      if (student) {
        const key = `${student.id}::${text('ExamName').toLowerCase()}`;
        if (seen.has(key)) {
          rowErrors.ExamName = 'Duplicate row — this student/exam appears more than once';
        } else {
          seen.add(key);
        }
      }

      if (Object.keys(rowErrors).length) {
        errors[`row_${rowNum}`] = rowErrors;
        return;
      }

      entries.push({
        studentId: student.id,
        classId,
        studentName: student.name,
        rollNumber: student.rollNumber,
        examName: text('ExamName'),
        examDate,
        // The TIMETABLE's spelling, resolved once by the scope gate above.
        subject: scope.canonical,
        maxMarks,
        obtained,
      });
    });

    if (Object.keys(errors).length) {
      const failed = Object.keys(errors).length;
      return sendValidationError(res, {
        ...errors,
        file: `Nothing was saved — ${failed} row${failed === 1 ? '' : 's'} failed validation`,
      });
    }

    /* ---------- 4. Persist atomically (one transaction — all or nothing) ---------- */
    let result;
    try {
      result = await saveMarkRows(entries, { enteredBy: req.user?.username || null, writer: 'teacher' });
    } catch (err) {
      if (sendMarksLockError(res, err)) return undefined;
      return next(err);
    }

    return sendSuccess(res, {
      saved: result.saved,
      students: result.students,
      exams: result.exams,
      classId,
      classLabel: label,
      subject: scope.canonical,
      // The batch clock the upload just stamped, so the page's countdown is
      // anchored to the real save instant.
      savedAt: result.savedAt,
      rows: entries.map((e) => ({
        studentId: e.studentId,
        studentName: e.studentName,
        rollNumber: e.rollNumber,
        examName: e.examName,
        examDate: toDateStr(e.examDate),
        subject: e.subject,
        maxMarks: e.maxMarks,
        obtained: e.obtained,
      })),
    }, `Saved ${result.saved} ${scope.canonical} mark${result.saved === 1 ? '' : 's'} for ${label}`, 201);
  }
);
