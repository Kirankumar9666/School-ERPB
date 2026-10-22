/**
 * Response-shape mappers and small date helpers.
 *
 * The Prisma models are normalized (Student has classId + a Class relation,
 * PayrollRecord is flat, dates are DateTime) while the original mock stores
 * used denormalized API shapes (class: '10' + section: 'A', nested
 * allowances/deductions, 'YYYY-MM-DD' strings). These mappers convert DB rows
 * to the exact shapes the routes returned while mock-driven, so the frontend
 * and the integration tests keep working unchanged.
 */
const { employment } = require('./employment');
const prisma = require('./prisma');

/** DateTime (@db.Date, UTC midnight) → 'YYYY-MM-DD' */
const toDateStr = (d) => (d ? d.toISOString().slice(0, 10) : null);

/** DateTime → ISO string (or null) */
const toIso = (d) => (d ? d.toISOString() : null);

/**
 * The school's current date as 'YYYY-MM-DD', derived from the REAL clock on
 * every call — never cached or hardcoded — so the announcement show-window
 * filter can never go stale. Asia/Kolkata is the school timezone the whole
 * app runs on (en-IN dates, IST timetable), so "today" is the school's
 * calendar day, not the server process's UTC day.
 */
const schoolToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); // en-CA → YYYY-MM-DD

/**
 * 'YYYY-MM' → { gte: Date, lt: Date } covering that month (UTC bounds).
 * Returns null for malformed months (callers then serve empty records,
 * matching the old mock behaviour for unknown month keys).
 */
const monthRange = (month) => {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const gte = new Date(`${month}-01T00:00:00.000Z`);
  const lt = new Date(gte);
  lt.setUTCMonth(lt.getUTCMonth() + 1);
  return { gte, lt };
};

/** 'YYYY-MM' → 'August 2026' (used by the payroll month label) */
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const monthLabel = (month) => {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '');
  return m ? `${MONTH_NAMES[Number(m[2]) - 1]} ${m[1]}` : month;
};

/* DB enum 'half_day' ↔ API string 'half-day' (the mock/API spelling) */
const statusToApi = (s) => (s === 'half_day' ? 'half-day' : s);
const statusToDb = (s) => (s === 'half-day' ? 'half_day' : s);

/**
 * Human label for a Class row — 'Class 10A' for a numbered level, 'Nursery A'
 * for a named one.
 *
 * ONE function, used everywhere a class is named: server-side error messages,
 * every class list, the payslip and report builders, and the frontend's shared
 * `classes.js` helper. Nothing else in the app builds a class name, so a screen
 * cannot invent wording the rest of the app does not use.
 *
 * `cls.level` is only present when the query included it. When it is missing the
 * function falls back to `cls.grade` — which is defined to hold the level's order
 * — so the output is UNCHANGED for a caller that has not been updated yet. That
 * fallback is what makes this refactor safe to land in pieces: a missed include
 * degrades to today's exact wording rather than to a wrong one.
 *
 * @param {{grade?: number, section: string, level?: {name: string, order: number}}} cls
 * @returns {string|null}
 */
const classLabel = (cls) => {
  if (!cls || !cls.section) return null;
  const levelName = cls.level ? cls.level.name : (cls.grade === undefined || cls.grade === null ? null : String(cls.grade));
  if (levelName === null) return `Class ${cls.section}`;
  // A level whose name is a number keeps the historical wording; a named level
  // reads as its own name. 'Class 10A', but 'Nursery A'.
  //
  // Guard (QA-A1-016): the `grade` fallback holds the level's ORDER, so a NAMED
  // level that arrived without its `level` relation would read as its order —
  // LKG (order -1) as "-1 A", UKG (order 0) as "Class 0A". Order 0 and negatives
  // never name a real numbered class, so printing them is always wrong. Rather
  // than invent a number, we refuse to render one: the caller should include the
  // level (or use `classLabelFor`, which loads it).
  if (/^-?\d+$/.test(levelName) && Number(levelName) <= 0) return `Class ${cls.section}`;
  return /^\d+$/.test(levelName)
    ? `Class ${levelName}${cls.section}`
    : `${levelName} ${cls.section}`;
};

/**
 * The same label, but loads the level when the row does not carry it.
 *
 * `classLabel` is synchronous and every hot path already includes `level`. A few
 * read paths (a preview, a roster assembled from ids) can receive a bare class
 * row; when such a row is missing its level AND its fallback `grade` is 0 or
 * negative, we fetch the level so the label is the class's NAME ("LKG A") rather
 * than its order ("-1 A"). Extra round-trips happen only on that edge, never on
 * the normal path where the level is already present.
 *
 * @param {{id?: string, grade?: number, section: string, level?: {name: string, order: number}}} cls
 * @returns {Promise<string|null>}
 */
