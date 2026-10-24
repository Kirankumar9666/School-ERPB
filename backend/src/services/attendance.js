/**
 * Attendance service — one implementation of the "Mark Attendance" rules,
 * shared by the admin panel (`/admin/attendance/*`) and the teacher flow in the
 * employee portal (`/employees/:id/attendance/*`).
 *
 * Both entry points read and write the same tables (StudentAttendance /
 * AttendanceConfirmation) through the functions below, so attendance a teacher
 * saves is exactly what the admin panel sees — there is no second attendance
 * store and no duplicated business logic. The only difference is
 * authorization: the admin router may act on any group, the employee router only
 * on classes the requesting teacher has a timetable period in (the shared rule in
 * `services/timetableScope.js`).
 */
const { z } = require('zod');
const { AttendanceStatus } = require('@prisma/client');
const prisma = require('./prisma');
const { statusToApi, statusToDb, toIso } = require('./mappers');
const {
  teacherTimetableClasses,
  teacherTeachesClass: teacherTimetableTeachesClass,
} = require('./timetableScope');

/** Milliseconds after a confirmed save during which the same day stays editable. */
const ATTENDANCE_EDIT_WINDOW_MS = 60 * 60 * 1000;

/** ISO date pattern (YYYY-MM-DD) — the API's date spelling */
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

/** The two sessions of a school day — required on every session-scoped call. */
const sessionEnum = z.enum(['FN', 'AN']);

/** Convert an API 'YYYY-MM-DD' string to a UTC-midnight Date */
const apiDate = (value) => new Date(`${value}T00:00:00.000Z`);

/**
 * Request body of a whole-group save. Exported so the admin router and the
 * employee router validate against the same contract. `session` scopes the
 * save to one half-day (FN/AN): only that session's rows are written or
 * confirmed, so confirming FN never touches — or locks — AN.
 */
const bulkAttendanceSchema = z.object({
  kind: z.enum(['student', 'employee']),
  groupKey: z.string().min(1),
  date: dateStr,
  session: sessionEnum,
  /** Explicit "Edit past attendance" — lifts the closed 1-hour window. */
  override: z.boolean().optional(),
  entries: z.array(z.object({
    entityId: z.string().min(1),
    status: z.enum(Object.values(AttendanceStatus).map(statusToApi)),
  })).min(1),
});

/**
 * Load one attendance group with its members, derived live from the tables:
 * kind 'student' → a Class row (groupKey = class id), kind 'employee' → ONE
 * named employee (groupKey = that person's id) — a group of a single member.
 * Returns { label, members } or null when the group does not exist.
 *
 * For students, `date` is the enrollment gate: only students whose enrolledAt
 * is on/before that day belong to that day's roster, so a student added today
 * never appears for earlier dates.
 *
 * Employee attendance is recorded per PERSON, not per designation: the admin
 * picks an individual off the flat staff list, so marking them writes only
 * their own row, and the confirmation (and therefore the 1-hour edit window)
 * is theirs alone rather than being shared with every colleague of the same
 * designation. A key that matches no employee id still falls back to the old
 * designation lookup, so confirmations written that way before the split stay
 * readable instead of 404-ing.
 */
const attendanceGroup = async (kind, groupKey, date) => {
  if (kind === 'student') {
    const klass = await prisma.class.findUnique({
      where: { id: groupKey },
      include: {
        students: {
          // Enrollment gate — inclusive: enrolled on the requested day = listed.
          where: date ? { enrolledAt: { lte: apiDate(date) } } : undefined,
          orderBy: { rollNumber: 'asc' },
        },
      },
    });
    if (!klass) return null;
    return { label: `${klass.grade} - Class ${klass.section}`, members: klass.students };
  }
  /* An employee id first: a person IS their own group. */
  const person = await prisma.employee.findUnique({ where: { id: groupKey } });
  if (person) return { label: person.name, members: [person] };

  /* Legacy: a designation keys the whole department (pre-split confirmations). */
  const members = await prisma.employee.findMany({
    where: { designation: groupKey },
    orderBy: { name: 'asc' },
  });
  if (members.length === 0) return null;
  return { label: groupKey, members };
};

