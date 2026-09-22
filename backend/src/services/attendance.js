/**
 * Attendance service — one implementation of the "Mark Attendance" rules,
 * shared by the admin panel (`/admin/attendance/*`) and the teacher flow in the
 * employee portal (`/employees/:id/attendance/*`).
 *
 * Both entry points read and write the same tables (StudentAttendance /
 * AttendanceConfirmation) through the functions below, so attendance a teacher
 * saves is exactly what the admin panel sees — there is no second attendance
 * store and no duplicated business logic. The only difference is
 * authorization: the admin router may act on any group, the employee router
 * only on classes the requesting teacher is actually assigned to.
 */
const { z } = require('zod');
const { AttendanceStatus } = require('@prisma/client');
const prisma = require('./prisma');
const { statusToApi, statusToDb, toIso } = require('./mappers');

/** Milliseconds after a confirmed save during which the same day stays editable. */
const ATTENDANCE_EDIT_WINDOW_MS = 60 * 60 * 1000;

/** ISO date pattern (YYYY-MM-DD) — the API's date spelling */
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

/** Convert an API 'YYYY-MM-DD' string to a UTC-midnight Date */
const apiDate = (value) => new Date(`${value}T00:00:00.000Z`);

/**
 * Request body of a whole-group save. Exported so the admin router and the
 * employee router validate against the same contract.
 */
const bulkAttendanceSchema = z.object({
  kind: z.enum(['student', 'employee']),
  groupKey: z.string().min(1),
  date: dateStr,
  /** Explicit "Edit past attendance" — lifts the closed 1-hour window. */
  override: z.boolean().optional(),
  entries: z.array(z.object({
    entityId: z.string().min(1),
    status: z.enum(Object.values(AttendanceStatus).map(statusToApi)),
  })).min(1),
});

/**
 * Load one attendance group with its members, derived live from the tables:
 * kind 'student' → a Class row (groupKey = class id), kind 'employee' → every
 * employee sharing a designation (groupKey = the designation string).
 * Returns { label, members } or null when the group does not exist.
 *
 * For students, `date` is the enrollment gate: only students whose enrolledAt
 * is on/before that day belong to that day's roster, so a student added today
 * never appears for earlier dates.
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
 * Roster of one group for one date: every member's saved status (null =
 * unmarked) plus the confirmation state that drives the edit window.
 * Returns null when the group does not exist.
 *
 * @param {'student'|'employee'} kind
 * @param {string} groupKey Class id (students) or designation (employees)
 * @param {string} date 'YYYY-MM-DD'
 */