const classLabelFor = async (cls) => {
  if (!cls || !cls.section) return null;
  const needsLevel = !cls.level && cls.id
    && (cls.grade === undefined || cls.grade === null || Number(cls.grade) <= 0);
  if (needsLevel) {
    const full = await prisma.class.findUnique({ where: { id: cls.id }, include: { level: true } });
    if (full) return classLabel(full);
  }
  return classLabel(cls);
};

/**
 * The one sort order for classes: by level order, then section.
 *
 * `Class.grade` IS the level's order (kept in sync whenever a level moves — see
 * services/classes.js), so this comparator and a Prisma
 * `orderBy: [{ grade: 'asc' }, { section: 'asc' }]` always agree, and the two can
 * never be made to disagree by editing one of them.
 *
 * @param {{grade?: number, section: string, level?: {order: number}}} a
 * @param {{grade?: number, section: string, level?: {order: number}}} b
 * @returns {number}
 */
const classOrder = (cls) => (cls && cls.level ? cls.level.order : (cls ? cls.grade : 0));

const compareClasses = (a, b) => {
  const byOrder = classOrder(a) - classOrder(b);
  if (byOrder !== 0) return byOrder;
  return String((a && a.section) || '').localeCompare(String((b && b.section) || ''));
};

/**
 * Level name → the fragment used to build a class id.
 *
 * Numbered levels pass through untouched, so Class 1 A is still 'cls-1A' exactly
 * as the seeded rows are; a named level keeps its name ('Nursery' →
 * 'cls-NURSERYA'). An id is therefore NEVER parsed back into a grade or a
 * section — it is an opaque key and the class record is the only source of truth
 * for both.
 */
const levelSlug = (name) => String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '');

/* 'LKG' + 'A' → 'cls-LKGA'; '10' + 'A' → 'cls-10A' (the seeded Class id format) */
const classIdOf = (levelName, section) => `cls-${levelSlug(levelName)}${String(section).trim().toUpperCase()}`;

/**
 * Student row (with included class) → mock API shape.
 * classId/createdAt/updatedAt are dropped; class/section are denormalized.
 */
const mapStudent = (s) => ({
  id: s.id,
  userId: s.userId,
  username: s.user?.username ?? null, // login account (only present when included)
  name: s.name,
  photo: s.photo,
  class: s.class ? String(s.class.grade) : null,
  section: s.class ? s.class.section : null,
  // The class's REAL id. Callers used to rebuild it as `cls-${class}${section}`,
  // which works while a level name is a number and silently produces
  // 'cls--2A' for Nursery. The database id is the only safe key.
  classId: s.classId ?? null,
  // The display name, so no screen rebuilds "Class -2-A" out of the order for a
  // pre-primary level. Null when the student holds no current class.
  classLabel: s.class ? classLabel(s.class) : null,
  admissionYear: s.admissionYear,
  rollNumber: s.rollNumber,
  feeTotal: s.feeTotal,
  feeDues: s.feeDues,
  parentName: s.parentName,
  guardianContact: s.guardianContact,
  address: s.address,
  bloodGroup: s.bloodGroup,
  dob: toDateStr(s.dob),
});

/**
 * Employee row (with included classesTaught.class + class._count.students)
 * → mock API shape with the denormalized assignedClasses list.
 */
const mapEmployee = (e) => ({
  id: e.id,
  userId: e.userId,
  name: e.name,
  photo: e.photo,
  employeeId: e.employeeId,
  gender: e.gender,
  dob: toDateStr(e.dob),
  bloodGroup: e.bloodGroup,
  mobile: e.mobile,
  email: e.email,
  address: e.address,
  emergencyContact: e.emergencyContact,
  department: e.department,
  designation: e.designation,
  role: e.role,
  qualification: e.qualification,
  dateOfJoining: toDateStr(e.dateOfJoining),
  experience: e.experience,
  reportingPrincipal: e.reportingPrincipal,
  employmentType: e.employmentType,
  status: e.status,
  // Default salary structure (₹) — edited on the employee form, prefilled into
  // new payroll months. Same flat keys as PayrollRecord.
  basicPay: e.basicPay,
  hra: e.hra,
  transportAllowance: e.transportAllowance,
  medicalAllowance: e.medicalAllowance,
  providentFund: e.providentFund,
  professionalTax: e.professionalTax,
  tds: e.tds,
  assignedClasses: (e.classesTaught || [])
    .map((a) => ({
      classId: a.classId,
      class: String(a.class.grade),
      section: a.class.section,
      subject: a.subject,
      studentCount: a.class._count?.students ?? 0,
      room: a.room,
      isClassTeacher: a.isClassTeacher,
    }))
    .sort((a, b) => {
      const g = Number(a.class) - Number(b.class);
      return g !== 0 ? g : a.section.localeCompare(b.section);
    }),
  /* The open EmploymentEnd row, or null while they are on staff — see
     `employment()` in services/employment.js. Null when the caller did not
     include the timeline, which every employee read does. This is where the
     admin list learns WHICH reason someone is off staff; `status` alone can only
     say that they are. */
  employment: employment(e.employmentEnds),
});