/** Confirmation row → API payload with the derived 1-hour edit-window state. */
const confirmationPayload = (row) => {
  if (!row) return null;
  return {
    confirmedAt: toIso(row.confirmedAt),
    withinEditWindow: Date.now() - row.confirmedAt.getTime() < ATTENDANCE_EDIT_WINDOW_MS,
  };
};

/**
 * Roster of one group for one date + session: every member's saved status for
 * that session (null = unmarked) plus that session's confirmation state that
 * drives the edit window. Each session loads its own rows and its own
 * confirmation, so the FN roster and the AN roster of the same day are edited
 * (and locked) independently.
 * Returns null when the group does not exist.
 *
 * @param {'student'|'employee'} kind
 * @param {string} groupKey Class id (students) or employee id (employees)
 * @param {string} date 'YYYY-MM-DD'
 * @param {'FN'|'AN'} session which half-day this roster is for
 */
const loadAttendanceRoster = async (kind, groupKey, date, session) => {
  const group = await attendanceGroup(kind, groupKey, date);
  if (!group) return null;

  const day = apiDate(date);
  const ids = group.members.map((m) => m.id);
  const rows = ids.length
    ? await (kind === 'student'
      ? prisma.studentAttendance.findMany({ where: { studentId: { in: ids }, date: day, session } })
      : prisma.employeeAttendance.findMany({ where: { employeeId: { in: ids }, date: day, session } }))
    : [];
  const statusById = new Map(rows.map((r) => [(kind === 'student' ? r.studentId : r.employeeId), statusToApi(r.status)]));

  const confirmation = await prisma.attendanceConfirmation.findUnique({
    where: { kind_groupKey_date_session: { kind, groupKey, date: day, session } },
  });

  return {
    kind,
    groupKey,
    date,
    session,
    label: group.label,
    count: group.members.length,
    members: group.members.map((m) => ({
      id: m.id,
      name: m.name,
      /* Same field names as the students API so the roster rows and the
         "Check student" selector render identically for both kinds. */
      rollNumber: kind === 'student' ? m.rollNumber : m.employeeId,
      parentName: kind === 'student' ? m.parentName : m.designation,
      guardianContact: kind === 'student' ? m.guardianContact : m.mobile,
      status: statusById.get(m.id) ?? null,
    })),
    confirmation: confirmationPayload(confirmation),
  };
};

/**
 * Save a whole group's attendance for one date in a single transaction: every
 * entry as given ('absent' toggles, everything sent as 'present' for the rest
 * of the roster the UI lists). Atomic — an unknown member id or a failed write
 * leaves no partial rows. Re-confirming within the 1-hour window overwrites;
 * after it closes the request must carry override: true (the explicit "Edit
 * past attendance" path).
 *
 * Never throws for expected outcomes — callers turn the result into a response:
 *   { ok: true,  data }                   → 201 payload
 *   { ok: false, status, code, message }  → error response
 *
 * @param {object} input
 * @param {'student'|'employee'} input.kind
 * @param {string} input.groupKey
 * @param {string} input.date 'YYYY-MM-DD'
 * @param {'FN'|'AN'} input.session the half-day this save targets
 * @param {Array<{entityId: string, status: string}>} input.entries
 * @param {boolean} [input.override] Lifts the closed edit window
 * @param {string} [input.markedBy] Username recorded on the confirmation row
 */
