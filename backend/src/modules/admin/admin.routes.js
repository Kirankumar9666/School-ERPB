const express = require('express');
const { z } = require('zod');
const bcrypt = require('bcrypt');
const multer = require('multer');
const ExcelJS = require('exceljs');
const {
  Gender,
  EmploymentType,
  AttendanceStatus,
  EmploymentEndReason,
} = require('@prisma/client');
const { parse: parseCsv } = require('csv-parse/sync');
const authMiddleware = require('../../middleware/auth.middleware');
const requirePasswordChange = require('../../middleware/passwordGate.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { ROLES, EMPLOYEE_ROLES } = require('../../constants/roles');
const { ACHIEVEMENT_TYPES } = require('../../constants/options');
const { sendSuccess, sendError, sendValidationError } = require('../../utils/response');
const { passwordSchema } = require('../../services/passwords');
const { wrapAsync } = require('../../utils/asyncRoute');
const { contactSchema } = require('../../utils/phone');
const prisma = require('../../services/prisma');
const { isTransientDbError } = require('../../services/prisma');
const cache = require('../../utils/cache');
const { invalidateClassOptions } = require('../../services/options');
const {
  bulkAttendanceSchema,
  loadAttendanceRoster,
  saveBulkAttendance,
  sessionEnum,
} = require('../../services/attendance');
const {
  mapStudent,
  mapEmployee,
  mapLeave,
  mapPayroll,
  mapPayrollPayment,
  mapUserPublic,
  mapPeriod,
  mapAchievement,
  monthLabel,
  normalizeSyllabusTopics,
  statusToDb,
  statusToApi,
  classIdOf,
  classLabel,
  toDateStr,
  toIso,
  schoolToday,
} = require('../../services/mappers');
// Payroll payment arithmetic (status, the paid/remaining split, and the derived
// "settled on" date) lives in one place so the admin list, the admin month
// detail, the employee read and the payslip PDF cannot describe the same month
// four different ways — see services/payroll.js.
const {
  payrollStatus,
  settledOn,
  summarizePayments,
  payrollShape,
} = require('../../services/payroll');
// Employment lifecycle (ending/reopening a spell of employment, the reason
// timeline, and the dependent-record census that decides whether a permanent
// delete is even possible) — see services/employment.js for why `status` stays a
// two-value enum and the reason lives on a timeline row.
const {
  EMPLOYMENT_DESCRIPTION_MAX,
  normalizeDescription,
  openEmploymentEnd,
  employmentHistory,
  mapEmploymentEnd,
  dependentRecords,
  endEmployment,
  reactivate,
} = require('../../services/employment');
// Marks rules (subject identity, exam resolution, atomic persistence and the
// bulk-upload primitives) live in one place so the admin panel and the teacher
// Marks Entry page cannot drift apart — see services/marks.js.
const {
  groupMarksByExam,
  groupMarksByBatch,
  saveMarkRows,
  subjectIndex,
  canonicalSubject,
  canonicalSubjectFor,
  MARKS_BULK_MAX_ROWS,
  MARKS_MAX,
  parseMarkDate,
  isHeaderRow,
} = require('../../services/marks');
const {
  loadTakenUsernames,
  createStudentAccount,
} = require('../../services/studentAccounts');
const {
  sendDocumentPdf,
  documentUpload,
  documentUploadError,
  requirePdf,
  docNameFrom,
  checkOptionalPdf,
} = require('../../services/documents');
const {
  AnnouncementScope,
  AnnouncementError,
  announcementSchema,
  targetedAnnouncementSchema,
  announcementListSelect,
  createAnnouncement,
  mapAnnouncementAdmin,
  sendAnnouncementPdf,
} = require('../../services/announcements');
const enrollment = require('../../services/enrollment');
// Per-year student fees: the only module allowed to write `StudentFee` /
// `FeePayment`, and the owner of the derived `Student.feeTotal`/`feeDues` cache.
const fees = require('../../services/fees');
const { setWeeklyOffDays } = require('../../services/settings');
const classesService = require('../../services/classes');
// The bulk-upload template, for ONE class. A separate module because it streams a
// file and owns the column list + wording; the bulk route below owns the import.
const bulkTemplate = require('./bulkTemplate');

// Every route below is async, so failures must be forwarded to Express's error
// handler — see utils/asyncRoute.js for why this is not the default in Express 4.
const router = wrapAsync(express.Router());
router.use(authMiddleware);
// Refuses every admin endpoint while the account still uses its school-chosen
// initial password — the server-side half of the forced first-login change.
router.use(requirePasswordChange);
router.use(requireRole([ROLES.ADMIN])); // All admin routes require ADMIN role

/* ---------- Audit trail ---------- */
/**
 * Every successful mutating request (POST/PUT/PATCH/DELETE) on any admin route
 * is recorded to the audit_entries table. Bodies are never captured, so
 * passwords can never leak into the log. GET requests are not audited.
 */
router.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  res.on('finish', () => {
    if (res.statusCode < 400) {
      // Any successful admin mutation may have changed class lists, student
      // headcounts or the summary counters — drop those caches so the next
      // read is fresh (staleness is otherwise bounded by their TTLs).
      cache.del('options:');
      cache.del('summary');
      prisma.auditEntry.create({
        data: {
          actorUserId: req.user?.id || null,
          entityType: 'admin-resource',
          entityId: req.params.id || null,
          message: `${req.method} ${req.originalUrl}`,
        },
      }).catch((err) => console.error('[audit] failed to record entry:', err.message));
    }
  });
  next();
});

/* ---------- helpers ---------- */

/** Generate a unique id (same format the mock store used) */
const newId = (prefix) => `${prefix}-${Date.now()}`;

/** ISO date regex */
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

/**
 * A money amount in WHOLE rupees (QA-A1-010's sibling finding).
 *
 * Fees are stored as Int, so 45000.50 used to be silently rounded to 45001 —
 * the form showed one number and the school kept another. Refusing is the only
 * honest answer; the message tells the office exactly what to type instead.
 * A negative amount keeps its own "too small" wording, so the two problems do
 * not share one confusing message.
 */
const wholeRupees = z.number().min(0).int({ message: 'Enter a whole rupee amount' });

/** Convert an API 'YYYY-MM-DD' string to a UTC-midnight Date (or null) */
const apiDate = (value) => (value ? new Date(`${value}T00:00:00.000Z`) : null);

/* ---------- Bulk marks entry (CSV / XLSX) ---------- */

/**
 * Long/tidy format — one row per student per subject. Header row required, exact order.
 *
 * Deliberately carries NO Class/Section columns: the class is chosen once with
 * the Select Class dropdown on the Marks Entry page and posted with the file, so
 * the spreadsheet can never contradict the page (or silently target another
 * class). RollNumber alone identifies the student because roll numbers are
 * unique per class (`@@unique([classId, rollNumber])`) — see schema.prisma.
 */
const MARKS_BULK_COLUMNS = [
  'RollNumber', 'StudentName', 'ExamName', 'ExamDate',
  'Subject', 'MaxMarks', 'ObtainedMarks',
];

/** Multer keeps the upload in memory — no temp files to clean up. 5 MB cap. */
const marksBulkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

/**
 * Format placeholder row shipped in the downloadable template.
 *
 * Deliberately contains no student data (no names, roll numbers, subjects or
 * marks): the angle-bracket tokens cannot match a student, so uploading the
 * untouched template is rejected row-by-row instead of silently writing
 * invented results.
 */
const MARKS_BULK_PLACEHOLDER_ROW = [
  '<RollNumber>', '<StudentName>', '<ExamName>', '<ExamDate>',
  '<Subject>', '<MaxMarks>', '<ObtainedMarks>',
];

/** Shared student payload → Prisma data (resolves class/section to classId) */
const studentDataFrom = async (data) => {
  /**
   * `classId` is the PRIMARY path and the one every new caller uses: a database
   * id selected from the shared class list, so a named level needs no conversion
   * and no id is ever built from a typed string. Anything else is LEGACY and is
   * resolved through `ensureClass`, which matches the level list.
   */
  if (data.classId) {
    const cls = await prisma.class.findUnique({ where: { id: data.classId }, select: { id: true } });
    if (!cls) {
      throw Object.assign(new Error('There is no class with id ' + data.classId), { code: 'UNKNOWN_CLASS' });
    }
    return {
      name: data.name,
      classId: cls.id,
      rollNumber: data.rollNumber ?? null,
      parentName: data.parentName ?? null,
      guardianContact: data.guardianContact ?? null,
      address: data.address ?? null,
      admissionYear: data.admissionYear ?? null,
      bloodGroup: data.bloodGroup ?? null,
      dob: apiDate(data.dob),
    };
  }
  return {
    name: data.name,
    // The legacy typed form CREATES the class row as a side effect — that is the
    // long-standing behaviour ("add a student to a class that does not exist yet
    // and it does"), and the bulk route relies on it too. ensureClass resolves
    // the level and upserts, so the id it hands back is a row that really exists.
    classId: (await ensureClass(await resolveClassName(data.class), data.section)).id,
    rollNumber: data.rollNumber ?? null,
    parentName: data.parentName ?? null,
    guardianContact: data.guardianContact ?? null,
    address: data.address ?? null,
    admissionYear: data.admissionYear ?? null,
    bloodGroup: data.bloodGroup ?? null,
    dob: apiDate(data.dob),
    // feeTotal/feeDues are deliberately NOT written here: they are a derived
    // cache of the current year's StudentFee row, owned by services/fees.js.
  };
};

/**
 * Ensure the Class row for a level/section pair exists (idempotent).
 *
 * `cls` is a LEVEL NAME, not a grade: admitting the first student to a section
 * has to resolve the level the same way every other route does, or a named level
 * would end up with a class whose id was built from an order number. The grade is
 * taken from the level, so `classLabel` and the sort stay correct.
 */
/**
 * Resolve a typed class value to the LEVEL NAME to use.
 *
 * The only place a typed class is still accepted, and only for a legacy bulk
 * file's Class column: the level list is matched case-insensitively with an
 * optional "Class " prefix, so "lkg", "LKG", "5" and "Class 5" all work.
 *
 * @returns {Promise<string>} the level's own stored name
 * @throws when nothing matches — the caller reports the row and the valid names
 */
const resolveClassName = async (rawClass) => {
  const wanted = String(rawClass ?? '')
    .trim()
    .replace(/^class\s+/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  if (!wanted) {
    throw Object.assign(new Error('A class is required'), { code: 'MISSING_CLASS' });
  }
  const levels = await classesService.listLevels();
  const level = levels.find((l) => l.name.toLowerCase() === wanted);
  if (!level) {
    throw Object.assign(
      new Error('"' + rawClass + '" is not a class level. Valid levels: ' + levels.map((l) => l.name).join(', ')),
      { code: 'UNKNOWN_LEVEL', validLevels: levels.map((l) => l.name) },
    );
  }
  return level.name;
};

/**
 * The class a student row points at, resolved from whichever form it carries.
 * Used by the bulk insert's roll-number retry, which has to know the class
 * without re-running the whole payload through studentDataFrom.
 */
const resolvedClassId = async (data) => {
  if (data.classId) return data.classId;
  return classIdOf(await resolveClassName(data.class), data.section);
};

const ensureClass = async (levelName, section) => {
  const level = await classesService.matchLevel(levelName);
  if (!level) {
    throw Object.assign(new Error(`There is no class level named "${levelName}"`), { code: 'UNKNOWN_LEVEL' });
  }
  const id = classIdOf(levelName, section);
  return prisma.class.upsert({
    where: { id },
    update: {},
    create: { id, grade: level.order, section: String(section).toUpperCase(), levelId: level.id },
  });
};

/** Friendly message for unique-constraint violations */
const uniqueErrorMessage = (err, fallback) => {
  const target = err?.meta?.target?.join(', ') || '';
  return `Duplicate value for: ${target}`;
};

/* ---------- Students CRUD ---------- */

const studentSchema = z.object({
  name: z.string().min(2).max(100),
  /**
   * The class as a database id from the shared class list. THE PRIMARY PATH:
   * every new caller sends this, and a named level needs no conversion.
   */
  classId: z.string().min(1).optional(),
  /**
   * The LEGACY typed form, for a bulk file's Class column only. A level name or a
   * grade, resolved against the level list (see resolveClassName) and never
   * parsed as a number. Optional, so nothing that sends classId must change.
   */
  class: z.string().min(1).max(20).nullish(),
  /* Optional when a classId is given: the class record already carries the
     section, so a caller selecting from the shared list supplies no section at
     all. Required only for the legacy typed pair, where it builds the id. */
  section: z.string().trim().min(1).max(3).regex(/^[A-Za-z]+$/, 'Letters only, no digits').nullish(),
  /**
   * A roll number is OPTIONAL, and `null` is a value the database really holds.
   *
   * Two ordinary situations produce it: an admission with no roll number yet, and
   * every student a promotion has just moved, whose old roll number belonged to
   * the class they left (keeping it would collide with whoever holds it in the
   * new class). `mapStudent` returns that `null` verbatim, so an edit form that
   * posts the record back unchanged was sending `null` — which a plain
   * `.optional()` string rejects with "expected string, received null", leaving the
   * office unable to save a promoted child's profile at all until someone thought
   * to invent a roll number first.
   */
  rollNumber: z.string().min(1).max(50).nullish(),
  /**
   * Guardian name and contact are REQUIRED on both Add Student and Edit Student.
   *
   * They are the identity triple the duplicate rule matches on (name + guardian
   * name + guardian contact — see services/enrollment.js), so a student without
   * them is a record the duplicate rule cannot see and the office cannot tell
   * apart from anybody else's child. They are also what a login is derived from:
   * the initial password IS the guardian contact (services/studentAccounts.js),
   * so a student with no contact could never be given one.
   *
   * Bulk Add has always required both; this makes the single Add/Edit form agree
   * with it. Records created BEFORE this rule keep their blanks: they read as
   * null, stay viewable everywhere, and Edit asks for the missing values before
   * it will save (this same schema is what refuses).
   */
  parentName: z.string({ error: 'Parent / Guardian is required' })
    .trim()
    .min(2, 'Parent / Guardian must be at least 2 characters')
    .max(100),
  // Contact fields are the shared digits-only rule (exactly 10) — see utils/phone.
  // The stored shape ('+91-XXXXXXXXXX'), the bare national digits and the
  // country-coded form are all accepted and normalised to the stored one.
  guardianContact: contactSchema,
  address: z.string().min(5).max(300).optional(),
  admissionYear: z.number().int().min(1990).max(2100).optional(),
  bloodGroup: z.string().max(5).optional(),
  /**
   * A date of birth is in the past by definition. A future one is a typo
   * (the year fat-fingered), and every age that reads from it — the class a
   * child belongs in, the report card header — would then be wrong in a way
   * nobody checks. Compared date-string to date-string so no timezone is
   * involved: 'YYYY-MM-DD' sorts lexicographically exactly as it does in time.
   */
  dob: dateStr.refine((v) => v <= new Date().toISOString().slice(0, 10), {
    message: 'Date of birth cannot be in the future',
  }).optional(),
  /**
   * Fees are money in whole rupees. A decimal was silently rounded on the way
   * into the database (Prisma Int), so the office saw one figure and the school
   * stored another. Refused instead, with a message that says what to type.
   */
  feeTotal: wholeRupees.optional(),
  feeDues: wholeRupees.optional(),
});

/* A classId is complete on its own. The legacy typed pair needs BOTH parts,
   because that is what builds the id: a section on its own would silently
   target every class with that section letter in it. */
const studentSchemaRefined = studentSchema.refine(
  (v) => Boolean(v.classId) || (Boolean(v.class) && Boolean(v.section)),
  { message: "Choose a class, or give both a class and a section", path: ["classId"] },
);

/**
 * GET /api/v1/admin/students — list all students.
 * `?classId=` narrows the roster to one class (the Marks Entry page reads the
 * selected class's students this way, so the dropdown and every table on that
 * page can only ever contain that class's students).
 */
router.get('/students', async (req, res) => {
  const { classId } = req.query;
  const rows = await prisma.student.findMany({
    where: classId ? { classId: String(classId) } : undefined,
    include: { class: { include: { level: true } } },
    orderBy: { id: 'asc' },
  });
  return sendSuccess(res, rows.map(mapStudent));
});

/* ---------- Class summaries (derived aggregation over students + marks) ---------- */

/**
 * GET /api/v1/admin/students/by-class — students grouped per class with aggregates.
 * Derived live from the students + marks_entries tables, so rows update
 * automatically on any add/edit/delete (never cached — the bulk-marks flow
 * re-reads this endpoint right after saving). Query ?q= filters the underlying
 * students by name/roll/class/section before grouping.
 *
 * Perf: two lean queries instead of full-table row loads —
 *   - students: only the columns the response/`?q=` filter actually use
 *   - marks: per-student totals computed by the database (groupBy/_sum),
 *     so one aggregate row per student is shipped instead of every entry
 */
router.get('/students/by-class', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();

  /* The class table, so an EMPTY class still gets a card. A class created through
     Create Class holds no students yet, and the office that just made it must see
     it appear — a page built only from the students would render nothing at all
     for it, which reads as "the button did not work". Read in the same pass as
     the students and the marks: one extra query for that. */
  const [students, markSums, allClasses] = await Promise.all([
    prisma.student.findMany({
      select: {
        id: true,
        name: true,
        rollNumber: true,
        feeDues: true,
        // The real class id, so a group built from students can act on the class
        // (delete it) without rebuilding an id from grade + section.
        classId: true,
        // The level is loaded so the card's name comes from the shared
        // `classLabel` — a named level reads "Nursery A", not its order.
        class: { select: { grade: true, section: true, level: { select: { name: true, order: true } } } },
      },
      orderBy: { id: 'asc' },
    }),
    prisma.marksEntry.groupBy({
      by: ['studentId'],
      _sum: { obtained: true, maxMarks: true },
    }),
    prisma.class.findMany({
      include: { level: true },
      orderBy: [{ grade: 'asc' }, { section: 'asc' }],
    }),
  ]);

  // studentId → overall percent 0–100, or null when unmarked / max<=0
  // (identical semantics to summing every entry row per student).
  const percentOf = new Map();
  markSums.forEach((m) => {
    const obtained = m._sum.obtained ?? 0;
    const max = m._sum.maxMarks ?? 0;
    percentOf.set(m.studentId, max > 0 ? (obtained / max) * 100 : null);
  });

  // A student with NO current class — someone passed out of school, or recorded
  // only for a past year — has `classId: null`, and `include: { class }` then
  // hands back `class: null`. This endpoint groups BY class, so there is no group
  // to put them in and they are dropped before either the ?q= filter or the
  // grouping below gets a chance to touch `s.class.grade`.
  //
  // Dropping them is not "losing" them: they belong to no current register, and
  // Class History is where that record is read. What MUST not happen is what used
  // to happen — `s.class.grade` on null threw a TypeError, this route returned
  // 500, and because Student Management loads it alongside two other requests with
  // an unguarded Promise.all, ONE failure blanked the entire page into a confident
  // "0 students across 0 classes" while the students were sitting right there in
  // the database. A class list that cannot express "no class" must not crash when
  // it meets one.
  const classed = students.filter((s) => s.class);

  // Same JS-side filter the mock version applied (keeps ?q= semantics
  // identical: name/roll/class/section substring match)
  /* A class is matched by its LEVEL NAME and section, so "lkg", "nursery" and
     "5a" all find the right rows. Matching on the order number instead would mean
     typing "-2" to reach Nursery — an internal value no office would ever type. */
  /* A class is matched by its LEVEL NAME, its SECTION and the two CONCATENATED,
     so "lkg", "nursery", "5a" and "lkgir" all find the right rows. Matching on
     the order number instead would mean typing "-2" to reach Nursery - an
     internal value no office would ever type. */
  const termsOf = (cls) => {
    const name = cls.level ? cls.level.name : String(cls.grade);
    return [name, cls.section, `${name}${cls.section}`];
  };
  const pool = q
    ? classed.filter((s) => [s.name, s.rollNumber, ...termsOf(s.class)]
      .some((v) => String(v ?? '').toLowerCase().includes(q)))
    : classed;
  /* The classes a SEARCH matched. An empty class must be findable by its own
     name — searching "lkg" has to show the empty LKG A card, not only the ones
     that already hold students. With no query this is simply every class. */
  const matchedClasses = q
    ? allClasses.filter((c) => termsOf(c).some((v) => String(v ?? '').toLowerCase().includes(q)))
    : allClasses;

  /* Per-student fee picture, INCLUDING carried-forward dues. The `Student.feeDues`
     column is only the current year; the class card must show everything the
     class still owes, so the real figure comes from the fee rows. */
  const feeSummary = await fees.feeSummariesFor(prisma, pool.map((s) => s.id));

  /* Every class that EXISTS is a card, including the empty ones.
     A class created through Create Class holds no students yet, and the office
     that just made it must see it appear — a page built only from the students
     would render nothing at all for it, which reads as "the button did not
     work". A search narrows the set: with a query, only the classes that matched
     are shown, so an empty class never rides along on someone else's match. */
  const groups = new Map();
  matchedClasses.forEach((c) => {
    const key = `${c.grade}-${c.section}`;
    groups.set(key, {
      id: c.id,
      key,
      grade: c.grade,
      section: c.section,
      label: classLabel(c),
      order: c.level ? c.level.order : c.grade,
      studentIds: [],
      totalStudents: 0,
      feeDues: 0,
      currentDues: 0,
      previousDues: 0,
      percents: [],
    });
  });
  pool.forEach((s) => {
    const key = `${s.class.grade}-${s.class.section}`;
    if (!groups.has(key)) {
      groups.set(key, {
        id: s.classId,
        key,
        grade: s.class.grade,
        section: s.class.section,
        // Built by the ONE shared name function, so the Student Management cards
        // name a class exactly as every other screen does.
        label: classLabel(s.class),
        order: s.class.level ? s.class.level.order : s.class.grade,
        studentIds: [],
        totalStudents: 0,
        feeDues: 0,
        currentDues: 0,
        previousDues: 0,
        percents: [],
      });
    }
    const g = groups.get(key);
    g.studentIds.push(s.id);
    g.totalStudents += 1;
    const summary = feeSummary.get(s.id);
    g.feeDues += summary ? summary.totalDue : Number(s.feeDues) || 0;
    g.currentDues += summary && summary.current && summary.current.balance != null ? summary.current.balance : 0;
    g.previousDues += summary ? summary.previousDues : 0;
    const percent = percentOf.get(s.id);
    if (percent !== undefined && percent !== null) g.percents.push(percent);
  });

  const rows = [...groups.values()].map((g) => ({
    key: g.key,
    // The class's real id, so a caller can act on it (delete) without rebuilding
    // it from the grade and section — which a named level makes impossible.
    id: g.id,
    class: g.label,
    // `order` and `section` are carried out of the group so the sort below and any
    // consumer can see them; `key` alone is no longer enough to order by (it used
    // to be parsed for the grade, which a named level's id has none of).
    order: g.order,
    section: g.section,
    totalStudents: g.totalStudents,
    feeDues: g.feeDues,
    currentDues: g.currentDues,
    previousDues: g.previousDues,
    topScore: g.percents.length ? Math.round(Math.max(...g.percents)) : null,
    avgMarks: g.percents.length
      ? Math.round(g.percents.reduce((a, b) => a + b, 0) / g.percents.length)
      : null,
    markedCount: g.percents.length,
    studentIds: g.studentIds,
  }));

  // ONE shared sort: level order, then section.
  rows.sort((a, b) => (a.order - b.order) || a.section.localeCompare(b.section));

  return sendSuccess(res, rows);
});

