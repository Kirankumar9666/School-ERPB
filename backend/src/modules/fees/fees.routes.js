/**
 * Fees — reading the fee ledger, setting the current year's amount, and
 * recording payments.
 *
 * ## Why its own module, and why not under /admin
 *
 * The rest of the admin router is `requireRole([ROLES.ADMIN])`. Fees are the one
 * area the office shares with the accountant, so this router is mounted on its own
 * path with its own gate (`ADMIN` + `ACCOUNTANT`). Putting a second role inside
 * the admin router would mean either loosening that router's single gate or
 * carving a hole in it; a separate module keeps the admin gate exactly as strict
 * as it was.
 *
 * ## Every figure here is derived
 *
 * `current` / `previous` / `totalDue` all come from services/fees.js, which reads
 * the per-year `StudentFee` rows and their payments. Nothing is cached in the
 * response layer, so the dashboard, the class cards, the profile and this page
 * cannot disagree about what a student owes.
 *
 * @module modules/fees/fees.routes
 */
const express = require('express');
const { z } = require('zod');
const authMiddleware = require('../../middleware/auth.middleware');
const requirePasswordChange = require('../../middleware/passwordGate.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { ROLES } = require('../../constants/roles');
const { sendSuccess, sendError, sendValidationError } = require('../../utils/response');
const prisma = require('../../services/prisma');
const fees = require('../../services/fees');
const { classLabel } = require('../../services/mappers');
const { wrapAsync } = require('../../utils/asyncRoute');
const { requireStudentAccess, requireClassAccess } = require('../../services/studentAccess');

const router = wrapAsync(express.Router());
router.use(authMiddleware);
router.use(requirePasswordChange);
// Money is the office's and the accountant's business — nobody else's.
router.use(requireRole([ROLES.ADMIN, ROLES.ACCOUNTANT]));

/**
 * Every student-id and class-id route below goes through the ONE access rule
 * (`services/studentAccess.js`) before touching data. This router is already
 * role-gated to admin + accountant - both of whom the rule admits for the fee
 * desk - so the guard's job here is not to change who gets in but to make the
 * money surface obey the SAME rule as the rest of the API. If a role is ever
 * added to this router, or the rule changes for the accountant, the money
 * routes follow automatically instead of quietly becoming a hole.
 */
const guardStudent = (req, res) => requireStudentAccess(req, res, req.params.studentId, { intent: 'basic' });
const guardClass = (req, res) => requireClassAccess(req, res, req.params.classId);

/** Fee service error code → HTTP status + optional message. */
const FEE_ERRORS = {
  NO_CURRENT_YEAR: [500, 'The school has no academic year covering today.'],
  NOT_FOUND: [404, null],
  INVALID_AMOUNT: [400, null],
  INVALID_TARGET: [400, null],
  AMOUNT_EXCEEDS_ROW: [409, null],
  INVALID_DATE: [400, null],
  AMOUNT_EXCEEDS_DUES: [409, null],
  NO_DUES: [409, null],
};

const feeError = (res, err) => {
  const entry = FEE_ERRORS[err?.code];
  if (!entry) return null;
  const [status, message] = entry;
  // A 400 that names a field is a form error: it belongs beside the input it is
  // about, which is why the message travels inside a validation payload.
  if (status === 400 && err.field) {
    return sendValidationError(res, { [err.field]: message || err.message });
  }
  // A 409 is a rule, not a field: more than is owed, or nothing owed at all.
  if (status === 409) {
    return sendError(res, message || err.message, status, err.code);
  }
  return sendError(res, message || err.message, status, err.code);
};

/**
 * GET /api/v1/fees/dues
 *
 * The Fee Dues page. One row per student with their current-year fee, each
 * previous year that still carries a balance, and the total. `?filter=not_set`
 * finds students whose current fee has not been entered; `?filter=dues` narrows
 * to students who owe something; `?classId=` and `?q=` narrow further.
 */
router.get('/dues', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const filter = String(req.query.filter || '');
  const classId = req.query.classId ? String(req.query.classId) : null;

  const students = await prisma.student.findMany({
    where: classId ? { classId } : undefined,
    select: {
      id: true,
      name: true,
      rollNumber: true,
      parentName: true,
      guardianContact: true,
      classId: true,
      class: { select: { grade: true, section: true, level: { select: { name: true, order: true } } } },
    },
    orderBy: [{ name: 'asc' }],
  });

  const summaries = await fees.feeSummariesFor(prisma, students.map((s) => s.id));

  let rows = students.map((s) => {
    const summary = summaries.get(s.id) || fees.emptySummary(s.id);
    return {
      studentId: s.id,
      name: s.name,
      rollNumber: s.rollNumber,
      parentName: s.parentName,
      guardianContact: s.guardianContact,
      classId: s.classId,
      classLabel: s.class ? classLabel(s.class) : null,
      current: summary.current,
      previous: summary.previous,
      currentDues: summary.current && summary.current.balance != null ? summary.current.balance : 0,
      previousDues: summary.previousDues,
      totalDue: summary.totalDue,
      feeSet: Boolean(summary.current && summary.current.isSet),
    };
  });

  if (q) {
    rows = rows.filter((r) => [r.name, r.rollNumber, r.classLabel, r.guardianContact]
      .some((v) => String(v ?? '').toLowerCase().includes(q)));
  }
  if (filter === 'not_set') rows = rows.filter((r) => !r.feeSet);
  else if (filter === 'dues') rows = rows.filter((r) => r.totalDue > 0);

  const totals = rows.reduce((acc, r) => ({
    currentDues: acc.currentDues + r.currentDues,
    previousDues: acc.previousDues + r.previousDues,
    totalDue: acc.totalDue + r.totalDue,
    notSetCount: acc.notSetCount + (r.feeSet ? 0 : 1),
  }), {
    currentDues: 0, previousDues: 0, totalDue: 0, notSetCount: 0,
  });

  return sendSuccess(res, { students: rows, totals });
});

