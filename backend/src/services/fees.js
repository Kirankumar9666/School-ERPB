/**
 * Student fees — the single place that reads and writes `StudentFee` and
 * `FeePayment`.
 *
 * ## The model, in one paragraph
 *
 * A student's fee is stored PER ACADEMIC YEAR: one `StudentFee` row for each
 * year they were charged, carrying the amount (`total`, NULL meaning "not set
 * yet") and the class it was charged for. Payments are `FeePayment` rows against
 * a specific year's fee, so "which year did this settle" is stored rather than
 * guessed. `Student.feeTotal` and `Student.feeDues` are a DERIVED CACHE of the
 * CURRENT year only, recomputed here on every write, so the many existing call
 * sites that read those two columns keep working while the per-year rows are
 * the real source of truth.
 *
 * ## Why balances are derived, never stored
 *
 * `balance = total - sum(payments)`, clamped at zero. A stored balance is a
 * second copy of a fact the payment rows already contain, and the two drift the
 * first time a payment is corrected. This is the same reasoning payroll uses for
 * its `paidOn` cache.
 *
 * ## What "previous dues" means
 *
 * Every `StudentFee` row whose year is NOT the current one and whose balance is
 * still positive. It is not a separate column: the old year's own record IS the
 * carried-forward debt, tagged with its class and year, which is exactly what
 * the requirement asks the Fee Dues page to show.
 *
 * @module services/fees
 */
const prisma = require('./prisma');
const { classIdOf, classLabel } = require('./mappers');

/** Normalise a money input to whole rupees, or null when it is not a valid amount. */
const toAmount = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
};

/** `45000` → `₹45,000`. The money format used in every fee message and figure. */
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

/** The academic year whose range contains `date` (today by default). */
const currentYear = async (client = prisma, date = new Date()) => client.academicYear.findFirst({
  where: { startDate: { lte: date }, endDate: { gte: date } },
});

/** A fee row's outstanding balance, or null when the amount has not been set. */
const balanceOf = (fee, paid) => (fee.total == null ? null : Math.max(0, fee.total - paid));

/**
 * The academic year a student's fee is CURRENT for.
 *
 * This is the year of their ACTIVE enrollment, not the calendar year. The two
 * part company for the whole window between a promotion and the new year's
 * start date: promotion repoints the student at the next year's class while the
 * calendar still says the old year. Their fee must follow the class pointer —
 * otherwise a child just moved up would still be shown as owing the old year's
 * amount as their "current" fee, which is precisely the bug the carry-forward
 * exists to prevent.
 *
 * A student with no active seat (passed out, or recorded only for a past year)
 * falls back to the calendar current year.
 */
const feeYearForStudent = async (client, studentId) => {
  const seat = await client.studentEnrollment.findFirst({
    where: { studentId, status: 'active' },
    include: { academicYear: true },
    orderBy: { academicYear: { startDate: 'desc' } },
  });
  if (seat) return seat.academicYear;
  return currentYear(client);
};

/** The same resolution for many students at once (one query, not N). */
const feeYearByStudent = async (client, studentIds) => {
  const map = new Map();
  if (studentIds.length) {
    const seats = await client.studentEnrollment.findMany({
      where: { studentId: { in: studentIds }, status: 'active' },
      select: { studentId: true, academicYearId: true, academicYear: { select: { startDate: true } } },
      orderBy: { academicYear: { startDate: 'asc' } },
    });
    // Ascending order, so the last write per student is their latest active year.
    for (const seat of seats) map.set(seat.studentId, seat.academicYearId);
  }
  return map;
};

/** Sum of payments per StudentFee id. */
const paidByFee = async (client, feeIds) => {
  if (!feeIds.length) return new Map();
  const rows = await client.feePayment.groupBy({
    by: ['studentFeeId'],
    where: { studentFeeId: { in: feeIds } },
    _sum: { amount: true },
  });
  return new Map(rows.map((r) => [r.studentFeeId, r._sum.amount || 0]));
};

/** An empty summary for a student who has no fee rows at all. */
const emptySummary = (studentId) => ({
  studentId,
  current: null,
  previous: [],
  previousDues: 0,
  totalDue: 0,
  hasFee: false,
});

