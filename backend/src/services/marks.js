/**
 * Marks service — one implementation of the marks rules, shared by the admin
 * panel (`/admin/marks*`) and the teacher flow in the employee portal
 * (`/employees/:id/marks*`).
 *
 * Both entry points read and write the same two tables (Exam / MarksEntry)
 * through the functions below, so marks a teacher enters are exactly the marks
 * the admin panel lists, the Student Profile shows and the Student Portal
 * reports on — there is no second marks store. The only difference is
 * authorization: the admin router may act on any class and any subject, the
 * employee router only on (class, subject) pairs the requesting teacher
 * actually holds in the TIMETABLE.
 *
 * ── Why this file exists at all ─────────────────────────────────────────────
 * Two problems needed one home:
 *
 * 1. SUBJECT IDENTITY. `TimetablePeriod.subject`, `MarksEntry.subject`,
 *    `SyllabusEntry.subject` and `TeachingAssignment.subject` are all bare
 *    free-text `String` columns — there is no Subject table. Two records that
 *    mean the same thing can therefore be spelled differently ('Mathematics' vs
 *    'maths'), which would silently break a teacher's permission check (which
 *    reads the timetable) against the row they just saved. `subjectKey()` +
 *    `canonicalSubject()` close that gap: EVERY marks write — the teacher's
 *    and the admin's — resolves the incoming subject against the class's own
 *    timetable rows and stores THAT spelling. A subject with no timetable match
 *    (the admin may legitimately add one) is stored as typed, so the existing
 *    free-text flow is untouched. No migration, no new table, and the permission
 *    check and the stored row are the same string by construction.
 *
 * 2. TEACHER SCOPE. `teacherMarkAssignments()` derives the permitted
 *    (class, subject) pairs live from `TimetablePeriod` on every call. There is
 *    deliberately NO cached permissions list: when an admin edits a timetable
 *    the teacher's access changes with it, in the same request. The timetable
 *    is the only source of truth — and since the "Mark Attendance" screen and the
 *    student/class access gate were moved onto the same derivation
 *    (`services/timetableScope.js`), it is now the only source for the whole
 *    employee portal, not just marks. Nothing is derived from
 *    `TeachingAssignment` any more.
 *
 * 3. THE TEACHER'S 48-HOUR EDIT WINDOW. Marks a teacher saves stay correctable
 *    by that teacher for two days, after which only the admin can change them.
 *    Because the same `saveMarkRows` serves both portals, "only the admin" is
 *    simply what an admin write does — it is never refused, and it never
 *    reopens a window the teacher has already lost. The clock lives on its own
 *    column (`teacherSavedAt`) rather than on `updatedAt`, and the window is per
 *    (exam, subject) BATCH rather than per student cell, so a whole class's
 *    marks lock and unlock together.
 */
const prisma = require('./prisma');
const { toDateStr, toIso, classLabel } = require('./mappers');
const { yearForDate, today } = require('./enrollment');
const {
  subjectKey,
  scopedSubjectKey,
  teacherNameOf,
  teacherTimetablePairs,
} = require('./timetableScope');

/* ─────────────────────────── Subject identity ────────────────────────────── */

/* `subjectKey` / `scopedSubjectKey` now live in `services/timetableScope.js`,
   the shared timetable-scope module, so the marks permission check here and the
   Attendance class list fold subject spellings the exact same way. They are
   re-exported from this module unchanged, so existing importers keep working. */

/**
 * Build a `classId::subjectKey` → timetable spelling index for the given
 * classes, in ONE query.
 *
 * The value is the timetable's own spelling, which is what gets written to
 * MarksEntry. When a class has several periods for the same subject they
 * normally agree, but if they don't the earliest period wins — the point is
 * determinism, not a majority vote.
 *
 * @param {string[]} classIds
 * @returns {Promise<Map<string,string>>}
 */
const subjectIndex = async (classIds) => {
  const ids = [...new Set((classIds || []).filter(Boolean))];
  if (!ids.length) return new Map();

  const periods = await prisma.timetablePeriod.findMany({
    where: { classId: { in: ids } },
    select: { classId: true, subject: true },
    orderBy: [{ classId: 'asc' }, { period: 'asc' }],
  });

  const index = new Map();
  periods.forEach((p) => {
    const key = scopedSubjectKey(p.classId, p.subject);
    if (!index.has(key)) index.set(key, p.subject.trim());
  });
  return index;
};