const saveBulkAttendance = async ({ kind, groupKey, date, session, entries, override, markedBy }) => {
  const day = apiDate(date);

  const group = await attendanceGroup(kind, groupKey, date);
  if (!group) {
    return {
      ok: false,
      status: 404,
      code: 'NOT_FOUND',
      message: kind === 'student' ? 'Class not found' : 'Employee not found',
    };
  }

  // Every entry must belong to this group — rejects stale/foreign ids before
  // anything is written (atomicity guard).
  const memberIds = new Set(group.members.map((m) => m.id));
  const unknownEntries = entries.filter((e) => !memberIds.has(e.entityId));
  if (unknownEntries.length) {
    const unknown = unknownEntries.map((e) => e.entityId);
    // A student who is in the class but not yet enrolled on this date is a
    // distinct mistake from a foreign id — report it precisely, and never let
    // the roster gate be bypassed with a direct request.
    if (kind === 'student') {
      const notEnrolled = await prisma.student.findMany({
        where: { id: { in: unknown }, classId: groupKey },
        select: { name: true, id: true },
      });
      if (notEnrolled.length) {
        return {
          ok: false,
          status: 400,
          code: 'VALIDATION_ERROR',
          message: `Students not enrolled on ${date}: ${notEnrolled.map((s) => s.name).join(', ')}`,
        };
      }
    }
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      message: `Entries not in this ${kind === 'student' ? 'class' : 'group'}: ${unknown.join(', ')}`,
    };
  }

  const existing = await prisma.attendanceConfirmation.findUnique({
    where: { kind_groupKey_date_session: { kind, groupKey, date: day, session } },
  });
  if (existing && !override && Date.now() - existing.confirmedAt.getTime() >= ATTENDANCE_EDIT_WINDOW_MS) {
    return {
      ok: false,
      status: 403,
      code: 'EDIT_LOCKED',
      message: 'The 1-hour edit window for this attendance has closed',
    };
  }

  const confirmedAt = new Date();

  await prisma.$transaction(async (tx) => {
    // Perf: one existence read + batched writes (createMany / grouped
    // updateMany) instead of two sequential round trips per row. A 40-student
    // class drops from ~80 queries to ~3. Semantics are identical to per-row
    // upserts: missing rows are created, existing rows get their status set.
    // Every read/write is scoped to `session`, so the two half-days of a day
    // are fully independent records.
    const ids = entries.map((e) => e.entityId);
    const existingRows = kind === 'student'
      ? await tx.studentAttendance.findMany({ where: { studentId: { in: ids }, date: day, session }, select: { studentId: true } })
      : await tx.employeeAttendance.findMany({ where: { employeeId: { in: ids }, date: day, session }, select: { employeeId: true } });
    const existingIds = new Set(existingRows.map((r) => (kind === 'student' ? r.studentId : r.employeeId)));

    const creates = [];
    // Updates grouped by identical payload → one updateMany per distinct status
    const updateGroups = new Map(); // key → { statusDb, workingHours, ids[] }
    const seen = new Set(); // in-request duplicates: later entries act as updates
    entries.forEach((e) => {
      const statusDb = statusToDb(e.status);
      const isExisting = existingIds.has(e.entityId) || seen.has(e.entityId);
      seen.add(e.entityId);
      if (isExisting) {
        // Session working hours are half the old full-day figure (a present
        // session = 4h), so FN 4h + AN 4h still sums to the 8h day everyone's
        // month/hour figures expect.
        const workingHours = kind === 'employee' ? (e.status === 'absent' ? 0 : 4) : null;
        const key = `${statusDb}|${workingHours}`;
        if (!updateGroups.has(key)) updateGroups.set(key, { statusDb, workingHours, ids: [] });
        updateGroups.get(key).ids.push(e.entityId);
      } else if (kind === 'student') {
        creates.push({ studentId: e.entityId, date: day, session, status: statusDb, recordedAt: confirmedAt });
      } else {
        creates.push({
          employeeId: e.entityId,
          date: day,
          session,
          status: statusDb,
          workingHours: e.status === 'absent' ? 0 : 4,
        });
      }
    });

    // Creates first, then updates — an in-request duplicate of a created row is
    // picked up by its updateMany (same transaction, same connection).
    if (creates.length) {
      if (kind === 'student') await tx.studentAttendance.createMany({ data: creates });
      else await tx.employeeAttendance.createMany({ data: creates });
    }
    for (const mgroup of updateGroups.values()) {
      const data = kind === 'employee'
        ? { status: mgroup.statusDb, workingHours: mgroup.workingHours }
        : { status: mgroup.statusDb, recordedAt: confirmedAt };
      if (kind === 'student') {
        await tx.studentAttendance.updateMany({ where: { studentId: { in: mgroup.ids }, date: day, session }, data });
      } else {
        await tx.employeeAttendance.updateMany({ where: { employeeId: { in: mgroup.ids }, date: day, session }, data });
      }
    }

    await tx.attendanceConfirmation.upsert({
      where: { kind_groupKey_date_session: { kind, groupKey, date: day, session } },
      update: { confirmedAt, markedBy },
      create: { kind, groupKey, date: day, session, confirmedAt, markedBy },
    });
  });

  const absent = entries.filter((e) => e.status === 'absent').length;
  return {
    ok: true,
    data: {
      kind,
      groupKey,
      date,
      session,
      saved: entries.length,
      absent,
      present: entries.length - absent,
      confirmedAt: toIso(confirmedAt),
    },
  };
};