/* ---------- Classes and grade levels ---------- */

/**
 * POST /api/v1/admin/classes — create a class.
 *
 * The level is chosen from the LEVEL LIST (a set of database rows), never typed as
 * a number: a named level has no number to type, and "Nursery" typed into a grade
 * box is exactly the kind of guess that puts the wrong class in front of a family.
 *
 * Class.grade is filled from the level's ORDER in the same write, which is what
 * keeps the shared sort, the (grade, section) unique index and every existing
 * query working unchanged.
 */
const createClassSchema = z.object({
  levelId: z.string().min(1),
  section: z.string().trim().min(1).max(3).regex(/^[A-Za-z]+$/, 'Letters only, no digits'),
});

router.post('/classes', async (req, res) => {
  const parsed = createClassSchema.safeParse(req.body || {});
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  try {
    const { cls, created, label } = await classesService.createClass({
      levelId: parsed.data.levelId,
      section: parsed.data.section,
    });
    if (!created) return sendError(res, `${label} already exists.`, 409, 'DUPLICATE');
    // Drop the cached class list, so the new class reaches every dropdown without
    // a page reload — the 60s TTL would otherwise hide it from a screen that was
    // already open when it was created.
    invalidateClassOptions();
    return sendSuccess(res, {
      id: cls.id,
      section: cls.section,
      label,
    }, `${label} created`, 201);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return sendError(res, 'Class level not found', 404, 'NOT_FOUND');
    if (err.code === 'BAD_SECTION') return sendError(res, err.message, 400, 'BAD_SECTION');
    throw err;
  }
});

/**
 * GET /api/v1/admin/classes — every class, with its level, in the shared order.
 *
 * The one list the Create Class dropdown, the Student Management cards and the
 * Promote tab read, so no screen keeps a copy of its own.
 */
router.get('/classes', async (req, res) => {
  const rows = await prisma.class.findMany({
    include: {
      level: true,
      _count: { select: { students: true, enrollments: true } },
    },
    // grade holds the level's order, so this IS the one shared sort.
    orderBy: [{ grade: 'asc' }, { section: 'asc' }],
  });
  return sendSuccess(res, rows.map((c) => ({
    id: c.id,
    section: c.section,
    order: c.level ? c.level.order : c.grade,
    levelId: c.levelId,
    levelName: c.level ? c.level.name : null,
    label: classLabel(c),
    studentCount: c._count.students,
    enrollmentCount: c._count.enrollments,
  })));
});

/**
 * DELETE /api/v1/admin/classes/:id — remove an EMPTY class.
 *
 * A class with any record at all refuses, with the reason named: deleting it would
 * strand that data rather than clean it up.
 */
router.delete('/classes/:id', async (req, res) => {
  const cls = await prisma.class.findUnique({
    where: { id: req.params.id },
    include: {
      level: true,
      _count: {
        select: {
          students: true, enrollments: true, fees: true, exams: true,
          timetable: true, syllabus: true, assignments: true, announcements: true,
        },
      },
    },
  });
  if (!cls) return sendError(res, 'Class not found', 404, 'NOT_FOUND');

  const blocked = Object.entries({
    students: cls._count.students,
    enrollments: cls._count.enrollments,
    fees: cls._count.fees,
    exams: cls._count.exams,
    timetable: cls._count.timetable,
    syllabus: cls._count.syllabus,
    assignments: cls._count.assignments,
    announcements: cls._count.announcements,
  }).filter(([, n]) => n > 0);

  if (blocked.length) {
    return sendError(
      res,
      `${classLabel(cls)} has ${blocked.map(([k]) => k).join(', ')} and cannot be deleted`,
      409,
      'CLASS_HAS_RECORDS',
    );
  }

  await prisma.class.delete({ where: { id: cls.id } });
  invalidateClassOptions();
  return sendSuccess(res, { id: cls.id }, `${classLabel(cls)} deleted`);
});

/**
 * GET /api/v1/admin/class-levels — the grade levels, in teaching order.
 *
 * Served out of the table, so a school that adds Playgroup or Class 12 needs no
 * code change and no screen keeps a local copy of the list.
 */
router.get('/class-levels', async (req, res) => {
  const levels = await classesService.listLevels();
  const counts = await prisma.class.groupBy({
    by: ['levelId'],
    _count: { _all: true },
  });
  const classCount = new Map(counts.map((c) => [c.levelId, c._count._all]));
  return sendSuccess(res, levels.map((l) => ({
    id: l.id,
    name: l.name,
    order: l.order,
    classCount: classCount.get(l.id) || 0,
  })));
});

/**
 * POST /api/v1/admin/class-levels — add a level.
 *
 * afterId says where it goes; everything below is renumbered in the SAME
 * transaction as the insert, and every affected class's grade is re-synced inside
 * it too — a partially-renumbered order list would sort two levels into the same
 * place and leave a class pointing at the wrong row.
 */
const createLevelSchema = z.object({
  name: z.string().trim().min(1).max(20),
  afterId: z.string().min(1).nullish(),
});

router.post('/class-levels', async (req, res) => {
  const parsed = createLevelSchema.safeParse(req.body || {});
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  try {
    const level = await classesService.createLevel({
      name: parsed.data.name,
      afterId: parsed.data.afterId || null,
    });
    invalidateClassOptions();
    return sendSuccess(res, level, `Level ${level.name} added`, 201);
  } catch (err) {
    if (err.code === 'DUPLICATE_LEVEL') return sendError(res, err.message, 409, 'DUPLICATE_LEVEL');
    if (err.code === 'MISSING_NAME') return sendError(res, err.message, 400, 'MISSING_NAME');
    throw err;
  }
});

/** PUT /api/v1/admin/class-levels/:id — rename. Class ids are NOT rebuilt. */
router.put('/class-levels/:id', async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(20) }).safeParse(req.body || {});
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  try {
    const level = await classesService.renameLevel({ levelId: req.params.id, name: parsed.data.name });
    invalidateClassOptions();
    return sendSuccess(res, level, `Level renamed to ${level.name}`);
  } catch (err) {
    if (err.code === 'DUPLICATE_LEVEL') return sendError(res, err.message, 409, 'DUPLICATE_LEVEL');
    if (err.code === 'P2025') return sendError(res, 'Class level not found', 404, 'NOT_FOUND');
    throw err;
  }
});

/**
 * DELETE /api/v1/admin/class-levels/:id — refused while any class uses it.
 * A level that still holds classes is a decision for the office, not a cascade.
 */
router.delete('/class-levels/:id', async (req, res) => {
  try {
    const level = await classesService.deleteLevel({ levelId: req.params.id });
    invalidateClassOptions();
    return sendSuccess(res, level, `Level ${level.name} removed`);
  } catch (err) {
    if (err.code === 'LEVEL_HAS_CLASSES') return sendError(res, err.message, 409, 'LEVEL_HAS_CLASSES');
    if (err.code === 'NOT_FOUND') return sendError(res, 'Class level not found', 404, 'NOT_FOUND');
    throw err;
  }
});
/* ---------- Students bulk upload (CSV / XLSX, parsed server-side) ---------- */

/** Multer keeps the upload in memory — no temp files to clean up. 5 MB cap. */
const bulkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

/** Bulk-upload columns with the class on the row (the LEGACY form). */
const BULK_COLUMNS = ['Name', 'Class', 'Section', 'RollNumber', 'ParentGuardian', 'Contact', 'FeeDues'];

/**
 * Bulk-upload columns for a file scoped to a CHOSEN class.
 *
 * The class is absent because the Bulk Add screen supplies it and it applies to
 * every row. This is what the template hands out, so a fresh file never carries a
 * column that would be ignored.
 */
const SCOPED_BULK_COLUMNS = ['Name', 'RollNumber', 'ParentGuardian', 'Contact', 'FeeDues'];

/** Per class/section, the latest year seen in that group's roll numbers */
const latestRollYear = (students) => {
  const years = students
    .map((s) => (/^STU-(\d{4})-(\d+)$/.exec(String(s.rollNumber ?? '').trim()) || [])[1])
    .filter(Boolean);
  return years.length ? years.sort().pop() : String(new Date().getFullYear());
};

/**
 * The next free roll number for ONE class, read from the database.
 *
 * The one place a roll number is chosen, so Add Student and Bulk Add cannot
 * disagree about what "next" means — and so a student added one at a time gets
 * the number the next bulk upload would skip rather than collide with. `client`
 * is a transaction handle when a caller needs the number from its own snapshot.
 *
 * ## Why this reads ENROLLMENTS, not `Student.classId`
 *
 * Uniqueness is enforced by `StudentEnrollment @@unique([classId, academicYearId,
 * rollNumber])` — a number is taken per class PER YEAR. Counting the students who
 * currently point at the class is a different set, and after a promotion the two
 * disagree: a promoted child's seat in the class they left is closed, not deleted
 * (that row IS last year's register, kept on purpose), so it still occupies its
 * number for that class and year while their `Student.classId` has moved on.
 * Enumerating the pointer then re-issues a number that is still taken, and the
 * admission dies on the unique constraint ("Duplicate value for: classId,
 * academicYearId, rollNumber") — a school cannot admit anyone into a class it has
 * just promoted. Reading the seats themselves is what the constraint is actually
 * about.
 */
const nextRollNumberFor = async (client, classId, academicYearId) => {
  if (!classId) return null;
  /* The year the seat will be written in. Resolved through the caller's own
     handle, so the number is chosen from the same snapshot the write will use. */
  const yearId = academicYearId || (await enrollment.currentYear(client))?.id;
  const members = yearId ? await rollNumbersTakenIn(client, classId, yearId) : [];
  return nextRollNumber(members, latestRollYear(members));
};

/**
 * The roll numbers ALREADY TAKEN in one class for one year — the exact set the
 * unique constraint is about.
 *
 * Both Add Student and Bulk Add choose their numbers from this, so the two paths
 * agree on what "next" means. Read from `StudentEnrollment` (class + year), never
 * from `Student.classId`: see `nextRollNumberFor` for why the pointer gives the
 * wrong answer after a promotion.
 *
 * @param {object} client a Prisma client or transaction handle
 * @param {string} classId
 * @param {string} academicYearId
 * @returns {Promise<Array<{rollNumber: string|null}>>}
 */
const rollNumbersTakenIn = async (client, classId, academicYearId) => client.studentEnrollment.findMany({
  where: { classId, academicYearId },
  select: { rollNumber: true },
});
/** Derive the next available roll number within one class/section group */
const nextRollNumber = (students, year) => {
  const maxNum = students.reduce((max, s) => {
    const m = new RegExp(`^STU-${year}-(\\d+)$`).exec(String(s.rollNumber ?? '').trim());
    return m ? Math.max(max, parseInt(m[1], 10)) : max;
  }, 0);
  return `STU-${year}-${String(maxNum + 1).padStart(3, '0')}`;
};

/**
 * POST /api/v1/admin/students/bulk — create many students in one call.
 * Prefers multipart/form-data with a `file` field (.csv / .xlsx) parsed and
 * validated server-side, so a modified frontend can't bypass validation.
 * Also accepts { students: [...] } JSON for programmatic use (same rules).
 * Expected columns (header row required, exact order):
 *   Name, Class, Section, RollNumber, ParentGuardian, Contact, FeeDues
 * RollNumber is optional — blank cells get the next available roll number for
 * that class/section, derived from the existing students' roll numbers.
 * Atomic: every row is validated first; if ANY row is invalid nothing is
 * created and the response lists the failing row numbers and columns.
 */
