/**
 * FIXTURE seed — wipes the database and rebuilds it from the mock stores
 * (usr-001, stu-001, cls-10A, exam-001, ...), preserving the existing ids so
 * API URLs stay stable after the mock -> Prisma swap.
 *
 * THIS IS THE DESTRUCTIVE SEED. It deletes every table, so it may only ever run
 * against the TEST database — the guard at the top of `seed()` enforces that,
 * and running it by hand against anything else stops with a message and deletes
 * nothing.
 *
 *   Tests             `npm test` (tests/helpers.js calls this before each file)
 *   Directly, guarded  node prisma/seed.js   with TEST_DATABASE_URL set
 *
 * For a database that must keep its data — a demo, a staging box, a developer's
 * own working copy — use prisma/demo-seed.js, which upserts and never deletes.
 *
 * @see ./demo-seed.js the non-destructive seed
 */
const { PrismaClient } = require('@prisma/client');
const PDFDocument = require('pdfkit');
const { assertSafeToWipe } = require('../src/config/test-env');
const { MOCK_USERS } = require('../src/mock/users');
const { MOCK_STUDENTS, MOCK_ATTENDANCE_STUDENT, MOCK_MARKS, MOCK_ACHIEVEMENTS, MOCK_STUDENT_DOCUMENTS } = require('../src/mock/students');
const { MOCK_EMPLOYEES, MOCK_ATTENDANCE_EMPLOYEE, MOCK_LEAVES, MOCK_PAYROLL, MOCK_DOCUMENTS } = require('../src/mock/employees');
const { MOCK_TIMETABLE, MOCK_HOLIDAYS, MOCK_ANNOUNCEMENTS, MOCK_SYLLABUS } = require('../src/mock/school');
const { DEFAULT_WEEKLY_OFF_DAYS } = require('../src/services/settings');
const { weekdayOf } = require('../src/utils/attendance');

/*
 * The URL this seed is about to wipe, and the reason it is read BEFORE the client
 * is built.
 *
 * PrismaClient reads DATABASE_URL itself at construction, so the tests pass
 * TEST_DATABASE_URL through the environment and this seed must honour it — a test
 * that inherited the developer’s DATABASE_URL would wipe their database instead.
 * `assertSafeToWipe` then judges it, and only a database whose name carries the
 * "test" marker is allowed. Reads `process.env` directly rather than through
 * src/config/env.js so the guard is the first thing that runs, before any
 * configuration module has pulled in the rest of the app.
 */
const SEED_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
assertSafeToWipe(SEED_DATABASE_URL, 'prisma/seed.js (the fixture seed deletes every table)');

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: SEED_DATABASE_URL,
    },
  },
});
const at = (dateStr) => new Date(`${dateStr}T00:00:00.000Z`);

/**
 * The 'holiday' attendance rows a weekly-off setting implies, for every day of
 * every seeded month that is one of `weeklyOffDays` — one entry per FN + AN
 * session, matching the shape the mock stores use. Derived from the setting, so
 * nothing here names a weekday: a day is closed only because the school's
 * weekly-off setting says so, and changing that setting changes the fixtures.
 *
 * A mock day that already carries a real status is skipped — a recorded class
 * day is never overwritten by the off-day rule.
 *
 * @param {Record<string, Record<string, object>>} mock  MOCK_ATTENDANCE_*
 * @param {Set<number>} weeklyOffDays JS weekday numbers (0 = Sunday)
 * @param {boolean} withHours employee shape ({ status, workingHours }) vs plain
 * @returns {Array<object>} rows ready for createMany
 */
