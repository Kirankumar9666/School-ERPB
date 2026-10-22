/**
 * Teacher scope, from the TIMETABLE — the ONE place a teacher's classes are
 * decided for the whole employee portal.
 *
 * ## Why this module exists
 *
 * Three screens ask the same question — "which classes is this teacher on?" —
 * and they used to answer it from two different tables:
 *
 *   - My Timetable   → `TimetablePeriod` (rows whose `teacherName` is the teacher)
 *   - Marks Entry    → `TimetablePeriod` (the same rows, collapsed to (class, subject))
 *   - Mark Attendance→ `TeachingAssignment` (a separate row set)
 *
 * Because a `TeachingAssignment` row can exist for a class with no period (and a
 * period can exist with no assignment row), the two answers could disagree: a
 * teacher with one class in the timetable and two assignment rows saw 1 class on
 * My Timetable and Marks Entry but 2 on the Attendance screen, and could mark
 * attendance for a class she never teaches.
 *
 * There is now exactly one derivation, here, from `TimetablePeriod` alone, so the
 * three screens cannot drift apart again. `TeachingAssignment` is untouched as
 * DATA — it still scopes everything it scoped before EXCEPT the teacher's class
 * list, which is no longer derived from it.
 *
 * ## Matching the teacher
 *
 * `TimetablePeriod.teacherName` is free text matched to `Employee.name` by
 * equality. That is the convention `GET /employees/:id/timetable` has always
 * used, so reusing it here guarantees a teacher's timetable page and every
 * permission check agree about which periods are theirs — no second identity
 * model, no id column to add.
 *
 * ## Live, never cached
 *
 * Every function reads the current rows on every call. When an admin re-points a
 * period at a different teacher, every screen and every permission check changes
 * in the same request. There is no permissions table and nothing to invalidate.
 *
 * @module services/timetableScope
 */
const prisma = require('./prisma');
const { classLabel } = require('./mappers');

/**
 * The comparison key for a free-text subject: trimmed, inner whitespace
 * collapsed, lowercased. Two spellings share a key iff they are the same subject
 * to a human (' Mathematics ', 'MATHEMATICS' and 'Mathematics' all key to
 * 'mathematics'). The timetable's own spelling is free text too, so folding case
 * here is what makes the timetable, marks and syllabi agree.
 */
const subjectKey = (subject) => String(subject ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Map key: one subject within one class. */
const scopedSubjectKey = (classId, subject) => `${classId}::${subjectKey(subject)}`;

/**
 * The staff name a timetable period must carry to count as this employee's.
 *
 * Returns null when the employee does not exist, which callers treat as "no
 * classes" rather than an error.
 */
const teacherNameOf = async (employeeId) => {
  if (!employeeId) return null;
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { name: true },
  });
  return employee?.name || null;
};

/**
 * Every timetable period belonging to this teacher.
 *
 * The single read the rest of the module is built on: `teacherTimetablePairs`
 * and `teacherTimetableClassIds` both collapse THIS list, so they can never
 * disagree about which periods are the teacher's.
 *
 * @returns {Promise<Array<{classId:string, subject:string, period:number}>>}
 */
const teacherTimetablePeriods = async (employeeId) => {
  const name = await teacherNameOf(employeeId);
  if (!name) return [];
  return prisma.timetablePeriod.findMany({
    where: { teacherName: name },
    select: { classId: true, subject: true, period: true },
    orderBy: [{ classId: 'asc' }, { period: 'asc' }],
  });
};

/**
 * The (class, subject) pairs this teacher holds in the timetable — one entry per
 * pair, with how many periods a week it runs.
 *
 * A subject taught twice a week yields ONE pair. The class rows ride along so a
 * caller has the label, the level order and the student count without a second
 * query.
 *
 * @returns {Promise<Array<{classId:string, subject:string, periods:number,
 *   order:number, grade:string, section:string, classLabel:string,
 *   studentCount:number}>>}
 */
const teacherTimetablePairs = async (employeeId) => {
  const periods = await teacherTimetablePeriods(employeeId);
  if (!periods.length) return [];

  // Collapse the periods into one row per (class, subject) pair.
  const pairs = new Map();
  periods.forEach((p) => {
    const key = scopedSubjectKey(p.classId, p.subject);
    if (!pairs.has(key)) pairs.set(key, { classId: p.classId, subject: p.subject.trim(), periods: 0 });
    pairs.get(key).periods += 1;
  });

  const classes = await prisma.class.findMany({
    where: { id: { in: [...new Set([...pairs.values()].map((p) => p.classId))] } },
    include: { _count: { select: { students: true } }, level: true },
  });
  const byId = new Map(classes.map((c) => [c.id, c]));

  return [...pairs.values()]
    // A period whose class has since been deleted is not usable; skip it rather
    // than surface a pair no screen could load a roster for.
    .filter((p) => byId.has(p.classId))
    .map((p) => {
      const cls = byId.get(p.classId);
      return {
        classId: cls.id,
        subject: p.subject,
        periods: p.periods,
        order: cls.level ? cls.level.order : cls.grade,
        grade: String(cls.grade),
        section: cls.section,
        classLabel: classLabel(cls),
        studentCount: cls._count?.students ?? 0,
      };
    });
};

/**
 * The classes this teacher has at least one period in, in the shape every class
 * list uses (`{ id, order, grade, section, label, studentCount }`), sorted the
 * way classes sort everywhere else.
 *
 * This is what the Attendance screen lists and what every teacher permission
 * check consults, so it MUST be the same set the Timetable and Marks Entry
 * screens show. One pair per (class, subject) collapses to one class here.
 *
 * @returns {Promise<Array<{id:string, order:number, grade:string, section:string,
 *   label:string, studentCount:number}>>}
 */
const teacherTimetableClasses = async (employeeId) => {
  const pairs = await teacherTimetablePairs(employeeId);
  const seen = new Map();
  pairs.forEach((p) => {
    if (!seen.has(p.classId)) {
      seen.set(p.classId, {
        id: p.classId,
        order: p.order,
        grade: p.grade,
        section: p.section,
        label: p.classLabel,
        studentCount: p.studentCount,
      });
    }
  });
  return [...seen.values()].sort((a, b) => (a.order - b.order) || a.section.localeCompare(b.section));
};

/**
 * Does this teacher have a period in this class? The server-side gate for every
 * teacher-facing class action (attendance read/save, announcement targeting,
 * student/class access) — a class the teacher has no period in is refused even
 * when requested directly, not merely hidden in the UI.
 *
 * Derived from the SAME period list as `teacherTimetableClasses`, so the gate and
 * the list can never disagree: a class that appears on the screen always passes,
 * and one that does not never does.
 */
const teacherTeachesClass = async (employeeId, classId) => {
  if (!employeeId || !classId) return false;
  const name = await teacherNameOf(employeeId);
  if (!name) return false;
  const row = await prisma.timetablePeriod.findFirst({
    where: { teacherName: name, classId },
    select: { id: true },
  });
  return Boolean(row);
};

module.exports = {
  subjectKey,
  scopedSubjectKey,
  teacherNameOf,
  teacherTimetablePeriods,
  teacherTimetablePairs,
  teacherTimetableClasses,
  teacherTeachesClass,
};