router.post('/students/bulk', bulkUpload.single('file'), async (req, res) => {
  const entries = [];
  const errors = {};

  /* The class the whole file belongs to, when the screen chose one. Multer puts
     multipart FIELDS on req.body, so a file upload arrives with it; the query
     string covers the JSON fallback. */
  const wantedClassId = String(req.body?.classId || req.query?.classId || '').trim();
  let chosenClass = null;
  if (wantedClassId) {
    chosenClass = await prisma.class.findUnique({
      where: { id: wantedClassId },
      include: { level: true },
    });
    if (!chosenClass) return sendError(res, 'Class not found', 404, 'NOT_FOUND');
  }

  /* The level list, read ONCE for the whole file. Every typed Class cell is
     matched against it, and an unknown one is reported by ROW with the full list
     of valid level names — rather than as a single opaque failure that says
     nothing about which line was wrong. Read up front so a request that only
     supplies a file still resolves levels before the per-row loop runs. */
  const bulkLevelNames = (await classesService.listLevels()).map((l) => l.name);
  // A lower-cased SET for matching; `bulkLevelNames` keeps the real names for the
  // error message, which must read "Nursery, LKG, UKG" rather than "nursery, lkg".
  const bulkLevelMatch = new Set(bulkLevelNames.map((n) => n.toLowerCase()));

  /* ---------- 1. Obtain rows (uploaded file or JSON fallback) ---------- */
  if (req.file) {
    const originalName = String(req.file.originalname || '').toLowerCase();
    if (!originalName.endsWith('.csv') && !originalName.endsWith('.xlsx')) {
      return sendError(res, 'Unsupported file type — upload a .csv or .xlsx file', 400, 'BAD_REQUEST');
    }

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
        const sheet = book.worksheets[0];
        if (!sheet) return sendError(res, 'The workbook has no sheets', 400, 'BAD_REQUEST');
        records = [];
        sheet.eachRow((row) => {
          const cells = [];
          row.eachCell({ includeEmpty: true }, (cell, col) => { cells[col - 1] = cell.text ?? ''; });
          records.push(cells);
        });
      }
    } catch (err) {
      return sendError(res, `Could not parse the file: ${err.message}`, 400, 'BAD_REQUEST');
    }

    /* Header row: required, exact column order. EITHER of the two layouts is
       accepted: the current one the template hands out (no class columns, because
       the screen chose the class), or the legacy one that carries Class and Section
       per row. Which one it is decides everything below, so it is settled here
       once rather than re-derived per row. */
    const header = (records[0] || []).map((h) => String(h ?? '').trim());
    const lower = header.map((h) => h.toLowerCase());
    const isScoped = lower.length === SCOPED_BULK_COLUMNS.length
      && lower.every((h, i) => h === SCOPED_BULK_COLUMNS[i].toLowerCase());
    const isLegacy = lower.length === BULK_COLUMNS.length
      && lower.every((h, i) => h === BULK_COLUMNS[i].toLowerCase());
    if (!isScoped && !isLegacy) {
      const expected = chosenClass ? SCOPED_BULK_COLUMNS : BULK_COLUMNS;
      return sendValidationError(res, {
        file: `Header row must be exactly: ${expected.join(', ')}`
          + (chosenClass ? ` (you chose ${classLabel(chosenClass)}, so there are no Class or Section columns)` : ''),
      });
    }
    /* Columns the row will read, and where the class comes from. */
    const columns = isScoped ? SCOPED_BULK_COLUMNS : BULK_COLUMNS;

    /* Drop fully-empty data rows and enforce the 200-row limit */
    const dataRows = records.slice(1)
      .map((cells) => cells.map((c) => (c == null ? '' : String(c).trim())))
      .filter((cells) => cells.some((c) => c !== ''));
    if (dataRows.length === 0) {
      return sendValidationError(res, { file: 'The file has no student rows below the header' });
    }
    if (dataRows.length > 200) {
      return sendValidationError(res, { file: `Bulk upload is limited to 200 students per file (got ${dataRows.length})` });
    }

    dataRows.forEach((cells, i) => {
      const rowNum = i + 2; // header is row 1, so the first data row is line 2
      if (cells.length !== columns.length) {
        errors[`row_${rowNum}`] = {
          columns: `Expected ${columns.length} columns, got ${cells.length}`,
        };
        return;
      }
      /* Read the row against whichever layout the header declared. The scoped
         form has no class columns at all, so the class comes from the screen. */
      const name = cells[0];
      let rollNumber = cells[isScoped ? 1 : 3];
      let cls = isScoped ? null : cells[1];
      let section = isScoped ? null : cells[2];
      const parentGuardian = cells[isScoped ? 2 : 4];
      const contact = cells[isScoped ? 3 : 5];
      const feeDues = cells[isScoped ? 4 : 6];

      /* With a chosen class, the class is fixed: it is not read from the row, and
         there is nothing on a scoped row to read. Anything a legacy row says is
         compared against it instead (see below). */
      if (chosenClass) {
        cls = chosenClass.level ? chosenClass.level.name : String(chosenClass.grade);
        section = chosenClass.section;
      }

      /* Required per row (only RollNumber may be blank) + format checks */
      const rowErrors = {};
      if (!name) rowErrors.Name = 'Required';
      if (!cls) rowErrors.Class = 'Required';
      if (!section) rowErrors.Section = 'Required';
      else if (!/^[A-Za-z]{1,3}$/.test(String(section).trim())) rowErrors.Section = 'Must be 1–3 letters';
      if (!parentGuardian) rowErrors.ParentGuardian = 'Required';
      if (!contact) rowErrors.Contact = 'Required';
      if (!feeDues) rowErrors.FeeDues = 'Required';
      else if (Number.isNaN(Number(feeDues)) || Number(feeDues) < 0) rowErrors.FeeDues = 'Must be a non-negative number';
      // Whole rupees only, the same rule the single Add/Edit form enforces: a
      // decimal row was rounded on its way into the Int column.
      else if (!Number.isInteger(Number(feeDues))) rowErrors.FeeDues = 'Enter a whole rupee amount';
      if (Object.keys(rowErrors).length > 0) {
        errors[`row_${rowNum}`] = rowErrors;
        return;
      }

      /* A LEGACY row that names a DIFFERENT class than the one chosen on screen
         is a contradiction, not a compatibility case: the row would land somewhere
         the admin did not ask for. Refused by row, naming both, and matched on the
         LEVEL name so "LKG", "lkg" and "Class LKG" all agree with LKG. */
      if (chosenClass && isLegacy) {
        const said = String(cells[1]).trim().replace(/^class\s+/i, '').toLowerCase();
        const want = cls.trim().replace(/^class\s+/i, '').toLowerCase();
        if (said && said !== want) {
          errors[`row_${rowNum}`] = {
            Class: `Row says "${cells[1]}" but you chose ${classLabel(chosenClass)}. Every row must be for ${classLabel(chosenClass)}.`,
          };
          return;
        }
      }

      const parsed = studentSchemaRefined.safeParse({
        name,
        class: cls,
        section: String(section).toUpperCase(),
        rollNumber: rollNumber || undefined,
        parentName: parentGuardian,
        guardianContact: contact,
        feeDues: Number(feeDues),
      });
      if (!parsed.success) {
        errors[`row_${rowNum}`] = parsed.error.flatten().fieldErrors;
        return;
      }
      /* A typed class is only allowed for this legacy column, and it is matched
         against the LEVEL LIST here — one row at a time, so an unknown level names
         its own row and the valid list rather than aborting the whole file with a
         message that says nothing about which line was wrong. */
      if (!chosenClass && !parsed.data.classId && parsed.data.class) {
        const wanted = String(parsed.data.class).trim().replace(/^class\s+/i, '').toLowerCase();
        if (!bulkLevelMatch.has(wanted)) {
          errors[`row_${rowNum}`] = {
            Class: `Unknown class "${parsed.data.class}". Valid levels: ${bulkLevelNames.join(', ')}`,
          };
          return;
        }
      }
      entries.push(parsed.data);
    });
  } else if (Array.isArray(req.body?.students)) {
    /* JSON fallback for programmatic use — identical validation rules */
    if (req.body.students.length === 0) {
      return sendError(res, 'Provide a non-empty "students" array', 400, 'BAD_REQUEST');
    }
    if (req.body.students.length > 200) {
      return sendError(res, 'Bulk add is limited to 200 students per request', 400, 'BAD_REQUEST');
    }
    req.body.students.forEach((entry, i) => {
      const parsed = studentSchemaRefined.safeParse(entry);
      if (!parsed.success) {
        errors[`row_${i + 1}`] = parsed.error.flatten().fieldErrors;
        return;
      }
      if (!parsed.data.classId && parsed.data.class) {
        const wanted = String(parsed.data.class).trim().replace(/^class\s+/i, '').toLowerCase();
        if (!bulkLevelMatch.has(wanted)) {
          errors[`row_${i + 1}`] = {
            Class: `Unknown class "${parsed.data.class}". Valid levels: ${bulkLevelNames.join(', ')}`,
          };
          return;
        }
      }
      entries.push(parsed.data);
    });
  } else {
    return sendError(res, 'Attach a .csv or .xlsx file in the "file" field', 400, 'BAD_REQUEST');
  }

  /* ---------- 2. Atomic: reject the whole file if any row failed ---------- */
  if (Object.keys(errors).length > 0) return sendValidationError(res, errors);



  /* ---------- 3. Auto-generate blank roll numbers per class/section ---------- */
  /* Keyed by CLASS ID on BOTH sides. An earlier version keyed existing students by
     `s.classId` but file rows by a "grade-section" string, so the two never met:
     every file row looked like a brand-new class, its group was empty, and the year
     fell back to the current calendar year instead of continuing the class's own
     "STU-2022-" sequence. The existing side is now the SEATS for the year the
     entries are about to be seated in — the set the unique constraint is on — not
     the current-class pointer, which after a promotion no longer lists the children
     who left and whose closed seats still hold their numbers. */
  const groups = new Map();
  const groupKey = (s) => String(s.classId ?? '').trim();
  /* The year the entries will be seated in — the same year `syncLiveEnrollment`
     writes, so the numbers we hand out are checked against the seats that will
     actually constrain them. */
  const bulkYearId = (await enrollment.currentYear(prisma))?.id;
  const existing = bulkYearId
    ? await prisma.studentEnrollment.findMany({
      where: { academicYearId: bulkYearId },
      select: { rollNumber: true, classId: true },
    })
    : [];
  existing.forEach((s) => {
    /* A seat with no class belongs to no roll-number group: numbering is per class,
       so it cannot collide with any group's sequence. */
    if (!s.classId) return;
    const k = groupKey(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ rollNumber: s.rollNumber });
  });
  for (const entry of entries) {
    if (entry.rollNumber) continue; // the row supplied one
    /* The entry's class is not a classId yet — that is written in step 4 below,
       when the class row is created. Resolve it HERE so the group key matches the
       one built from `existing` above. Without this a class that already holds a
       "STU-2022-" sequence looked like a brand-new class and the year restarted.
       Sequential because resolving a level is a read. */
    if (!entry.classId) {
      entry.classId = (await ensureClass(await resolveClassName(entry.class), entry.section)).id;
    }
    const k = groupKey(entry);
    // The group MUST exist in `groups` before reading it: a throwaway array would
    // store the sequence into the void and hand every row of a brand-new class the
    // same number.
    if (!groups.has(k)) groups.set(k, []);
    const members = groups.get(k);
    const roll = nextRollNumber(members, latestRollYear(members));
    entry.rollNumber = roll;
    members.push({ rollNumber: roll }); // later blank rows in the same group must not collide
  }

  /* ---------- 3b. Duplicate check (the same rule as Add / Edit) ----------
     Two passes, because a file can collide with the database AND with itself, and
     a file that lists the same child twice must not be saved even when neither
     row exists yet. Reported per row with the existing student named, so the
     office is sent to the record that is already on file rather than being told
     the word "duplicate". The whole file is refused — atomic, as before. */
  const duplicateErrors = {};
  const seenInFile = new Map(); // identity key → first row number that carried it

  // (a) against the database. One match per row is enough to refuse it, and this
  //     loop is sequential so the school's rows are graded in file order.
  for (let i = 0; i < entries.length; i += 1) {
    const existing = await enrollment.findDuplicateStudent(entries[i], { limit: 1 });
    if (existing.length) {
      // File row numbers count the header, so the first data row is row 2 — the
      // same numbering the rest of this route reports on.
      duplicateErrors[`row_${i + 2}`] = {
        Name: `Already on file: ${enrollment.duplicateMessage(existing[0])}`,
      };
    }
  }

  // (b) against the other rows in the same file. The FIRST occurrence wins and is
  //     kept, so the row numbers named in the error are the ones to delete.
  entries.forEach((entry, i) => {
    const rowNum = i + 2;
    if (duplicateErrors[`row_${rowNum}`]) return; // already flagged against the database
    const key = enrollment.identityLockKey(entry);
    if (seenInFile.has(key)) {
      duplicateErrors[`row_${rowNum}`] = {
        Name: `Listed twice in this file — row ${seenInFile.get(key)} is the same student`,
      };
      return;
    }
    seenInFile.set(key, rowNum);
  });

  if (Object.keys(duplicateErrors).length > 0) return sendValidationError(res, duplicateErrors);

  /* ---------- 4. Insert (ensure Class rows, then create in row order) ---------- */
  const stamp = Date.now();
  const createdRows = [];
  for (let i = 0; i < entries.length; i += 1) {
    /* With a chosen class there is nothing to resolve: the id is known and the
       class row already exists (it was read at the top of the route). Without
       one, a typed level name still creates its class on demand. */
    if (chosenClass) {
      entries[i].classId = chosenClass.id;
      entries[i].class = null;
    } else if (!entries[i].classId) {
      await ensureClass(entries[i].class, entries[i].section);
    }
    // Per-row recovery: a dropped pooler connection can lose the response
    // AFTER the row committed, so a plain retry would trip the rollNumber
    // unique constraint. On any failure, re-derive the next free roll number
    // from fresh DB state and retry with a fresh unique id.
    let row = null;
    for (let attempt = 0; attempt < 3 && !row; attempt += 1) {
      try {
        // Sortable unique id ('stu-<ts>-<0001>') so a re-read preserves row order.
        // The enrollment is written in the same transaction — see the single-student
        // route for why an admitted student without one is a broken record.
        row = await prisma.$transaction(async (tx) => {
          const created = await tx.student.create({
            data: {
              id: `stu-${stamp}-${String(i + 1).padStart(4, '0')}${attempt ? `r${attempt}` : ''}`,
              ...(await studentDataFrom(entries[i])),
            },
            include: { class: { include: { level: true } } },
          });
          await enrollment.syncLiveEnrollment(tx, created.id);
          // The bulk column is "FeeDues" — what is owed. With no total supplied,
          // that becomes the current year's amount, so the balance reproduces it.
          await fees.applyLegacyFee(tx, {
            studentId: created.id,
            feeDues: entries[i].feeDues,
            openingPaidOn: created.enrolledAt,
          });
          return tx.student.findUnique({ where: { id: created.id }, include: { class: { include: { level: true } } } });
        }, { timeout: 60000, maxWait: 15000 });
      } catch (err) {
        const retriable = attempt < 2
          && (String(err?.meta?.target || '').includes('rollNumber') || isTransientDbError(err));
        if (!retriable) throw err;
        /* A fresh read of the SEATS in this class for this year, from the same
           source the constraint is enforced on — not the current-class pointer,
           which would re-issue a number a promoted child still holds. */
        const members = bulkYearId
          ? await rollNumbersTakenIn(prisma, await resolvedClassId(entries[i]), bulkYearId)
          : [];
        entries[i].rollNumber = nextRollNumber(members, latestRollYear(members));
      }
    }
    createdRows.push(row);
  }

  /* ---------- 5. Auto-provision a login per student (no manual step) ---------- */
  // One STUDENT account per created student: username from the name (suffix
  // on collision), initial password = guardian contact. Students without a
  // contact on file are skipped (nothing to derive a password from) — the
  // response reports exactly how many accounts were created.
  const taken = await loadTakenUsernames();
  const accounts = [];
  for (const row of createdRows) {
    if (!row) continue;
    const account = await createStudentAccount(row, { taken });
    if (account) accounts.push(account);
  }
  const created = createdRows.map(mapStudent);
  /* The count is the REAL inserted rows, and the class is named so the message
     confirms what was acted on rather than leaving the office to check. */
  const classNote = chosenClass ? ` to ${classLabel(chosenClass)}` : '';
  const message = `${created.length} student${created.length === 1 ? '' : 's'} added${classNote}`
    + ` · ${accounts.length} login account${accounts.length === 1 ? '' : 's'} created`
    + ' (initial password = guardian contact — returned in this response only, it cannot be retrieved afterwards)';
  return sendSuccess(res, {
    created,
    count: created.length,
    accountsCreated: accounts.length,
    accounts,
    // The class every row went to, so the caller never has to assume it.
    classId: chosenClass ? chosenClass.id : null,
    classLabel: chosenClass ? classLabel(chosenClass) : null,
  }, message, 201);
});

/** POST /api/v1/admin/students — create student (login auto-provisioned) */
router.post('/students', async (req, res) => {
  const parsed = studentSchemaRefined.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  if (!parsed.data.classId && !parsed.data.class) {
    return sendValidationError(res, { classId: ['Choose a class'] });
  }
  try {
    /* Admission writes the Student row and their first enrollment together, so the
       child can never exist without a seat for this year. A student with a class
       but no enrollment is invisible to Class Management: the Promote tab would not
       offer to move them and their history would read as an empty year that
       happened to contain them. */
    const created = await prisma.$transaction(async (tx) => {
      /* The duplicate rule, applied HERE rather than before the transaction so
         there is no window between the check and the write. The advisory lock on
         the identity triple then serialises two simultaneous admissions of the
         same child — the one that loses waits, reads the winner's row, and is
         refused rather than both sailing through. */
      await enrollment.lockIdentity(tx, parsed.data);
      const duplicates = await enrollment.findDuplicateStudent(parsed.data, { client: tx });
      if (duplicates.length) {
        throw Object.assign(
          new Error(enrollment.duplicateMessage(duplicates[0])),
          { code: 'DUPLICATE_IDENTITY', status: 409, duplicate: { studentId: duplicates[0].student.id } },
        );
      }

      /* The class the row will land in, resolved once: the roll number below needs
         it and the create needs it. */
      const studentData = await studentDataFrom(parsed.data);
      const row = await tx.student.create({
        data: {
          id: newId('stu'),
          ...studentData,
          /* A blank roll number gets the next free one in that class, exactly as
             Bulk Add does it — the same two helpers, read inside this transaction,
             so a single admission and a bulk import cannot number the class
             differently. Left NULL until now on purpose: the row has to exist
             before its class is known, and a guess outside the transaction could
             hand out a number the batch was already given. */
          rollNumber: parsed.data.rollNumber ? parsed.data.rollNumber : await nextRollNumberFor(tx, studentData.classId),
        },
        include: { class: { include: { level: true } } },
      });
      await enrollment.syncLiveEnrollment(tx, row.id);
      // The two legacy fee inputs become the current year's per-year record. When
      // both are given, what was already paid is recorded as one opening payment
      // so the starting balance is exactly the old `feeDues`.
      await fees.applyLegacyFee(tx, {
        studentId: row.id,
        feeTotal: parsed.data.feeTotal,
        feeDues: parsed.data.feeDues,
        openingPaidOn: row.enrolledAt,
      });
      return tx.student.findUnique({ where: { id: row.id }, include: { class: { include: { level: true } } } });
    }, { timeout: 60000, maxWait: 15000 });
    // Auto-provision the student's login: username from the name (suffix on
    // collision), initial password = guardian contact. Null when the student
    // has no guardian contact on file (nothing to derive a password from).
    const account = await createStudentAccount(created, { taken: await loadTakenUsernames() });
    const message = account
      ? `Student created. Login: ${account.username} (initial password = guardian contact — returned now only; it cannot be retrieved afterwards and must be changed at first login)`
      : 'Student created';
    return sendSuccess(res, { ...mapStudent(created), account }, message, 201);
  } catch (err) {
    if (err.code === 'P2002') return sendError(res, uniqueErrorMessage(err), 409, 'DUPLICATE');
    if (err.code === 'DUPLICATE_IDENTITY') return sendError(res, err.message, 409, 'DUPLICATE_IDENTITY');
    // A class value that matched no level, or a classId that matches no class.
    // The message already lists the valid levels, so it can be shown as-is.
    if (err.code === 'UNKNOWN_LEVEL' || err.code === 'UNKNOWN_CLASS' || err.code === 'MISSING_CLASS') {
      return sendError(res, err.message, 400, err.code);
    }
    throw err;
  }
});

/** PUT /api/v1/admin/students/:id — update student */
router.put('/students/:id', async (req, res) => {
  const parsed = studentSchemaRefined.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const existing = await prisma.student.findUnique({ where: { id: req.params.id } });
  if (!existing) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  if (!parsed.data.classId && !parsed.data.class) {
    return sendValidationError(res, { classId: ['Choose a class'] });
  }
  try {
    /* The enrollment is synced inside the same transaction as the Student row, so a
       class correction and the seat that records it land together. `syncLiveEnrollment`
       is a no-op when the class did not change, which is the normal case for an edit
       that only touched, say, a phone number — such an edit leaves the enrollment
       history completely untouched.

       This is deliberately NOT treated as a promotion: a correction fixes today's
       seat and says nothing about any other year. */
    const updated = await prisma.$transaction(async (tx) => {
      /* The same duplicate rule, with the row being edited left out: a student
         whose own record is compared against itself is trivially a duplicate, and
         the check would otherwise refuse every save of an unchanged name. */
      await enrollment.lockIdentity(tx, parsed.data);
      const duplicates = await enrollment.findDuplicateStudent(parsed.data, {
        client: tx,
        excludeStudentIds: [req.params.id],
      });
      if (duplicates.length) {
        throw Object.assign(
          new Error(enrollment.duplicateMessage(duplicates[0])),
          { code: 'DUPLICATE_IDENTITY', status: 409, duplicate: { studentId: duplicates[0].student.id } },
        );
      }

      const row = await tx.student.update({
        where: { id: req.params.id },
        data: await studentDataFrom(parsed.data),
        include: { class: { include: { level: true } } },
      });
      await enrollment.syncLiveEnrollment(tx, row.id);

      // The student's current fee row — the year they are actually seated in —
      // carries the class it was charged FOR, so a class correction keeps its
      // label honest. Amounts are untouched unless the form supplied one.
      const feeYear = await fees.feeYearForStudent(tx, row.id);
      if (feeYear) {
        await tx.studentFee.updateMany({
          where: { studentId: row.id, academicYearId: feeYear.id },
          data: { classId: row.classId },
        });
      }
      if (parsed.data.feeTotal !== undefined || parsed.data.feeDues !== undefined) {
        await fees.applyLegacyFee(tx, {
          studentId: row.id,
          feeTotal: parsed.data.feeTotal,
          feeDues: parsed.data.feeDues,
          openingPaidOn: row.enrolledAt,
        });
      }
      return tx.student.findUnique({ where: { id: row.id }, include: { class: { include: { level: true } } } });
    }, { timeout: 60000, maxWait: 15000 });
    return sendSuccess(res, mapStudent(updated), 'Student updated');
  } catch (err) {
    // A roll number already taken in the target class fails on the per-(class, year)
    // enrollment unique index exactly as it does on the Student one.
    if (err.code === 'P2002') return sendError(res, uniqueErrorMessage(err), 409, 'DUPLICATE');
    if (err.code === 'DUPLICATE_IDENTITY') return sendError(res, err.message, 409, 'DUPLICATE_IDENTITY');
    // A class value that matched no level, or a classId that matches no class.
    // The message already lists the valid levels, so it can be shown as-is.
    if (err.code === 'UNKNOWN_LEVEL' || err.code === 'UNKNOWN_CLASS' || err.code === 'MISSING_CLASS') {
      return sendError(res, err.message, 400, err.code);
    }
    throw err;
  }
});

/** DELETE /api/v1/admin/students/:id */
/**
 * Delete one student, and their login account with them.
 *
 * The User row used to survive the delete, which left a real account in the
 * database holding a valid password hash and a valid refresh token for a person
 * who is no longer on roll. Nothing in the app could read or use it, and the
 * User Accounts screen still listed it, so the office was shown an account for a
 * student they had just deleted.
 *
 * The login is found through the `User.student` relation, so a student created
 * without a guardian contact (and therefore with no account) has nothing to remove. — created without a guardian
 * contact — simply has no row to remove). Deleting the user also drops its
 * refresh tokens, which cascade from the User row.
 */
router.delete('/students/:id', async (req, res) => {
  try {
    // `User.student` is a relation, not a scalar FK, so the lookup filters on the
    // related row rather than on a studentId column.
    const user = await prisma.user.findFirst({
      where: { student: { id: req.params.id } },
      select: { id: true },
    });
    // The student first: if the delete is refused for dependent records, the
    // account must survive too, or the office is left with an orphaned login.
    await prisma.student.delete({ where: { id: req.params.id } });
    if (user) await prisma.user.delete({ where: { id: user.id } });
    return sendSuccess(res, { id: req.params.id, accountRemoved: Boolean(user) }, 'Student deleted');
  } catch (err) {
    if (err.code === 'P2025') return sendError(res, 'Student not found', 404, 'NOT_FOUND');
    if (err.code === 'P2003') return sendError(res, 'Student has dependent records (attendance/marks/achievements)', 409, 'CONFLICT');
    throw err;
  }
});

/**
 * POST /api/v1/admin/students/:id/create-login — provision the login for a
 * student who has none.
 *
 * Every student created through this admin surface gets a login automatically
 * (services/studentAccounts.js), but a student admitted before that, or one
 * whose guardian contact was added later, can still be sitting on the register
 * with no account at all. This route is the one place that closes that gap, and
 * it applies the SAME rule the admission paths do: username from the student's
 * name (a numeric suffix on a collision, never a failure), initial password =
 * the guardian contact exactly as stored, bcrypt-hashed, flagged
 * `mustChangePassword` so the predictable default is only usable until the
 * student's first login.
 *
 * Refusals, all deliberate:
 *   409 LOGIN_EXISTS — the student already has an account. An existing login is
 *     NEVER touched by this route: a password reset from User Accounts is the
 *     way to change one, and silently replacing it would lock out whoever is
 *     already signing in.
 *   400 NO_GUARDIAN_CONTACT — nothing to derive the initial password from. The
 *     contact is filled in with Edit Student (now a required field there).
 *
 * The derivation rule is stated in THIS response and nowhere else afterwards —
 * the same one-time handover moment an Add Student gives the office.
 */