/** GET /api/v1/fees/students/:studentId — one student's fee picture and history. */
router.get('/students/:studentId', async (req, res) => {
  if (!(await guardStudent(req, res))) return undefined;
  const student = await prisma.student.findUnique({
    where: { id: req.params.studentId },
    select: {
      id: true,
      name: true,
      rollNumber: true,
      class: { select: { grade: true, section: true, level: { select: { name: true, order: true } } } },
    },
  });
  if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  const [summary, ledger] = await Promise.all([
    fees.feeSummaryFor(prisma, student.id),
    fees.feeLedgerFor(prisma, student.id),
  ]);

  return sendSuccess(res, {
    student: {
      id: student.id,
      name: student.name,
      rollNumber: student.rollNumber,
      classLabel: student.class ? classLabel(student.class) : null,
    },
    summary,
    // `rows` IS the history: every fee year with its payments, oldest first.
    rows: ledger.rows,
    currentAcademicYearId: ledger.currentAcademicYearId,
    outstanding: ledger.outstanding,
  });
});

/**
 * PUT /api/v1/fees/students/:studentId/amount
 *
 * Set the CURRENT year's fee. A null (or blank) amount clears it back to
 * "Not set" — the required distinction between "we decided it is zero" and "we
 * have not decided yet".
 */
const amountSchema = z.object({
  amount: z.union([z.number(), z.string(), z.null()]),
});

router.put('/students/:studentId/amount', async (req, res) => {
  if (!(await guardStudent(req, res))) return undefined;
  const parsed = amountSchema.safeParse(req.body || {});
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const raw = parsed.data.amount;
  const cleared = raw === null || raw === '';
  const amount = cleared ? null : fees.toAmount(raw);
  if (!cleared && amount === null) {
    return sendValidationError(res, { amount: 'Enter a non-negative amount' });
  }

  try {
    const { academicYear } = await fees.setCurrentFee(prisma, {
      studentId: req.params.studentId,
      amount,
    });
    const summary = await fees.feeSummaryFor(prisma, req.params.studentId);
    return sendSuccess(
      res,
      summary,
      cleared
        ? `Fee for ${academicYear.label} cleared to "not set"`
        : `Fee set to ₹${amount} for ${academicYear.label}`,
    );
  } catch (err) {
    return feeError(res, err) || sendError(res, 'Could not set the fee', 500, 'FEE_SET_FAILED');
  }
});