/**
 * Resolve an incoming subject to the spelling the class's timetable already
 * uses, falling back to the trimmed input when the class has no such period.
 *
 * Pass the index from `subjectIndex()` when resolving many subjects for the
 * same classes (a 200-row upload must not issue 200 queries).
 */
const canonicalSubject = (index, classId, subject) => {
  const trimmed = String(subject ?? '').trim();
  if (!trimmed) return trimmed;
  const match = index instanceof Map ? index.get(scopedSubjectKey(classId, trimmed)) : null;
  return match || trimmed;
};

/** Single-shot `canonicalSubject()` for one class (index built for you). */
const canonicalSubjectFor = async (classId, subject) =>
  canonicalSubject(await subjectIndex([classId]), classId, subject);

/* ───────────────────────── Teacher scope (timetable) ─────────────────────── */

/* `teacherNameOf` and the timetable reads now live in `services/timetableScope.js`
   — the ONE derivation of a teacher's classes, shared with the Attendance screen
   and My Timetable, so the three cannot disagree again. */

/**
 * Class-then-section ordering, matching how classes are listed everywhere else.
 *
 * `order` is the LEVEL's order (which is what `Class.grade` holds), so this is
 * the same rule as `compareClasses` — one sort, two call sites, no parsing of a
 * class id and no drift between them.
 */
const byClassThenSubject = (a, b) => {
  const order = (a.order ?? Number(a.grade)) - (b.order ?? Number(b.grade));
  if (order !== 0) return order;
  const section = a.section.localeCompare(b.section);
  if (section !== 0) return section;
  return a.subject.localeCompare(b.subject);
};

/**
 * The (class, subject) pairs this employee may enter marks for — the shared
 * timetable pairs, sorted class-then-subject for the entry screen.
 *
 * The whole permission model for the teacher Marks Entry page, and now the SAME
 * list the Attendance screen derives its classes from (`timetableScope.js`).
 * There is no permissions table, no cache and no hardcoded list: if an admin
 * re-points a period at a different teacher, or adds periods for a class that
 * had none, the next request already reflects it. A teacher who teaches
 * Mathematics twice a week yields ONE pair, not two.
 *
 * @param {string} employeeId
 * @returns {Promise<Array<{classId:string, grade:string, section:string,
 *   classLabel:string, subject:string, periods:number, studentCount:number}>>}
 *   `subject` is the timetable's exact spelling — the same string that will be
 *   stored on any marks row for that pair. Empty for non-teaching staff (an
 *   accountant or librarian has no periods), which is how the page renders an
 *   empty state instead of an error.
 */
const teacherMarkAssignments = async (employeeId) => {
  const pairs = await teacherTimetablePairs(employeeId);
  return pairs.sort(byClassThenSubject);
};

/**
 * Server-side gate for a teacher marks write.
 *
 * This is the enforcement point, not the UI: it is called on the class-wide
 * save, the bulk upload and the template download, so a request naming a
 * (class, subject) pair the teacher does not hold in their timetable is rejected
 * with 403 even when sent straight to the API. Hiding options in the dropdown
 * would not prevent that.
 *
 * @returns {Promise<{ok:boolean, canonical:string|null, classId:string,
 *   classLabel:string|null, status:number, code:string, message:string}>}
 *   On success `canonical` is the TIMETABLE's spelling of the subject — callers
 *   MUST store that value rather than the raw request string, which is what
 *   guarantees the saved row's subject and this permission check are the same
 *   string (see the file header).
 */
const teacherMarkScope = async (employeeId, classId, subject) => {
  const name = subjectKey(subject);
  if (!classId || !name) {
    return {
      ok: false,
      canonical: null,
      classId: classId || null,
      classLabel: null,
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'A class and a subject are required',
    };
  }

  const pairs = await teacherMarkAssignments(employeeId);
  const match = pairs.find((p) => p.classId === classId && subjectKey(p.subject) === name);
  if (match) {
    return {
      ok: true,
      canonical: match.subject,
      classId,
      classLabel: match.classLabel,
      status: 200,
      code: 'OK',
      message: '',
    };
  }

  // Denied. The class is by definition not among the teacher's pairs, so its
  // label needs its own lookup — one extra query, on the failure path only, so
  // the message can name the class exactly as the dropdown would.
  const cls = await prisma.class.findUnique({
    where: { id: classId },
    select: { grade: true, section: true, level: { select: { name: true, order: true } } },
  });
  const label = cls ? classLabel(cls) : classId;
  return {
    ok: false,
    canonical: null,
    classId,
    classLabel: label,
    status: 403,
    code: 'FORBIDDEN',
    message: `You can only enter marks for the classes and subjects in your timetable — ${label} · ${String(subject).trim()} is not one of them`,
  };
};