router.post('/students/:id/create-login', async (req, res) => {
  const student = await prisma.student.findUnique({
    where: { id: req.params.id },
    select: { id: true, name: true, guardianContact: true, userId: true },
  });
  if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  if (student.userId) {
    return sendError(
      res,
      'This student already has a login account. To change its password, use Reset Password in User Accounts — an existing login is never replaced.',
      409,
      'LOGIN_EXISTS',
    );
  }
  if (!String(student.guardianContact ?? '').trim()) {
    return sendError(
      res,
      'This student has no guardian contact on file, and the initial password is the guardian contact. Add one with Edit Student first, then create the login.',
      400,
      'NO_GUARDIAN_CONTACT',
    );
  }

  try {
    const account = await createStudentAccount(student, { taken: await loadTakenUsernames() });
    // createStudentAccount only skips when the contact is blank, which was just
    // ruled out above — so this is a belt-and-braces guard, not an expected path.
    if (!account) {
      return sendError(
        res,
        'This student has no guardian contact on file, and the initial password is the guardian contact. Add one with Edit Student first, then create the login.',
        400,
        'NO_GUARDIAN_CONTACT',
      );
    }
    return sendSuccess(
      res,
      { account },
      `Login created: ${account.username} — initial password = guardian contact (returned now only; it cannot be retrieved afterwards and must be changed at first login)`,
      201,
    );
  } catch (err) {
    if (err.code === 'P2002') return sendError(res, uniqueErrorMessage(err), 409, 'DUPLICATE');
    throw err;
  }
});

/* ---------- Employees CRUD ---------- */

/* Shared include: employee + teaching assignments (with class + student counts) */
const EMPLOYEE_INCLUDE = {
  classesTaught: { include: { class: { include: { _count: { select: { students: true } } } } } },
  // The open EmploymentEnd row, so every employee read carries `employment` —
  // the reason and last working day for anyone currently off staff.
  ...openEmploymentEnd,
};

/**
 * Writable employee fields.
 *
 * `status` is deliberately NOT here. It is owned by
 * `POST /employees/:id/end-employment` and `POST /employees/:id/reactivate`
 * alone, because it is the "is this person on the staff list" switch and those
 * two routes are what give it meaning: a status flipped through the edit form
 * would put someone off staff with no reason, no last working day, no audit
 * trail and no timeline row — an off-staff employee the app could never explain
 * or reverse. A create always starts them `active` (see `employeeDataFrom`).
 */
const employeeSchema = z.object({
  name: z.string().min(2).max(100),
  employeeId: z.string().min(1).max(50).optional(),
  gender: z.enum(Object.values(Gender)).optional(),
  dob: dateStr.optional(),
  bloodGroup: z.string().max(5).optional(),
  mobile: contactSchema.optional(),
  email: z.string().email().optional(),
  address: z.string().min(5).max(300).optional(),
  emergencyContact: contactSchema.optional(),
  department: z.string().min(1).max(100).optional(),
  designation: z.string().min(1).max(100).optional(),
  role: z.enum(EMPLOYEE_ROLES).optional(),
  qualification: z.string().max(200).optional(),
  dateOfJoining: dateStr.optional(),
  experience: z.string().max(50).optional(),
  reportingPrincipal: z.string().max(100).optional(),
  employmentType: z.enum(Object.values(EmploymentType)).optional(),
  // Default salary structure (₹, whole rupees, non-negative) — saved on the
  // employee form, prefilled into each new payroll month. Component set
  // mirrors PayrollRecord / payrollSchema exactly.
  basicPay: z.number().int().min(0).max(10000000).optional(),
  hra: z.number().int().min(0).max(10000000).optional(),
  transportAllowance: z.number().int().min(0).max(10000000).optional(),
  medicalAllowance: z.number().int().min(0).max(10000000).optional(),
  providentFund: z.number().int().min(0).max(10000000).optional(),
  professionalTax: z.number().int().min(0).max(10000000).optional(),
  tds: z.number().int().min(0).max(10000000).optional(),
});

/** Employee payload → Prisma data (dates as @db.Date, enums verbatim) */
const employeeDataFrom = (d) => ({
  name: d.name,
  employeeId: d.employeeId ?? null,
  gender: d.gender ?? null,
  dob: apiDate(d.dob),
  bloodGroup: d.bloodGroup ?? null,
  mobile: d.mobile ?? null,
  email: d.email ?? null,
  address: d.address ?? null,
  emergencyContact: d.emergencyContact ?? null,
  department: d.department ?? null,
  designation: d.designation ?? null,
  role: d.role ?? null,
  qualification: d.qualification ?? null,
  dateOfJoining: apiDate(d.dateOfJoining),
  experience: d.experience ?? null,
  reportingPrincipal: d.reportingPrincipal ?? null,
  employmentType: d.employmentType ?? null,
  // Default salary structure — always written in full (the form sends every
  // component), so a partial payload never leaves a stale component behind.
  basicPay: d.basicPay ?? 0,
  hra: d.hra ?? 0,
  transportAllowance: d.transportAllowance ?? 0,
  medicalAllowance: d.medicalAllowance ?? 0,
  providentFund: d.providentFund ?? 0,
  professionalTax: d.professionalTax ?? 0,
  tds: d.tds ?? 0,
});

/** GET /api/v1/admin/employees — list all employees */
router.get('/employees', async (req, res) => {
  const rows = await prisma.employee.findMany({ include: EMPLOYEE_INCLUDE, orderBy: { id: 'asc' } });
  return sendSuccess(res, rows.map(mapEmployee));
});

/**
 * GET /api/v1/admin/employees/:id — one employee with their CURRENT salary
 * structure.
 *
 * The employee record carries a stored default salary structure, but those
 * columns can legally be zeros: a wage can be worked out on the Payroll screen
 * instead, which writes per-month PayrollRecord rows and never touches the
 * employee's default columns. The Edit Employee form must prefill the same
 * figures Payroll displays, so `salaryStructure` resolves the same way the
 * Payroll page's own editor does — the latest saved payroll month first, the
 * stored default structure only when no month exists. Everything comes from
 * real rows; nothing is derived from constants or hardcoded values.
 */
router.get('/employees/:id', async (req, res) => {
  /* The FULL timeline, not just the open ending: the details view shows the
     rehired-after-resigned history that a single row could never express. Note
     this include REPLACES `EMPLOYEE_INCLUDE`'s `employmentEnds` entry rather
     than layering on it — both key on the same relation, so spreading both would
     silently keep whichever came last. `employment()` re-derives the current
     status from whatever rows it is handed, so either include stays correct. */
  const employee = await prisma.employee.findUnique({
    where: { id: req.params.id },
    include: { ...EMPLOYEE_INCLUDE, employmentEnds: employmentHistory.employmentEnds },
  });
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  const latest = await prisma.payrollRecord.findFirst({
    where: { employeeId: employee.id },
    orderBy: { month: 'desc' },
    select: {
      basicPay: true, hra: true, transportAllowance: true, medicalAllowance: true,
      providentFund: true, professionalTax: true, tds: true,
    },
  });

  /* Both reads are independent and neither depends on the other, so they go out
     together rather than making the details view wait for two round trips in
     series. Counts come straight from the tables — never a stored total — so
     "can this record be permanently deleted" can never be stale. */
  const [dependencies] = await Promise.all([dependentRecords(employee.id)]);

  // All seven components are non-null Ints on both models, so a plain logical
  // pick between the latest month and the stored default is unambiguous.
  const src = latest ?? employee;
  return sendSuccess(res, {
    ...mapEmployee(employee),
    /* Newest first, so index 0 is the most recent event. `mapEmployee` above
       already reduced this to the open row in `employment`; the two are read
       from the same include, so they cannot disagree. */
    employmentHistory: (employee.employmentEnds || []).map(mapEmploymentEnd),
    dependentRecords: dependencies.records,
    canDeletePermanently: dependencies.canDeletePermanently,
    salaryStructure: {
      basicPay: src.basicPay,
      hra: src.hra,
      transportAllowance: src.transportAllowance,
      medicalAllowance: src.medicalAllowance,
      providentFund: src.providentFund,
      professionalTax: src.professionalTax,
      tds: src.tds,
      source: latest ? 'payroll' : 'default',
    },
  });
});

/** POST /api/v1/admin/employees — create employee */
router.post('/employees', async (req, res) => {
  const parsed = employeeSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  try {
    const created = await prisma.employee.create({
      /* A new hire joins the active staff list; the only route to `inactive` is
         ending an employment, which needs a row that does not exist yet. */
      data: { id: newId('emp'), status: 'active', ...employeeDataFrom(parsed.data) },
    });
    const full = await prisma.employee.findUnique({ where: { id: created.id }, include: EMPLOYEE_INCLUDE });
    return sendSuccess(res, mapEmployee(full), 'Employee created', 201);
  } catch (err) {
    if (err.code === 'P2002') return sendError(res, uniqueErrorMessage(err), 409, 'DUPLICATE');
    throw err;
  }
});

/** PUT /api/v1/admin/employees/:id — update employee */
router.put('/employees/:id', async (req, res) => {
  /* `status` is not in `employeeSchema`, so zod silently strips it. Reject it
     loudly instead: a caller that thinks it deactivated an employee through
     this route would get an "Employee updated" response and an employee who is
     still on staff. Point them at the route that actually means it. */
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'status')) {
    return sendError(
      res,
      'Employment status is set by End Employment / Reactivate, not by editing the profile.',
      409,
      'STATUS_NOT_EDITABLE',
    );
  }

  const parsed = employeeSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const existing = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!existing) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  await prisma.employee.update({ where: { id: req.params.id }, data: employeeDataFrom(parsed.data) });
  const updated = await prisma.employee.findUnique({ where: { id: req.params.id }, include: EMPLOYEE_INCLUDE });
  return sendSuccess(res, mapEmployee(updated), 'Employee updated');
});

/**
 * DELETE /api/v1/admin/employees/:id — the RARE permanent path.
 *
 * Only for a record that was never used: a duplicate typed by mistake, or a
 * placeholder for someone who never started. It is deliberately not the row's
 * everyday action — someone who has genuinely left is ended, not deleted, so
 * their payroll, attendance, marks, leave and documents survive.
 *
 * The refusal is still the foreign keys', not a rule invented here: P2003 means
 * a dependent row exists, and this cascade would take it with the employee. The
 * message now names what is in the way and says which route to use instead,
 * because "Employee has dependent records" reads like a dead end when the answer
 * is simply "end their employment".
 */
router.delete('/employees/:id', async (req, res) => {
  try {
    await prisma.employee.delete({ where: { id: req.params.id } });
    return sendSuccess(res, { id: req.params.id }, 'Employee deleted');
  } catch (err) {
    if (err.code === 'P2025') return sendError(res, 'Employee not found', 404, 'NOT_FOUND');
    if (err.code === 'P2003') {
      return sendError(
        res,
        'This employee has records that depend on them, so they cannot be deleted. Use End Employment instead — it takes them off the staff list while keeping their payroll, attendance, marks, leave and documents.',
        409,
        'CONFLICT',
      );
    }
    throw err;
  }
});

/* ---------- Employment lifecycle ---------- */

/**
 * The admin who processed an employment event, recorded as the login username.
 *
 * A username rather than a User foreign key — the same choice
 * `MarksEntry.enteredBy` makes and for the same reason: the audit trail has to
 * survive the account it refers to. `endsBy` is also the identifier the audit log
 * itself uses, so one string ties the two together.
 */
const actorOf = (req) => req.user.username;

/** Load an employee for a lifecycle write, with the link needed to demote a login. */
const loadEmployee = async (id) =>
  prisma.employee.findUnique({ where: { id }, select: { id: true, userId: true, status: true } });

/**
 * Re-read an employee after a lifecycle write, fully mapped, so the response the
 * admin's list receives is exactly the row its next render would fetch.
 */
const readEmployee = async (id) => {
  const row = await prisma.employee.findUnique({ where: { id }, include: EMPLOYEE_INCLUDE });
  return mapEmployee(row);
};

/**
 * POST /api/v1/admin/employees/:id/end-employment
 *
 * Takes someone off the staff list without destroying a single record they own.
 * Writes the timeline row and demotes both the employee and their portal login in
 * one transaction, so there is no instant where the person is off staff but can
 * still sign in.
 *
 * Body:
 *   reason          required — an EmploymentEndReason value (the enum, so the
 *                   API and the modal's dropdown cannot disagree)
 *   lastWorkingDay  required — 'YYYY-MM-DD', the employee's own last day. Kept
 *                   separate from `endedAt` (when the office processed it) because
 *                   payroll is cut off on this date and terminations are routinely
 *                   filed late. A future date is allowed: that is a notice period,
 *                   not a mistake, and this route does not decide who gets paid.
 *   description     optional — free text, normalised then bounded
 *                   (EMPLOYMENT_DESCRIPTION_MAX), exactly as on the leave reason.
 */
const endEmploymentSchema = z.object({
  reason: z.enum(Object.values(EmploymentEndReason)),
  lastWorkingDay: dateStr,
  description: z
    .string()
    .optional()
    .transform(normalizeDescription)
    .refine((v) => v.length <= EMPLOYMENT_DESCRIPTION_MAX, {
      message: `Description must be at most ${EMPLOYMENT_DESCRIPTION_MAX} characters`,
    }),
});

router.post('/employees/:id/end-employment', async (req, res) => {
  const employee = await loadEmployee(req.params.id);
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  const parsed = endEmploymentSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);
  const { reason, lastWorkingDay, description } = parsed.data;

  /* Their last day cannot precede the day they joined — it would be a payroll
     cutoff that closes before the employment it cuts off ever began. */
  const joined = await prisma.employee.findUnique({
    where: { id: req.params.id },
    select: { dateOfJoining: true },
  });
  if (joined?.dateOfJoining && lastWorkingDay < joined.dateOfJoining.toISOString().slice(0, 10)) {
    return sendError(
      res,
      'Last working day cannot be earlier than the date of joining.',
      400,
      'VALIDATION_ERROR',
    );
  }

  /* Refuse before writing anything, and say why: the linked login belongs to an
     admin account, so ending this employment would lock the office out of its
     own system. Worth catching even though the seeded staff have no such link. */
  if (employee.userId) {
    const linked = await prisma.user.findUnique({
      where: { id: employee.userId },
      select: { role: true },
    });
    if (linked?.role === ROLES.ADMIN) {
      return sendError(
        res,
        'This employee is linked to an admin login account, which cannot be disabled. Unlink or reassign the account first.',
        409,
        'ADMIN_LINK_CONFLICT',
      );
    }
  }

  let result;
  try {
    result = await endEmployment({
      employee,
      reason,
      lastWorkingDay: apiDate(lastWorkingDay),
      description,
      actor: actorOf(req),
    });
  } catch (err) {
    /* The precondition lives inside the transaction (see services/employment.js)
       so two concurrent ends cannot both write an open row. */
    if (err && err.code === 'ALREADY_ENDED') {
      return sendError(res, 'This employee has already had their employment ended.', 409, 'ALREADY_ENDED');
    }
    throw err;
  }

  const fresh = await readEmployee(employee.id);
  return sendSuccess(
    res,
    { employee: fresh, employment: result.end },
    `Employment ended for ${fresh.name}. Their records have been kept.`,
  );
});

/**
 * POST /api/v1/admin/employees/:id/reactivate — the rehire path.
 *
 * Restores the active status and the portal login, and stamps the open timeline
 * row with who reopened it and when. The previous ending is NOT removed, so the
 * history reads hired → ended → rehired instead of resetting to a single spell.
 */
router.post('/employees/:id/reactivate', async (req, res) => {
  const employee = await loadEmployee(req.params.id);
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  try {
    await reactivate({ employee, actor: actorOf(req) });
  } catch (err) {
    if (err && err.code === 'NOT_ENDED') {
      return sendError(res, 'This employee is already on the active staff list.', 409, 'NOT_ENDED');
    }
    throw err;
  }

  const fresh = await readEmployee(employee.id);
  return sendSuccess(res, { employee: fresh }, `${fresh.name} reactivated.`);
});

/* ---------- Leaves ---------- */

/**
 * GET /api/v1/admin/leaves/pending — list all pending leave applications
 *
 * `employeeDesignation` rides along with the name because the Leave Approval
 * screen's "View more" popup is headed by the employee: without the designation
 * the popup could not say whose request it is showing, and the list would have
 * to fetch it in a second request.
 */
router.get('/leaves/pending', async (req, res) => {
  const pending = await prisma.leaveRequest.findMany({
    where: { status: 'pending' },
    include: { employee: { select: { name: true, designation: true } } },
    orderBy: { appliedAt: 'desc' },
  });
  return sendSuccess(res, pending.map((l) => ({
    ...mapLeave(l),
    employeeId: l.employeeId,
    employeeName: l.employee?.name || null,
    employeeDesignation: l.employee?.designation || null,
  })));
});

/** PUT /api/v1/admin/leaves/:leaveId/status — approve or reject a leave */
const leaveStatusSchema = z.object({
  status: z.enum(['approved', 'rejected']),
});

router.put('/leaves/:leaveId/status', async (req, res) => {
  const parsed = leaveStatusSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  try {
    await prisma.leaveRequest.update({
      where: { id: req.params.leaveId },
      data: { status: parsed.data.status, decidedAt: new Date() },
    });
    return sendSuccess(res, null, `Leave ${parsed.data.status} successfully`);
  } catch (err) {
    if (err.code === 'P2025') return sendError(res, 'Leave record not found', 404, 'NOT_FOUND');
    throw err;
  }
});

/* ---------- Class Management (academic years, promotion, class history, backfill) ---------- */

/*
 * Admin-only by construction: the whole router is already behind
 * `requireRole([ROLES.ADMIN])` above, so none of these endpoints can be reached
 * from the Employee Portal. That is deliberate rather than a per-route check —
 * a gate repeated on twenty handlers is a gate that eventually gets forgotten on
 * the twenty-first.
 *
 * Every value these return is derived from real rows. The top grade comes from the
 * classes that actually have students, the year list from the AcademicYear table,
 * a year's class structure from that year's enrollments, and every student figure
 * from the students themselves — so nothing about the school is assumed here.
 */

/** Turn a service error code into the HTTP status the client should see. */
const CLASS_MGMT_ERRORS = {
  NOT_FOUND: [404, null],
  NO_CURRENT_YEAR: [500, 'The school has no academic year covering today.'],
  NO_TARGET_YEAR: [409, 'There is no academic year after the current one to promote into.'],
  CLASS_IS_TOP: [409, null],
  // The class to promote out of has no successor level in the level list. The
  // message says what to do about it: add the next level.
  NO_NEXT_LEVEL: [409, null],
  NOTHING_TO_PROMOTE: [409, 'No students left to promote - every student was excluded.'],
  NOTHING_TO_PASS_OUT: [409, 'That class has no students to pass out.'],
  UNREVIEWED_STUDENTS: [409, null],
  MISSING_IDENTITY: [400, null],
  AMBIGUOUS_SUBJECT: [400, null],
  INCOMPLETE_ATTENDANCE: [400, null],
  INVALID_ATTENDANCE: [400, null],
  ATTENDANCE_EXCEEDS_TERM: [400, null],
  MARK_MISSING_EXAM: [400, null],
  MARK_MISSING_SUBJECT: [400, null],
  MARK_BAD_MAX: [400, null],
  MARK_OUT_OF_RANGE: [400, null],
  ALREADY_RECORDED_IN_OTHER_CLASS: [409, null],
  NO_CURRENT_CLASS: [409, null],
  ALREADY_HANDLED: [409, null],
  BAD_ACTION: [400, null],
  // A chosen target that is not real, or not a step forward. A past/same year is a
  // conflict with the world state (409); an id that names no class/year is a
  // malformed choice the form can focus (400).
  YEAR_NOT_LATER: [409, null],
  UNKNOWN_YEAR: [400, 'That academic year does not exist'],
  UNKNOWN_CLASS: [400, 'That class does not exist'],
  // One seat per (student, year): a second one is a conflict, not a bad request.
  DUPLICATE_SEAT: [409, null],
  NOTHING_TO_UNDO: [409, null],
  UNDO_WINDOW_CLOSED: [409, null],
  INVALID_AMOUNT: [400, null],
  INVALID_DATE: [400, null],
  AMOUNT_EXCEEDS_DUES: [409, null],
  NO_DUES: [409, null],
  // The one identity rule, shared by Add Student, Edit Student, Bulk Add, Enter
  // Past Data and promotion. One entry here covers every one of those paths.
  DUPLICATE_IDENTITY: [409, null],
};