const loadAttendanceRoster = async (kind, groupKey, date) => {
  const group = await attendanceGroup(kind, groupKey, date);
  if (!group) return null;

  const day = apiDate(date);
  const ids = group.members.map((m) => m.id);
  const rows = ids.length
    ? await (kind === 'student'
      ? prisma.studentAttendance.findMany({ where: { studentId: { in: ids }, date: day } })
      : prisma.employeeAttendance.findMany({ where: { employeeId: { in: ids }, date: day } }))
    : [];
  const statusById = new Map(rows.map((r) => [(kind === 'student' ? r.studentId : r.employeeId), statusToApi(r.status)]));

  const confirmation = await prisma.attendanceConfirmation.findUnique({
    where: { kind_groupKey_date: { kind, groupKey, date: day } },
  });

  return {
    kind,
    groupKey,
    date,
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
 * @param {Array<{entityId: string, status: string}>} input.entries
 * @param {boolean} [input.override] Lifts the closed edit window
 * @param {string} [input.markedBy] Username recorded on the confirmation row
 */
const saveBulkAttendance = async ({ kind, groupKey, date, entries, override, markedBy }) => {
  const day = apiDate(date);

  const group = await attendanceGroup(kind, groupKey, date);
  if (!group) {
    return {
      ok: false,
      status: 404,
      code: 'NOT_FOUND',
      message: kind === 'student' ? 'Class not found' : 'Staff group not found',
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
    where: { kind_groupKey_date: { kind, groupKey, date: day } },
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
    const ids = entries.map((e) => e.entityId);
    const existingRows = kind === 'student'
      ? await tx.studentAttendance.findMany({ where: { studentId: { in: ids }, date: day }, select: { studentId: true } })
      : await tx.employeeAttendance.findMany({ where: { employeeId: { in: ids }, date: day }, select: { employeeId: true } });
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
        const workingHours = kind === 'employee' ? (e.status === 'absent' ? 0 : 8) : null;
        const key = `${statusDb}|${workingHours}`;
        if (!updateGroups.has(key)) updateGroups.set(key, { statusDb, workingHours, ids: [] });
        updateGroups.get(key).ids.push(e.entityId);
      } else if (kind === 'student') {
        creates.push({ studentId: e.entityId, date: day, status: statusDb });
      } else {
        creates.push({
          employeeId: e.entityId,
          date: day,
          status: statusDb,
          workingHours: e.status === 'absent' ? 0 : 8,
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
        : { status: mgroup.statusDb };
      if (kind === 'student') {
        await tx.studentAttendance.updateMany({ where: { studentId: { in: mgroup.ids }, date: day }, data });
      } else {
        await tx.employeeAttendance.updateMany({ where: { employeeId: { in: mgroup.ids }, date: day }, data });
      }
    }

    await tx.attendanceConfirmation.upsert({
      where: { kind_groupKey_date: { kind, groupKey, date: day } },
      update: { confirmedAt, markedBy },
      create: { kind, groupKey, date: day, confirmedAt, markedBy },
    });
  });

  const absent = entries.filter((e) => e.status === 'absent').length;
  return {
    ok: true,
    data: {
      kind,
      groupKey,
      date,
      saved: entries.length,
      absent,
      present: entries.length - absent,
      confirmedAt: toIso(confirmedAt),
    },
  };
};

/* ---------- Teacher scoping (employee portal "Mark Attendance") ---------- */

/**
 * The classes a teacher is assigned to teach — the ONLY classes they may mark
 * attendance for. Read live from TeachingAssignment, so nothing is hardcoded:
 * change a teacher's assignments and this list changes with them.
 *
 * @param {string|null} employeeId
 * @returns {Promise<string[]>} class ids
 */
const teacherClassIds = async (employeeId) => {
  if (!employeeId) return [];
  const rows = await prisma.teachingAssignment.findMany({
    where: { employeeId },
    select: { classId: true },
  });
  return rows.map((r) => r.classId);
};

/**
 * Does this teacher actually teach this class? The server-side gate for every
 * teacher-facing attendance action — a class the teacher isn't assigned to is
 * rejected even when requested directly, not merely hidden in the UI.
 */
const teacherTeachesClass = async (employeeId, classId) => {
  if (!employeeId || !classId) return false;
  const row = await prisma.teachingAssignment.findUnique({
    where: { employeeId_classId: { employeeId, classId } },
    select: { classId: true },
  });
  return Boolean(row);
};

/**
 * The classes a teacher may mark attendance for, in the same shape the admin
 * class list uses (`{ id, grade, section, label, studentCount }`), so the
 * employee portal renders an identical search-result list — just scoped to this
 * teacher's real assignments instead of every class in the school.
 *
 * A teacher with no assignments gets an empty list (the UI shows its empty
 * state); requesting any class id then fails the teacherTeachesClass gate.
 *
 * @param {string|null} employeeId
 * @returns {Promise<Array<{id: string, grade: string, section: string, label: string, studentCount: number}>>}
 */
const teacherClassGroups = async (employeeId) => {
  const ids = await teacherClassIds(employeeId);
  if (ids.length === 0) return [];

  const rows = await prisma.class.findMany({
    where: { id: { in: ids } },
    include: { _count: { select: { students: true } } },
    orderBy: [{ grade: 'asc' }, { section: 'asc' }],
  });
  return rows.map((c) => ({
    id: c.id,
    grade: String(c.grade),
    section: c.section,
    label: `Class ${c.grade}${c.section}`,
    studentCount: c._count.students,
  }));
};

module.exports = {
  ATTENDANCE_EDIT_WINDOW_MS,
  dateStr,
  apiDate,
  bulkAttendanceSchema,
  attendanceGroup,
  confirmationPayload,
  loadAttendanceRoster,
  saveBulkAttendance,
  teacherClassIds,
  teacherTeachesClass,
  teacherClassGroups,
};