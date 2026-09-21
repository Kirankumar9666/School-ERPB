/**
 * Prisma seed — populates the database from the same mock stores the API
 * currently serves, preserving the existing ids (usr-001, stu-001, cls-10A,
 * exam-001, ...) so API URLs stay stable after the mock -> Prisma swap.
 *
 * Run as a CLI:  npx prisma db seed   (requires DATABASE_URL + migrated db:
 *                                     npx prisma migrate dev / deploy)
 *
 * Also importable:  const { seed } = require('../prisma/seed')  — the test
 * helper calls this before each test file so every file starts from the same
 * seeded state (the mock stores used to give each test process fresh data).
 *
 * Idempotent: wipes all tables in reverse-dependency order, then inserts.
 */
const { PrismaClient } = require('@prisma/client');
const { MOCK_USERS } = require('../src/mock/users');
const { MOCK_STUDENTS, MOCK_ATTENDANCE_STUDENT, MOCK_MARKS, MOCK_ACHIEVEMENTS, MOCK_STUDENT_DOCUMENTS } = require('../src/mock/students');
const { MOCK_EMPLOYEES, MOCK_ATTENDANCE_EMPLOYEE, MOCK_LEAVES, MOCK_PAYROLL, MOCK_DOCUMENTS } = require('../src/mock/employees');
const { MOCK_TIMETABLE, MOCK_HOLIDAYS, MOCK_ANNOUNCEMENTS, MOCK_SYLLABUS } = require('../src/mock/school');

const prisma = new PrismaClient();
const at = (dateStr) => new Date(`${dateStr}T00:00:00.000Z`);

/** 'cls-10A' -> { grade: 10, section: 'A' } (inverse of the mock key format) */
const parseClassId = (classId) => {
  const m = /^cls-(\d+)([A-Za-z])$/.exec(classId);
  return m ? { grade: Number(m[1]), section: m[2].toUpperCase() } : null;
};

/** Collect every class referenced anywhere in the mock data */
function collectClasses() {
  const byId = new Map();
  const add = (classId) => {
    const parsed = parseClassId(classId);
    if (parsed && !byId.has(classId)) byId.set(classId, { id: classId, ...parsed, classTeacherId: null });
  };
  Object.keys(MOCK_TIMETABLE).forEach(add);
  Object.keys(MOCK_SYLLABUS).forEach(add);
  MOCK_EMPLOYEES.forEach((e) => (e.assignedClasses || []).forEach((a) => add(a.classId)));
  MOCK_STUDENTS.forEach((s) => add(`cls-${s.class}${String(s.section).toUpperCase()}`));
  return byId;
}

/**
 * Retry wrapper — the remote Supabase pooler occasionally drops connections
 * ("Can't reach database server" / "Server has closed the connection").
 * Retries transient connectivity errors with backoff; real logic errors
 * (validation, unique constraints) fail immediately.
 */
const TRANSIENT = ['P1001', 'P1002', 'P1017', "Can't reach database server", 'Server has closed the connection', 'Connection terminated', 'Timed out fetching'];
const isTransient = (err) => TRANSIENT.some((t) => (err?.code && err.code === t) || String(err?.message || '').includes(t));