/**
 * Turn a class-management service failure into the right response for the client.
 *
 * The distinction that matters is between "your request is malformed — fix the
 * form" and "the request was fine, the world state conflicts". Those are answered
 * differently on purpose:
 *
 *   MALFORMED (400) — sent through `sendValidationError`, which carries a per-field
 *     `errors` map so the form can focus the box, exactly as the rest of this
 *     router reports a bad payload.
 *
 *   CONFLICT (409) — sent through `sendError` with its own code, even when the
 *     service named a field. This is what was getting lost: a child already
 *     recorded in another class that year is a genuine conflict, and reporting it
 *     as `VALIDATION_ERROR`/400 told the client the request was malformed, dropped
 *     the code that distinguishes it, and left the office with a red class dropdown
 *     and no idea that they need to delete a record first.
 *
 * Every one of these is an expected outcome of a deliberate user action, so they
 * are answered with the service's own wording rather than a generic 500 — and that
 * wording names the students involved, because "3 students need review" sends the
 * admin hunting for something they already scrolled past.
 */
const classMgmtError = (res, err) => {
  const entry = CLASS_MGMT_ERRORS[err?.code];
  if (!entry) return null;
  const [status, message] = entry;
  if (status === 400 && err.field) {
    return sendValidationError(res, { [err.field]: message || err.message });
  }
  return sendError(res, message || err.message, status, err.code);
};

/**
 * GET /api/v1/admin/class-management/years — every academic year, newest first.
 *
 * `isCurrent` is recomputed server-side from each year's DATE RANGE rather than
 * read from its stored flag, so the year the UI calls "current" and the year a
 * promotion would actually move students into can never disagree.
 */
router.get('/class-management/years', async (req, res) => {
  const years = await enrollment.listYears();
  return sendSuccess(res, years);
});

/**
 * GET /api/v1/admin/class-management/overview — the Promote Classes tab.
 *
 * Every class with its live headcount, plus for each class the action that
 * applies: graduate the top grade, promote the rest. `topGradeBasis` is returned
 * so the screen can state WHICH rule picked the top class — "highest grade with
 * students: 10" is a rule the office can check, whereas a graduating class that
 * appears without explanation is just a surprise.
 */
router.get('/class-management/overview', async (req, res) => {
  try {
    return sendSuccess(res, await enrollment.classOverview());
  } catch (err) {
    return classMgmtError(res, err) || sendError(res, 'Could not load the class overview', 500, 'OVERVIEW_FAILED');
  }
});

/**
 * GET /api/v1/admin/class-management/years/:yearId/classes
 *
 * The class structure AS IT WAS in that year, which is what the Class History
 * selector needs and is emphatically NOT today's class list: a 9-B that everyone
 * was promoted out of must not appear as a choice for 2024-25. Each class reports
 * how many enrollment rows it has that year, so the caller can show what ran and
 * offer to start a year that did not (which "Enter Past Data" legitimately needs).
 */
router.get('/class-management/years/:yearId/classes', async (req, res) => {
  const classes = await enrollment.classesForYear(req.params.yearId);
  return sendSuccess(res, classes);
});

/**
 * GET /api/v1/admin/class-management/years/:yearId/classes/:classId/roster
 *
 * Everyone in that class in that year, read from the enrollment table. Returns an
 * empty list — not an error — for a year/class with nothing recorded, which is
 * the Class History empty state.
 */
router.get('/class-management/years/:yearId/classes/:classId/roster', async (req, res) => {
  const roster = await enrollment.rosterFor({
    academicYearId: req.params.yearId,
    classId: req.params.classId,
  });
  return sendSuccess(res, roster);
});

/**
 * GET /api/v1/admin/class-management/students/:studentId/promotion-options
 * GET /api/v1/admin/class-management/classes/:classId/promotion-options
 *
 * Everything the promotion popup renders, derived from the tables: the current
 * year and class, the suggested next year and class, the list of years an admin
 * may choose (every year AFTER the current one), and the list of real classes.
 * Read-only — it writes nothing, and the chosen target is re-validated inside the
 * move transaction, so a screen left open cannot act on a stale choice.
 */
router.get('/class-management/students/:studentId/promotion-options', async (req, res) => {
  try {
    return sendSuccess(res, await enrollment.promotionOptions({ studentId: req.params.studentId }));
  } catch (err) {
    return classMgmtError(res, err) || sendError(res, 'Could not build the promotion options', 500, 'OPTIONS_FAILED');
  }
});

router.get('/class-management/classes/:classId/promotion-options', async (req, res) => {
  try {
    return sendSuccess(res, await enrollment.promotionOptions({ classId: req.params.classId }));
  } catch (err) {
    return classMgmtError(res, err) || sendError(res, 'Could not build the promotion options', 500, 'OPTIONS_FAILED');
  }
});

/**
 * GET /api/v1/admin/class-management/classes/:classId/promotion-plan
 *
 * The review screen. Read-only: it changes nothing, and the matching plan it
 * reports is re-derived inside the promote transaction, so a screen left open
 * against a class that changed underneath it cannot promote a roster the admin
 * never saw.
 */
router.get('/class-management/classes/:classId/promotion-plan', async (req, res) => {
  try {
    return sendSuccess(res, await enrollment.promotionPlan({ classId: req.params.classId }));
  } catch (err) {
    return classMgmtError(res, err) || sendError(res, 'Could not build the promotion plan', 500, 'PLAN_FAILED');
  }
});

/**
 * POST /api/v1/admin/class-management/classes/:classId/promote
 *
 * Moves the whole class up a grade for the next academic year, in one atomic
 * transaction — all of them or none of them. `confirm` and `exclude` are the
 * admin's answers to the review screen's flags: a flagged student who is neither
 * confirmed nor excluded stops the batch with their name, so nothing ambiguous is
 * ever resolved silently.
 */
const promoteSchema = z.object({
  confirm: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  // Optional chosen target. Absent → the next year and the next class, as before.
  toAcademicYearId: z.string().min(1).optional(),
  toClassId: z.string().min(1).optional(),
});

router.post('/class-management/classes/:classId/promote', async (req, res) => {
  const parsed = promoteSchema.safeParse(req.body || {});
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  try {
    const result = await enrollment.promoteClass({ classId: req.params.classId, ...parsed.data });
    const skipped = result.excluded.length ? ` ${result.excluded.length} left behind.` : '';
    return sendSuccess(
      res,
      result,
      `${result.movedCount} student${result.movedCount === 1 ? '' : 's'} promoted from ${result.sourceClassLabel} to ${result.targetClassLabel} for ${result.toAcademicYearLabel}.${skipped}`,
    );
  } catch (err) {
    return classMgmtError(res, err) || sendError(res, 'Could not promote the class', 500, 'PROMOTE_FAILED');
  }
});

/**
 * POST /api/v1/admin/class-management/classes/:classId/pass-out
 *
 * Graduates the top class. Every student keeps all of their recorded history and
 * simply stops holding a current class, which is what removes them from every
 * live register and headcount in the app without a single other query changing.
 */
router.post('/class-management/classes/:classId/pass-out', async (req, res) => {
  try {
    const result = await enrollment.passOutClass({ classId: req.params.classId });
    return sendSuccess(
      res,
      result,
      `${result.passedOutCount} student${result.passedOutCount === 1 ? '' : 's'} from ${result.sourceClassLabel} marked as passed out. Their records stay available in Class History.`,
    );
  } catch (err) {
    return classMgmtError(res, err) || sendError(res, 'Could not mark the class as passed out', 500, 'PASS_OUT_FAILED');
  }
});

/**
 * GET /api/v1/admin/class-management/classes/:classId/students
 *
 * The class's CURRENT-year register for the roster panel, with what has already
 * happened to each child this cycle. Every row is a real enrollment seat, so a
 * student moved individually is still listed — with a "Promoted to 10-B" badge —
 * and the counts the card shows ("17 remaining") are read from the same set.
 */
router.get('/class-management/classes/:classId/students', async (req, res) => {
  try {
    return sendSuccess(res, await enrollment.classPromotionRoster({ classId: req.params.classId }));
  } catch (err) {
    return classMgmtError(res, err) || sendError(res, 'Could not load the class roster', 500, 'ROSTER_FAILED');
  }
});

/**
 * POST /api/v1/admin/class-management/students/:studentId/move
 *
 * Move ONE student for the current cycle: `promote` a grade, `keep` them in the
 * same class for the new year, or `pass_out`. All three roll the fee forward in
 * the same transaction. A student already moved this cycle is refused, so nobody
 * climbs two grades at once.
 *
 * The admin may CHOOSE where the student goes: `toAcademicYearId` and, for
 * `promote`/`keep`, `toClassId`. Omitting them keeps today's behaviour exactly
 * (the next year, the next class). `keep` ignores `toClassId` — repeating a year
 * means staying in the same class — and `pass_out` takes no target at all.
 */
const moveStudentSchema = z.object({
  action: z.enum(['promote', 'keep', 'pass_out']),
  toAcademicYearId: z.string().min(1).optional(),
  toClassId: z.string().min(1).optional(),
});

router.post('/class-management/students/:studentId/move', async (req, res) => {
  const parsed = moveStudentSchema.safeParse(req.body || {});
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  try {
    const result = await enrollment.moveStudent({
      studentId: req.params.studentId,
      action: parsed.data.action,
      // `keep` is always the same class, so any class in the body is ignored rather
      // than silently honoured — repeating the year cannot change the class.
      toAcademicYearId: parsed.data.toAcademicYearId ?? null,
      toClassId: parsed.data.action === 'keep' ? null : (parsed.data.toClassId ?? null),
    });
    const messages = {
      promoted: `${result.name} promoted to ${result.targetClassLabel} for ${result.toAcademicYearLabel}. Their fee starts blank for the new year; what they still owe stays as previous dues.`,
      kept: `${result.name} kept in ${result.targetClassLabel} for ${result.toAcademicYearLabel}. Their fee starts blank for the new year; what they still owe stays as previous dues.`,
      passed_out: `${result.name} marked as passed out of ${result.sourceClassLabel}. Their records stay available in Class History.`,
    };
    return sendSuccess(res, result, messages[result.kind]);
  } catch (err) {
    return classMgmtError(res, err) || sendError(res, 'Could not move the student', 500, 'MOVE_FAILED');
  }
});

/**
 * POST /api/v1/admin/class-management/students/:studentId/undo
 *
 * Reverse ONE student's move. Allowed only while nothing has been recorded for
 * the new year — the first attendance mark, mark entry or fee payment closes the
 * window, and the response says which rule stopped it.
 */
router.post('/class-management/students/:studentId/undo', async (req, res) => {
  try {
    const result = await enrollment.undoStudentMove({ studentId: req.params.studentId });
    return sendSuccess(res, result, `Undone. ${result.name} is back in ${result.restoredClassLabel || 'their previous class'}.`);
  } catch (err) {
    return classMgmtError(res, err) || sendError(res, 'Could not undo the move', 500, 'UNDO_FAILED');
  }
});

/**
 * GET /api/v1/admin/class-management/students/search
 *
 * Finds an existing child to attach a historical record to, by name, guardian
 * name or guardian contact — the same identity key promotion matches on, so the
 * two features can never disagree about who a child is.
 *
 * The tier on each hit is computed, never requested: the screen uses it to sort
 * and to require a human decision whenever the match is not unambiguous.
 */
router.get('/class-management/students/search', async (req, res) => {
  const q = req.query || {};
  const observed = {
    name: q.name ? String(q.name) : '',
    parentName: q.parentName ? String(q.parentName) : '',
    guardianContact: q.guardianContact ? String(q.guardianContact) : '',
  };
  if (!observed.name && !observed.parentName && !observed.guardianContact) {
    return sendValidationError(res, { name: 'Type a name, guardian name or contact to search' });
  }
  const results = await enrollment.searchIdentity(observed);
  return sendSuccess(res, results);
});

/**
 * POST /api/v1/admin/class-management/historical-records
 *
 * "Save Historical Record": one student's class, attendance totals and exam
 * results for one past academic year, atomically.
 *
 * Everything written is marked `source: 'historical'` so it can never be confused
 * with something the school recorded day to day — and the current-class pointer is
 * deliberately untouched, because a record of 2024-25 says nothing about where a
 * child is today.
 */
/* All three identity fields are required together, and the per-field wording is
   spelled out rather than left to zod's default. Zod's own message for an absent
   field is "Invalid input: expected string, received undefined", which tells the
   office nothing about why a guardian name is required in the first place — and
   this is the one form in Class Management whose failure explains a policy rather
   than a typo, so the message IS the guidance. */
const historicalStudentSchema = z.object({
  name: z.string({ error: 'Name is required' }).trim().min(1, 'Name is required').max(100),
  parentName: z.string({ error: 'Guardian name is required — this is how the student is matched in future years' })
    .trim().min(1, 'Guardian name is required — this is how the student is matched in future years').max(100),
  guardianContact: z.string({ error: 'Guardian contact is required — this is how the student is matched in future years' })
    .trim().min(1, 'Guardian contact is required — this is how the student is matched in future years').max(40),
});

const historicalRecordSchema = z.object({
  academicYearId: z.string().min(1, 'Choose the academic year'),
  classId: z.string().min(1, 'Choose the class'),
  existingStudentId: z.string().min(1).optional(),
  newStudent: historicalStudentSchema.optional(),
  rollNumber: z.string().trim().min(1).max(40).nullish(),
  /**
   * The three figures go in TOGETHER or not at all, and an absent one says which.
   *
   * "Validation failed · Invalid input: expected number, received undefined" is
   * what zod offers for a missing field, which leaves the office guessing which of
   * the three they forgot. Each message names the figure, and the pair that must
   * accompany it — a yearly summary that recorded absences as absent is a
   * different claim from one that recorded nothing at all.
   */
  attendance: z.object({
    workingDays: z.number({ error: 'Working days is required' }).int().nonnegative('Working days cannot be negative'),
    daysPresent: z.number({ error: 'Days present is required' }).int().nonnegative('Days present cannot be negative'),
    daysAbsent: z.number({ error: 'Days absent is required' }).int().nonnegative('Days absent cannot be negative'),
  }).nullish(),
  /* Each row is (exam, subject, maximum, obtained). The absent-field messages
     matter more than usual here: this is a repeatable row list, so a rejected row
     has to be identifiable by its text — "row 3 is invalid" sends the office
     hunting, while "Subject is required" points straight at the box. */
  marks: z.array(z.object({
    examName: z.string({ error: 'Exam name is required' }).min(1, 'Exam name is required').max(100),
    subject: z.string({ error: 'Subject is required' }).min(1, 'Subject is required').max(100),
    maxMarks: z.number({ error: 'Max marks is required' }).int().positive('Max marks must be above 0'),
    obtained: z.number({ error: 'Obtained marks is required' }).int().nonnegative('Obtained cannot be negative'),
    examDate: dateStr.nullish(),
  })).default([]),
}).refine((v) => Boolean(v.existingStudentId) !== Boolean(v.newStudent), {
  message: 'Choose an existing student, or add one as a new historical record',
  path: ['newStudent'],
});

router.post('/class-management/historical-records', async (req, res) => {
  const parsed = historicalRecordSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  try {
    const result = await enrollment.saveHistoricalRecord({
      ...parsed.data,
      actorUsername: req.user?.username || null,
    });
    const bits = [`recorded in ${result.classLabel} for ${result.academicYearLabel}`];
    if (result.attendance) bits.push(`${result.attendance.daysPresent}/${result.attendance.workingDays} days present`);
    if (result.marksSaved) bits.push(`${result.marksSaved} result${result.marksSaved === 1 ? '' : 's'}`);
    return sendSuccess(res, result, `${result.name} ${bits.join(', ')}.`);
  } catch (err) {
    return classMgmtError(res, err) || sendError(res, 'Could not save the historical record', 500, 'BACKFILL_FAILED');
  }
});

/**
 * GET /api/v1/admin/class-management/students/:studentId/years/:yearId
 *
 * One student's data AS RECORDED FOR ONE YEAR, which is what the year-scoped
 * Student Profile opened from Class History shows. Marks are filtered to the class
 * they were in THAT year, so a promoted child's 2024-25 results come from their
 * 2024-25 register rather than from — or instead of — this year's.
 */
router.get('/class-management/students/:studentId/years/:yearId', async (req, res) => {
  try {
    const view = await enrollment.studentYearView({
      studentId: req.params.studentId,
      academicYearId: req.params.yearId,
    });
    return sendSuccess(res, view);
  } catch (err) {
    return classMgmtError(res, err) || sendError(res, 'Could not load that student year', 500, 'YEAR_VIEW_FAILED');
  }
});

/* ---------- Payroll ---------- */

/** Strict month key: 'YYYY-MM' with a real month (01–12) */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Net payable — always recomputed server-side from the saved components. */
const netOf = (p) =>
  p.basicPay + p.hra + p.transportAllowance + p.medicalAllowance -
  p.providentFund - p.professionalTax - p.tds;

/**
 * Re-derive and persist `PayrollRecord.paidOn` from a record's payment rows.
 *
 * The column is a cache of the payments, not an independent fact, so it is
 * rewritten inside the same transaction as whatever changed. Called after every
 * payment insert/delete AND after a salary edit, because a lower net can settle
 * a partially-paid month and a higher one can unsettle a settled one.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} recordId
 * @param {number} netSalary
 * @returns {Promise<Date|null>} the settled-on date written.
 */
const resettle = (tx, recordId, netSalary) => {
  return tx.payrollPayment.findMany({ where: { payrollRecordId: recordId } })
    .then((rows) => {
      const on = settledOn(netSalary, rows);
      return tx.payrollRecord.update({ where: { id: recordId }, data: { paidOn: on } })
        .then(() => on);
    });
};

/** One record + its payments, for the routes that answer about a single month. */
const loadMonth = (employeeId, month) =>
  prisma.payrollRecord.findUnique({
    where: { employeeId_month: { employeeId, month } },
    include: { payments: { orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }] } },
  });

/** Shared 404 for a (employee, month) pair with no salary structure yet. */
const noRecord = (res, month) =>
  sendError(res, `No payroll record for ${monthLabel(month)} — save the salary structure first`, 404, 'NOT_FOUND');

/**
 * GET /api/v1/admin/payroll — every employee with their full payment history.
 *
 * One query per table (employees, records, ALL payments), grouped in memory, so
 * the whole payroll screen is one round trip however many employees and months
 * exist — a school's payroll is tens of rows, not thousands, and paying the
 * per-month detail fetch on the client instead would be N+1 requests to show a
 * list the admin already has open.
 */
router.get('/payroll', async (req, res) => {
  const [employees, records, payments] = await Promise.all([
    prisma.employee.findMany({ orderBy: { id: 'asc' } }),
    prisma.payrollRecord.findMany({ orderBy: [{ employeeId: 'asc' }, { month: 'asc' }] }),
    prisma.payrollPayment.findMany({ orderBy: { paidOn: 'desc' } }),
  ]);

  const byRecord = new Map();
  payments.forEach((p) => {
    const list = byRecord.get(p.payrollRecordId);
    if (list) list.push(p);
    else byRecord.set(p.payrollRecordId, [p]);
  });

  const history = {};
  records.forEach((r) => {
    const list = byRecord.get(r.id) || [];
    (history[r.employeeId] ??= []).push(payrollShape(r, list));
  });

  return sendSuccess(res, employees.map((e) => ({
    id: e.id,
    name: e.name,
    employeeId: e.employeeId,
    department: e.department,
    designation: e.designation,
    role: e.role,
    status: e.status,
    // Default salary structure (mapped like a payroll record) so a brand-new
    // month starts from the employee's saved structure, not zeros.
    defaultSalary: {
      basicPay: e.basicPay,
      allowances: {
        hra: e.hra,
        transportAllowance: e.transportAllowance,
        medicalAllowance: e.medicalAllowance,
      },
      deductions: {
        providentFund: e.providentFund,
        professionalTax: e.professionalTax,
        tds: e.tds,
      },
    },
    payroll: history[e.id] || [],
  })));
});

/** Editable salary components — the request never supplies netSalary. */
const payrollSchema = z.object({
  basicPay: z.number().int().min(0).max(10000000),
  hra: z.number().int().min(0).max(10000000).default(0),
  transportAllowance: z.number().int().min(0).max(10000000).default(0),
  medicalAllowance: z.number().int().min(0).max(10000000).default(0),
  providentFund: z.number().int().min(0).max(10000000).default(0),
  professionalTax: z.number().int().min(0).max(10000000).default(0),
  tds: z.number().int().min(0).max(10000000).default(0),
});

