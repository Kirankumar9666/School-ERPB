const express = require('express');
const { z } = require('zod');
const bcrypt = require('bcrypt');
const multer = require('multer');
const ExcelJS = require('exceljs');
const {
  Gender,
  EmploymentType,
  AccountStatus,
  AttendanceStatus,
} = require('@prisma/client');
const { parse: parseCsv } = require('csv-parse/sync');
const authMiddleware = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { ROLES, EMPLOYEE_ROLES } = require('../../constants/roles');
const { ANNOUNCEMENT_CATEGORIES, ACHIEVEMENT_TYPES } = require('../../constants/options');
const { sendSuccess, sendError, sendValidationError } = require('../../utils/response');
const { contactSchema } = require('../../utils/phone');
const prisma = require('../../services/prisma');
const { isTransientDbError } = require('../../services/prisma');
const cache = require('../../utils/cache');
const {
  bulkAttendanceSchema,
  loadAttendanceRoster,
  saveBulkAttendance,
} = require('../../services/attendance');
const {
  mapStudent,
  mapEmployee,
  mapLeave,
  mapPayroll,
  mapUserPublic,
  mapPeriod,
  mapAchievement,
  monthLabel,
  normalizeSyllabusTopics,
  statusToDb,
  statusToApi,
  classIdOf,
  toDateStr,
  toIso,
  schoolToday,
} = require('../../services/mappers');
const {
  loadTakenUsernames,
  createStudentAccount,
} = require('../../services/studentAccounts');
const { sendDocumentPdf } = require('../../services/documents');

const router = express.Router();
router.use(authMiddleware);
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

/** Maximum rows accepted per bulk-marks file */
const MARKS_BULK_MAX_ROWS = 200;

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

/**
 * Human label for a Class row — identical shape to `options.classOptions()`
 * ('Class 10A'), so error messages name the class exactly as the Select Class
 * dropdown does. Deriving it here keeps the wording in one place.
 */
const classLabelOf = (cls) => `Class ${cls.grade}${cls.section}`;

/** RFC-4180 CSV cell: quote only when the value needs it (doubling inner quotes) */
const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

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
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return utcDate(iso[1], iso[2], iso[3]);
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
  if (dmy) return utcDate(dmy[3], dmy[2], dmy[1]);
  return null;
};

/** Shared student payload → Prisma data (resolves class/section to classId) */
const studentDataFrom = async (data) => ({
  name: data.name,
  classId: classIdOf(data.class, data.section),
  rollNumber: data.rollNumber ?? null,
  parentName: data.parentName ?? null,
  guardianContact: data.guardianContact ?? null,
  address: data.address ?? null,
  admissionYear: data.admissionYear ?? null,
  bloodGroup: data.bloodGroup ?? null,
  dob: apiDate(data.dob),
  feeTotal: data.feeTotal ?? null,
  feeDues: data.feeDues ?? null,
});