const shapeFee = (fee, paid) => ({
  id: fee.id,
  academicYearId: fee.academicYearId,
  academicYearLabel: fee.academicYear.label,
  startDate: fee.academicYear.startDate,
  classId: fee.classId,
  classLabel: fee.class ? classLabel(fee.class) : null,
  total: fee.total,
  paid,
  balance: balanceOf(fee, paid),
  isSet: fee.total != null,
});

/**
 * Fee summaries for a set of students.
 *
 * @param {object} client a Prisma client or transaction handle
 * @param {string[]} [studentIds] omit to summarise every student
 * @returns {Promise<Map<string, object>>} studentId → summary
 */
const feeSummariesFor = async (client, studentIds) => {
  const fees = await client.studentFee.findMany({
    where: studentIds ? { studentId: { in: studentIds } } : undefined,
    include: { academicYear: true, class: { include: { level: true } } },
    orderBy: { academicYear: { startDate: 'asc' } },
  });
  const paid = await paidByFee(client, fees.map((f) => f.id));

  // Each student's "current" year is the year they are actually seated in, so a
  // just-promoted child is judged against the new year, not the calendar.
  const ids = studentIds || [...new Set(fees.map((f) => f.studentId))];
  const seatYears = await feeYearByStudent(client, ids);
  const fallback = await currentYear(client);

  const grouped = new Map();
  for (const fee of fees) {
    if (!grouped.has(fee.studentId)) grouped.set(fee.studentId, []);
    grouped.get(fee.studentId).push(shapeFee(fee, paid.get(fee.id) || 0));
  }

  const out = new Map();
  for (const [studentId, entries] of grouped) {
    const currentId = seatYears.get(studentId) || (fallback ? fallback.id : null);
    const current = currentId ? entries.find((e) => e.academicYearId === currentId) || null : null;
    const previous = entries
      .filter((e) => e.academicYearId !== currentId && e.balance != null && e.balance > 0)
      .sort((a, b) => a.startDate - b.startDate);
    const previousDues = previous.reduce((sum, e) => sum + e.balance, 0);
    const currentUnpaid = current && current.balance != null ? current.balance : 0;
    out.set(studentId, {
      studentId,
      current,
      previous,
      previousDues,
      totalDue: previousDues + currentUnpaid,
      hasFee: Boolean(current && current.isSet),
    });
  }
  return out;
};

/** One student's fee summary, with an empty summary when they have no rows. */
const feeSummaryFor = async (client, studentId) => {
  const map = await feeSummariesFor(client, [studentId]);
  return map.get(studentId) || emptySummary(studentId);
};

/**
 * One student's whole fee LEDGER: every year they were charged, oldest first,
 * each with its payments and whether it is the student's current fee year.
 *
 * This is the single read behind the Record-payment breakdown, the Fee Dues
 * detail, the Student Profile fee section, Class History's year view and the
 * student's own portal — so all five cannot disagree about which year a payment
 * belongs to. A year that owes money but has no fee row yet (a freshly promoted
 * student whose amount has not been entered) is still listed, with its class
 * taken from the seat they hold, so "Fee not set" is a row rather than a hole.
 *
 * @returns {Promise<{rows: Array, currentAcademicYearId: string|null, outstanding: number}>}
 */