/**
 * GET /api/v1/admin/payroll/:employeeId/:month — one month in full: the salary
 * breakdown, the derived payment summary, and every individual payment.
 *
 * This is the payroll detail view's own read, so the page can refresh a single
 * month (after a payment, a deletion or a salary edit) without reloading every
 * employee. It is the same shape one record gets inside `GET /admin/payroll`.
 */
router.get('/payroll/:employeeId/:month', async (req, res) => {
  const { employeeId, month } = req.params;
  if (!MONTH_RE.test(month)) return sendError(res, 'Month must be YYYY-MM', 400, 'VALIDATION_ERROR');

  const [employee, record] = await Promise.all([
    prisma.employee.findUnique({ where: { id: employeeId } }),
    loadMonth(employeeId, month),
  ]);
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');
  if (!record) return noRecord(res, month);

  return sendSuccess(res, {
    ...payrollShape(record, record.payments),
    employee: { id: employee.id, name: employee.name, employeeId: employee.employeeId },
  });
});

/**
 * PUT /api/v1/admin/payroll/:employeeId/:month — create or update the salary
 * breakdown for one month (upsert on the employeeId+month unique pair), with
 * netSalary recomputed here so a tampered client can't post a wrong net.
 *
 * This is a MONTH's salary, deliberately separate from the employee's default
 * structure on the Employee record: a raise, a bonus or a one-off deduction
 * entered here affects this month and no other. The employee's own default
 * structure is never written by this route — changing it is the employee form's
 * job, and it only prefills months that do not exist yet.
 *
 * A month that is FULLY paid is immutable (409 ALREADY_PAID): the slip already
 * went out, so a later correction has to be a new month's record or a payroll
 * correction outside this screen. A PARTIALLY paid month stays editable, which
 * is the ordinary case — pay part of a month, then fix the structure.
 *
 * Because the net can change here, the derived "settled on" date is recomputed in
 * the same transaction. Note the asymmetry that creates: an edit CAN settle a
 * month (lowering the net below what is already paid), but can never unsettle
 * one — a settled month is refused by the lock above, so there is no edit that
 * would reopen it. A month only becomes outstanding again by REMOVING a payment.
 */
router.put('/payroll/:employeeId/:month', async (req, res) => {
  const { employeeId, month } = req.params;
  if (!MONTH_RE.test(month)) return sendError(res, 'Month must be YYYY-MM', 400, 'VALIDATION_ERROR');
  const parsed = payrollSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  const existing = await prisma.payrollRecord.findUnique({
    where: { employeeId_month: { employeeId, month } },
  });
  // Locked on the DERIVED status, not on the cached `paidOn` column, so the lock
  // follows the payments even if the cache was ever out of step.
  if (existing) {
    const payments = await prisma.payrollPayment.findMany({
      where: { payrollRecordId: existing.id },
    });
    if (payrollStatus(existing.netSalary, summarizePayments(existing, payments).paidTotal) === 'paid') {
      return sendError(
        res,
        `${monthLabel(month)} payroll is already fully paid — a settled month cannot be edited`,
        409,
        'ALREADY_PAID',
      );
    }
  }

  const net = netOf(parsed.data);
  if (net < 0) return sendError(res, 'Deductions exceed total earnings', 400, 'INVALID_PAYROLL');

  const saved = await prisma.$transaction(async (tx) => {
    const record = await tx.payrollRecord.upsert({
      where: { employeeId_month: { employeeId, month } },
      update: { ...parsed.data, netSalary: net },
      create: { employeeId, month, ...parsed.data, netSalary: net },
    });
    // Re-derive the settled date against the NEW net (see the route doc).
    await resettle(tx, record.id, net);
    return record;
  });

  const fresh = await loadMonth(employeeId, month);
  return sendSuccess(res, payrollShape(fresh, fresh.payments), 'Salary structure saved');
});

/**
 * POST /api/v1/admin/payroll/:employeeId/:month/mark-paid — settle the month in
 * one action, by recording a single payment for whatever is still outstanding.
 *
 * A convenience over POST /payments, not a second mechanism: it writes the same
 * row, so a month settled this way is indistinguishable from one paid in
 * instalments, and it works on a partially-paid month (it pays the balance, not
 * the whole net again).
 *
 * Refuses when there is nothing left to pay — an already-paid month (409) or a
 * month with no net salary to settle.
 */

/** POST /api/v1/admin/payroll/:employeeId/:month/payments body */
const paymentSchema = z.object({
  /** ₹, whole rupees, strictly positive. A zero or negative "payment" is not a
   *  payment; removing one that was entered in error is DELETE, not a negative. */
  amount: z.number().int().min(1).max(100000000),
  /** 'YYYY-MM-DD'; omitted → today (UTC) */
  paidOn: dateStr.optional(),
  /** Free text: 'advance', 'salary on hold', a UTR/reference… */
  note: z.string().trim().max(200).optional().or(z.literal('')),
});

/**
 * POST /api/v1/admin/payroll/:employeeId/:month/payments — record ONE payment
 * against a month, creating a new row. Never edits or replaces an earlier one.
 *
 * This is the partial-payment path: an admin can pay ₹10,000 now and the rest on
 * the 28th, and both transfers are kept as separate rows with their own dates.
 * The month becomes 'partial' on the first payment and flips to 'paid' by itself
 * once the sum reaches the net salary — no flag is set by hand.
 *
 * An amount ABOVE the remaining balance is allowed and recorded: the money really
 * moved, and refusing it would leave the books wrong. The response carries
 * `overpaid` and `overpaidBy` so the page shows the excess instead of hiding it.
 *
 * The payment date is not required to fall inside the payroll month — salaries
 * are routinely paid a few days into the next one.
 */
router.post('/payroll/:employeeId/:month/payments', async (req, res) => {
  const { employeeId, month } = req.params;
  if (!MONTH_RE.test(month)) return sendError(res, 'Month must be YYYY-MM', 400, 'VALIDATION_ERROR');
  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const record = await loadMonth(employeeId, month);
  if (!record) return noRecord(res, month);

  const { amount, note } = parsed.data;
  const paidOn = apiDate(parsed.data.paidOn || new Date().toISOString().slice(0, 10));

  await prisma.$transaction(async (tx) => {
    await tx.payrollPayment.create({
      data: {
        payrollRecordId: record.id,
        amount,
        paidOn,
        note: note ? note : null,
      },
    });
    await resettle(tx, record.id, record.netSalary);
  });

  const fresh = await loadMonth(employeeId, month);
  return sendSuccess(
    res,
    payrollShape(fresh, fresh.payments),
    `Payment of ₹${amount.toLocaleString('en-IN')} recorded`,
    201,
  );
});

/**
 * DELETE /api/v1/admin/payroll/:employeeId/:month/payments/:paymentId — remove
 * one mistaken payment.
 *
 * A month that is fully paid has a LOCKED salary (see PUT), so without this a
 * payment entered against the wrong month, or a typo in the amount, could never
 * be taken back: the month would sit there reading 'paid' on money that never
 * went out. A payment is the reversible record and the salary is the committed
 * one, which is the right way round for a correction.
 *
 * The payment must belong to this (employee, month) — a payment id from another
 * employee's month is a 404, not a silent delete.
 */
router.delete('/payroll/:employeeId/:month/payments/:paymentId', async (req, res) => {
  const { employeeId, month, paymentId } = req.params;
  if (!MONTH_RE.test(month)) return sendError(res, 'Month must be YYYY-MM', 400, 'VALIDATION_ERROR');

  const record = await prisma.payrollRecord.findUnique({
    where: { employeeId_month: { employeeId, month } },
  });
  if (!record) return noRecord(res, month);

  const payment = await prisma.payrollPayment.findFirst({
    where: { id: paymentId, payrollRecordId: record.id },
  });
  if (!payment) {
    return sendError(res, 'No such payment for this employee and month', 404, 'NOT_FOUND');
  }

  await prisma.$transaction(async (tx) => {
    await tx.payrollPayment.delete({ where: { id: payment.id } });
    // Removing money can unsettle a month that had been fully paid, so the
    // derived date is re-derived rather than left behind.
    await resettle(tx, record.id, record.netSalary);
  });

  const fresh = await loadMonth(employeeId, month);
  return sendSuccess(
    res,
    payrollShape(fresh, fresh.payments),
    `Payment of ₹${payment.amount.toLocaleString('en-IN')} removed`,
  );
});

/** POST /api/v1/admin/payroll/:employeeId/:month/mark-paid body */
const markPaidSchema = z.object({
  /** 'YYYY-MM-DD'; omitted → today (UTC) */
  paidDate: dateStr.optional(),
});

/**
 * POST /api/v1/admin/payroll/:employeeId/:month/mark-paid — settle the month in
 * one action, by recording a single payment for whatever is still outstanding.
 *
 * A convenience over POST /payments, not a second mechanism: it writes the same
 * row, so a month settled this way is indistinguishable from one paid in
 * instalments, and it works on a partially-paid month (it pays the balance, not
 * the whole net again).
 *
 * Refuses when there is nothing left to pay — an already-paid month (409) or a
 * month with no net salary to settle.
 */
router.post('/payroll/:employeeId/:month/mark-paid', async (req, res) => {
  const { employeeId, month } = req.params;
  if (!MONTH_RE.test(month)) return sendError(res, 'Month must be YYYY-MM', 400, 'VALIDATION_ERROR');
  const parsed = markPaidSchema.safeParse(req.body ?? {});
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const record = await loadMonth(employeeId, month);
  if (!record) return noRecord(res, month);

  const { paidTotal } = summarizePayments(record, record.payments);
  const remaining = record.netSalary - paidTotal;
  if (remaining <= 0) {
    return sendError(
      res,
      paidTotal > record.netSalary
        ? `${monthLabel(month)} payroll is already fully paid, and overpaid by ₹${(paidTotal - record.netSalary).toLocaleString('en-IN')}`
        : `${monthLabel(month)} payroll is already fully paid`,
      409,
      'ALREADY_PAID',
    );
  }

  const paidOn = apiDate(parsed.data.paidDate || new Date().toISOString().slice(0, 10));
  await prisma.$transaction(async (tx) => {
    await tx.payrollPayment.create({
      data: { payrollRecordId: record.id, amount: remaining, paidOn, note: null },
    });
    await resettle(tx, record.id, record.netSalary);
  });

  const fresh = await loadMonth(employeeId, month);
  return sendSuccess(res, payrollShape(fresh, fresh.payments), 'Payroll marked as paid');
});

/* ---------- Announcements ---------- */

/**
 * Announcements — the broad Audience publish plus a targeted "Send To…" flow.
 *
 * Both write to the same table and show up in the same admin list, because a
 * circular addressed to one class is still a circular. What differs is the
 * audience: `targetRoles` for the broad send, a single `targetClassId` or the
 * all-employees scope for a targeted one (recipient rules live in
 * services/announcements.js).
 *
 * The create routes are multipart so an optional PDF rides along with the text;
 * the stored bytes are served back by the authenticated download route.
 */

/** Turn a service-layer AnnouncementError into the right HTTP response. */
const sendAnnouncementError = (res, err) => {
  if (err instanceof AnnouncementError) {
    if (err.fieldErrors) return sendValidationError(res, err.fieldErrors);
    return sendError(res, err.message, err.status, err.code);
  }
  throw err;
};

/** GET /api/v1/admin/announcements — list all (admin sees everything, including
 *  scheduled and expired windows), newest showFrom first */
router.get('/announcements', async (req, res) => {
  const rows = await prisma.announcement.findMany({
    select: announcementListSelect,
    orderBy: [{ showFrom: 'desc' }, { createdAt: 'desc' }],
  });
  return sendSuccess(res, rows.map(mapAnnouncementAdmin));
});

/** POST /api/v1/admin/announcements — broad Audience publish (optional PDF) */
router.post(
  '/announcements',
  documentUpload.single('file'),
  documentUploadError,
  async (req, res) => {
    const parsed = announcementSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);
    // The attachment is optional here — a text-only circular is valid — but a
    // file that IS attached must be a real PDF (extension + MIME + magic bytes).
    const pdf = checkOptionalPdf(req);
    if (pdf === 'invalid') return sendError(res, 'Only PDF files are allowed', 400, 'BAD_REQUEST');

    try {
      const { row } = await createAnnouncement(parsed.data, {
        scope: AnnouncementScope.ROLES,
        file: pdf === 'ok' ? req.file : null,
        // An admin has no Employee row, so nothing is attributed on this route.
        sender: { role: req.user.role, employeeId: null, name: null },
      });
      return sendSuccess(res, mapAnnouncementAdmin(row), 'Announcement created', 201);
    } catch (err) {
      return sendAnnouncementError(res, err);
    }
  }
);

/**
 * POST /api/v1/admin/announcements/targeted — the "Send To…" flow.
 *
 * Separate from the broad publish above: the caller names a SCOPE (one class /
 * all employees) and never the role tags, so a targeted send cannot be widened
 * by hand-crafting the payload. `reached` in the response is a real count from
 * the database — the UI shows "Send to N students in Class 9B?" as the confirm
 * step before anything is stored.
 */
router.post(
  '/announcements/targeted',
  documentUpload.single('file'),
  documentUploadError,
  async (req, res) => {
    const parsed = targetedAnnouncementSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);
    const pdf = checkOptionalPdf(req);
    if (pdf === 'invalid') return sendError(res, 'Only PDF files are allowed', 400, 'BAD_REQUEST');

    try {
      const { row, studentCount, employeeCount } = await createAnnouncement(parsed.data, {
        scope: parsed.data.targetScope,
        file: pdf === 'ok' ? req.file : null,
        sender: { role: req.user.role, employeeId: null, name: null },
      });
      const reached = studentCount !== null ? studentCount : employeeCount;
      const audience = studentCount !== null ? `${reached} students` : `${reached} employees`;
      return sendSuccess(res, { ...mapAnnouncementAdmin(row), reached }, `Announcement sent to ${audience}`, 201);
    } catch (err) {
      return sendAnnouncementError(res, err);
    }
  }
);

/** PUT /api/v1/admin/announcements/:id — update announcement (incl. extending
 * the show window: e.g. an exam-schedule notice kept visible longer) */
router.put('/announcements/:id', async (req, res) => {
  const parsed = announcementSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  try {
    const existing = await prisma.announcement.findUnique({ where: { id: req.params.id } });
    if (!existing) return sendError(res, 'Announcement not found', 404, 'NOT_FOUND');

    // Omitted showFrom keeps the stored one (PUT payloads may reschedule the
    // "Show until" date only).
    const showFrom = parsed.data.showFrom || toDateStr(existing.showFrom);
    if (showFrom > parsed.data.showUntil) {
      return sendValidationError(res, { showUntil: ['Show until must be on or after Show from.'] });
    }

    // Only the text fields are written — targetScope/targetClassId, the author
    // and any PDF attachment are untouched by a reschedule, so widening or
    // re-attaching has to go through the send routes.
    const updated = await prisma.announcement.update({
      where: { id: req.params.id },
      data: { ...parsed.data, showFrom: apiDate(showFrom), showUntil: apiDate(parsed.data.showUntil) },
    });
    return sendSuccess(res, mapAnnouncementAdmin(updated), 'Announcement updated');
  } catch (err) {
    if (err.code === 'P2025') return sendError(res, 'Announcement not found', 404, 'NOT_FOUND');
    throw err;
  }
});

/** DELETE /api/v1/admin/announcements/:id */
router.delete('/announcements/:id', async (req, res) => {
  try {
    await prisma.announcement.delete({ where: { id: req.params.id } });
    return sendSuccess(res, { id: req.params.id }, 'Announcement deleted');
  } catch (err) {
    if (err.code === 'P2025') return sendError(res, 'Announcement not found', 404, 'NOT_FOUND');
    throw err;
  }
});

/**
 * GET /api/v1/admin/announcements/:annId/pdf — serve a circular's attachment.
 * Admin sees every circular, so this is only the admin router guard; the
 * audience check that matters lives on the portal route below.
 */
router.get('/announcements/:annId/pdf', async (req, res) => {
  const row = await prisma.announcement.findUnique({ where: { id: req.params.annId } });
  if (!row) return sendError(res, 'Announcement not found', 404, 'NOT_FOUND');
  try {
    return sendAnnouncementPdf(res, row);
  } catch (err) {
    return sendAnnouncementError(res, err);
  }
});

/* ---------- Holidays ---------- */

const holidaySchema = z.object({
  date: dateStr,
  name: z.string().min(2).max(100),
});

/** GET /api/v1/admin/holidays — list all (chronological) */
router.get('/holidays', async (req, res) => {
  const rows = await prisma.holiday.findMany({ orderBy: { date: 'asc' } });
  return sendSuccess(res, rows.map((h) => ({ id: h.id, date: toDateStr(h.date), name: h.name })));
});

/** POST /api/v1/admin/holidays — add a holiday */
router.post('/holidays', async (req, res) => {
  const parsed = holidaySchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  try {
    const created = await prisma.holiday.create({
      data: { id: newId('hol'), date: apiDate(parsed.data.date), name: parsed.data.name },
    });
    return sendSuccess(res, { id: created.id, date: toDateStr(created.date), name: created.name }, 'Holiday added', 201);
  } catch (err) {
    if (err.code === 'P2002') return sendError(res, 'A holiday already exists on that date', 409, 'DUPLICATE');
    throw err;
  }
});

/** DELETE /api/v1/admin/holidays/:id */
router.delete('/holidays/:id', async (req, res) => {
  try {
    await prisma.holiday.delete({ where: { id: req.params.id } });
    return sendSuccess(res, { id: req.params.id }, 'Holiday deleted');
  } catch (err) {
    if (err.code === 'P2025') return sendError(res, 'Holiday not found', 404, 'NOT_FOUND');
    throw err;
  }
});

/* ---------- School settings ---------- */

/**
 * PUT /api/v1/admin/settings — the weekly off days (weekday numbers, 0 =
 * Sunday). The school's default is Sunday only. This is the one place the
 * working week is defined; every calendar and attendance summary reads it.
 */
const settingsSchema = z.object({
  weeklyOffDays: z.array(z.number().int().min(0).max(6)).max(7, 'There are only seven weekdays'),
});

router.put('/settings', async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const weeklyOffDays = await setWeeklyOffDays(parsed.data.weeklyOffDays);
  return sendSuccess(res, { weeklyOffDays }, 'Settings saved');
});

/* ---------- Attendance ---------- */

const attendanceSchema = z.object({
  entityType: z.enum(['student', 'employee']),
  entityId: z.string().min(1),
  date: dateStr,
  session: sessionEnum,
  status: z.enum(Object.values(AttendanceStatus).map(statusToApi)),
  workingHours: z.number().min(0).max(24).optional(),
});

/** POST /api/v1/admin/attendance — mark attendance for a student or employee (upsert per day + session) */
router.post('/attendance', async (req, res) => {
  const parsed = attendanceSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const { entityType, entityId, date, session, status, workingHours } = parsed.data;
  const statusDb = statusToDb(status);
  const day = apiDate(date);
  // One session's default hours — a full present day is FN 4h + AN 4h = 8h.
  const hours = workingHours ?? (status === 'present' ? 4 : 0);

  if (entityType === 'student') {
    const student = await prisma.student.findUnique({ where: { id: entityId } });
    if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

    // Enrollment gate (same rule as the day rosters): attendance cannot be
    // recorded for a day before the student was enrolled.
    if (student.enrolledAt > day) {
      return sendError(res, `${student.name} was not enrolled on ${date}`, 400, 'VALIDATION_ERROR');
    }

    const recordedAt = new Date();
    await prisma.studentAttendance.upsert({
      where: { studentId_date_session: { studentId: entityId, date: day, session } },
      update: { status: statusDb, recordedAt },
      create: { studentId: entityId, date: day, session, status: statusDb, recordedAt },
    });
  } else {
    const employee = await prisma.employee.findUnique({ where: { id: entityId } });
    if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

    await prisma.employeeAttendance.upsert({
      where: { employeeId_date_session: { employeeId: entityId, date: day, session } },
      update: { status: statusDb, workingHours: hours },
      create: { employeeId: entityId, date: day, session, status: statusDb, workingHours: hours },
    });
  }

  return sendSuccess(res, { entityType, entityId, date, session, status }, 'Attendance marked', 201);
});

/* ---------- Bulk attendance (class / staff-group screen) ---------- */

/*
 * Group loading (live rosters), the 1-hour edit window and the whole-class
 * save all live in services/attendance.js — the same module the teacher flow in
 * the employee portal uses, so both entry points read and write identical
 * records. This router stays the unrestricted entry point: an admin may act on
 * any group, while the employee router enforces the teacher's own classes.
 */

