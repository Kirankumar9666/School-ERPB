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

/** DateTime (@db.Date, UTC midnight) → 'YYYY-MM-DD' */
const toDateStr = (d) => (d ? d.toISOString().slice(0, 10) : null);

/** DateTime → ISO string (or null) */
const toIso = (d) => (d ? d.toISOString() : null);

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

/* '10' + 'A' → 'cls-10A' (the seeded Class id format) */
const classIdOf = (cls, section) => `cls-${String(cls).trim()}${String(section).trim().toUpperCase()}`;

/**
 * Student row (with included class) → mock API shape.
 * classId/createdAt/updatedAt are dropped; class/section are denormalized.
 */
const mapStudent = (s) => ({
  id: s.id,
  userId: s.userId,
  name: s.name,
  photo: s.photo,
  class: s.class ? String(s.class.grade) : null,
  section: s.class ? s.class.section : null,
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
  paidOn: toDateStr(p.paidOn),
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

/** Attendance rows → mock records map keyed by 'YYYY-MM-DD' */
const buildAttendanceRecords = (rows, withHours) => {
  const records = {};
  rows.forEach((r) => {
    records[toDateStr(r.date)] = withHours
      ? { status: statusToApi(r.status), workingHours: r.workingHours ?? 0 }
      : statusToApi(r.status);
  });
  return records;
};

/** Sanitized user shape — never includes passwordHash */
const mapUserPublic = (u) => ({
  id: u.id,
  username: u.username,
  role: u.role,
  name: u.name,
  profilePhoto: u.profilePhoto,
  status: u.status,
  linkedEntityId: u.student?.id || u.employee?.id || null,
});

module.exports = {
  toDateStr,
  toIso,
  monthRange,
  monthLabel,
  statusToApi,
  statusToDb,
  classIdOf,
  mapStudent,
  mapEmployee,
  mapLeave,
  mapPayroll,
  mapPeriod,
  mapAchievement,
  buildAttendanceRecords,
  mapUserPublic,
};
