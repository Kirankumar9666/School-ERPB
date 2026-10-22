/**
 * Employee employment lifecycle — ending and reopening a spell of employment.
 *
 * ## Why this exists instead of a DELETE
 *
 * `DELETE /admin/employees/:id` is already right to refuse: once an employee has
 * a payroll month, an attendance row, a leave request, a document, a teaching
 * assignment or an announcement, the foreign keys say their history may not be
 * destroyed, and the route reports the conflict. What it cannot offer is the
 * ordinary case — someone who has genuinely left and whose history must be kept.
 *
 * So "End Employment" writes a row here and flips `Employee.status` to
 * `inactive`. Nothing else is touched: payroll, attendance, marks, leave,
 * documents, timetable periods and announcements all stay, still attributed to
 * the same employee. That is the whole point — the records that made a hard
 * delete impossible are exactly the records that make a termination meaningful.
 *
 * ## Why `status` stays a two-value enum
 *
 * `Employee.status` is `AccountStatus` (active | inactive), the SAME enum as
 * `User.status`, where it means only "may this account authenticate". The reason
 * someone left is event data, not an account-access state, so it lives in
 * `EmploymentEndReason` on a timeline row instead. Putting `resigned`/`retired`
 * into the shared enum would have put four new values in front of every
 * `status = 'active'` filter, badge and login check in the app, none of which
 * would know what to do with them.
 *
 * ## One source of truth, no cached copy
 *
 * The open (not yet reopened) `EmploymentEnd` row IS the employment status. The
 * status is deliberately NOT denormalised onto `Employee` as "current reason"
 * columns: a scalar cannot hold two terminations across a rehire, and a cached
 * copy of a timeline row is exactly the drift risk that `PayrollRecord.paidOn`
 * used to carry. `employment()` below derives it from the rows every time.
 *
 * ## Who owns `Employee.status`
 *
 * Only `endEmployment` and `reactivate` write it. The admin employee form does
 * not offer a status control, and `PUT /employees/:id` rejects an attempt to
 * change it — otherwise the list could show someone off-staff with no reason, no
 * last working day and no audit trail, which is precisely the silent reset that
 * the timeline is here to prevent.
 *
 * ## Reactivation
 *
 * A rehire appends nothing and erases nothing: it STAMPS the open row with
 * `reactivatedAt`/`reactivatedBy`. The spell stays on the timeline (hired →
 * ended → rehired), a later termination writes a new row, and the login is
 * re-enabled. Nothing in the app writes `User.status` other than this module, so
 * restoring it cannot silently undo an unrelated administrative decision.
 */
const prisma = require('./prisma');

/** Mirrors `LEAVE_REASON_MAX` on the leave side — same field, same counter idiom. */
const EMPLOYMENT_DESCRIPTION_MAX = 500;

/**
 * The free-text termination note, normalised — the server's half of the contract.
 *
 * Deliberately identical to `normalizeReason` in `modules/employees`, because it
 * is the same job on the same kind of field: a `<textarea>` submits CRLF when
 * typed on Windows, so measuring the raw value would count two characters per
 * line break that is then stored as one, and the on-screen counter would stop
 * agreeing with the limit at exactly the moment someone writes a multi-line note.
 * The frontend mirror in `utils/employment.js` MUST stay step for step identical.
 *
 * As on the leave side there is no HTML escaping and no tag stripping: the text
 * is stored exactly as typed and rendered as text by React. Output encoding is
 * the security boundary, and sanitising on the way in would corrupt an honest
 * note that merely mentions a tag.
 */
const normalizeDescription = (raw) => String(raw ?? '').replace(/\r\n?/g, '\n').trim();

/**
 * Prisma include for the one `EmploymentEnd` row that currently explains an
 * employee's status: the most recent ending that has not been reopened.
 *
 * Spread into any employee query whose result is passed to `mapEmployee`, so the
 * `employment` field on the wire is derived from the timeline rather than
 * asserted separately. At most one row can match by construction (ending twice
 * in a row is refused), but `take: 1` is kept as the belt-and-braces guard that a
 * data-entry mistake cannot silently make "the reason" ambiguous.
 */
const openEmploymentEnd = {
  employmentEnds: { where: { reactivatedAt: null }, orderBy: { endedAt: 'desc' }, take: 1 },
};