/**
 * GET /api/v1/admin/attendance/group?kind=student|employee&groupKey=...&date=YYYY-MM-DD&session=FN|AN
 * Roster of one group with each member's saved status for the date + session
 * (null = unmarked) plus that session's confirmation state that drives the
 * 1-hour edit window. Students are ordered by roll number, employees by name.
 * The FN and AN rosters of a day are independent: each shows its own statuses
 * and its own edit-window state.
 *
 * `groupKey` is a class id for `kind=student` and an EMPLOYEE ID for
 * `kind=employee` — a person is their own group, so the admin marks one named
 * employee at a time and each person's confirmation is their own.
 */
router.get('/attendance/group', async (req, res) => {
  const kind = String(req.query.kind || '');
  const groupKey = String(req.query.groupKey || '').trim();
  const dateQ = String(req.query.date || '').trim();
  const session = String(req.query.session || '').trim();

  if (!['student', 'employee'].includes(kind)) {
    return sendError(res, 'kind must be "student" or "employee"', 400, 'VALIDATION_ERROR');
  }
  if (!groupKey) return sendError(res, 'groupKey is required', 400, 'VALIDATION_ERROR');
  if (!dateStr.safeParse(dateQ).success) {
    return sendError(res, 'date must be YYYY-MM-DD', 400, 'VALIDATION_ERROR');
  }
  if (session !== 'FN' && session !== 'AN') {
    return sendError(res, 'session must be "FN" or "AN"', 400, 'VALIDATION_ERROR');
  }

  const roster = await loadAttendanceRoster(kind, groupKey, dateQ, session);
  if (!roster) {
    return sendError(res, kind === 'student' ? 'Class not found' : 'Employee not found', 404, 'NOT_FOUND');
  }

  return sendSuccess(res, roster);
});

/* Body of a whole-class save — validated by the shared schema in
   services/attendance.js, the same contract the teacher flow accepts. */

/**
 * POST /api/v1/admin/attendance/bulk — save a whole group's attendance for one
 * date in a single transaction: every entry as given ('absent' toggles,
 * everything sent as 'present' for the rest of the roster the UI lists).
 * Atomic — an unknown member id or a failed write leaves no partial rows.
 * Re-confirming within the 1-hour window overwrites; after it closes the
 * request must carry override: true (the explicit "Edit past attendance" path).
 */
router.post('/attendance/bulk', async (req, res) => {
  const parsed = bulkAttendanceSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const result = await saveBulkAttendance({ ...parsed.data, markedBy: req.user?.username || null });
  if (!result.ok) return sendError(res, result.message, result.status, result.code);

  return sendSuccess(res, result.data, 'Attendance confirmed', 201);
});

/* ---------- Marks ---------- */

/**
 * The admin's class-wide marks view: the "already saved" card grid plus the
 * pre-filled roster of one opened batch.
 *
 * `examName` + `subject` together identify a BATCH — a (exam, subject) pair is
 * what is saved, counted down and locked, and what a card stands for. Pass both
 * to load that batch's marks into the roster for correction; omit them and every
 * `obtained` comes back null, which is the same empty grid a fresh exam gets.
 *
 * `subject` alone filters the card grid to one subject. It is optional and
 * UNSCOPED by any permission: the admin is not bound to the timetable the way a
 * teacher is, so the whole class's marks in every subject are the admin's to
 * read and change.
 */
const adminClassMarksQuery = {
  classId: z.string().min(1),
  /** The two halves of a batch key. Both or neither — see `adminClassViewSchema`. */
  subject: z.string().trim().min(1).max(100).optional(),
  examName: z.string().trim().min(2).max(100).optional(),
};

/**
 * Read: `examName` + `subject` open one saved batch into the roster; omit BOTH and
 * you get the card grid alone. A half key is refused rather than guessed, and the
 * grid's own subject filter is deliberately NOT a server parameter — it narrows a
 * list of a few dozen cards the client already holds, so filtering it here would
 * mean a round trip per chip press and a second, subtly different `subject`
 * meaning in the same query string.
 */
const adminClassViewSchema = z.object(adminClassMarksQuery).refine(
  (d) => Boolean(d.examName) === Boolean(d.subject),
  {
    message: 'examName and subject go together — they identify one saved batch',
    path: ['examName'],
  },
);

/** Write: a correction names exactly one batch, so both halves are required. */
const adminClassSaveSchema = z.object({
  classId: adminClassMarksQuery.classId,
  subject: adminClassMarksQuery.subject.unwrap(),
  examName: adminClassMarksQuery.examName.unwrap(),
  date: dateStr.optional(),
  maxMarks: z.number().int().min(1).max(MARKS_MAX),
});

/** One mark of a whole-class save. Mirrors the teacher's `entries` shape. */
const adminClassMarkEntrySchema = z.object({
  studentId: z.string().min(1),
  obtained: z.number().int().min(0).max(MARKS_MAX),
});

const marksSchema = z.object({
  studentId: z.string().min(1),
  examName: z.string().min(2).max(100),
  date: dateStr.optional(),
  subjects: z.array(z.object({
    subject: z.string().min(1),
    maxMarks: z.number().min(1),
    obtained: z.number().min(0),
  })).min(1),
});

/** POST /api/v1/admin/marks — upload marks for a student/exam (upserts exam + subject entries) */
router.post('/marks', async (req, res) => {
  const parsed = marksSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const student = await prisma.student.findUnique({ where: { id: parsed.data.studentId } });
  if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  // The same saveMarkRows the teacher page and the bulk upload use, so this
  // route gains the same three guarantees rather than keeping its own copy:
  // atomic all-or-nothing, the subject written as the class timetable spells it,
  // and recorded attribution. The response echoes the rows AS STORED, so a
  // client that sent "maths" is told it landed as "Mathematics".
  //
  // `writer: 'admin'` is the whole of the Admin Panel's exemption from the 48-hour
  // teacher edit window, and it is stated here rather than left to the default:
  // an admin write is never refused, and it leaves `teacherSavedAt` untouched, so
  // correcting a batch the teacher can no longer change does not hand them 48
  // fresh hours to change it back. `updatedBy`/`updatedAt` still record the admin,
  // so the "last changed by" attribution is accurate afterwards.
  const result = await saveMarkRows(
    parsed.data.subjects.map((s) => ({
      studentId: student.id,
      classId: student.classId,
      examName: parsed.data.examName,
      examDate: apiDate(parsed.data.date) || new Date(),
      subject: s.subject,
      maxMarks: s.maxMarks,
      obtained: s.obtained,
    })),
    { enteredBy: req.user?.username || null, writer: 'admin' },
  );

  const exam = result.examList[0];
  return sendSuccess(res, {
    examId: exam.examId,
    studentId: student.id,
    examName: exam.name,
    date: exam.date,
    subjects: result.rows.map((r) => ({ subject: r.subject, maxMarks: r.maxMarks, obtained: r.obtained })),
  }, 'Marks uploaded', 201);
});

/**
 * GET /api/v1/admin/marks?studentId=&classId= — marks grouped per exam
 * (object keyed by student when no studentId is given).
 * `?classId=` keeps only the rows whose student is in that class, so the Marks
 * Entry page recomputes its stat cards from the selected class alone instead of
 * filtering a school-wide payload client-side.
 *
 * `attribution: true` — this is the staff-facing read, so each subject carries
 * who entered it, when, and who last changed it. That is how the admin sees
 * marks a teacher entered from the Employee Portal. (The student-facing read in
 * `students.routes.js` shares the same grouping function with attribution OFF,
 * so staff usernames are never exposed to a student.)
 */
router.get('/marks', async (req, res) => {
  const { studentId, classId } = req.query;
  const entries = await prisma.marksEntry.findMany({
    where: {
      ...(studentId ? { studentId: String(studentId) } : {}),
      ...(classId ? { student: { classId: String(classId) } } : {}),
    },
    include: { exam: true },
    orderBy: [{ exam: { date: 'asc' } }, { subject: 'asc' }],
  });

  const group = (rows) => groupMarksByExam(rows, { attribution: true });
  if (studentId) return sendSuccess(res, group(entries));

  // No studentId → same shape the mock store served: object keyed by studentId
  const byStudent = new Map();
  entries.forEach((e) => {
    if (!byStudent.has(e.studentId)) byStudent.set(e.studentId, []);
    byStudent.get(e.studentId).push(e);
  });
  const out = {};
  byStudent.forEach((rows, sid) => { out[sid] = group(rows); });
  return sendSuccess(res, out);
});

/**
 * GET /api/v1/admin/marks/class?classId=[&subject=][&examName=]
 * One class's marks history, plus the pre-filled roster of one opened batch.
 *
 * This is the admin's answer to the teacher page's "already saved" grid, over
 * the SAME rows — `GET /admin/marks` is per student (it answers "how did this
 * student do"), this one is per batch (it answers "which exams exist, and let me
 * open one"). Two different axes, so both are kept: grouping by student cannot
 * show a batch's own count / average / top, and grouping by batch cannot show a
 * student's totals across exams.
 *
 * Response:
 *   - `subjects` — every subject this class has marks in, live from its own rows,
 *     so the card grid's subject filter can never offer a subject with nothing
 *     behind it.
 *   - `batches` — one entry per (exam, subject) with that batch's own `saved`
 *     count, `average`, `top` and attribution, newest exam first. One card each.
 *     Always the class's whole history; the grid's own subject filter is a client
 *     concern, not a second meaning for the `subject` parameter.
 *   - `batch` / `roster` — when `examName` + `subject` name a saved batch, its
 *     marks keyed to the class's students (roll-number order) for correction.
 *
 * NOT included: the teacher's 48-hour window. The admin is never inside it, so
 * this read deliberately exposes only `savedAt` (the batch's real last teacher
 * save) as provenance and no `locked` flag — there is no state here for the
 * client to mistake for a restriction.
 */
router.get('/marks/class', async (req, res) => {
  const parsed = adminClassViewSchema.safeParse(req.query);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const { classId, subject, examName } = parsed.data;
  const klass = await prisma.class.findUnique({
    where: { id: classId },
    include: { _count: { select: { students: true } } },
  });
  if (!klass) return sendError(res, 'Class not found', 404, 'NOT_FOUND');

  /* Case-insensitive on both halves, for the same reason findExamByName exists:
     `Exam` is unique per (classId, name) and THAT comparison is case-sensitive,
     so an exact match would silently miss a re-typed name and open nothing. */
  const examRef = examName
    ? await prisma.exam.findFirst({ where: { classId, name: { equals: examName, mode: 'insensitive' } } })
    : null;
  const batch = examRef
    ? await prisma.marksEntry.findFirst({ where: { examId: examRef.id, subject: { equals: subject, mode: 'insensitive' } } })
    : null;
  const savedSubject = batch ? batch.subject : null;

  const [students, classRows, savedRows] = await Promise.all([
    prisma.student.findMany({
      where: { classId },
      select: { id: true, name: true, rollNumber: true },
      orderBy: { rollNumber: 'asc' },
    }),
    prisma.marksEntry.findMany({
      where: { exam: { classId } },
      include: { exam: true },
    }),
    savedSubject
      ? prisma.marksEntry.findMany({ where: { examId: examRef.id, subject: savedSubject } })
      : Promise.resolve([]),
  ]);

  const batches = groupMarksByBatch(classRows);
  const byStudent = new Map(savedRows.map((r) => [r.studentId, r]));

  /* The batch's Max Marks, as the value most of its rows agree on.
     `maxMarks` is stored per ROW, not per batch, so a batch assembled by
     separate one-student saves (the admin's per-student form) can hold more than
     one value. Taking whichever row came back first would prefill the editor
     with a coin toss, and re-saving would then overwrite every other student's
     max with it. Ties break to the highest, so the editor errs towards a bound
     that still contains the marks already recorded. */
  const batchMax = (() => {
    if (!savedRows.length) return null;
    const tally = new Map();
    savedRows.forEach((r) => tally.set(r.maxMarks, (tally.get(r.maxMarks) || 0) + 1));
    return [...tally.entries()].sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]))[0][0];
  })();

  return sendSuccess(res, {
    classId,
    classLabel: classLabel(klass),
    studentCount: klass._count.students ?? 0,
    // Every subject this class actually has marks in — derived, never a stored
    // list, so a subject added later appears without anything being redeployed.
    subjects: [...new Set(classRows.map((r) => r.subject))].sort((a, b) => a.localeCompare(b)),
    batches,
    batch: batch
      ? {
        examId: examRef.id,
        examName: examRef.name,
        date: toDateStr(examRef.date),
        subject: savedSubject,
        maxMarks: batchMax,
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
  });
});

/**
 * POST /api/v1/admin/marks/class — correct one (exam, subject) batch for a whole
 * class in a single atomic request. The admin counterpart of the teacher's
 * class-wide save, opened by clicking a card in the "already saved" grid.
 *
 * Entries are validated against the SERVER's roster, not the client's, so a
 * hand-rolled request naming a student of another class is rejected instead of
 * filing their mark against this exam. The whole save is all-or-nothing: a single
 * bad row, or one above Max Marks, writes nothing.
 *
 * A blank cell is not an error and is not a zero. It is simply not sent, and so:
 *
 *   - it creates NO row, for a student who had no mark. An absent student did
 *     not score zero, and storing 0 would record a mark nobody entered.
 *   - it leaves an EXISTING row exactly as it is. This is an edit, not a rebuild:
 *     the marks you name are the marks that change, and clearing a cell is not a
 *     way to delete a mark that was already recorded. (Deleting one would be a
 *     different operation, and the Employee Portal behaves the same way.)
 *
 * `writer: 'admin'` is the whole of the Admin Panel's exemption from the 48-hour
 * teacher edit window, stated here for the same reason it is on `POST /marks`:
 * the save is never refused however long ago the teacher saved the batch, and it
 * leaves `teacherSavedAt` untouched, so an admin correction does not hand the
 * teacher 48 fresh hours to change it back. `updatedBy` / `updatedAt` still record
 * the admin, so the batch's "last changed by" flips to the admin afterwards.
 */
router.post('/marks/class', async (req, res) => {
  const parsed = adminClassSaveSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const { classId, subject, examName, maxMarks } = parsed.data;
  const klass = await prisma.class.findUnique({ where: { id: classId } });
  if (!klass) return sendError(res, 'Class not found', 404, 'NOT_FOUND');

  const rawEntries = Array.isArray(req.body?.entries) ? req.body.entries : [];
  const cleaned = [];
  const rejected = [];
  for (const entry of rawEntries) {
    // A blank cell is a legitimate state, not an error, and it is dropped BEFORE
    // validation so it can never fail as a bad number. See the route doc: it
    // creates no row, and it leaves any row already stored untouched.
    if (entry?.obtained === null || entry?.obtained === undefined || entry?.obtained === '') continue;
    const one = adminClassMarkEntrySchema.safeParse(entry);
    if (one.success) cleaned.push(one.data);
    else rejected.push(`${entry.studentId ?? 'a student'}: ${one.error.issues[0].message}`);
  }
  if (rejected.length) {
    return sendError(res, `Invalid mark — ${rejected.slice(0, 5).join('; ')}`, 400, 'VALIDATION_ERROR');
  }
  if (cleaned.length === 0) {
    return sendError(res, 'Enter at least one mark first', 400, 'VALIDATION_ERROR');
  }

  const roster = await prisma.student.findMany({ where: { classId }, select: { id: true } });
  const own = new Set(roster.map((s) => s.id));
  const foreign = [...new Set(cleaned.map((c) => c.studentId))].filter((id) => !own.has(id));
  if (foreign.length) {
    return sendError(
      res,
      `These students are not in ${classLabel(klass)}: ${foreign.join(', ')}`,
      400, 'VALIDATION_ERROR',
    );
  }

  const overMax = cleaned.filter((c) => c.obtained > maxMarks);
  if (overMax.length) {
    return sendError(
      res,
      `An obtained mark cannot exceed Max Marks (${maxMarks}) — ${overMax.length} row${overMax.length === 1 ? '' : 's'} affected`,
      400, 'VALIDATION_ERROR',
    );
  }

  // The class timetable's own spelling, so what is stored is what the permission
  // check and the other marks screens read — the same rule every other write uses.
  const canonical = await canonicalSubjectFor(classId, subject);
  const result = await saveMarkRows(
    cleaned.map((c) => ({
      studentId: c.studentId,
      classId,
      examName,
      examDate: apiDate(parsed.data.date) || new Date(),
      subject: canonical,
      maxMarks,
      obtained: c.obtained,
    })),
    { enteredBy: req.user?.username || null, writer: 'admin' },
  );

  return sendSuccess(res, {
    classId,
    classLabel: classLabel(klass),
    examName,
    subject: canonical,
    maxMarks,
    saved: result.saved,
    /* The ADMIN's own save instant. Deliberately NOT called `teacherSavedAt`:
       the teacher clock was not moved by this write, and echoing the admin's
       timestamp under that name would read as "the teacher may edit again",
       which is exactly the wrong conclusion. The batch's real teacher anchor is
       left alone in the table and simply comes back unchanged on the next read. */
    savedAt: result.savedAt,
  }, 'Marks saved', 201);
});

/* ---------- Marks bulk upload routes (CSV / XLSX, parsed server-side) ---------- */

/**
 * POST /api/v1/admin/marks/bulk — bulk marks entry from a CSV/XLSX file.
 * Long/tidy format, one row per student per subject; header row required in
 * this exact order:
 *   RollNumber, StudentName, ExamName, ExamDate, Subject, MaxMarks, ObtainedMarks
 *
 * The class is NOT part of the file: it is chosen on the Marks Entry page with
 * the Select Class dropdown and posted as `classId` (body field, `?classId=`
 * also accepted). Only that class's students are loaded, so a roll number that
 * belongs to any other class is rejected row-by-row and never silently files
 * marks against the wrong class.
 *
 * Rows are matched to students by RollNumber (never by name — names collide),
 * which is sufficient because roll numbers are unique within a class.
 * StudentName is a readability/cross-check column. Subject is free text —
 * subjects are admin-defined per exam, so there is no fixed subject list to
 * validate against.
 * Atomic: every row is validated before a single write happens, so an invalid
 * row rejects the whole file and the response names the failing row(s)/column(s).
 * Up to 200 rows per file.
 */