/* ───────────────────── Teacher edit window (48 hours) ────────────────────── */

/**
 * How long a teacher may keep correcting a batch of marks they saved, measured
 * from THEIR OWN last save. After it, the batch is read-only for them and only
 * the Admin Panel can change it (services/marks.js is shared by both, so the
 * admin's writes are simply never subject to this).
 *
 * Deliberately separate from the attendance feature's 1-hour window: that one
 * guards a daily confirmation, this one guards a result that has to stay
 * correct, and the two must not drift into sharing a constant.
 */
const MARKS_TEACHER_EDIT_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * The edit-window state of one (exam, subject) batch, derived from the real save
 * time and the real current time — never from a flag stored alongside them.
 *
 * `savedAt` is the batch's anchor: MAX(teacherSavedAt) over its rows, so a
 * re-save that touched one student still refreshes the whole batch and the
 * batch locks as one unit. A null anchor means no teacher has ever saved this
 * batch, so there is no window to close: the teacher is entering, not correcting.
 *
 * @param {Date|string|null|undefined} savedAt the batch anchor. A Date (straight
 *   from Prisma) or an ISO string (straight from a save's own `savedAt`) — both
 *   are accepted because both are real sources of the same instant, and silently
 *   reading a string as "no anchor" would quietly report an open window as never
 *   having been saved.
 * @param {number} [now] epoch ms, injectable for tests
 * @returns {{savedAt: string|null, locked: boolean, remainingMs: number|null,
 *   windowMs: number, editableUntil: string|null}} `remainingMs` is null when
 *   there is no anchor — no teacher save means no countdown, not an infinite one.
 */
const marksEditWindow = (savedAt, now = Date.now()) => {
  const anchor = savedAt === null || savedAt === undefined
    ? null
    : (savedAt instanceof Date ? savedAt : new Date(savedAt));
  if (!anchor || Number.isNaN(anchor.getTime())) {
    return { savedAt: null, locked: false, remainingMs: null, windowMs: MARKS_TEACHER_EDIT_WINDOW_MS, editableUntil: null };
  }
  const remainingMs = anchor.getTime() + MARKS_TEACHER_EDIT_WINDOW_MS - now;
  return {
    savedAt: toIso(anchor),
    locked: remainingMs <= 0,
    remainingMs: Math.max(0, remainingMs),
    windowMs: MARKS_TEACHER_EDIT_WINDOW_MS,
    editableUntil: toIso(new Date(anchor.getTime() + MARKS_TEACHER_EDIT_WINDOW_MS)),
  };
};

/**
 * Thrown by `saveMarkRows` when a teacher tries to write a batch whose window
 * has closed. Carries the API's own error shape so the routers can answer with
 * the same 403 / EDIT_LOCKED envelope the attendance window uses, instead of
 * inventing a second vocabulary for "too late".
 */
class MarksEditLockedError extends Error {
  constructor(exams) {
    const names = [...new Set(exams.map((e) => e.examName))];
    super(
      names.length === 1
        ? `The 2-day edit window for ${names[0]} has closed — contact an admin to change these marks`
        : `The 2-day edit window has closed for ${names.join(', ')} — contact an admin to change these marks`,
    );
    this.name = 'MarksEditLockedError';
    this.status = 403;
    this.code = 'EDIT_LOCKED';
    this.exams = exams;
  }
}

/* ─────────────────────────────── Grouping ────────────────────────────────── */

/**
 * MarksEntry rows (with `exam` included) → [{ examId, examName, date, subjects }]
 *
 * The one grouping implementation, previously duplicated verbatim between the
 * admin marks route and the student marks route.
 *
 * @param {object[]} rows
 * @param {{attribution?:boolean}} [opts] `attribution: true` adds who recorded /
 *   last changed each mark. Off by default because the student-facing reads
 *   must not expose staff usernames; the admin and teacher reads turn it on.
 */
const groupMarksByExam = (rows, { attribution = false } = {}) => {
  const byExam = new Map();
  rows.forEach((e) => {
    if (!byExam.has(e.examId)) {
      byExam.set(e.examId, {
        examId: e.examId,
        examName: e.exam.name,
        date: toDateStr(e.exam.date),
        subjects: [],
      });
    }
    const subject = {
      subject: e.subject,
      maxMarks: e.maxMarks,
      obtained: e.obtained,
    };
    if (attribution) {
      subject.enteredBy = e.enteredBy ?? null;
      subject.enteredAt = toIso(e.enteredAt);
      subject.updatedBy = e.updatedBy ?? null;
      subject.updatedAt = toIso(e.updatedAt);
    }
    byExam.get(e.examId).subjects.push(subject);
  });
  return [...byExam.values()];
};

/* ──────────────────────────────── Persisting ─────────────────────────────── */

/** Seeded-style id for the Exam rows this app creates itself. */
const newExamId = () => `exam-${Date.now()}`;

/**
 * Upper bound on Max Marks and on a single obtained mark, enforced identically
 * by the teacher save, the admin per-student save, the admin class-wide save and
 * the teacher's own page. One constant, because a bound that exists twice is a
 * bound that will eventually disagree with itself.
 */
const MARKS_MAX = 10000;

/**
 * Find this class's exam by name WITHIN ONE ACADEMIC YEAR, case-insensitively.
 *
 * `Exam` is `@@unique([classId, academicYearId, name])` and that comparison is
 * case-SENSITIVE, so re-saving an existing exam as "unit test 2" would quietly
 * create a SECOND exam and strand the original marks on it. Reusing the existing
 * row is what makes "same class, subject, exam name and date → correct the existing
 * marks" actually hold when the name is retyped.
 *
 * The YEAR is part of the lookup, and not merely of the key. Every year has a
 * "Unit Test 1" for the same class, so a lookup that ignored it would let a live
 * save silently attach itself to a backfilled exam from three years ago — marks
 * entered today landing on a historical record, with no error anywhere to show for
 * it.
 *
 * `client` exists so `saveMarkRows` can resolve exams INSIDE its transaction: a
 * lookup made outside one would still see the pre-save state.
 */
const findExamByName = (classId, name, academicYearId, client = prisma) =>
  client.exam.findFirst({
    where: { classId, academicYearId, name: { equals: name, mode: 'insensitive' } },
    select: { id: true },
  });

/**
 * The exam a live save is writing to, if one already exists.
 *
 * ## Why the year is a preference, not the key
 *
 * The exam is filed under the academic year containing its own date, so year and
 * date can never disagree. Taken naively, that makes the YEAR the lookup key — and
 * that quietly breaks the 48-hour edit window.
 *
 * A teacher who saved "Unit Test 1" on 5 September and re-enters the batch a day
 * later with the date typed as 1 January means to correct a date, not to open a
 * new examination. Keying strictly on the year would not find the original exam,
 * would create a second "Unit Test 1" in the earlier year, and — because the
 * window is anchored per exam id — would then see a brand-new batch with no
 * `teacherSavedAt` and wave the edit straight through a lock that was supposed to
 * stop it. A typo in a date cell would have become a way to edit locked marks.
 *
 * So: prefer the exam in the year the date implies, and fall back to the class's
 * only same-named exam in another year — which is what "the date was wrong" looks
 * like from here. The caller re-files it into the derived year so the invariant
 * still holds afterwards.
 *
 * ## When the fallback must NOT apply
 *
 * A class id outlives its cohort: 9-B runs in 2024-25, empties, and 9-B runs again
 * in 2026-27. Both years have a "Unit Test 1", and they are genuinely different
 * examinations of different children. So when the class holds MORE THAN ONE
 * same-named exam, the year is the only thing that can tell them apart and a new
 * one is created for the derived year. Backfilled history takes its own,
 * year-scoped path (`services/enrollment.js`) and never comes through here.
 *
 * @param {string} classId
 * @param {string} name
 * @param {string} academicYearId the year the incoming date falls in
 * @param {object} [client]
 * @returns {Promise<{id:string, academicYearId?:string}|null>}
 */
const findExamForSave = async (classId, name, academicYearId, client = prisma) => {
  const inYear = await findExamByName(classId, name, academicYearId, client);
  if (inYear) return { ...inYear, reFiled: false };

  const elsewhere = await client.exam.findMany({
    where: { classId, name: { equals: name, mode: 'insensitive' } },
    select: { id: true, academicYearId: true },
  });
  if (elsewhere.length === 1) return { ...elsewhere[0], reFiled: elsewhere[0].academicYearId !== academicYearId };
  return null;
};

/**
 * The academic year a live exam belongs to: the one containing its own date.
 *
 * Derived rather than typed, and by the SAME shared implementation every other
 * reader uses (`yearForDate` in services/enrollment.js), so the year recorded on
 * the exam and the year the app later reads back can never disagree.
 *
 * An unusable date - a bulk file whose "ExamDate" cell was blank or unreadable -
 * falls back to the year the school is actually in. That is a real judgement
 * rather than a shrug: the exam is being entered NOW, on a live register, so the
 * current year is the only defensible answer, and the marks are far better placed
 * than refused over a cell the office could not format.
 *
 * @param {Date|null} date
 * @param {object} [client]
 * @returns {Promise<object>} the AcademicYear row
 */
const examYearFor = async (date, client = prisma) => {
  const years = await client.academicYear.findMany({ orderBy: { startDate: 'asc' } });
  const matched = yearForDate(date, years);
  if (matched) return matched;

  const now = today();
  const current = years.find((y) => now >= y.startDate && now <= y.endDate);
  if (current) return current;

  /* No year covers today either. A school with no current year is misconfigured
     rather than mid-entry, so say so instead of filing marks somewhere arbitrary. */
  const fallback = years[years.length - 1];
  if (!fallback) {
    throw new Error('No academic years are configured, so marks cannot be filed against one');
  }
  return fallback;
};

/**
 * Write a set of mark rows ATOMICALLY — all of them, or none.
 *
 * The single write path for marks, used by the admin's per-student save, the
 * admin's bulk upload and the teacher's class-wide save and bulk upload. Rows
 * are given in one shape so the identical exam resolution, subject
 * canonicalisation and attribution rules apply to all four:
 *
 *   { studentId, classId, examName, examDate (Date), subject, maxMarks, obtained }
 *
 * Re-saving an existing (student, exam, subject) row OVERWRITES it in place
 * rather than creating a duplicate — the unique key
 * `@@unique([studentId, examId, subject])` is what guarantees that, and it is
 * why corrections converge on one row instead of accumulating history.
 *
 * Attribution: the first write of a row records `enteredBy` / `enteredAt`; any
 * later write records `updatedBy` / `updatedAt` and leaves the original author
 * intact, so "entered by" is never erased by a correction. A row that predates
 * the attribution columns has no author, so its next write is treated as the
 * first — which is the honest reading (nobody has recorded entering it).
 *
 * `writer` is load-bearing, not decoration. A TEACHER write stamps
 * `teacherSavedAt` and is refused outright if the batch's 48-hour window has
 * closed; an ADMIN write is neither stamped nor restricted, and must not
 * reopen the window the teacher lost. Both checks live HERE rather than in the
 * routers because this is the one function all four save paths go through, and
 * the read that decides the anchor and the write that must be refused are then
 * in the same transaction — a request sent straight to the API cannot slip
 * between them.
 *
 * @param {object[]} rows
 * @param {{enteredBy?:string|null, writer?:'teacher'|'admin'}} [opts] the saver's
 *   login username, and who is saving. `writer` defaults to 'admin' — the
 *   restrictive reading — so a caller that forgets it can never silently hand a
 *   teacher a fresh 48 hours; the two teacher routes pass 'teacher' explicitly.
 * @returns {Promise<{saved:number, students:number, exams:number, created:number,
 *   updated:number, rows:object[], examList:object[], savedAt:string}>} `rows`
 *   are the canonicalised, exam-resolved rows as stored — callers echo them back
 *   in their response so the client sees the exact subject spelling that landed
 *   in the database, not the one it happened to send. `savedAt` is that same
 *   instant as an ISO string, so a client can anchor its countdown to the real
 *   save time rather than to when the response happened to arrive.
 */
const saveMarkRows = async (rows, { enteredBy = null, writer = 'admin' } = {}) => {
  if (!rows?.length) {
    return { saved: 0, students: 0, exams: 0, created: 0, updated: 0, rows: [], examList: [], savedAt: null };
  };
  const teacherWrite = writer === 'teacher';

  // One index for every class in the file, so subject canonicalisation costs a
  // single query no matter how many rows are being written. Read-only and
  // independent of the exams, so it stays outside the transaction below.
  const index = await subjectIndex(rows.map((r) => r.classId));

  // Exams are unique per (class, name): one exam per (class, name-lowercased)
  // group, reused across classes only if the name matches. Filled INSIDE the
  // transaction (see below) and read afterwards for the response.
  const exams = new Map(); // `${classId}::${nameKey}` → { examId, classId, name, date }
  const now = new Date();
  const prepared = [];

  // Interactive transaction: the array form batches statements but cannot
  // express "read the existing rows first, then choose create vs update", and a
  // 200-row file is 200+ upserts over a remote database where the default 5s
  // timeout would abort. Any failure rolls the whole file back — including the
  // 48-hour refusal below, which is thrown from here for exactly that reason.
  //
  // The EXAM rows are resolved in here too, not just the marks. They used to be
  // upserted beforehand, which meant a save the window then refused had already
  // rewritten the exam's date: a request that changed nothing still changed
  // something. "All of them, or none" now covers the exam as well.
  const outcome = await prisma.$transaction(async (tx) => {
    for (const row of rows) {
      const nameKey = `${row.classId}::${subjectKey(row.examName)}`;
      if (exams.has(nameKey)) continue;
      // The exam is filed under the year containing its own date, so a date can
      // never sit on an exam the app would have placed in a different year.
      const year = await examYearFor(row.examDate, tx);
      const existing = await findExamForSave(row.classId, row.examName, year.id, tx);
      const exam = existing
        ? await tx.exam.update({
          where: { id: existing.id },
          /* Date and year move TOGETHER when the exam is being re-filed, because the
             invariant is that the year is the one containing the date. Leaving the
             year behind would file a 1-January date under an autumn year, which is
             exactly the disagreement the column exists to prevent. */
          data: { date: row.examDate, academicYearId: year.id },
        })
        : await tx.exam.create({
          data: {
            id: newExamId(),
            classId: row.classId,
            name: row.examName,
            date: row.examDate,
            academicYearId: year.id,
            source: 'live',
          },
        });
      exams.set(nameKey, { examId: exam.id, classId: row.classId, name: exam.name, date: row.examDate });
    }

    rows.forEach((row) => prepared.push({
      studentId: row.studentId,
      examId: exams.get(`${row.classId}::${subjectKey(row.examName)}`).examId,
      // The TIMETABLE's spelling, so this row's subject and the teacher's
      // permitted pair are guaranteed to be the same string.
      subject: canonicalSubject(index, row.classId, row.subject),
      maxMarks: row.maxMarks,
      obtained: row.obtained,
    }));

    const examIds = [...new Set(prepared.map((p) => p.examId))];
    const existingRows = await tx.marksEntry.findMany({
      where: { examId: { in: examIds } },
      select: { id: true, studentId: true, examId: true, subject: true },
    });
    const existingKeys = new Set(existingRows.map((r) => `${r.studentId}::${r.examId}::${r.subject}`));

    // A teacher's save is refused outright if ANY batch it touches is past its
    // 48-hour window. Read here, inside the transaction that does the writing,
    // so the anchor and the refusal cannot disagree. `by: ['examId','subject']` +
    // `_max` gives each touched batch its own anchor in one query: MAX over the
    // batch, so correcting one student refreshes the whole class's window and
    // the batch still locks as one unit.
    if (teacherWrite) {
      const anchors = await tx.marksEntry.groupBy({
        by: ['examId', 'subject'],
        where: {
          examId: { in: examIds },
          subject: { in: [...new Set(prepared.map((p) => p.subject))] },
          teacherSavedAt: { not: null },
        },
        _max: { teacherSavedAt: true },
      });
      const nameOfExam = new Map([...exams.values()].map((e) => [e.examId, e.name]));
      const locked = anchors
        .filter((a) => marksEditWindow(a._max.teacherSavedAt, now.getTime()).locked)
        .map((a) => ({
          examId: a.examId,
          examName: nameOfExam.get(a.examId) || a.examId,
          subject: a.subject,
          savedAt: a._max.teacherSavedAt,
        }));
      if (locked.length) throw new MarksEditLockedError(locked);
    }

    const creates = [];
    const updates = [];
    const seen = new Set();
    prepared.forEach((p) => {
      const key = `${p.studentId}::${p.examId}::${p.subject}`;
      if (seen.has(key)) return; // defensive: parsers reject in-file duplicates
      seen.add(key);
      const data = {
        maxMarks: p.maxMarks,
        obtained: p.obtained,
        updatedBy: enteredBy,
        updatedAt: now,
        // The teacher's own clock, stamped on a teacher write only. An admin
        // write leaves the column exactly as it found it, so correcting a batch
        // after the window closed does not hand the teacher 48 fresh hours.
        ...(teacherWrite ? { teacherSavedAt: now } : {}),
      };
      if (existingKeys.has(key)) {
        updates.push({ id: (existingRows.find((r) => `${r.studentId}::${r.examId}::${r.subject}` === key)).id, data });
      } else {
        creates.push({ ...p, enteredBy, enteredAt: now, ...(teacherWrite ? { teacherSavedAt: now } : {}) });
      }
    });

    if (creates.length) await tx.marksEntry.createMany({ data: creates });
    // Perf: identical corrections collapse into one updateMany. A class-wide
    // re-save where nothing changed is 1 query instead of one per student. The
    // key deliberately leaves `teacherSavedAt` out: it is one shared `now` for
    // the whole save, so grouping by it would only fragment the batches.
    const groups = new Map();
    updates.forEach((u) => {
      const key = `${u.data.maxMarks}::${u.data.obtained}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(u);
    });
    for (const group of groups.values()) {
      await tx.marksEntry.updateMany({
        where: { id: { in: group.map((u) => u.id) } },
        data: group[0].data,
      });
    }

    return { created: creates.length, updated: updates.length };
  }, { timeout: 180000, maxWait: 20000 });

  return {
    saved: prepared.length,
    students: new Set(prepared.map((p) => p.studentId)).size,
    exams: exams.size,
    ...outcome,
    // The instant actually written to the rows, not "now" at return time — the
    // client's countdown is anchored to this.
    savedAt: toIso(now),
    rows: prepared.map(({ studentId, examId, subject, maxMarks, obtained }) =>
      ({ studentId, examId, subject, maxMarks, obtained })),
    examList: [...exams.values()].map((e) => ({
      examId: e.examId, classId: e.classId, name: e.name, date: toDateStr(e.date),
    })),
  };
};

/* ─────────────────────── Class-wide batch history (admin) ────────────────── */

/**
 * Collapse MarksEntry rows into one summary per (exam, subject) BATCH.
 *
 * A batch is the unit the teacher page saves, locks and counts down against —
 * `@@unique([studentId, examId, subject])` makes a row belong to exactly one
 * (exam, subject) pair — so it is also the right unit for the admin's "already
 * saved" card grid: one card per exam the class has marks in, per subject, with
 * that batch's own count / average / top. The admin sees the same batches the
 * teacher does, which is the point: there is no separate admin history.
 *
 * `teacherSavedAt` is folded as a MAX, never taken from whichever row happened to
 * come back last, for the same reason the teacher read does it: the anchor is
 * per batch, so a correction to one student must not appear to move it.
 *
 * @param {object[]} rows MarksEntry rows, each with `exam` included.
 * @returns {Array<{examId:string, examName:string, date:string|null, subject:string,
 *   saved:number, average:number|null, top:number|null, enteredBy:string|null,
 *   updatedBy:string|null, savedAt:string|null}>} Newest exam first, then subject
 *   A–Z, so the grid reads as a history rather than a hash.
 */
const groupMarksByBatch = (rows) => {
  const byBatch = new Map();
  rows.forEach((r) => {
    const key = `${r.examId}::${subjectKey(r.subject)}`;
    if (!byBatch.has(key)) {
      byBatch.set(key, {
        examId: r.examId,
        examName: r.exam.name,
        date: toDateStr(r.exam.date),
        // The TIMETABLE-stored spelling of the first row seen for this batch.
        subject: r.subject,
        obtained: [],
        enteredBy: null,
        updatedBy: null,
        teacherSavedAt: null,
      });
    }
    const batch = byBatch.get(key);
    // Several spellings can reach the table for one subject (see the file
    // header); the first row's own spelling is the one a save will reuse.
    if (r.subject) batch.subject = r.subject;
    batch.obtained.push(r.obtained);
    if (!batch.enteredBy && r.enteredBy) batch.enteredBy = r.enteredBy;
    if (r.updatedBy) batch.updatedBy = r.updatedBy;
    if (r.teacherSavedAt && (!batch.teacherSavedAt || r.teacherSavedAt > batch.teacherSavedAt)) {
      batch.teacherSavedAt = r.teacherSavedAt;
    }
  });

  return [...byBatch.values()]
    .map(({ obtained, enteredBy, updatedBy, teacherSavedAt, ...rest }) => ({
      ...rest,
      saved: obtained.length,
      average: obtained.length
        ? Math.round((obtained.reduce((sum, n) => sum + n, 0) / obtained.length) * 10) / 10
        : null,
      top: obtained.length ? Math.max(...obtained) : null,
      enteredBy,
      updatedBy,
      /* The batch's real teacher clock, as PROVENANCE ONLY. Deliberately not
         spread through `marksEditWindow(...)`: the admin is never inside that
         window and must never be shown a lock, so this is the raw last teacher
         save ("the teacher last touched this on …"), not a countdown and not a
         `locked` flag the UI could be tempted to honour. */
      savedAt: toIso(teacherSavedAt),
    }))
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
      return a.subject.localeCompare(b.subject);
    });
};

/* ─────────────────────── Bulk-upload shared primitives ───────────────────── */

/** Maximum rows accepted per bulk-marks file, on every marks upload route. */
const MARKS_BULK_MAX_ROWS = 200;

/** Build a UTC-midnight Date, rejecting impossible calendar dates (e.g. 31-02-2026) */
const utcDate = (y, mo, d) => {
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const ok = date.getUTCFullYear() === Number(y)
    && date.getUTCMonth() === Number(mo) - 1
    && date.getUTCDate() === Number(d);
  return ok ? date : null;
};

/**
 * Parse an ExamDate cell into a UTC-midnight Date (null when invalid).
 * Accepts real spreadsheet date cells (ExcelJS hands back Date instances) plus
 * 'dd-mm-yyyy' (the template format), 'dd/mm/yyyy', 'dd.mm.yyyy' and 'yyyy-mm-dd'.
 * Impossible calendar dates (e.g. 31-02-2026) parse to null so the row is rejected.
 */
const parseMarkDate = (value) => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : utcDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  const text = String(value ?? '').trim();
  if (!text) return null;
  // 'yyyy-mm-dd' (the API's own spelling) and 'dd-mm-yyyy' / 'dd/mm/yyyy' / 'dd.mm.yyyy'
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return utcDate(iso[1], iso[2], iso[3]);
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
  if (dmy) return utcDate(dmy[3], dmy[2], dmy[1]);
  return null;
};

/** RFC-4180 CSV cell: quote only when the value needs it (doubling inner quotes) */
const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * Does a spreadsheet row exactly match the required header?
 *
 * Case-insensitive, but ORDER-SIGNIFICANT and exact on the set of names: a file
 * with a missing or extra column is rejected outright rather than being read
 * with the columns silently shifted by one — which is the failure mode a
 * template built for a different marks page (admin vs teacher) must hit.
 */
const isHeaderRow = (cells, columns) =>
  cells.length === columns.length
  && cells.every((cell, i) => String(cell ?? '').trim().toLowerCase() === columns[i].toLowerCase());

module.exports = {
  // subject identity
  subjectKey,
  subjectIndex,
  canonicalSubject,
  canonicalSubjectFor,
  MARKS_MAX,
  // teacher scope
  teacherNameOf,
  teacherMarkAssignments,
  teacherMarkScope,
  // reads / writes
  groupMarksByExam,
  groupMarksByBatch,
  saveMarkRows,
  findExamByName,
  // teacher edit window
  MARKS_TEACHER_EDIT_WINDOW_MS,
  marksEditWindow,
  MarksEditLockedError,
  // bulk primitives
  MARKS_BULK_MAX_ROWS,
  utcDate,
  parseMarkDate,
  csvCell,
  isHeaderRow,
};