async function withRetry(fn, attempts = 4, baseDelayMs = 1500) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === attempts - 1) throw err;
      const delay = baseDelayMs * 2 ** i;
      console.warn(`[seed] transient DB error (${String(err.message).slice(0, 80)}) — retry ${i + 1}/${attempts - 1} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function seed() {
  return withRetry(async () => {
  /* ---- wipe in reverse-dependency order (idempotent re-seed) ---- */
  for (const model of [
    'auditEntry', 'marksEntry', 'exam', 'studentAttendance', 'employeeAttendance',
    'teachingAssignment', 'leaveRequest', 'leaveBalance', 'payrollRecord',
    'employeeDocument', 'studentDocument', 'achievement', 'syllabusEntry', 'timetablePeriod',
    'reminder', 'announcement', 'holiday', 'student', 'class', 'employee', 'user',
  ]) {
    await prisma[model].deleteMany();
  }

  /* ---- classes (derived from every reference in the mock data) ---- */
  const classes = collectClasses();
  await prisma.class.createMany({ data: [...classes.values()] });

  /* ---- users ---- */
  await prisma.user.createMany({
    data: MOCK_USERS.map(({ id, username, passwordHash, role, name, profilePhoto, status }) => ({
      id, username, passwordHash, role, name, profilePhoto, status,
    })),
  });

  /* ---- employees (+ teaching assignments, class-teacher links) ---- */
  for (const e of MOCK_EMPLOYEES) {
    const { assignedClasses, userId, ...rest } = e;
    await prisma.employee.create({
      data: {
        ...rest,
        /* checked input: scalar FKs can't be mixed with nested writes, so the
           User link is expressed as a connect (users are seeded above) */
        user: userId ? { connect: { id: userId } } : undefined,
        dob: rest.dob ? at(rest.dob) : null,
        dateOfJoining: rest.dateOfJoining ? at(rest.dateOfJoining) : null,
        classesTaught: {
          create: (assignedClasses || []).map((a) => ({
            class: { connect: { id: a.classId } },
            subject: a.subject,
            room: a.room ?? null,
            isClassTeacher: Boolean(a.isClassTeacher),
          })),
        },
      },
    });
    (assignedClasses || []).forEach((a) => {
      if (a.isClassTeacher && classes.has(a.classId)) classes.get(a.classId).classTeacherId = e.id;
    });
  }
  for (const c of classes.values()) {
    if (c.classTeacherId) {
      await prisma.class.update({ where: { id: c.id }, data: { classTeacherId: c.classTeacherId } });
    }
  }

  /* ---- students ---- */
  for (const s of MOCK_STUDENTS) {
    const { class: grade, section, dob, ...rest } = s;
    await prisma.student.create({
      data: {
        ...rest,
        classId: `cls-${grade}${String(section).toUpperCase()}`,
        dob: dob ? at(dob) : null,
      },
    });
  }

  /* ---- attendance ---- */
  const studentAttendance = [];
  Object.entries(MOCK_ATTENDANCE_STUDENT).forEach(([studentId, months]) => {
    Object.values(months).forEach((days) => {
      Object.entries(days).forEach(([date, status]) => {
        studentAttendance.push({ studentId, date: at(date), status });
      });
    });
  });
  if (studentAttendance.length) await prisma.studentAttendance.createMany({ data: studentAttendance });

  const employeeAttendance = [];
  Object.entries(MOCK_ATTENDANCE_EMPLOYEE).forEach(([employeeId, months]) => {
    Object.values(months).forEach((days) => {
      Object.entries(days).forEach(([date, rec]) => {
        employeeAttendance.push({
          employeeId, date: at(date), status: rec.status, workingHours: rec.workingHours ?? null,
        });
      });
    });
  });
  if (employeeAttendance.length) await prisma.employeeAttendance.createMany({ data: employeeAttendance });

  /* ---- exams + marks (exams derived from the marks rows themselves) ---- */
  const exams = new Map(); // examId -> { id, classId, name, date }
  Object.entries(MOCK_MARKS).forEach(([studentId, examList]) => {
    const student = MOCK_STUDENTS.find((s) => s.id === studentId);
    const classId = `cls-${student.class}${String(student.section).toUpperCase()}`;
    examList.forEach((exam) => {
      if (!exams.has(exam.examId)) {
        exams.set(exam.examId, { id: exam.examId, classId, name: exam.examName, date: at(exam.date) });
      }
    });
  });
  if (exams.size) await prisma.exam.createMany({ data: [...exams.values()] });

  const marks = [];
  Object.entries(MOCK_MARKS).forEach(([studentId, examList]) => {
    examList.forEach((exam) => {
      (exam.subjects || []).forEach((sub) => {
        marks.push({
          studentId, examId: exam.examId,
          subject: sub.subject, maxMarks: sub.maxMarks, obtained: sub.obtained,
        });
      });
    });
  });
  if (marks.length) await prisma.marksEntry.createMany({ data: marks });

  /* ---- timetable / syllabus ---- */
  const periods = [];
  Object.entries(MOCK_TIMETABLE).forEach(([classId, list]) => {
    list.forEach((p) => periods.push({
      classId, period: p.period, timeStart: p.timeStart, timeEnd: p.timeEnd,
      subject: p.subject, teacherName: p.teacher, room: p.room ?? null,
    }));
  });
  if (periods.length) await prisma.timetablePeriod.createMany({ data: periods });

  const syllabus = [];
  Object.entries(MOCK_SYLLABUS).forEach(([classId, list]) => {
    list.forEach((entry) => syllabus.push({
      classId, subject: entry.subject,
      // Completion starts at zero for every topic — the old mock percentages are
      // deliberately NOT carried over (per-topic done state is tracked explicitly).
      topics: entry.topics.map((t) => ({ topic: t, done: false })),
    }));
  });
  if (syllabus.length) await prisma.syllabusEntry.createMany({ data: syllabus });

  /* ---- leaves / payroll / documents ---- */
  const leaveBalances = [];
  const leaveRequests = [];
  Object.entries(MOCK_LEAVES).forEach(([employeeId, data]) => {
    leaveBalances.push({ employeeId, ...data.balance });
    (data.history || []).forEach((l) => leaveRequests.push({
      id: l.id, employeeId, type: l.type,
      fromDate: at(l.fromDate), toDate: at(l.toDate),
      reason: l.reason, status: l.status, appliedAt: new Date(l.appliedAt),
    }));
  });
  if (leaveBalances.length) await prisma.leaveBalance.createMany({ data: leaveBalances });
  if (leaveRequests.length) await prisma.leaveRequest.createMany({ data: leaveRequests });

  const payroll = [];
  Object.entries(MOCK_PAYROLL).forEach(([employeeId, list]) => {
    list.forEach((p) => payroll.push({
      employeeId, month: p.month, basicPay: p.basicPay,
      hra: p.allowances?.hra ?? 0,
      transportAllowance: p.allowances?.transportAllowance ?? 0,
      medicalAllowance: p.allowances?.medicalAllowance ?? 0,
      providentFund: p.deductions?.providentFund ?? 0,
      professionalTax: p.deductions?.professionalTax ?? 0,
      tds: p.deductions?.tds ?? 0,
      netSalary: p.netSalary,
      paidOn: p.paidOn ? at(p.paidOn) : null,
    }));
  });
  if (payroll.length) await prisma.payrollRecord.createMany({ data: payroll });

  const documents = [];
  Object.entries(MOCK_DOCUMENTS).forEach(([employeeId, list]) => {
    list.forEach((d) => documents.push({
      id: d.id, employeeId, type: d.type, fileName: d.fileName, uploadedAt: new Date(d.uploadedAt),
    }));
  });
  if (documents.length) await prisma.employeeDocument.createMany({ data: documents });

  const studentDocs = [];
  Object.entries(MOCK_STUDENT_DOCUMENTS).forEach(([studentId, list]) => {
    list.forEach((d) => studentDocs.push({
      id: d.id, studentId, type: d.type, fileName: d.fileName, uploadedAt: new Date(d.uploadedAt),
    }));
  });
  if (studentDocs.length) await prisma.studentDocument.createMany({ data: studentDocs });

  /* ---- announcements / holidays / achievements ---- */
  if (MOCK_ANNOUNCEMENTS.length) {
    await prisma.announcement.createMany({
      data: MOCK_ANNOUNCEMENTS.map((a) => ({
        id: a.id, title: a.title, body: a.body, targetRoles: a.targetRoles,
        category: a.category ?? null, createdAt: new Date(a.createdAt),
        showFrom: at(a.showFrom), showUntil: at(a.showUntil),
      })),
    });
  }
  if (MOCK_HOLIDAYS.length) {
    await prisma.holiday.createMany({
      data: MOCK_HOLIDAYS.map((h) => ({ id: h.id, date: at(h.date), name: h.name })),
    });
  }
  const achievements = [];
  Object.entries(MOCK_ACHIEVEMENTS).forEach(([studentId, list]) => {
    list.forEach((a) => achievements.push({
      id: a.id, studentId, title: a.title, description: a.description,
      date: at(a.date), type: a.type,
    }));
  });
  if (achievements.length) await prisma.achievement.createMany({ data: achievements });

  /* ---- summary (computed from what was actually inserted) ---- */
  const [users, classCount, students, employees] = await Promise.all([
    prisma.user.count(), prisma.class.count(), prisma.student.count(), prisma.employee.count(),
  ]);
  console.log(`Seed complete: ${users} users, ${classCount} classes, ${students} students, ${employees} employees.`);
  });
}

module.exports = { seed, prisma };

/* CLI entry (npx prisma db seed / node prisma/seed.js) */
if (require.main === module) {
  seed()
    .catch((err) => { console.error(err); process.exit(1); })
    .finally(() => prisma.$disconnect());
}