/** The newest ending first, so "latest" is always `history[0]`. */
const employmentHistory = {
  employmentEnds: { orderBy: [{ endedAt: 'desc' }, { id: 'desc' }] },
};

/**
 * One `EmploymentEnd` row → the wire shape.
 *
 * `open` is computed from `reactivatedAt` rather than stored, so the flag a
 * client renders can never disagree with the timestamp it was derived from.
 * @param {object} row EmploymentEnd row.
 */
const mapEmploymentEnd = (row) => ({
  id: row.id,
  employeeId: row.employeeId,
  reason: row.reason,
  lastWorkingDay: row.lastWorkingDay.toISOString().slice(0, 10),
  description: row.description ?? null,
  endedBy: row.endedBy,
  endedAt: row.endedAt.toISOString(),
  reactivatedAt: row.reactivatedAt ? row.reactivatedAt.toISOString() : null,
  reactivatedBy: row.reactivatedBy ?? null,
  open: row.reactivatedAt === null,
});

/**
 * The current employment status of an employee, derived from their timeline.
 *
 * Picks the row that is itself OPEN (`reactivatedAt === null`) rather than
 * trusting the caller's slice to contain only open rows. That matters: the
 * details view includes the WHOLE timeline, and its include overwrites the
 * `openEmploymentEnd` one on the shared `employmentEnds` key — so taking
 * `rows[0]` there would report a closed, already-reactivated ending as the
 * employee's current status. Deriving "open" from the row's own timestamp (the
 * same field the mapped `open` flag comes from) makes the answer correct
 * whichever slice the caller happened to include, and keeps it consistent with
 * the flag the client renders beside it.
 *
 * @param {Array<object>|undefined} rows Timeline rows, or undefined when the
 *   caller did not include them.
 * @returns {object|null} the open ending, mapped, or null while they are on staff.
 */
const employment = (rows) => {
  const open = (rows || []).find((r) => r.reactivatedAt === null);
  return open ? mapEmploymentEnd(open) : null;
};

/**
 * Every record that would be destroyed by deleting this employee outright.
 *
 * Split into two kinds, and the distinction is the whole point of the feature:
 *
 *   blocking  — a foreign key to `Employee`. Deleting the row fails (P2003) or
 *               would cascade real history away. These are what stop a permanent
 *               delete and what End Employment exists to avoid needing.
 *   preserved — attributed by NAME, not by foreign key. `MarksEntry.enteredBy`
 *               stores the author's login username precisely so that "removing
 *               an employee never deletes their historical marks". Those rows
 *               survive the delete as an orphaned username string, so they are
 *               reported for honesty but never block.
 *
 * Counted from the real tables every time, never from a stored total, so the
 * answer can never be stale. Everything except the mark count comes back in a
 * single query.
 *
 * @param {string} employeeId
 * @returns {Promise<{records: Array<{key:string,count:number,blocking:boolean}>,
 *   blockingTotal:number, canDeletePermanently:boolean}>}
 */
const dependentRecords = async (employeeId) => {
  const row = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      user: { select: { username: true } },
      /* LeaveBalance is keyed by `employeeId`, so there is no `id` column to
         select — this relation's presence alone is the signal that the employee
         has one. */
      leaveBalance: { select: { employeeId: true } },
      _count: {
        select: {
          payroll: true,
          attendance: true,
          leaveRequests: true,
          documents: true,
          classesTaught: true,
          classesInCharge: true,
          announcementsSent: true,
        },
      },
    },
  });

  // Marks are keyed by username, so this is the one count that needs its own
  // query — and the reason a `userId`-less employee (staff with no portal login)
  // simply has no marks to report rather than an error.
  const marksEntered = row?.user?.username
    ? await prisma.marksEntry.count({ where: { enteredBy: row.user.username } })
    : 0;

  const c = (row?._count) || {};
  const records = [
    { key: 'payroll', count: c.payroll ?? 0, blocking: true },
    { key: 'attendance', count: c.attendance ?? 0, blocking: true },
    { key: 'leaveRequests', count: c.leaveRequests ?? 0, blocking: true },
    { key: 'documents', count: c.documents ?? 0, blocking: true },
    { key: 'classesTaught', count: c.classesTaught ?? 0, blocking: true },
    { key: 'classesInCharge', count: c.classesInCharge ?? 0, blocking: true },
    { key: 'announcementsSent', count: c.announcementsSent ?? 0, blocking: true },
    { key: 'leaveBalance', count: row?.leaveBalance ? 1 : 0, blocking: true },
    { key: 'marksEntered', count: marksEntered, blocking: false },
  ];

  const blockingTotal = records.reduce((sum, r) => (r.blocking ? sum + r.count : sum), 0);
  return { records, blockingTotal, canDeletePermanently: blockingTotal === 0 };
};