router.post('/marks/bulk', marksBulkUpload.single('file'), async (req, res) => {
  if (!req.file) {
    return sendError(res, 'No file uploaded — attach a .csv or .xlsx file', 400, 'BAD_REQUEST');
  }

  const originalName = String(req.file.originalname || '').toLowerCase();
  if (!originalName.endsWith('.csv') && !originalName.endsWith('.xlsx')) {
    return sendError(res, 'Unsupported file type — upload a .csv or .xlsx file', 400, 'BAD_REQUEST');
  }

  /* ---------- 0. Which class is this file for? ---------- */
  // Required: without it the file has no class context at all (Class/Section are
  // no longer template columns), so accepting the upload would mean guessing.
  const classId = String(req.body?.classId ?? req.query?.classId ?? '').trim();
  if (!classId) {
    return sendValidationError(res, {
      classId: 'Choose a class on the Marks Entry page before uploading — the file no longer carries a Class column',
    });
  }

  const cls = await prisma.class.findUnique({ where: { id: classId } });
  if (!cls) return sendError(res, 'Class not found', 404, 'NOT_FOUND');

  const classLabelText = classLabel(cls);

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
        return isHeaderRow(cells, MARKS_BULK_COLUMNS);
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
  if (!isHeaderRow(header, MARKS_BULK_COLUMNS)) {
    return sendValidationError(res, { file: `Header row must be exactly: ${MARKS_BULK_COLUMNS.join(', ')}` });
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
  const errors = {};
  const entries = [];
  const seen = new Set(); // duplicate student+exam+subject guard for this file

  const students = await prisma.student.findMany({
    where: { classId },
    include: { class: { include: { level: true } } },
  });

  // Roll numbers are unique within a class (@@unique([classId, rollNumber])),
  // so inside the selected class the roll number alone identifies the student.
  const byRoll = new Map();
  students.forEach((s) => {
    const key = String(s.rollNumber ?? '').trim().toLowerCase();
    if (!key) return;
    byRoll.set(key, s);
  });

  // One query for the whole file: this class's timetable subject spellings, so
  // every row's Subject is stored exactly as the timetable writes it and matches
  // what a teacher holding that period is permitted to enter.
  const timetableSubjects = await subjectIndex([classId]);

  dataRows.forEach((cells, i) => {
    const rowNum = i + 2; // header is row 1
    const rowErrors = {};

    if (cells.length !== MARKS_BULK_COLUMNS.length) {
      errors[`row_${rowNum}`] = { columns: `Expected ${MARKS_BULK_COLUMNS.length} columns, got ${cells.length}` };
      return;
    }

    const raw = {};
    MARKS_BULK_COLUMNS.forEach((column, idx) => { raw[column] = cells[idx]; });
    const text = (column) => String(raw[column] ?? '').trim();
    const dateCell = raw.ExamDate;

    // Every field must be present in every row
    MARKS_BULK_COLUMNS.forEach((column) => {
      const value = raw[column];
      if (value === undefined || value === null || text(column) === '') {
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
    const examDate = parseMarkDate(dateCell);
    if (!rowErrors.ExamDate && !examDate) {
      rowErrors.ExamDate = 'Must be a valid date (dd-mm-yyyy)';
    }

    // Match the student by roll number — scoped to the selected class. A roll
    // number that exists only in some OTHER class is rejected right here.
    const student = byRoll.get(text('RollNumber').toLowerCase()) || null;
    if (!student) {
      rowErrors.RollNumber = `No student with this roll number in ${classLabelText}`;
    }

    // Resolve the subject to the spelling this class's TIMETABLE already uses,
    // before the duplicate check — so "Mathematics" and "maths" in the same file
    // are recognised as the same subject (one duplicate error) rather than both
    // silently collapsing onto one stored row. Free text is preserved when the
    // class has no such period, so admin-defined subjects are unaffected.
    const subject = canonicalSubject(timetableSubjects, classId, text('Subject'));

    // One row per student per exam per subject — duplicates are ambiguous
    if (student) {
      const key = `${student.id}::${text('ExamName').toLowerCase()}::${subject.toLowerCase()}`;
      if (seen.has(key)) {
        rowErrors.Subject = 'Duplicate row — this student/exam/subject appears more than once';
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
      classId: student.classId,
      studentName: student.name,
      rollNumber: student.rollNumber,
      class: String(student.class.grade),
      section: student.class.section,
      examName: text('ExamName'),
      examDate,
      subject,
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
  // The shared write path, so this upload, the admin's single-student save and
  // the teacher's class-wide save all get identical exam resolution, subject
  // canonicalisation and attribution. One interactive transaction: a 200-row
  // file is 200+ statements over a remote database where the default 5s timeout
  // would abort, and any failure rolls the whole file back. `writer: 'admin'`
  // keeps the 48-hour teacher window out of it, exactly as the save above.
  const { saved, students: studentsTouched, exams: examsTouched } =
    await saveMarkRows(entries, { enteredBy: req.user?.username || null, writer: 'admin' });

  return sendSuccess(res, {
    saved,
    students: studentsTouched,
    exams: examsTouched,
    rows: entries.map((e) => ({
      studentId: e.studentId,
      studentName: e.studentName,
      rollNumber: e.rollNumber,
      class: e.class,
      section: e.section,
      examName: e.examName,
      examDate: toDateStr(e.examDate),
      subject: e.subject,
      maxMarks: e.maxMarks,
      obtained: e.obtained,
    })),
  }, `${saved} mark row${saved === 1 ? '' : 's'} saved for ${studentsTouched} student${studentsTouched === 1 ? '' : 's'} in ${examsTouched} exam${examsTouched === 1 ? '' : 's'} (${classLabelText})`, 201);
});

/**
 * GET /api/v1/admin/marks/bulk-template — download the bulk-marks .xlsx
 * template (header + example rows + an Instructions sheet). Built with the
 * same ExcelJS version that parses uploads, so the downloaded file always
 * matches exactly what the importer accepts.
 */
router.get('/marks/bulk-template', async (req, res) => {
  const book = new ExcelJS.Workbook();
  book.creator = 'School ERP';

  const sheet = book.addWorksheet('Marks');
  sheet.addRow(MARKS_BULK_COLUMNS);
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFE7D6' } };
  const placeholder = sheet.addRow(MARKS_BULK_PLACEHOLDER_ROW);
  placeholder.font = { italic: true, color: { argb: 'FF808080' } };
  sheet.columns.forEach((c) => { c.width = 16; });

  const notes = book.addWorksheet('Instructions');
  notes.addRow(['How to use this template']);
  notes.getRow(1).font = { bold: true, size: 13 };
  [
    '',
    `1. Go to the 'Marks' tab. Row 2 is a FORMAT PLACEHOLDER — replace every <...> value with real data (keep the header row).`,
    '2. Use ONE ROW PER STUDENT PER SUBJECT (long/tidy format) — not one row per student with a column per subject.',
    `3. Choose the class on the Marks Entry page BEFORE uploading. There are NO Class/Section columns in this file — the class comes from the page's Select Class dropdown, and every row must belong to that class.`,
    `4. Students are matched by RollNumber, so it must match a student already in the selected class.`,
    '5. Subject is free text. Any subject name is accepted — subjects are defined by the admin, not a fixed list.',
    '6. Save as .xlsx or .csv, then upload it with "Bulk Upload" on the Marks Entry page.',
    '',
    'Column reference',
  ].forEach((line) => notes.addRow([line]));
  [
    ['RollNumber', 'Required. Used to match the student record — must belong to the selected class.'],
    ['StudentName', 'Required, for readability/cross-check only — the system matches on RollNumber.'],
    ['ExamName', 'Required. e.g. Unit Test 2.'],
    ['ExamDate', 'Required. Format dd-mm-yyyy (Excel date cells also work).'],
    ['Subject', 'Required. Any subject name — not limited to a fixed list.'],
    ['MaxMarks', 'Required. Whole number, must be at least 1.'],
    ['ObtainedMarks', 'Required. Whole number, must be <= MaxMarks.'],
  ].forEach(([column, description]) => notes.addRow([column, description]));
  notes.addRow([]);
  [
    `- Up to ${MARKS_BULK_MAX_ROWS} rows per file.`,
    '- Rows are validated together: if any row is invalid nothing is saved (atomic upload).',
    `- Every row must belong to the class chosen with the Select Class dropdown — rows for students of other classes are rejected and nothing is saved.`,
    '- A student with 5 subjects needs 5 rows, all sharing the same RollNumber, ExamName and ExamDate.',
  ].forEach((line) => notes.addRow([line]));
  notes.getColumn(1).width = 18;
  notes.getColumn(2).width = 80;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="marks_bulk_upload_template.xlsx"');
  await book.xlsx.write(res);
  return res.end();
});

/* ---------- Timetable ---------- */

const periodSchema = z.object({
  classKey: z.string().regex(/^cls-[A-Z0-9]+[A-Z]$/),
  period: z.number().int().min(1).max(12),
  timeStart: z.string().regex(/^\d{2}:\d{2}$/),
  timeEnd: z.string().regex(/^\d{2}:\d{2}$/),
  subject: z.string().min(1).max(100),
  teacher: z.string().min(1).max(100),
  room: z.string().min(1).max(50),
});

/** GET /api/v1/admin/timetable — all class timetables, grouped by class id */
router.get('/timetable', async (req, res) => {
  const rows = await prisma.timetablePeriod.findMany({ orderBy: [{ classId: 'asc' }, { period: 'asc' }] });
  const out = {};
  rows.forEach((p) => {
    if (!out[p.classId]) out[p.classId] = [];
    out[p.classId].push(mapPeriod(p));
  });
  return sendSuccess(res, out);
});

/** POST /api/v1/admin/timetable — add a period */
router.post('/timetable', async (req, res) => {
  const parsed = periodSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const cls = await prisma.class.findUnique({ where: { id: parsed.data.classKey } });
  if (!cls) return sendError(res, 'Class not found', 404, 'NOT_FOUND');

  const { classKey, teacher, ...period } = parsed.data;
  try {
    const created = await prisma.timetablePeriod.create({
      data: { classId: cls.id, teacherName: teacher, ...period },
    });
    return sendSuccess(res, mapPeriod(created), 'Period added', 201);
  } catch (err) {
    if (err.code === 'P2002') return sendError(res, `Period ${period.period} already exists for ${classKey}`, 409, 'DUPLICATE');
    throw err;
  }
});

/** DELETE /api/v1/admin/timetable/:classKey/:period */
router.delete('/timetable/:classKey/:period', async (req, res) => {
  const { classKey, period } = req.params;
  const deleted = await prisma.timetablePeriod.deleteMany({
    where: { classId: classKey, period: Number(period) },
  });
  if (deleted.count === 0) return sendError(res, 'Period not found', 404, 'NOT_FOUND');
  return sendSuccess(res, { classKey, period }, 'Period deleted');
});

/* ---------- Syllabus ---------- */

/** One topic: non-empty name, explicit done flag (never a client-supplied %). */
const topicSchema = z.object({
  topic: z.string().trim().min(1).max(200),
  done: z.boolean().default(false),
});

const syllabusSchema = z.object({
  classKey: z.string().regex(/^cls-[A-Z0-9]+[A-Z]$/),
  subject: z.string().trim().min(1).max(100),
  // Full replacement: the client always sends the complete topic list with the
  // current done/not-done state (chip toggles + renames/additions/removals).
  topics: z.array(topicSchema).min(1).max(100),
});

/**
 * GET /api/v1/admin/syllabus — all class syllabus records, grouped by class id.
 * Topics are normalized [{ topic, done }]; completion is derived client-side
 * (done count / total) and never stored.
 */
router.get('/syllabus', async (req, res) => {
  const rows = await prisma.syllabusEntry.findMany({ orderBy: [{ classId: 'asc' }, { subject: 'asc' }] });
  const out = {};
  rows.forEach((s) => {
    if (!out[s.classId]) out[s.classId] = [];
    out[s.classId].push({ subject: s.subject, topics: normalizeSyllabusTopics(s.topics) });
  });
  return sendSuccess(res, out);
});

/** POST /api/v1/admin/syllabus — create or replace a class/subject syllabus (upsert) */
router.post('/syllabus', async (req, res) => {
  const parsed = syllabusSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const cls = await prisma.class.findUnique({ where: { id: parsed.data.classKey } });
  if (!cls) return sendError(res, 'Class not found', 404, 'NOT_FOUND');

  const { classKey, ...entry } = parsed.data;
  const existing = await prisma.syllabusEntry.findUnique({
    where: { classId_subject: { classId: cls.id, subject: entry.subject } },
  });
  if (existing) {
    await prisma.syllabusEntry.update({ where: { id: existing.id }, data: entry });
    return sendSuccess(res, entry, 'Syllabus updated');
  }
  await prisma.syllabusEntry.create({ data: { classId: cls.id, ...entry } });
  return sendSuccess(res, entry, 'Syllabus uploaded', 201);
});

/* ---------- Achievements ---------- */

const achievementSchema = z.object({
  studentId: z.string().min(1),
  title: z.string().min(3).max(200),
  description: z.string().min(10).max(500),
  date: dateStr,
  type: z.enum(ACHIEVEMENT_TYPES),
});

/** GET /api/v1/admin/achievements — flattened list with student names, newest first */
router.get('/achievements', async (req, res) => {
  const rows = await prisma.achievement.findMany({
    include: { student: { select: { name: true } } },
    orderBy: { date: 'desc' },
  });
  return sendSuccess(res, rows.map(mapAchievement));
});

/** POST /api/v1/admin/achievements */
router.post('/achievements', async (req, res) => {
  const parsed = achievementSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const { studentId, ...rest } = parsed.data;
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  const id = newId('ach');
  await prisma.achievement.create({
    data: { id, studentId, ...rest, date: apiDate(rest.date) },
  });
  return sendSuccess(res, { id, ...rest }, 'Achievement added', 201);
});

/** DELETE /api/v1/admin/achievements/:id */
router.delete('/achievements/:id', async (req, res) => {
  try {
    await prisma.achievement.delete({ where: { id: req.params.id } });
    return sendSuccess(res, { id: req.params.id }, 'Achievement deleted');
  } catch (err) {
    if (err.code === 'P2025') return sendError(res, 'Achievement not found', 404, 'NOT_FOUND');
    throw err;
  }
});

/* ---------- Documents ---------- */

/**
 * Document uploads: the PDF is validated server-side (extension + MIME +
 * `%PDF-` magic bytes) and its bytes are persisted on the row (`data`), so
 * the download endpoints can serve the real file back. The 5 MB cap matches
 * every other upload in this API.
 *
 * `documentUpload` (multer), `documentUploadError`, `requirePdf` and
 * `docNameFrom` all come from services/documents.js — the announcement
 * attachment surface uses the exact same ones, so "what counts as a PDF" is
 * defined once for the whole API.
 */
const documentSchema = z.object({
  type: z.string().min(2).max(100),
});

/** POST /api/v1/admin/employees/:id/documents — upload document record */
router.post('/employees/:id/documents', documentUpload.single('file'), documentUploadError, async (req, res) => {
  const parsed = documentSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);
  if (!requirePdf(req, res)) return;

  const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  const created = await prisma.employeeDocument.create({
    data: {
      id: newId('doc'),
      employeeId: employee.id,
      type: parsed.data.type,
      fileName: docNameFrom(req.file),
      data: req.file.buffer,
    },
  });
  return sendSuccess(res, {
    id: created.id,
    type: created.type,
    fileName: created.fileName,
    uploadedAt: toIso(created.uploadedAt),
  }, 'Document uploaded', 201);
});

/** GET /api/v1/admin/documents — flattened list with employee names, newest first.
 * Explicit column select: `data` (the stored PDF bytes) must never ship in a
 * list response. */
router.get('/documents', async (req, res) => {
  const rows = await prisma.employeeDocument.findMany({
    select: {
      id: true, type: true, fileName: true, uploadedAt: true, employeeId: true,
      employee: { select: { name: true } },
    },
    orderBy: { uploadedAt: 'desc' },
  });
  return sendSuccess(res, rows.map((d) => ({
    id: d.id,
    type: d.type,
    fileName: d.fileName,
    uploadedAt: toIso(d.uploadedAt),
    employeeId: d.employeeId,
    employeeName: d.employee?.name || null,
  })));
});

/** DELETE /api/v1/admin/documents/:id — remove a document record */
router.delete('/documents/:id', async (req, res) => {
  try {
    await prisma.employeeDocument.delete({ where: { id: req.params.id } });
    return sendSuccess(res, { id: req.params.id }, 'Document deleted');
  } catch (err) {
    if (err.code === 'P2025') return sendError(res, 'Document not found', 404, 'NOT_FOUND');
    throw err;
  }
});

/**
 * GET /api/v1/admin/documents/:docId/download — serve the stored PDF of one
 * employee document record. The router's admin guard applies; the lookup is
 * by unique document id, so a missing id is a plain 404. Rows created before
 * the bytes column existed have no stored file → 404 NO_FILE.
 */
router.get('/documents/:docId/download', async (req, res) => {
  const doc = await prisma.employeeDocument.findUnique({
    where: { id: req.params.docId },
    select: { fileName: true, data: true },
  });
  if (!doc) return sendError(res, 'Document not found', 404, 'NOT_FOUND');
  if (!doc.data) return sendError(res, 'No stored file for this record (metadata-only)', 404, 'NO_FILE');
  return sendDocumentPdf(res, doc);
});

/* ---------- Student documents (mirror of the employee documents surface) ---------- */

/**
 * GET /api/v1/admin/students/:id/documents — one student's document records,
 * newest first (strictly scoped to this student).
 */
router.get('/students/:id/documents', async (req, res) => {
  const student = await prisma.student.findUnique({ where: { id: req.params.id } });
  if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  const docs = await prisma.studentDocument.findMany({
    where: { studentId: student.id },
    select: { id: true, type: true, fileName: true, uploadedAt: true, studentId: true },
    orderBy: { uploadedAt: 'desc' },
  });
  return sendSuccess(res, docs.map((d) => ({
    id: d.id,
    type: d.type,
    fileName: d.fileName,
    uploadedAt: toIso(d.uploadedAt),
    studentId: d.studentId,
  })));
});

/** POST /api/v1/admin/students/:id/documents — upload a document record */
router.post('/students/:id/documents', documentUpload.single('file'), documentUploadError, async (req, res) => {
  const parsed = documentSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);
  if (!requirePdf(req, res)) return;

  const student = await prisma.student.findUnique({ where: { id: req.params.id } });
  if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  const created = await prisma.studentDocument.create({
    data: {
      id: newId('sdoc'),
      studentId: student.id,
      type: parsed.data.type,
      fileName: docNameFrom(req.file),
      data: req.file.buffer,
    },
  });
  return sendSuccess(res, {
    id: created.id,
    type: created.type,
    fileName: created.fileName,
    uploadedAt: toIso(created.uploadedAt),
    studentId: created.studentId,
  }, 'Document uploaded', 201);
});

/**
 * DELETE /api/v1/admin/student-documents/:docId — remove exactly one student
 * document record. Deletion is by unique document id, so it can never touch
 * another student's records.
 */
router.delete('/student-documents/:docId', async (req, res) => {
  try {
    await prisma.studentDocument.delete({ where: { id: req.params.docId } });
    return sendSuccess(res, { id: req.params.docId }, 'Document deleted');
  } catch (err) {
    if (err.code === 'P2025') return sendError(res, 'Document not found', 404, 'NOT_FOUND');
    throw err;
  }
});

/**
 * GET /api/v1/admin/student-documents/:docId/download — serve the stored PDF
 * of one student document record (mirror of the employee download above).
 */
router.get('/student-documents/:docId/download', async (req, res) => {
  const doc = await prisma.studentDocument.findUnique({
    where: { id: req.params.docId },
    select: { fileName: true, data: true },
  });
  if (!doc) return sendError(res, 'Document not found', 404, 'NOT_FOUND');
  if (!doc.data) return sendError(res, 'No stored file for this record (metadata-only)', 404, 'NO_FILE');
  return sendDocumentPdf(res, doc);
});

/* ---------- Users / Password reset ---------- */

/** GET /api/v1/admin/users — sanitized user list (never includes password hashes) */
router.get('/users', async (req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { id: 'asc' },
    include: {
      student: { select: { id: true } },
      employee: { select: { id: true } },
    },
  });
  return sendSuccess(res, users.map(mapUserPublic));
});

const resetPasswordSchema = z.object({
  newPassword: passwordSchema,
});

/** PUT /api/v1/admin/users/:id/reset-password */
router.put('/users/:id/reset-password', async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return sendError(res, 'User not found', 404, 'NOT_FOUND');

  await prisma.user.update({
    where: { id: req.params.id },
    data: {
      passwordHash: await bcrypt.hash(parsed.data.newPassword, 10),
      // The admin deliberately set this password, so it is not a derived
      // default — the recipient is not forced to change it on next login.
      mustChangePassword: false,
    },
  });
  return sendSuccess(res, null, 'Password reset successfully');
});

/* ---------- Audit log ---------- */

/**
 * GET /api/v1/admin/audit-log — newest-first trail of admin mutations.
 * DB rows ({ actorUserId, message: 'METHOD /url', createdAt }) are mapped back
 * to the mock API shape the frontend expects: { actor, method, route, at }.
 */
router.get('/audit-log', async (req, res) => {
  const rows = await prisma.auditEntry.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  return sendSuccess(res, rows.map((e) => {
    const spaceIdx = e.message.indexOf(' ');
    return {
      id: e.id,
      actor: e.actorUserId,
      entityType: e.entityType,
      entityId: e.entityId,
      method: spaceIdx === -1 ? e.message : e.message.slice(0, spaceIdx),
      route: spaceIdx === -1 ? '' : e.message.slice(spaceIdx + 1),
      at: toIso(e.createdAt),
    };
  }));
});

/* ---------- Reports ---------- */

/** GET /api/v1/admin/reports/summary — key stats for the admin dashboard */
router.get('/reports/summary', async (req, res) => {
  // 30s cache: six counts/aggregates per hit, changes only via mutations
  // (which clear the 'summary' namespace in the admin mutation hook).
  const cached = cache.get('summary:reports');
  if (cached) return sendSuccess(res, cached);

  const [totalStudents, totalEmployees, totalFeeDues, totalAnnouncements, totalHolidays, pendingLeaves] = await Promise.all([
    prisma.student.count(),
    prisma.employee.count(),
    // Everything still owed, across EVERY year — a carried-forward balance from a
    // previous class counts here too, which is the point of the per-year model.
    fees.totalOutstanding(prisma),
    prisma.announcement.count(),
    prisma.holiday.count(),
    prisma.leaveRequest.count({ where: { status: 'pending' } }),
  ]);

  const summary = {
    totalStudents,
    totalEmployees,
    totalFeeDues,
    totalAnnouncements,
    totalHolidays,
    pendingLeaves,
  };
  cache.set('summary:reports', summary);
  return sendSuccess(res, summary);
});

/* The bulk-upload template is served by its own module, mounted here so it sits
   under the same admin guard as the rest of this router. */
router.use(bulkTemplate);

module.exports = router;