const feeLedgerFor = async (client, studentId) => {
  const [fees, currentYear] = await Promise.all([
    client.studentFee.findMany({
      where: { studentId },
      include: {
        academicYear: true,
        // The level rides along so a carried-forward balance can be labelled
        // "from Nursery A, 2025-26" for a named level too.
        class: { include: { level: true } },
        payments: { orderBy: { paidOn: 'asc' } },
      },
      orderBy: { academicYear: { startDate: 'asc' } },
    }),
    feeYearForStudent(client, studentId),
  ]);

  const rows = fees.map((fee) => {
    const paid = fee.payments.reduce((sum, p) => sum + p.amount, 0);
    return {
      id: fee.id,
      academicYearId: fee.academicYearId,
      academicYearLabel: fee.academicYear.label,
      classId: fee.classId,
      classLabel: fee.class ? classLabel(fee.class) : null,
      total: fee.total,
      isSet: fee.total != null,
      paid,
      balance: balanceOf(fee, paid),
      isCurrent: fee.academicYearId === (currentYear ? currentYear.id : null),
      // Every payment is tagged with the year and class it settled, because that
      // is a fact about the fee row it hangs off — never about the payment date.
      payments: fee.payments.map((p) => ({
        id: p.id,
        amount: p.amount,
        paidOn: p.paidOn.toISOString().slice(0, 10),
        note: p.note,
        recordedBy: p.recordedBy,
        receiptId: p.receiptId,
        chosenYear: p.chosenYear === true,
        academicYearLabel: fee.academicYear.label,
        classLabel: fee.class ? classLabel(fee.class) : null,
      })),
    };
  });

  // The current year may have no fee row at all. Show it anyway — the office needs
  // to see that this year's amount has not been entered, and the payment modal
  // needs it in the breakdown to say why money cannot be applied to it.
  if (currentYear && !rows.some((r) => r.academicYearId === currentYear.id)) {
    const seat = await client.studentEnrollment.findFirst({
      where: { studentId, academicYearId: currentYear.id },
      include: { class: true },
    });
    const student = await client.student.findUnique({
      where: { id: studentId },
      select: { class: { select: { grade: true, section: true, level: { select: { name: true, order: true } } } } },
    });
    const cls = (seat && seat.class) || (student && student.class) || null;
    rows.push({
      id: null,
      academicYearId: currentYear.id,
      academicYearLabel: currentYear.label,
    // The class's REAL id. Rebuilding it from grade+section would produce
    // 'cls--2T' for a named level — an id that exists nowhere, so the label would
    // be right and the key pointing at it wrong.
    classId: cls ? cls.id : null,
      classLabel: cls ? classLabel(cls) : null,
      total: null,
      isSet: false,
      paid: 0,
      balance: null,
      isCurrent: true,
      // No fee row exists yet, so nothing can be paid against it.
      payments: [],
      missing: true,
    });
    rows.sort((a, b) => a.academicYearLabel.localeCompare(b.academicYearLabel));
  }

  const outstanding = rows.reduce((sum, r) => sum + (r.balance != null && r.balance > 0 ? r.balance : 0), 0);
  return { rows, currentAcademicYearId: currentYear ? currentYear.id : null, outstanding };
};

/**
 * Recompute the current-year cache columns on `Student` from the fee rows.
 * Called inside every fee write, in the same transaction.
 */
const syncStudentFeeCache = async (client, studentId) => {
  const year = await feeYearForStudent(client, studentId);
  const fee = year
    ? await client.studentFee.findUnique({
      where: { studentId_academicYearId: { studentId, academicYearId: year.id } },
    })
    : null;

  let feeDues = null;
  if (fee && fee.total != null) {
    const paid = await client.feePayment.aggregate({
      where: { studentFeeId: fee.id },
      _sum: { amount: true },
    });
    feeDues = Math.max(0, fee.total - (paid._sum.amount || 0));
  }

  await client.student.update({
    where: { id: studentId },
    data: { feeTotal: fee ? fee.total : null, feeDues },
  });
};

/**
 * The batch form of `syncStudentFeeCache`, used by whole-class promotion.
 *
 * All the students share one new year, so their balances collapse into a handful
 * of distinct (total, dues) pairs — usually one, since every new year starts
 * blank. Grouping by the pair turns N student writes into a few `updateMany`
 * calls, which is what keeps a 40-student promotion inside its transaction.
 */