/** Ensure the Class row for a grade/section pair exists (idempotent) */
const ensureClass = (cls, section) => {
  const id = classIdOf(cls, section);
  return prisma.class.upsert({
    where: { id },
    update: {},
    create: { id, grade: parseInt(cls, 10), section: String(section).toUpperCase() },
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
  class: z.string().min(1).max(2),
  section: z.string().length(1),
  rollNumber: z.string().min(1).max(50).optional(),
  parentName: z.string().min(2).max(100).optional(),
  // Contact fields are the shared digits-only rule (exactly 10) — see utils/phone.
  guardianContact: contactSchema.optional(),
  address: z.string().min(5).max(300).optional(),
  admissionYear: z.number().int().min(1990).max(2100).optional(),
  bloodGroup: z.string().max(5).optional(),
  dob: dateStr.optional(),
  feeTotal: z.number().min(0).optional(),
  feeDues: z.number().min(0).optional(),
});

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
    include: { class: true },
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

  const [students, markSums] = await Promise.all([
    prisma.student.findMany({
      select: {
        id: true,
        name: true,
        rollNumber: true,
        feeDues: true,
        class: { select: { grade: true, section: true } },
      },
      orderBy: { id: 'asc' },
    }),
    prisma.marksEntry.groupBy({
      by: ['studentId'],
      _sum: { obtained: true, maxMarks: true },
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

  // Same JS-side filter the mock version applied (keeps ?q= semantics
  // identical: name/roll/class/section substring match)
  const pool = q
    ? students.filter((s) => [s.name, s.rollNumber, String(s.class.grade), s.class.section]
      .some((v) => String(v ?? '').toLowerCase().includes(q)))
    : students;

  const groups = new Map();
  pool.forEach((s) => {
    const key = `${s.class.grade}-${s.class.section}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        grade: s.class.grade,
        section: s.class.section,
        studentIds: [],
        totalStudents: 0,
        feeDues: 0,
        percents: [],
      });
    }
    const g = groups.get(key);
    g.studentIds.push(s.id);
    g.totalStudents += 1;
    g.feeDues += Number(s.feeDues) || 0;
    const percent = percentOf.get(s.id);
    if (percent !== undefined && percent !== null) g.percents.push(percent);
  });

  const rows = [...groups.values()].map((g) => ({
    key: g.key,
    class: `${g.grade} - Class ${g.section}`,
    totalStudents: g.totalStudents,
    feeDues: g.feeDues,
    topScore: g.percents.length ? Math.round(Math.max(...g.percents)) : null,
    avgMarks: g.percents.length
      ? Math.round(g.percents.reduce((a, b) => a + b, 0) / g.percents.length)
      : null,
    markedCount: g.percents.length,
    studentIds: g.studentIds,
  }));

  // Numeric classes first (9 before 10), then section A→B→C
  rows.sort((a, b) => {
    const na = parseInt(a.key, 10);
    const nb = parseInt(b.key, 10);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
    return a.key.localeCompare(b.key);
  });

  return sendSuccess(res, rows);
});

/* ---------- Students bulk upload (CSV / XLSX, parsed server-side) ---------- */

/** Multer keeps the upload in memory — no temp files to clean up. 5 MB cap. */
const bulkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

/** Bulk-upload columns — header row required, in this exact order (RollNumber optional) */
const BULK_COLUMNS = ['Name', 'Class', 'Section', 'RollNumber', 'ParentGuardian', 'Contact', 'FeeDues'];

/** Per class/section, the latest year seen in that group's roll numbers */
const latestRollYear = (students) => {
  const years = students
    .map((s) => (/^STU-(\d{4})-(\d+)$/.exec(String(s.rollNumber ?? '').trim()) || [])[1])
    .filter(Boolean);
  return years.length ? years.sort().pop() : String(new Date().getFullYear());
};

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

    /* Header row: required, exact column order */
    const header = (records[0] || []).map((h) => String(h ?? '').trim());
    const headerOk = header.length === BULK_COLUMNS.length
      && header.every((h, i) => h.toLowerCase() === BULK_COLUMNS[i].toLowerCase());
    if (!headerOk) {
      return sendValidationError(res, { file: `Header row must be exactly: ${BULK_COLUMNS.join(', ')}` });
    }

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
      const rowNum = i + 2; // header is row 1
      if (cells.length !== BULK_COLUMNS.length) {
        errors[`row_${rowNum}`] = { columns: `Expected ${BULK_COLUMNS.length} columns, got ${cells.length}` };
        return;
      }
      const [name, cls, section, rollNumber, parentGuardian, contact, feeDues] = cells;

      /* Required per row (only RollNumber may be blank) + format checks */
      const rowErrors = {};
      if (!name) rowErrors.Name = 'Required';
      if (!cls) rowErrors.Class = 'Required';
      else if (!/^\d{1,2}$/.test(cls)) rowErrors.Class = 'Must be a grade number (1–2 digits)';
      if (!section) rowErrors.Section = 'Required';
      else if (!/^[A-Z]$/.test(String(section).toUpperCase())) rowErrors.Section = 'Must be a single letter';
      if (!parentGuardian) rowErrors.ParentGuardian = 'Required';
      if (!contact) rowErrors.Contact = 'Required';
      if (!feeDues) rowErrors.FeeDues = 'Required';
      else if (Number.isNaN(Number(feeDues)) || Number(feeDues) < 0) rowErrors.FeeDues = 'Must be a non-negative number';
      if (Object.keys(rowErrors).length > 0) {
        errors[`row_${rowNum}`] = rowErrors;
        return;
      }

      const parsed = studentSchema.safeParse({
        name,
        class: cls,
        section: String(section).toUpperCase(),
        rollNumber: rollNumber || undefined,
        parentName: parentGuardian,
        guardianContact: contact,
        feeDues: Number(feeDues),
      });
      if (!parsed.success) errors[`row_${rowNum}`] = parsed.error.flatten().fieldErrors;
      else entries.push(parsed.data);
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
      const parsed = studentSchema.safeParse(entry);
      if (!parsed.success) errors[`row_${i + 1}`] = parsed.error.flatten().fieldErrors;
      else entries.push(parsed.data);
    });
  } else {
    return sendError(res, 'Attach a .csv or .xlsx file in the "file" field', 400, 'BAD_REQUEST');
  }

  /* ---------- 2. Atomic: reject the whole file if any row failed ---------- */
  if (Object.keys(errors).length > 0) return sendValidationError(res, errors);

  /* ---------- 3. Auto-generate blank roll numbers per class/section ---------- */
  const groups = new Map();
  const groupKey = (s) => `${String(s.class ?? '').trim()}-${String(s.section ?? '').trim().toUpperCase()}`;
  const existing = await prisma.student.findMany({
    select: { rollNumber: true, class: { select: { grade: true, section: true } } },
  });
  existing.forEach((s) => {
    const k = groupKey({ class: s.class.grade, section: s.class.section });
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ rollNumber: s.rollNumber });
  });
  entries.forEach((entry) => {
    if (entry.rollNumber) return; // the row supplied one
    const k = groupKey(entry);
    const members = groups.get(k) || [];
    const roll = nextRollNumber(members, latestRollYear(members));
    entry.rollNumber = roll;
    members.push({ rollNumber: roll }); // later blank rows in the same group must not collide
  });

  /* ---------- 4. Insert (ensure Class rows, then create in row order) ---------- */
  const stamp = Date.now();
  const createdRows = [];
  for (let i = 0; i < entries.length; i += 1) {
    await ensureClass(entries[i].class, entries[i].section);
    // Per-row recovery: a dropped pooler connection can lose the response
    // AFTER the row committed, so a plain retry would trip the rollNumber
    // unique constraint. On any failure, re-derive the next free roll number
    // from fresh DB state and retry with a fresh unique id.
    let row = null;
    for (let attempt = 0; attempt < 3 && !row; attempt += 1) {
      try {
        // Sortable unique id ('stu-<ts>-<0001>') so a re-read preserves row order
        row = await prisma.student.create({
          data: {
            id: `stu-${stamp}-${String(i + 1).padStart(4, '0')}${attempt ? `r${attempt}` : ''}`,
            ...(await studentDataFrom(entries[i])),
          },
          include: { class: true },
        });
      } catch (err) {
        const retriable = attempt < 2
          && (String(err?.meta?.target || '').includes('rollNumber') || isTransientDbError(err));
        if (!retriable) throw err;
        const members = await prisma.student.findMany({
          where: { classId: classIdOf(entries[i].class, entries[i].section) },
          select: { rollNumber: true },
        });
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
  const message = `${created.length} students added · ${accounts.length} login account${accounts.length === 1 ? '' : 's'} created (initial password = guardian contact)`;
  return sendSuccess(res, { created, count: created.length, accountsCreated: accounts.length, accounts }, message, 201);
});

/** POST /api/v1/admin/students — create student (login auto-provisioned) */
router.post('/students', async (req, res) => {
  const parsed = studentSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  await ensureClass(parsed.data.class, parsed.data.section);
  try {
    const created = await prisma.student.create({
      data: { id: newId('stu'), ...(await studentDataFrom(parsed.data)) },
      include: { class: true },
    });
    // Auto-provision the student's login: username from the name (suffix on
    // collision), initial password = guardian contact. Null when the student
    // has no guardian contact on file (nothing to derive a password from).
    const account = await createStudentAccount(created, { taken: await loadTakenUsernames() });
    const message = account
      ? `Student created. Login: ${account.username} (initial password = guardian contact)`
      : 'Student created';
    return sendSuccess(res, { ...mapStudent(created), account }, message, 201);
  } catch (err) {
    if (err.code === 'P2002') return sendError(res, uniqueErrorMessage(err), 409, 'DUPLICATE');
    throw err;
  }
});

/** PUT /api/v1/admin/students/:id — update student */
router.put('/students/:id', async (req, res) => {
  const parsed = studentSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const existing = await prisma.student.findUnique({ where: { id: req.params.id } });
  if (!existing) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  await ensureClass(parsed.data.class, parsed.data.section);
  const updated = await prisma.student.update({
    where: { id: req.params.id },
    data: await studentDataFrom(parsed.data),
    include: { class: true },
  });
  return sendSuccess(res, mapStudent(updated), 'Student updated');
});

/** DELETE /api/v1/admin/students/:id */
router.delete('/students/:id', async (req, res) => {
  try {
    await prisma.student.delete({ where: { id: req.params.id } });
    return sendSuccess(res, { id: req.params.id }, 'Student deleted');
  } catch (err) {
    if (err.code === 'P2025') return sendError(res, 'Student not found', 404, 'NOT_FOUND');
    if (err.code === 'P2003') return sendError(res, 'Student has dependent records (attendance/marks/achievements)', 409, 'CONFLICT');
    throw err;
  }
});

/* ---------- Employees CRUD ---------- */

/* Shared include: employee + teaching assignments (with class + student counts) */
const EMPLOYEE_INCLUDE = {
  classesTaught: { include: { class: { include: { _count: { select: { students: true } } } } } },
};

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
  status: z.enum(Object.values(AccountStatus)).optional(),
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
  ...(d.status !== undefined ? { status: d.status } : {}),
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
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id }, include: EMPLOYEE_INCLUDE });
  if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  const latest = await prisma.payrollRecord.findFirst({
    where: { employeeId: employee.id },
    orderBy: { month: 'desc' },
    select: {
      basicPay: true, hra: true, transportAllowance: true, medicalAllowance: true,
      providentFund: true, professionalTax: true, tds: true,
    },
  });

  // All seven components are non-null Ints on both models, so a plain logical
  // pick between the latest month and the stored default is unambiguous.
  const src = latest ?? employee;
  return sendSuccess(res, {
    ...mapEmployee(employee),
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
      data: { id: newId('emp'), ...employeeDataFrom(parsed.data) },
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
  const parsed = employeeSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const existing = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!existing) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

  await prisma.employee.update({ where: { id: req.params.id }, data: employeeDataFrom(parsed.data) });
  const updated = await prisma.employee.findUnique({ where: { id: req.params.id }, include: EMPLOYEE_INCLUDE });
  return sendSuccess(res, mapEmployee(updated), 'Employee updated');
});

/** DELETE /api/v1/admin/employees/:id */
router.delete('/employees/:id', async (req, res) => {
  try {
    await prisma.employee.delete({ where: { id: req.params.id } });
    return sendSuccess(res, { id: req.params.id }, 'Employee deleted');
  } catch (err) {
    if (err.code === 'P2025') return sendError(res, 'Employee not found', 404, 'NOT_FOUND');
    if (err.code === 'P2003') return sendError(res, 'Employee has dependent records', 409, 'CONFLICT');
    throw err;
  }
});

/* ---------- Leaves ---------- */

/** GET /api/v1/admin/leaves/pending — list all pending leave applications */
router.get('/leaves/pending', async (req, res) => {
  const pending = await prisma.leaveRequest.findMany({
    where: { status: 'pending' },
    include: { employee: { select: { name: true } } },
    orderBy: { appliedAt: 'desc' },
  });
  return sendSuccess(res, pending.map((l) => ({
    ...mapLeave(l),
    employeeId: l.employeeId,
    employeeName: l.employee?.name || null,
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

/* ---------- Payroll ---------- */

/**
 * Payroll status is DERIVED, never stored: a PayrollRecord with a paidOn date
 * is 'paid', everything else is 'pending' — the same rule the employee portal
 * renders as "Payment pending".
 */
const payrollStatus = (r) => (r.paidOn ? 'paid' : 'pending');

/** Strict month key: 'YYYY-MM' with a real month (01–12) */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Net payable — always recomputed server-side from the saved components. */
const netOf = (p) =>
  p.basicPay + p.hra + p.transportAllowance + p.medicalAllowance -
  p.providentFund - p.professionalTax - p.tds;

/**
 * GET /api/v1/admin/payroll — every employee with their full payment history.
 * One query per table, grouped in memory: employees + all payroll records,
 * keyed by employeeId. Status is derived per record (paid/pending).
 */
router.get('/payroll', async (req, res) => {
  const [employees, records] = await Promise.all([
    prisma.employee.findMany({ orderBy: { id: 'asc' } }),
    prisma.payrollRecord.findMany({ orderBy: [{ employeeId: 'asc' }, { month: 'asc' }] }),
  ]);

  const history = {};
  records.forEach((r) => {
    (history[r.employeeId] ??= []).push({ id: r.id, ...mapPayroll(r), status: payrollStatus(r) });
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
 * PUT /api/v1/admin/payroll/:employeeId/:month — create or update the salary
 * breakdown for one month (upsert on the employeeId+month unique pair), with
 * netSalary recomputed here so a tampered client can't post a wrong net.
 *
 * Pending months only: once a month is paid its record is immutable (the slip
 * already went out) — subsequent months should be set up instead. Returns 409
 * ALREADY_PAID otherwise.
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
  if (existing?.paidOn) {
    return sendError(
      res,
      `${monthLabel(month)} payroll is already paid — paid months cannot be edited`,
      409,
      'ALREADY_PAID',
    );
  }

  const net = netOf(parsed.data);
  if (net < 0) return sendError(res, 'Deductions exceed total earnings', 400, 'INVALID_PAYROLL');

  const saved = await prisma.payrollRecord.upsert({
    where: { employeeId_month: { employeeId, month } },
    update: { ...parsed.data, netSalary: net },
    create: { employeeId, month, ...parsed.data, netSalary: net },
  });

  return sendSuccess(
    res,
    { id: saved.id, ...mapPayroll(saved), status: payrollStatus(saved) },
    'Salary structure saved',
  );
});

/** POST /api/v1/admin/payroll/:employeeId/:month/mark-paid body */
const markPaidSchema = z.object({
  /** 'YYYY-MM-DD'; omitted → today (UTC) */
  paidDate: dateStr.optional(),
});

/**
 * POST /api/v1/admin/payroll/:employeeId/:month/mark-paid — record the payment
 * for a pending month. The record must exist (save the salary structure first)
 * and must not already be paid.
 */
router.post('/payroll/:employeeId/:month/mark-paid', async (req, res) => {
  const { employeeId, month } = req.params;
  if (!MONTH_RE.test(month)) return sendError(res, 'Month must be YYYY-MM', 400, 'VALIDATION_ERROR');
  const parsed = markPaidSchema.safeParse(req.body ?? {});
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const record = await prisma.payrollRecord.findUnique({
    where: { employeeId_month: { employeeId, month } },
  });
  if (!record) {
    return sendError(res, 'No payroll record for this month — save the salary structure first', 404, 'NOT_FOUND');
  }
  if (record.paidOn) {
    return sendError(res, `${monthLabel(month)} payroll is already paid`, 409, 'ALREADY_PAID');
  }

  const updated = await prisma.payrollRecord.update({
    where: { employeeId_month: { employeeId, month } },
    data: { paidOn: parsed.data.paidDate ? apiDate(parsed.data.paidDate) : apiDate(new Date().toISOString().slice(0, 10)) },
  });

  return sendSuccess(res, { id: updated.id, ...mapPayroll(updated), status: 'paid' }, 'Payroll marked as paid');
});

/* ---------- Announcements ---------- */

/**
 * DB row → API shape. showFrom/showUntil are the visibility window: a
 * circular appears on the portals only while today (the school's real
 * current date, computed per request) is inside [showFrom, showUntil].
 */
const mapAnnouncement = (a) => ({
  id: a.id,
  title: a.title,
  body: a.body,
  targetRoles: a.targetRoles,
  category: a.category,
  createdAt: toIso(a.createdAt),
  showFrom: toDateStr(a.showFrom),
  showUntil: toDateStr(a.showUntil),
});

/** showUntil ≥ showFrom (both 'YYYY-MM-DD' strings — lexicographic works) */
const scheduleRangeErrors = (showFrom, showUntil) =>
  showFrom > showUntil ? { showUntil: ['Show until must be on or after Show from.'] } : null;

const announcementSchema = z.object({
  title: z.string().min(3).max(200),
  body: z.string().min(10),
  targetRoles: z.array(z.enum(Object.values(ROLES))).min(1),
  category: z.enum(ANNOUNCEMENT_CATEGORIES),
  // Omitted on create → the circular is visible from today (server date).
  showFrom: dateStr.optional(),
  // Required: after this day the circular stops appearing everywhere.
  showUntil: dateStr,
});

/** GET /api/v1/admin/announcements — list all (admin sees everything, including
 * scheduled and expired windows), newest showFrom first */
router.get('/announcements', async (req, res) => {
  const rows = await prisma.announcement.findMany({
    orderBy: [{ showFrom: 'desc' }, { createdAt: 'desc' }],
  });
  return sendSuccess(res, rows.map(mapAnnouncement));
});

/** POST /api/v1/admin/announcements — create new announcement */
router.post('/announcements', async (req, res) => {
  const parsed = announcementSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  // "Show from" left blank → visible from today (the real current school date).
  const showFrom = parsed.data.showFrom || schoolToday();
  const rangeErrors = scheduleRangeErrors(showFrom, parsed.data.showUntil);
  if (rangeErrors) return sendValidationError(res, rangeErrors);

  const created = await prisma.announcement.create({
    data: { id: newId('ann'), ...parsed.data, showFrom: apiDate(showFrom), showUntil: apiDate(parsed.data.showUntil) },
  });
  return sendSuccess(res, mapAnnouncement(created), 'Announcement created', 201);
});

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
    const rangeErrors = scheduleRangeErrors(showFrom, parsed.data.showUntil);
    if (rangeErrors) return sendValidationError(res, rangeErrors);

    const updated = await prisma.announcement.update({
      where: { id: req.params.id },
      data: { ...parsed.data, showFrom: apiDate(showFrom), showUntil: apiDate(parsed.data.showUntil) },
    });
    return sendSuccess(res, mapAnnouncement(updated), 'Announcement updated');
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

/* ---------- Attendance ---------- */

const attendanceSchema = z.object({
  entityType: z.enum(['student', 'employee']),
  entityId: z.string().min(1),
  date: dateStr,
  status: z.enum(Object.values(AttendanceStatus).map(statusToApi)),
  workingHours: z.number().min(0).max(24).optional(),
});

/** POST /api/v1/admin/attendance — mark attendance for a student or employee (upsert per day) */
router.post('/attendance', async (req, res) => {
  const parsed = attendanceSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const { entityType, entityId, date, status, workingHours } = parsed.data;
  const statusDb = statusToDb(status);
  const day = apiDate(date);
  const hours = workingHours ?? (status === 'present' ? 8 : 0);

  if (entityType === 'student') {
    const student = await prisma.student.findUnique({ where: { id: entityId } });
    if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

    // Enrollment gate (same rule as the day rosters): attendance cannot be
    // recorded for a day before the student was enrolled.
    if (student.enrolledAt > day) {
      return sendError(res, `${student.name} was not enrolled on ${date}`, 400, 'VALIDATION_ERROR');
    }

    await prisma.studentAttendance.upsert({
      where: { studentId_date: { studentId: entityId, date: day } },
      update: { status: statusDb },
      create: { studentId: entityId, date: day, status: statusDb },
    });
  } else {
    const employee = await prisma.employee.findUnique({ where: { id: entityId } });
    if (!employee) return sendError(res, 'Employee not found', 404, 'NOT_FOUND');

    await prisma.employeeAttendance.upsert({
      where: { employeeId_date: { employeeId: entityId, date: day } },
      update: { status: statusDb, workingHours: hours },
      create: { employeeId: entityId, date: day, status: statusDb, workingHours: hours },
    });
  }

  return sendSuccess(res, { entityType, entityId, date, status }, 'Attendance marked', 201);
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
 * GET /api/v1/admin/attendance/group?kind=student|employee&groupKey=...&date=YYYY-MM-DD
 * Roster of one group with each member's saved status for the date (null =
 * unmarked) plus the confirmation state that drives the 1-hour edit window.
 * Students are ordered by roll number, employees by name.
 */
router.get('/attendance/group', async (req, res) => {
  const kind = String(req.query.kind || '');
  const groupKey = String(req.query.groupKey || '').trim();
  const dateQ = String(req.query.date || '').trim();

  if (!['student', 'employee'].includes(kind)) {
    return sendError(res, 'kind must be "student" or "employee"', 400, 'VALIDATION_ERROR');
  }
  if (!groupKey) return sendError(res, 'groupKey is required', 400, 'VALIDATION_ERROR');
  if (!dateStr.safeParse(dateQ).success) {
    return sendError(res, 'date must be YYYY-MM-DD', 400, 'VALIDATION_ERROR');
  }

  const roster = await loadAttendanceRoster(kind, groupKey, dateQ);
  if (!roster) {
    return sendError(res, kind === 'student' ? 'Class not found' : 'Staff group not found', 404, 'NOT_FOUND');
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

/** MarksEntry rows (with exam) → [{ examId, examName, date, subjects: [...] }] (mock API shape) */
const groupMarksByExam = (rows) => {
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
    byExam.get(e.examId).subjects.push({
      subject: e.subject,
      maxMarks: e.maxMarks,
      obtained: e.obtained,
    });
  });
  return [...byExam.values()];
};

/** POST /api/v1/admin/marks — upload marks for a student/exam (upserts exam + subject entries) */
router.post('/marks', async (req, res) => {
  const parsed = marksSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const student = await prisma.student.findUnique({ where: { id: parsed.data.studentId } });
  if (!student) return sendError(res, 'Student not found', 404, 'NOT_FOUND');

  const examDate = apiDate(parsed.data.date) || new Date();
  const exam = await prisma.exam.upsert({
    where: { classId_name: { classId: student.classId, name: parsed.data.examName } },
    update: { date: examDate },
    create: { id: newId('exam'), classId: student.classId, name: parsed.data.examName, date: examDate },
  });

  for (const s of parsed.data.subjects) {
    await prisma.marksEntry.upsert({
      where: { studentId_examId_subject: { studentId: student.id, examId: exam.id, subject: s.subject } },
      update: { maxMarks: s.maxMarks, obtained: s.obtained },
      create: { studentId: student.id, examId: exam.id, subject: s.subject, maxMarks: s.maxMarks, obtained: s.obtained },
    });
  }

  return sendSuccess(res, {
    examId: exam.id,
    studentId: student.id,
    examName: exam.name,
    date: toDateStr(exam.date),
    subjects: parsed.data.subjects,
  }, 'Marks uploaded', 201);
});

/**
 * GET /api/v1/admin/marks?studentId=&classId= — marks grouped per exam
 * (object keyed by student when no studentId is given).
 * `?classId=` keeps only the rows whose student is in that class, so the Marks
 * Entry page recomputes its stat cards from the selected class alone instead of
 * filtering a school-wide payload client-side.
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

  if (studentId) return sendSuccess(res, groupMarksByExam(entries));

  // No studentId → same shape the mock store served: object keyed by studentId
  const byStudent = new Map();
  entries.forEach((e) => {
    if (!byStudent.has(e.studentId)) byStudent.set(e.studentId, []);
    byStudent.get(e.studentId).push(e);
  });
  const out = {};
  byStudent.forEach((rows, sid) => { out[sid] = groupMarksByExam(rows); });
  return sendSuccess(res, out);
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

  const classLabel = classLabelOf(cls);

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
        return cells.length === MARKS_BULK_COLUMNS.length
          && cells.every((c, i) => c.toLowerCase() === MARKS_BULK_COLUMNS[i].toLowerCase());
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
  const headerOk = header.length === MARKS_BULK_COLUMNS.length
    && header.every((h, i) => h.toLowerCase() === MARKS_BULK_COLUMNS[i].toLowerCase());
  if (!headerOk) {
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
    include: { class: true },
  });

  // Roll numbers are unique within a class (@@unique([classId, rollNumber])),
  // so inside the selected class the roll number alone identifies the student.
  const byRoll = new Map();
  students.forEach((s) => {
    const key = String(s.rollNumber ?? '').trim().toLowerCase();
    if (!key) return;
    byRoll.set(key, s);
  });

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
      rowErrors.RollNumber = `No student with this roll number in ${classLabel}`;
    }

    // One row per student per exam per subject — duplicates are ambiguous
    if (student) {
      const key = `${student.id}::${text('ExamName').toLowerCase()}::${text('Subject').toLowerCase()}`;
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
      subject: text('Subject'),
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
  // Exams are unique per (class, name), so rows are grouped: one exam per class.
  const examGroups = new Map();
  entries.forEach((e) => {
    const key = `${e.classId}::${e.examName.toLowerCase()}`;
    if (!examGroups.has(key)) examGroups.set(key, { classId: e.classId, name: e.examName, date: e.examDate });
  });

  // Interactive transaction (the array form ignores `timeout`, and a 200-row
  // file means 200+ upserts over a remote database — the default 5s would abort).
  // Any failure rolls the whole file back, so nothing is partially saved.
  const stamp = Date.now();
  await prisma.$transaction(async (tx) => {
    const examIdOf = new Map();
    let n = 0;
    for (const [key, group] of examGroups) {
      n += 1;
      const exam = await tx.exam.upsert({
        where: { classId_name: { classId: group.classId, name: group.name } },
        update: { date: group.date },
        create: { id: `exam-${stamp}-${n}`, classId: group.classId, name: group.name, date: group.date },
      });
      examIdOf.set(key, exam.id);
    }
    // Perf: one existence read, then creates via createMany and updates
    // grouped by identical (exam, subject, maxMarks, obtained) payload →
    // one updateMany per distinct payload. A 200-row first upload becomes
    // ~2 queries instead of 200 sequential round trips; correction re-uploads
    // collapse to a handful. Semantics match the previous per-row upserts.
    const examIds = [...new Set(entries.map((e) => examIdOf.get(`${e.classId}::${e.examName.toLowerCase()}`)))];
    const existingRows = await tx.marksEntry.findMany({
      where: { examId: { in: examIds } },
      select: { studentId: true, examId: true, subject: true },
    });
    const existingKeys = new Set(existingRows.map((r) => `${r.studentId}::${r.examId}::${r.subject}`));

    const creates = [];
    const updateGroups = new Map(); // payload key → { examId, subject, maxMarks, obtained, studentIds[] }
    const seen = new Set();
    entries.forEach((e) => {
      const examId = examIdOf.get(`${e.classId}::${e.examName.toLowerCase()}`);
      const rowKey = `${e.studentId}::${examId}::${e.subject}`;
      const isExisting = existingKeys.has(rowKey) || seen.has(rowKey);
      seen.add(rowKey);
      if (isExisting) {
        const payloadKey = `${examId}::${e.subject}::${e.maxMarks}::${e.obtained}`;
        if (!updateGroups.has(payloadKey)) {
          updateGroups.set(payloadKey, { examId, subject: e.subject, maxMarks: e.maxMarks, obtained: e.obtained, studentIds: [] });
        }
        updateGroups.get(payloadKey).studentIds.push(e.studentId);
      } else {
        creates.push({ studentId: e.studentId, examId, subject: e.subject, maxMarks: e.maxMarks, obtained: e.obtained });
      }
    });

    // Creates first, then updates — a duplicate rowKey (defensive: the parser
    // already rejects in-file duplicates) lands as create + update on top.
    if (creates.length) {
      await tx.marksEntry.createMany({ data: creates });
    }
    for (const group of updateGroups.values()) {
      await tx.marksEntry.updateMany({
        where: { examId: group.examId, subject: group.subject, studentId: { in: group.studentIds } },
        data: { maxMarks: group.maxMarks, obtained: group.obtained },
      });
    }
  }, { timeout: 180000, maxWait: 20000 });

  const saved = entries.length;
  const studentsTouched = new Set(entries.map((e) => e.studentId)).size;
  const examsTouched = examGroups.size;

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
  }, `${saved} mark row${saved === 1 ? '' : 's'} saved for ${studentsTouched} student${studentsTouched === 1 ? '' : 's'} in ${examsTouched} exam${examsTouched === 1 ? '' : 's'} (${classLabel})`, 201);
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
  classKey: z.string().regex(/^cls-\d+[A-Z]$/),
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
  classKey: z.string().regex(/^cls-\d+[A-Z]$/),
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
 */
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

/** Multer rejections (e.g. over the 5 MB cap) become a plain 400, not a 500. */
function documentUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    return sendError(
      res,
      err.code === 'LIMIT_FILE_SIZE' ? 'File too large — the maximum size is 5 MB' : 'File upload failed',
      400,
      'BAD_REQUEST'
    );
  }
  return next(err);
}

const documentSchema = z.object({
  type: z.string().min(2).max(100),
});

/**
 * Server-side PDF gate — the browser's `accept` filter is advisory, so the
 * upload is only accepted when the real extension, the declared MIME type and
 * the file's own `%PDF-` magic bytes all agree. A renamed .txt or a binary
 * blob with a .pdf name is rejected here.
 */
function requirePdf(req, res) {
  if (!req.file) {
    sendError(res, 'No file uploaded — attach a PDF file', 400, 'BAD_REQUEST');
    return false;
  }
  const magic = req.file.buffer.subarray(0, 5).toString('latin1') === '%PDF-';
  if (!(/\.pdf$/i.test(req.file.originalname) && req.file.mimetype === 'application/pdf' && magic)) {
    sendError(res, 'Only PDF files are allowed', 400, 'BAD_REQUEST');
    return false;
  }
  return true;
}

/** Stored document name is derived from the actual uploaded file — never typed. */
function docNameFrom(file) {
  const base = file.originalname.replace(/\.[^.]*$/, '').trim();
  return (base || 'Document').slice(0, 200);
}

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
  newPassword: z.string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[a-z]/, 'Password must include a lowercase letter')
    .regex(/[A-Z]/, 'Password must include an uppercase letter')
    .regex(/[0-9]/, 'Password must include a digit'),
});

/** PUT /api/v1/admin/users/:id/reset-password */
router.put('/users/:id/reset-password', async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error.flatten().fieldErrors);

  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return sendError(res, 'User not found', 404, 'NOT_FOUND');

  await prisma.user.update({
    where: { id: req.params.id },
    data: { passwordHash: await bcrypt.hash(parsed.data.newPassword, 10) },
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

  const [totalStudents, totalEmployees, feeAgg, totalAnnouncements, totalHolidays, pendingLeaves] = await Promise.all([
    prisma.student.count(),
    prisma.employee.count(),
    prisma.student.aggregate({ _sum: { feeDues: true } }),
    prisma.announcement.count(),
    prisma.holiday.count(),
    prisma.leaveRequest.count({ where: { status: 'pending' } }),
  ]);

  const summary = {
    totalStudents,
    totalEmployees,
    totalFeeDues: feeAgg._sum.feeDues || 0,
    totalAnnouncements,
    totalHolidays,
    pendingLeaves,
  };
  cache.set('summary:reports', summary);
  return sendSuccess(res, summary);
});

module.exports = router;