/**
 * End an employee's employment.
 *
 * One transaction writes the timeline row and demotes BOTH `Employee.status` and
 * the linked `User.status`, so there is no window in which the employee is off
 * the staff list but can still sign in. The latter is what the login and refresh
 * routes already check, which is why no new auth logic is needed here.
 *
 * The precondition ("is this employee already off staff?") is evaluated INSIDE
 * the transaction against the same rows the write lands on, rather than checked
 * by the caller first — two admins ending the same person at once cannot both
 * succeed and leave two open rows.
 *
 * @param {object} opts.employee     the Employee row (must carry `userId`)
 * @param {string} opts.reason       EmploymentEndReason
 * @param {Date}   opts.lastWorkingDay
 * @param {string} [opts.description] already normalised
 * @param {string} opts.actor        admin username, for the audit columns
 * @returns {Promise<{end:object}>} the new timeline row; the caller re-reads the
 *   employee so the response carries a fresh status and employment summary.
 * @throws {{code:'ALREADY_ENDED'}} when an open ending already exists
 */
const endEmployment = async ({ employee, reason, lastWorkingDay, description, actor }) =>
  prisma.$transaction(async (tx) => {
    const open = await tx.employmentEnd.findFirst({
      where: { employeeId: employee.id, reactivatedAt: null },
      orderBy: { endedAt: 'desc' },
    });
    if (open) throw { code: 'ALREADY_ENDED', end: open };

    const end = await tx.employmentEnd.create({
      data: {
        employeeId: employee.id,
        reason,
        lastWorkingDay,
        description: description || null,
        endedBy: actor,
      },
    });

    await tx.employee.update({ where: { id: employee.id }, data: { status: 'inactive' } });
    /* Staff with no portal login have no User row to demote — that is the normal
       case for an accountant or a principal created without an account, not an
       error, so the link is simply skipped. */
    if (employee.userId) {
      await tx.user.update({ where: { id: employee.userId }, data: { status: 'inactive' } });
    }

    return { end: mapEmploymentEnd(end) };
  });

/**
 * Reopen an employee's employment (the rehire case).
 *
 * Stamps the OPEN row rather than deleting it, so the previous ending survives
 * with its reason, last working day and note intact and the history reads
 * hired → ended → rehired. Re-enables the login in the same transaction for the
 * same reason `endEmployment` demoted it.
 *
 * @param {object} opts.employee Employee row (must carry `userId`)
 * @param {string} opts.actor    admin username, for the audit columns
 * @returns {Promise<{end:object}>}
 * @throws {{code:'NOT_ENDED'}} when the employee is already on staff
 */
const reactivate = async ({ employee, actor }) =>
  prisma.$transaction(async (tx) => {
    const open = await tx.employmentEnd.findFirst({
      where: { employeeId: employee.id, reactivatedAt: null },
      orderBy: { endedAt: 'desc' },
    });
    if (!open) throw { code: 'NOT_ENDED' };

    const reopened = await tx.employmentEnd.update({
      where: { id: open.id },
      data: { reactivatedAt: new Date(), reactivatedBy: actor },
    });

    await tx.employee.update({ where: { id: employee.id }, data: { status: 'active' } });
    if (employee.userId) {
      await tx.user.update({ where: { id: employee.userId }, data: { status: 'active' } });
    }

    return { end: mapEmploymentEnd(reopened) };
  });

module.exports = {
  EMPLOYMENT_DESCRIPTION_MAX,
  normalizeDescription,
  openEmploymentEnd,
  employmentHistory,
  mapEmploymentEnd,
  employment,
  dependentRecords,
  endEmployment,
  reactivate,
};