/** LeaveRequest row → mock API shape (dates as 'YYYY-MM-DD', appliedAt ISO) */
const mapLeave = (l) => ({
  id: l.id,
  type: l.type,
  fromDate: toDateStr(l.fromDate),
  toDate: toDateStr(l.toDate),
  reason: l.reason,
  status: l.status,
  appliedAt: toIso(l.appliedAt),
});

/** PayrollRecord row → mock API shape (flat columns → nested groups) */
const mapPayroll = (p) => ({
  month: p.month,
  monthLabel: monthLabel(p.month),
  basicPay: p.basicPay,
  allowances: {
    hra: p.hra,
    transportAllowance: p.transportAllowance,
    medicalAllowance: p.medicalAllowance,
  },
  deductions: {
    providentFund: p.providentFund,
    professionalTax: p.professionalTax,
    tds: p.tds,
  },
  netSalary: p.netSalary,
  // The derived "fully settled on" date. Null while any part of the month is
  // outstanding — a partially-paid month has no completion date, and the
  // per-payment breakdown beside it is the real record of what was paid.
  paidOn: toDateStr(p.paidOn),
});

/**
 * PayrollPayment row → API shape.
 *
 * Kept beside `mapPayroll` rather than in services/payroll.js so every Date →
 * string conversion on the payroll surface happens in one file, the way the rest
 * of this module is organised. services/payroll.js does the arithmetic and hands
 * back Dates; this turns them into the wire format.
 */
const mapPayrollPayment = (p) => ({
  id: p.id,
  amount: p.amount,
  paidOn: toDateStr(p.paidOn),
  note: p.note,
  recordedAt: toIso(p.createdAt),
});

/** TimetablePeriod row → mock API shape (teacherName → teacher) */
const mapPeriod = (p) => ({
  period: p.period,
  timeStart: p.timeStart,
  timeEnd: p.timeEnd,
  subject: p.subject,
  teacher: p.teacherName,
  room: p.room,
});

/** Achievement row (with optional student) → mock API shape */
const mapAchievement = (a) => ({
  id: a.id,
  title: a.title,
  description: a.description,
  date: toDateStr(a.date),
  type: a.type,
  studentId: a.studentId,
  studentName: a.student?.name ?? null,
});

/**
 * Sanitized user shape — an explicit field whitelist, which is why a password
 * can never ride along: nothing is spread from the Prisma row, so neither
 * `passwordHash` nor any future secret column is reachable by accident.
 * `mustChangePassword` is a boolean flag (no credential material) that tells
 * the portal the account is still using a school-chosen password.
 */
const mapUserPublic = (u) => ({
  id: u.id,
  username: u.username,
  role: u.role,
  name: u.name,
  profilePhoto: u.profilePhoto,
  status: u.status,
  mustChangePassword: u.mustChangePassword === true,
  linkedEntityId: u.student?.id || u.employee?.id || null,
});

/**
 * SyllabusEntry.topics (Json) → normalized [{ topic, done }] array.
 * Defensive against legacy shapes: plain strings become { topic, done: false }
 * (per spec: no per-topic data = nothing done), malformed entries are dropped.
 */
const normalizeSyllabusTopics = (topics) => {
  if (!Array.isArray(topics)) return [];
  return topics
    .map((t) => {
      if (typeof t === 'string') return { topic: t, done: false };
      if (t && typeof t === 'object' && typeof t.topic === 'string') {
        return { topic: t.topic, done: t.done === true };
      }
      return null;
    })
    .filter((t) => t && t.topic.trim().length > 0);
};

module.exports = {
  toDateStr,
  toIso,
  schoolToday,
  monthRange,
  monthLabel,
  statusToApi,
  statusToDb,
  classIdOf,
  levelSlug,
  classLabel,
  classLabelFor,
  classOrder,
  compareClasses,
  mapStudent,
  mapEmployee,
  mapLeave,
  mapPayroll,
  mapPayrollPayment,
  mapPeriod,
  mapAchievement,
  mapUserPublic,
  normalizeSyllabusTopics,
};