const offDayAttendance = (mock, weeklyOffDays, withHours) => {
  const rows = [];
  Object.entries(mock).forEach(([entityId, months]) => {
    Object.values(months).forEach((days) => {
      const month = Object.keys(days)[0]?.slice(0, 7);
      if (!month) return;
      const [y, mo] = month.split('-').map(Number);
      const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      for (let day = 1; day <= lastDay; day += 1) {
        const date = `${month}-${String(day).padStart(2, '0')}`;
        if (days[date]) continue; // a real recorded day is never overwritten
        if (!weeklyOffDays.has(weekdayOf(date))) continue;
        ['FN', 'AN'].forEach((session) => {
          rows.push(withHours
            ? { employeeId: entityId, date: at(date), session, status: 'holiday', workingHours: 0 }
            : { studentId: entityId, date: at(date), session, status: 'holiday' });
        });
      }
    });
  });
  return rows;
};

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

/** '2026-27' from a start year — the AcademicYear id is always 'ay-' + this. */
const academicYearLabel = (startYear) => `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;

/**
 * The academic years the seed creates: a window of June-to-May years around the
 * REAL current date, so the Class Management year dropdowns have real years to
 * choose from and somewhere real to promote into.
 *
 * Derived from the clock like everything else here — not one year is written out.
 * The window is deliberately generous, because a year that does not exist yet is a
 * promotion that cannot be performed, and adding a year later is trivial whereas a
 * promotion blocked by a missing one is not.
 */
function collectAcademicYears() {
  const now = new Date();
  // An academic year starts on 1 June, so anything from June onwards belongs to
  // the year beginning this calendar year. UTC throughout, matching `at()` and
  // every other date this seed builds.
  const currentStartYear = now.getUTCMonth() >= 5 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const years = [];
  for (let y = currentStartYear - 6; y <= currentStartYear + 6; y += 1) {
    const label = academicYearLabel(y);
    years.push({
      id: `ay-${label}`,
      label,
      startDate: new Date(Date.UTC(y, 5, 1)),
      endDate: new Date(Date.UTC(y + 1, 4, 31)),
      isCurrent: y === currentStartYear,
    });
  }
  return years;
}

/**
 * The academic year containing a date, matched by RANGE — the same rule
 * services/enrollment.js applies on read, so a seeded exam can never land in a
 * different year than the app would have put it in.
 */
function academicYearFor(years, date) {
  const t = date.getTime();
  return years.find((y) => t >= y.startDate.getTime() && t <= y.endDate.getTime()) || null;
}

/**
 * A small one-page demo PDF for the seeded document records, so the document
 * download endpoints serve a real file from the very first seed (a real
 * upload replaces it). Standard-font ASCII only — the ₹-capable DejaVu fonts
 * the payslip embeds are not needed here.
 */
function demoDocumentPdf({ type, fileName, owner, subtitle }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 64, bottom: 64, left: 64, right: 64 } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#6d1a2d').text('School ERP');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(11).fillColor('#555555')
      .text(subtitle || 'Demo document record (seed data)');
    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#111111').text(type);
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(11).fillColor('#222222').text(`Owner : ${owner}`);
    doc.text(`File  : ${fileName.replace(/\.pdf$/i, '')}.pdf`);
    doc.moveDown(1);
    doc.fontSize(9).fillColor('#777777').text('Generated by prisma/seed.js — uploading a real document replaces this file.');
    doc.end();
  });
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

const { wipeAll } = require('./fixture-seed.wipe');

/**
 * Build the fixture database.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.wipe=true] delete every table first. `false` is the
 *   demo path — the fixtures are inserted over whatever is there, which works
 *   because every id below is deterministic and `createMany` is swapped for
 *   upserts in that mode.
 */
async function seed(opts = {}) {
  const wipe = opts.wipe !== false;
  return withRetry(async () => {
    if (wipe) await wipeAll(prisma);

    /* The school's weekly-off weekdays — the SAME default the app reads
       (services/settings.js), so the fixtures can never disagree with the
       setting about which weekdays are off. Persisted to the Setting table
       near the end of this function, and used to derive the off-day rows. */
    const weeklyOffDays = new Set(DEFAULT_WEEKLY_OFF_DAYS);

    /* ---- academic years (the spine every class/enrollment/exam hangs off) ---- */
  const years = collectAcademicYears();
  const currentYear = years.find((y) => y.isCurrent);
  if (!currentYear) throw new Error('[seed] no academic year contains today — the June-to-May window is empty');
  await prisma.academicYear.createMany({ data: years });

  /* ---- grade levels (the school's level list, as DATA) ----
     These mirror the migration's rows exactly, so a seeded database and a
     migrated one can never disagree about what levels exist or what order they
     sit in. skipDuplicates because the MIGRATION already inserts these rows, so
     a migrated database has them before the seed runs and a re-run must not fail. */
  const SEED_LEVELS = [['Nursery', -2], ['LKG', -1], ['UKG', 0]]
    .concat(Array.from({ length: 10 }, (_, i) => [String(i + 1), i + 1]));

  /* ---- classes (derived from every reference in the mock data) ---- */
  await prisma.gradeLevel.createMany({
    data: SEED_LEVELS.map(([name, order]) => ({ id: `gl-${name.toUpperCase()}`, name, order })),
    skipDuplicates: true,
  });

  const levelsByOrder = new Map((await prisma.gradeLevel.findMany()).map((l) => [String(l.order), l]));

  const classes = collectClasses();
  await prisma.class.createMany({
    data: [...classes.values()].map((c) => {
      // Link each seeded class to the level holding its grade, so `classLabel`
      // resolves through the shared name function.
      const level = levelsByOrder.get(String(c.grade));
      if (!level) throw new Error(`[seed] no grade level for class ${c.id}`);
      return { ...c, levelId: level.id };
    }),
  });

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
        // Enrollment day for the fixture, derived from its own admissionYear
        // (June 1 = academic-year start) so its seeded demo attendance for the
        // current term stays visible — same rule the _student_enrolled_at
        // migration applies to rows that already exist.
        enrolledAt: s.admissionYear ? new Date(Date.UTC(s.admissionYear, 5, 1)) : undefined,
      },
    });
  }

  /* ---- current-year class enrollments ----
         ONE row per student, for the academic year containing today, saying the
         only thing the fixtures actually know: these children are in these classes
         right now.

         Their earlier years are deliberately NOT invented. The mocks record an
         admission year but not which classes they passed through, so a guessed
         history would put fabricated rows in front of the school — and every one of
         those years would then show up in Class History looking authoritative.
         Those years stay empty until the office promotes into them or backfills
         the real records through "Enter Past Data", which is what that feature is
         for. */
  for (const s of MOCK_STUDENTS) {
    const classId = `cls-${s.class}${String(s.section).toUpperCase()}`;
    await prisma.studentEnrollment.create({
      data: {
        // Deterministic, so re-seeding cannot leave a duplicate behind.
        id: `enr-${s.id}`,
        studentId: s.id,
        academicYearId: currentYear.id,
        classId,
        rollNumber: s.rollNumber ?? null,
        status: 'active',
        source: 'live',
        enrolledOn: s.admissionYear ? new Date(Date.UTC(s.admissionYear, 5, 1)) : new Date(),
      },
    });
  }

  /* ---- current-year fees (one row per student — the new source of truth) ----
         The fixture's legacy `feeTotal`/`feeDues` scalars become a per-year
         `StudentFee` row, and the already-paid part becomes one payment — the
         exact shape the migration produces for rows that already exist. A
         student with no fee data gets `total: null` ("Not set"), which is what
         the Fee Dues "fee not set" filter is for. `Student.feeTotal`/`feeDues`
         are left as the fixture set them; they are the derived cache the app
         still reads. */
  for (const s of MOCK_STUDENTS) {
    const classId = `cls-${s.class}${String(s.section).toUpperCase()}`;
    const total = s.feeTotal ?? s.feeDues ?? null;
    await prisma.studentFee.create({
      data: { id: `sf-${s.id}`, studentId: s.id, academicYearId: currentYear.id, classId, total },
    });
    if (s.feeTotal != null && s.feeDues != null && s.feeTotal - s.feeDues > 0) {
      await prisma.feePayment.create({
        data: {
          id: `fp-${s.id}`,
          studentFeeId: `sf-${s.id}`,
          amount: s.feeTotal - s.feeDues,
          paidOn: s.admissionYear ? new Date(Date.UTC(s.admissionYear, 5, 1)) : new Date(),
          note: 'Opening balance from the student record',
        },
      });
    }
  }

  /* ---- attendance (one FN row + one AN row per mock day; the mock files are
     day-level, and each recorded day applies to both sessions — so FN and AN
     always agree in the seed data, exactly like the migration's backfill).

     Weekly-off weekdays are recorded as 'holiday' HERE, from the setting —
     never typed into the mock stores, which mark ordinary class days only. So
     a real off day reads as closed while every other weekday (including
     Saturday, under the default) stays an ordinary working day, and changing
     the school's working week changes the fixtures with no edit to this file.
     A mock day that already carries a status is left exactly as written. ---- */
  const studentAttendance = [];
  Object.entries(MOCK_ATTENDANCE_STUDENT).forEach(([studentId, months]) => {
    Object.values(months).forEach((days) => {
      Object.entries(days).forEach(([date, status]) => {
        ['FN', 'AN'].forEach((session) => {
          studentAttendance.push({ studentId, date: at(date), session, status });
        });
      });
    });
  });
  studentAttendance.push(...offDayAttendance(MOCK_ATTENDANCE_STUDENT, weeklyOffDays, false));
  if (studentAttendance.length) await prisma.studentAttendance.createMany({ data: studentAttendance });

  // Employee session hours keep the day total: a present day was 8h, so each
  // present session is 4h (a late day 7h → 3.5h per half, etc.). The read side
  // sums the two halves back into the day figures the mocks always asserted.
  const employeeAttendance = [];
  Object.entries(MOCK_ATTENDANCE_EMPLOYEE).forEach(([employeeId, months]) => {
    Object.values(months).forEach((days) => {
      Object.entries(days).forEach(([date, rec]) => {
        const halfHours = (rec.workingHours ?? 0) / 2;
        ['FN', 'AN'].forEach((session) => {
          employeeAttendance.push({
            employeeId, date: at(date), session, status: rec.status, workingHours: halfHours,
          });
        });
      });
    });
  });
  // Weekly-off days for employees too — 'holiday', zero hours, both sessions.
  employeeAttendance.push(...offDayAttendance(MOCK_ATTENDANCE_EMPLOYEE, weeklyOffDays, true));
  if (employeeAttendance.length) await prisma.employeeAttendance.createMany({ data: employeeAttendance });

  /* ---- exams + marks (exams derived from the marks rows themselves) ---- */
  const exams = new Map(); // examId -> { id, classId, name, date, academicYearId }
  Object.entries(MOCK_MARKS).forEach(([studentId, examList]) => {
    const student = MOCK_STUDENTS.find((s) => s.id === studentId);
    const classId = `cls-${student.class}${String(student.section).toUpperCase()}`;
    examList.forEach((exam) => {
      if (exams.has(exam.examId)) return;
      const date = at(exam.date);
      // Resolved by RANGE from the same table the app reads, never written out:
      // an exam dated inside one year must not be filed under another.
      const year = academicYearFor(years, date);
      if (!year) throw new Error(`[seed] exam ${exam.examId} dated ${exam.date} falls outside every academic year`);
      exams.set(exam.examId, { id: exam.examId, classId, name: exam.examName, date, academicYearId: year.id, source: 'live' });
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
      // Seeded as 'pr-EMP-2020-001-2026-08' so the payment rows below can be
      // linked without a second lookup. Deterministic, and unique per
      // (employee, month) — the same pair the unique index enforces.
      id: `pr-${employeeId}-${p.month}`,
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

  /* Months the mock marks as paid get ONE real payment row for the full net, on
     the date it was recorded. This is the same shape the migration's backfill
     produces for existing databases, so a freshly seeded DB and a migrated one
     are indistinguishable to every query that follows — in particular, the
     derived "settled on" date and the paid/partial status. */
  const payrollPayments = payroll
    .filter((p) => p.paidOn)
    .map((p) => ({
      id: `pay-${p.id}`,
      payrollRecordId: p.id,
      amount: p.netSalary,
      paidOn: p.paidOn,
      note: null,
    }));
  if (payrollPayments.length) await prisma.payrollPayment.createMany({ data: payrollPayments });

  /* Document records carry their (validated) PDF bytes in `data`, so the
   * download endpoints serve a real file. The seed generates a small demo
   * PDF per record; an upload through the API replaces it. */
  const documents = [];
  for (const [employeeId, list] of Object.entries(MOCK_DOCUMENTS)) {
    const owner = MOCK_EMPLOYEES.find((e) => e.id === employeeId)?.name || employeeId;
    for (const d of list) {
      documents.push({
        id: d.id, employeeId, type: d.type, fileName: d.fileName,
        uploadedAt: new Date(d.uploadedAt),
        data: await demoDocumentPdf({ type: d.type, fileName: d.fileName, owner }),
      });
    }
  }
  if (documents.length) await prisma.employeeDocument.createMany({ data: documents });

  const studentDocs = [];
  for (const [studentId, list] of Object.entries(MOCK_STUDENT_DOCUMENTS)) {
    const owner = MOCK_STUDENTS.find((s) => s.id === studentId)?.name || studentId;
    for (const d of list) {
      studentDocs.push({
        id: d.id, studentId, type: d.type, fileName: d.fileName,
        uploadedAt: new Date(d.uploadedAt),
        data: await demoDocumentPdf({ type: d.type, fileName: d.fileName, owner }),
      });
    }
  }
  if (studentDocs.length) await prisma.studentDocument.createMany({ data: studentDocs });

  /* ---- announcements / holidays / achievements ---- */
  if (MOCK_ANNOUNCEMENTS.length) {
    // Attachments are real generated PDFs (not placeholders) so the
    // download endpoints serve an actual file from the first seed — the same
    // way the seeded document records work. A mock without `pdfFileName` stays
    // a text-only circular.
    const announcements = [];
    for (const a of MOCK_ANNOUNCEMENTS) {
      announcements.push({
        id: a.id, title: a.title, body: a.body, targetRoles: a.targetRoles,
        category: a.category ?? null, createdAt: new Date(a.createdAt),
        showFrom: at(a.showFrom), showUntil: at(a.showUntil),
        targetScope: a.targetScope ?? 'ROLES',
        targetClassId: a.targetClassId ?? null,
        createdById: a.createdById ?? null,
        attributedTo: a.attributedTo ?? null,
        pdfFileName: a.pdfFileName ?? null,
        pdfData: a.pdfFileName ? await demoDocumentPdf({ type: a.title, fileName: a.pdfFileName, owner: a.attributedTo || 'School Office', subtitle: 'Announcement attachment (seed data)' }) : null,
      });
    }
    await prisma.announcement.createMany({ data: announcements });
  }
  if (MOCK_HOLIDAYS.length) {
    await prisma.holiday.createMany({
      data: MOCK_HOLIDAYS.map((h) => ({ id: h.id, date: at(h.date), name: h.name })),
    });
  }

  /* ---- school settings (weekly off days — the value derived at the top of
     this function from the app's own default) ---- */
  await prisma.setting.create({ data: { key: 'weeklyOffDays', value: [...weeklyOffDays].sort((a, b) => a - b) } });

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

/* CLI entry. `npx prisma db seed` is wired to demo-seed.js, which never
   deletes; this one is only for the test database and prints the guard's
   refusal rather than a stack trace. */
if (require.main === module) {
  seed()
    .catch((err) => {
      if (err && err.code === 'UNSAFE_DATABASE') {
        console.error(err.message);
        process.exit(2);
      }
      console.error(err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}