const syncStudentFeeCacheBatch = async (client, studentIds) => {
  if (!studentIds.length) return;
  const seatYears = await feeYearByStudent(client, studentIds);
  const fallback = await currentYear(client);
  const yearIds = new Set();
  for (const id of studentIds) {
    const y = seatYears.get(id) || (fallback ? fallback.id : null);
    if (y) yearIds.add(y);
  }

  const feeRows = yearIds.size
    ? await client.studentFee.findMany({
      where: { academicYearId: { in: [...yearIds] }, studentId: { in: studentIds } },
      select: { id: true, studentId: true, academicYearId: true, total: true },
    })
    : [];
  const paid = await paidByFee(client, feeRows.map((f) => f.id));

  const groups = new Map();
  const covered = new Set();
  for (const fee of feeRows) {
    const expectedYear = seatYears.get(fee.studentId) || (fallback ? fallback.id : null);
    if (fee.academicYearId !== expectedYear) continue; // a different year's row
    covered.add(fee.studentId);
    const dues = balanceOf(fee, paid.get(fee.id) || 0);
    const key = `${fee.total}|${dues}`;
    if (!groups.has(key)) groups.set(key, { feeTotal: fee.total, feeDues: dues, ids: [] });
    groups.get(key).ids.push(fee.studentId);
  }
  const missing = studentIds.filter((id) => !covered.has(id));
  if (missing.length) {
    if (!groups.has('null|null')) groups.set('null|null', { feeTotal: null, feeDues: null, ids: [] });
    groups.get('null|null').ids.push(...missing);
  }

  for (const group of groups.values()) {
    await client.student.updateMany({
      where: { id: { in: group.ids } },
      data: { feeTotal: group.feeTotal, feeDues: group.feeDues },
    });
  }
};

/**
 * Make sure a fee row exists for one student and one year. Never overwrites an
 * amount that is already set — an "ensure" must be safe to call on every read
 * path.
 */
const ensureStudentFee = async (client, { studentId, academicYearId, classId = null }) => client.studentFee.upsert({
  where: { studentId_academicYearId: { studentId, academicYearId } },
  create: { studentId, academicYearId, classId, total: null },
  update: {},
});

/**
 * Set (or clear) the current year's fee amount for one student and resync the
 * cache. `amount === null` clears it back to "Not set".
 */
const setCurrentFee = async (client, { studentId, amount }) => {
  const student = await client.student.findUnique({ where: { id: studentId } });
  if (!student) throw Object.assign(new Error('Student not found'), { code: 'NOT_FOUND' });
  const year = await feeYearForStudent(client, studentId);
  if (!year) throw Object.assign(new Error('No academic year contains today'), { code: 'NO_CURRENT_YEAR' });

  const fee = await client.studentFee.upsert({
    where: { studentId_academicYearId: { studentId, academicYearId: year.id } },
    create: { studentId, academicYearId: year.id, classId: student.classId, total: amount },
    update: { total: amount },
  });
  await syncStudentFeeCache(client, studentId);
  return { fee, academicYear: year };
};

/**
 * The ONE payment-allocation rule, shared by the preview, the save and the
 * history.
 *
 * OLDEST-FIRST across the years that still owe money — unless the caller names a
 * year, which is what a parent saying "this is for last year's fee" gets: that
 * payment settles that row and reaches no other year, and it is recorded as a
 * deliberate choice rather than as the default.
 *
 * Deliberately PURE and given already-summarised rows: the same call produces the
 * sentence the admin reads while they type and the rows that are written, so a
 * preview that disagreed with the save is impossible by construction. Every error
 * carries the codes the fee routes already map.
 *
 * @param {Array<{feeId,academicYearId,academicYearLabel,classLabel,balance}>} rows
 *        the OPEN years (balance > 0), oldest first
 * @param {number|string} amount
 * @param {object} [opts]
 * @param {string} [opts.targetFeeId] apply the whole payment to this year only
 * @returns {Array<{feeId,academicYearId,academicYearLabel,classLabel,amount,remainingAfter,selected}>}
 */