/* ---------- Teacher scoping (employee portal "Mark Attendance") ----------
 *
 * The classes a teacher may mark attendance for are the classes where she has a
 * period in the TIMETABLE — the SAME rule (and the same derivation) Marks Entry
 * and My Timetable use, via `services/timetableScope.js`. This used to read
 * `TeachingAssignment`, which can name a class with no period; that let a teacher
 * mark attendance for a class she never teaches and made the Attendance screen
 * list more classes than the other two. `TeachingAssignment` is still a table and
 * still scopes everything else it scoped — it is simply no longer the source of
 * the attendance class list.
 *
 * Nothing about SESSIONS (FN/AN) or the 1-hour edit window below changes: this
 * section decides WHICH class, and those decide HOW and FOR HOW LONG. */

/** The classes this teacher may mark attendance for (timetable-derived ids). */
const teacherClassIds = async (employeeId) => {
  const classes = await teacherTimetableClasses(employeeId);
  return classes.map((c) => c.id);
};

/**
 * Does this teacher actually have a period in this class? The server-side gate
 * for every teacher-facing attendance action — a class the teacher has no period
 * in is rejected even when requested directly, not merely hidden in the UI.
 *
 * Delegates to the shared timetable gate, so it can never admit a class the
 * Attendance screen does not list.
 */
const teacherTeachesClass = (employeeId, classId) => teacherTimetableTeachesClass(employeeId, classId);

/**
 * The classes a teacher may mark attendance for, in the same shape the admin
 * class list uses (`{ id, order, grade, section, label, studentCount }`), so the
 * employee portal renders an identical search-result list — just scoped to the
 * classes this teacher has a period in instead of every class in the school.
 *
 * A teacher with no periods gets an empty list (the UI shows its empty state);
 * requesting any class id then fails the `teacherTeachesClass` gate.
 *
 * The label and the sort are the SHARED ones (`classLabel` + the level order),
 * so a named level reads 'Nursery A' in the employee portal exactly as it does
 * in the admin panel.
 *
 * @param {string|null} employeeId
 * @returns {Promise<Array<{id: string, order: number, grade: string, section: string, label: string, studentCount: number}>>}
 */
const teacherClassGroups = (employeeId) => teacherTimetableClasses(employeeId);

module.exports = {
  ATTENDANCE_EDIT_WINDOW_MS,
  dateStr,
  apiDate,
  sessionEnum,
  bulkAttendanceSchema,
  attendanceGroup,
  confirmationPayload,
  loadAttendanceRoster,
  saveBulkAttendance,
  teacherClassIds,
  teacherTeachesClass,
  teacherClassGroups,
};