/**
 * POST /api/v1/fees/students/:studentId/allocate
 *
 * Where a payment WOULD go, computed by the very same `allocatePayment` call that
 * writes it. The Record-payment modal calls this as the admin types, so the
 * preview it shows is the allocation the save will produce — there is no second
 * copy of the rule on the client to fall out of step.
 *
 * `feeId` names a year explicitly ("this is for last year's fee"), which overrides
 * the oldest-first default and is recorded as a manual choice on the payment.
 */
router.post('/students/:studentId/allocate', async (req, res) => {
  if (!(await guardStudent(req, res))) return undefined;
  const parsed = z.object({
    amount: z.union([z.number(), z.string()]),
    feeId: z.string().min(1).optional(),
  }).safeParse(req.body || {});
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const ledger = await fees.feeLedgerFor(prisma, req.params.studentId);
  // Only years that can actually take money are candidates for an allocation.
  const open = ledger.rows
    .filter((r) => r.balance != null && r.balance > 0)
    .map((r) => ({
      feeId: r.id,
      academicYearId: r.academicYearId,
      academicYearLabel: r.academicYearLabel,
      classLabel: r.classLabel,
      balance: r.balance,
    }));

  try {
    const allocations = fees.allocatePayment(open, parsed.data.amount, {
      targetFeeId: parsed.data.feeId || null,
    });
    return sendSuccess(res, {
      allocations,
      outstanding: ledger.outstanding,
      message: fees.describeAllocations(allocations, 'preview'),
    });
  } catch (err) {
    return feeError(res, err) || sendError(res, 'Could not work out this payment', 500, 'ALLOCATE_FAILED');
  }
});

/**
 * POST /api/v1/fees/students/:studentId/payments
 *
 * Record a payment. It is applied OLDEST-FIRST — previous years before the
 * current one — and the response names the years it settled, so the rule used is
 * visible rather than implied.
 */
const paymentSchema = z.object({
  amount: z.union([z.number(), z.string()]),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
  note: z.string().max(200).optional(),
  feeId: z.string().min(1).optional(),
});

router.post('/students/:studentId/payments', async (req, res) => {
  if (!(await guardStudent(req, res))) return undefined;
  const parsed = paymentSchema.safeParse(req.body || {});
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  try {
    const result = await fees.recordPayment(prisma, {
      studentId: req.params.studentId,
      amount: parsed.data.amount,
      paidOn: parsed.data.paidOn,
      note: parsed.data.note,
      recordedBy: req.user.username,
      targetFeeId: parsed.data.feeId || null,
    });
    // The message comes from the allocation that was actually written, so the
    // toast names the year and class the money really went to.
    const summary = await fees.feeSummaryFor(prisma, req.params.studentId);
    return sendSuccess(res, { ...result, summary }, result.message);
  } catch (err) {
    return feeError(res, err) || sendError(res, 'Could not record the payment', 500, 'PAYMENT_FAILED');
  }
});

/**
 * POST /api/v1/fees/classes/:classId/amount
 *
 * Set the fee for a whole class in one action — but only for the students whose
 * fee is not set. A student whose amount was already entered is left exactly as
 * they are, and each remains individually editable afterwards.
 */
router.post('/classes/:classId/amount', async (req, res) => {
  if (!(await guardClass(req, res))) return undefined;
  const parsed = z.object({ amount: z.union([z.number(), z.string()]) }).safeParse(req.body || {});
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const amount = fees.toAmount(parsed.data.amount);
  if (amount === null) return sendValidationError(res, { amount: 'Enter a non-negative amount' });

  const students = await prisma.student.findMany({
    where: { classId: req.params.classId },
    select: { id: true },
  });
  const summaries = await fees.feeSummariesFor(prisma, students.map((s) => s.id));
  const targets = students.filter((s) => {
    const summary = summaries.get(s.id);
    return !(summary && summary.current && summary.current.isSet);
  });

  await prisma.$transaction(async (tx) => {
    for (const s of targets) {
      await fees.setCurrentFee(tx, { studentId: s.id, amount });
    }
  }, { timeout: 60000, maxWait: 15000 });

  return sendSuccess(
    res,
    { classId: req.params.classId, updated: targets.length, amount },
    `Fee set to ₹${amount} for ${targets.length} student${targets.length === 1 ? '' : 's'} who had no fee set.`,
  );
});

module.exports = router;