const allocatePayment = (rows, amount, { targetFeeId = null } = {}) => {
  const value = toAmount(amount);
  if (value === null || value <= 0) {
    throw Object.assign(
      new Error('Enter a payment amount greater than zero'),
      { code: 'INVALID_AMOUNT', field: 'amount' },
    );
  }
  if (!rows.length) {
    throw Object.assign(new Error('This student has no outstanding fee to pay'), { code: 'NO_DUES' });
  }

  // A named year is held to ITS OWN balance: applying more to it would have to
  // spill into another year, which is the opposite of what was asked for.
  const target = targetFeeId ? rows.find((r) => r.feeId === targetFeeId) : null;
  if (targetFeeId && !target) {
    throw Object.assign(
      new Error('That year is not open for payment'),
      { code: 'INVALID_TARGET', field: 'amount' },
    );
  }

  const outstanding = rows.reduce((sum, r) => sum + r.balance, 0);
  if (value > outstanding) {
    throw Object.assign(
      new Error(`The payment (${inr(value)}) is more than the total outstanding (${inr(outstanding)})`),
      { code: 'AMOUNT_EXCEEDS_DUES', field: 'amount', outstanding },
    );
  }
  if (target && value > target.balance) {
    throw Object.assign(
      new Error(`The payment (${inr(value)}) is more than the ${target.academicYearLabel} balance (${inr(target.balance)})`),
      { code: 'AMOUNT_EXCEEDS_ROW', field: 'amount', outstanding: target.balance },
    );
  }

  const chosen = target ? [target] : rows;
  let remaining = value;
  const allocations = [];
  for (const row of chosen) {
    if (remaining <= 0) break;
    const take = Math.min(row.balance, remaining);
    allocations.push({
      feeId: row.feeId,
      academicYearId: row.academicYearId,
      academicYearLabel: row.academicYearLabel,
      classLabel: row.classLabel,
      amount: take,
      remainingAfter: row.balance - take,
      selected: Boolean(targetFeeId),
    });
    remaining -= take;
  }
  return allocations;
};

/**
 * Turn an allocation into the sentence the modal shows. Both the live preview and
 * the success toast ask for the same string, so they read alike.
 *
 * @param {Array} allocations from `allocatePayment`
 * @param {'preview'|'saved'} [tone] preview leads with the total; saved states it
 */
const describeAllocations = (allocations, tone = 'preview') => {
  if (!allocations.length) return '';
  const total = allocations.reduce((sum, a) => sum + a.amount, 0);
  // "Class 9B · 2026–27" — the class the child was in that year, not today's.
  const feeLabel = (a) => (a.classLabel ? `${a.classLabel} · ${a.academicYearLabel}` : a.academicYearLabel);

  if (allocations.length === 1) {
    const [a] = allocations;
    const left = a.remainingAfter > 0 ? `${inr(a.remainingAfter)} will remain` : 'cleared in full';
    return tone === 'preview'
      ? `${inr(total)} will be applied to ${feeLabel(a)} (${left}).`
      : `${inr(total)} recorded against ${feeLabel(a)}.`;
  }

  const parts = allocations
    .map((a) => `${inr(a.amount)} to ${feeLabel(a)}${a.remainingAfter === 0 ? ' (cleared)' : ''}`)
    .join(', ');
  return tone === 'preview'
    ? `${parts}.`
    : `${inr(total)} recorded: ${parts}.`;
};

/**
 * Record a payment, allocating it OLDEST-FIRST across the student's open years.
 *
 * A receipt that spans years becomes one `FeePayment` row per year, all sharing
 * a `receiptId`, so each row stores the year it settled while the office still
 * sees one payment. The allocation is computed by the same `allocatePayment`
 * call the preview uses, then written row-for-row — there is no second
 * implementation of the split to drift out of step.
 *
 * The amount may not exceed the total outstanding: there is no credit or
 * overpayment concept in the fee ledger, and inventing one silently would
 * misstate what the school is owed.
 */
const recordPayment = async (client, { studentId, amount, paidOn, note, recordedBy, targetFeeId = null }) => {
  const student = await client.student.findUnique({ where: { id: studentId } });
  if (!student) throw Object.assign(new Error('Student not found'), { code: 'NOT_FOUND' });

  const fees = await client.studentFee.findMany({
    where: { studentId },
    include: { academicYear: true, class: { include: { level: true } } },
    orderBy: { academicYear: { startDate: 'asc' } },
  });
  const paid = await paidByFee(client, fees.map((f) => f.id));
  const open = fees
    .map((fee) => ({
      feeId: fee.id,
      academicYearId: fee.academicYearId,
      academicYearLabel: fee.academicYear.label,
      classLabel: fee.class ? classLabel(fee.class) : null,
      balance: balanceOf(fee, paid.get(fee.id) || 0),
    }))
    .filter((row) => row.balance != null && row.balance > 0);

  const allocations = allocatePayment(open, amount, { targetFeeId });

  const paidOnDate = paidOn ? new Date(paidOn) : new Date();
  if (Number.isNaN(paidOnDate.getTime())) {
    throw Object.assign(new Error('Enter a valid payment date'), { code: 'INVALID_DATE', field: 'paidOn' });
  }
  const receiptId = `rcpt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  for (const a of allocations) {
    await client.feePayment.create({
      data: {
        studentFeeId: a.feeId,
        amount: a.amount,
        paidOn: paidOnDate,
        note: note || null,
        recordedBy: recordedBy || null,
        receiptId,
        // Only set when the year was picked by hand, so the history can say so.
        chosenYear: a.selected || false,
      },
    });
  }

  await syncStudentFeeCache(client, studentId);
  return {
    receiptId,
    amount: allocations.reduce((sum, a) => sum + a.amount, 0),
    allocations,
    message: describeAllocations(allocations, 'saved'),
  };
};

/**
 * Roll a student's fee into the next academic year: the old year's record is
 * left exactly as it is (its outstanding balance is what "previous dues" means),
 * and the new year starts blank.
 *
 * `total` is left NULL — the fee is "Not set", not 0 and not copied — so the
 * accountant must enter it deliberately, exactly as the requirement says.
 */
const rollFeeForward = async (client, { studentId, fromYearId, toYearId, toClassId = null }) => {
  const student = await client.student.findUnique({ where: { id: studentId }, select: { id: true } });
  if (!student) throw Object.assign(new Error('Student not found'), { code: 'NOT_FOUND' });

  // One implementation, two entry points: the single-student move is the batch
  // move with one target, so a whole-class promotion and a one-off promotion can
  // never drift apart in how they reset a fee.
  await rollFeeForwardBatch(client, { fromYearId, toYearId, targets: [{ studentId, toClassId }] });
};

/**
 * Batch roll-forward for a whole-class promotion: every student moves from one
 * year to the next in the same transaction.
 *
 * Written as three set-based statements (ensure the old rows, create the new
 * blank rows, resync the cache) rather than a loop, because a 40-student class
 * over a remote database turns a per-student loop into hundreds of round trips —
 * which is exactly what pushes an interactive transaction past its timeout.
 */
const rollFeeForwardBatch = async (client, { fromYearId, toYearId, targets }) => {
  if (!targets.length) return;
  const studentIds = targets.map((t) => t.studentId);

  // The year being left must have a row for each student, so its balance can be
  // carried. It normally does; create only the missing ones.
  if (fromYearId && fromYearId !== toYearId) {
    const existing = await client.studentFee.findMany({
      where: { academicYearId: fromYearId, studentId: { in: studentIds } },
      select: { studentId: true },
    });
    const have = new Set(existing.map((r) => r.studentId));
    const missing = targets.filter((t) => !have.has(t.studentId));
    if (missing.length) {
      const students = await client.student.findMany({
        where: { id: { in: missing.map((t) => t.studentId) } },
        select: { id: true, feeTotal: true, classId: true },
      });
      const byId = new Map(students.map((s) => [s.id, s]));
      await client.studentFee.createMany({
        data: missing.map((t) => ({
          studentId: t.studentId,
          academicYearId: fromYearId,
          classId: (byId.get(t.studentId) || {}).classId ?? null,
          total: (byId.get(t.studentId) || {}).feeTotal ?? null,
        })),
        skipDuplicates: true,
      });
    }
  }

  // The new year starts blank for everyone.
  await client.studentFee.createMany({
    data: targets.map((t) => ({
      studentId: t.studentId,
      academicYearId: toYearId,
      classId: t.toClassId ?? null,
      total: null,
    })),
    skipDuplicates: true,
  });

  await syncStudentFeeCacheBatch(client, studentIds);
};

/**
 * Reverse effects. Delete a just-created next-year fee row — ONLY when no
 * payment has touched it, so undo can never erase a real payment. Returns true
 * when a row was removed.
 */
const removeUnpaidFeeYear = async (client, { studentId, academicYearId }) => {
  const fee = await client.studentFee.findUnique({
    where: { studentId_academicYearId: { studentId, academicYearId } },
    include: { payments: { select: { id: true }, take: 1 } },
  });
  if (!fee) return true;
  if (fee.payments.length) return false;
  await client.studentFee.delete({ where: { id: fee.id } });
  return true;
};

/**
 * Apply the LEGACY (feeTotal, feeDues) inputs from the existing student create /
 * edit / bulk-import flows to the per-year model.
 *
 * The current year's `total` becomes `feeTotal` when given, else `feeDues`. When
 * BOTH are given on a fresh record, the difference is recorded as a single
 * opening payment so the balance reproduces the old `feeDues` exactly. On an
 * existing record with payments, only `total` is applied — synthesizing a
 * payment would double-count money already received.
 */
const applyLegacyFee = async (client, { studentId, feeTotal, feeDues, openingPaidOn, openingNote }) => {
  const totalInput = feeTotal !== undefined ? toAmount(feeTotal) : null;
  const duesInput = feeDues !== undefined ? toAmount(feeDues) : null;
  if (totalInput === null && duesInput === null) return null;

  const student = await client.student.findUnique({ where: { id: studentId } });
  const year = await feeYearForStudent(client, studentId);
  if (!year) throw Object.assign(new Error('No academic year contains today'), { code: 'NO_CURRENT_YEAR' });

  const existing = await client.studentFee.findUnique({
    where: { studentId_academicYearId: { studentId, academicYearId: year.id } },
    include: { payments: { select: { amount: true } } },
  });
  const alreadyPaid = existing ? existing.payments.reduce((sum, p) => sum + p.amount, 0) : 0;

  /* `feeTotal` is the amount charged; `feeDues` is what is still owed. When only
     the dues are supplied (the edit form can do this) the total is derived so the
     resulting BALANCE is the figure the office typed — money already received is
     not turned back into a debt. */
  const total = totalInput !== null ? totalInput : duesInput + alreadyPaid;

  const fee = await client.studentFee.upsert({
    where: { studentId_academicYearId: { studentId, academicYearId: year.id } },
    create: { studentId, academicYearId: year.id, classId: student ? student.classId : null, total },
    update: { total, classId: student ? student.classId : undefined },
  });

  // Only synthesize an opening payment for a brand-new record (no payments yet)
  // when both figures are supplied and the total is the larger one.
  if (totalInput !== null && duesInput !== null) {
    const count = await client.feePayment.count({ where: { studentFeeId: fee.id } });
    const paid = totalInput - duesInput;
    if (count === 0 && paid > 0) {
      await client.feePayment.create({
        data: {
          studentFeeId: fee.id,
          amount: paid,
          paidOn: openingPaidOn ? new Date(openingPaidOn) : new Date(),
          note: openingNote || 'Opening balance from the student record',
          recordedBy: null,
        },
      });
    }
  }

  await syncStudentFeeCache(client, studentId);
  return fee;
};

/**
 * Total money still owed across the WHOLE school (every year, every student).
 * Used by the dashboard card so it includes carried-forward dues.
 */
const totalOutstanding = async (client = prisma) => {
  const rows = await client.$queryRaw`
    SELECT COALESCE(SUM(GREATEST(sf."total" - COALESCE(p."paid", 0), 0)), 0)::int AS "total"
    FROM "StudentFee" sf
    LEFT JOIN (
      SELECT "studentFeeId", SUM("amount") AS "paid"
      FROM "FeePayment"
      GROUP BY "studentFeeId"
    ) p ON p."studentFeeId" = sf."id"
    WHERE sf."total" IS NOT NULL
  `;
  return Number(rows[0]?.total || 0);
};

module.exports = {
  toAmount,
  currentYear,
  balanceOf,
  emptySummary,
  feeYearForStudent,
  feeYearByStudent,
  feeSummariesFor,
  feeSummaryFor,
  feeLedgerFor,
  syncStudentFeeCache,
  syncStudentFeeCacheBatch,
  ensureStudentFee,
  setCurrentFee,
  recordPayment,
  allocatePayment,
  describeAllocations,
  rollFeeForward,
  rollFeeForwardBatch,
  removeUnpaidFeeYear,
  applyLegacyFee,
  totalOutstanding,
};
