#!/usr/bin/env node
/**
 * QA SEED — a realistic (and deliberately messy) school, for QA sessions only.
 *
 *   node scripts/qa-seed.js
 *
 * It is DESTRUCTIVE (deletes every table first) and is therefore gated by the
 * same guard every other wiping entry point uses (`assertSafeToWipe`). It only
 * ever runs against a database whose name carries the `test` marker.
 *
 * What it builds, on purpose:
 *   - 4 classes: LKG-A (a named level), Class 1-A, Class 5-A (BIG, 45 students)
 *     and an EMPTY class (Class 8-A) that no student belongs to.
 *   - A year of student attendance (FN + AN) for LKG-A and 5-A, Saturdays
 *     included, so calendar / percentage maths has real volume.
 *   - 3 exams for 5-A with marks (a few students stay markless), plus an exam
 *     for 1-A.
 *   - Fees per year with partial payments and a carried-forward (previous-year)
 *     due.
 *   - Staff: 1 admin, 2 teachers (one WITH a timetable, one WITHOUT), an
 *     accountant, a librarian, plus a payroll month for each employee.
 *   - Messy names: Telugu, Hindi, an apostrophe (D'Souza), a 60-char name, two
 *     students sharing a name with different guardians, empty optional fields.
 *
 * @see DEPLOYMENT.md  (test database setup)
 */
const path = require('node:path');
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const { assertSafeToWipe } = require('../src/config/test-env');

const SEED_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
assertSafeToWipe(SEED_DATABASE_URL, 'scripts/qa-seed.js (the QA seed deletes every table)');

const prisma = new PrismaClient({ datasources: { db: { url: SEED_DATABASE_URL } } });

const at = (s) => new Date(`${s}T00:00:00.000Z`);
const PW = (p) => bcrypt.hashSync(p, 10);

// A school year that contains today, June->May.  Derived, never hardcoded.
const now = new Date();
const START = now.getUTCMonth() >= 5 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
const YEAR = `${START}-${String((START + 1) % 100).padStart(2, '0')}`;
const PREV = `${START - 1}-${String(START % 100).padStart(2, '0')}`;

// A deterministic RNG so a re-run reproduces the same school.
let _seed = 20261014;
function rnd() { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; }
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

function* eachDay(fromISO, toISO) {
  for (let d = at(fromISO); d <= at(toISO); d = new Date(d.getTime() + 86400000)) {
    yield new Date(d);
  }
}
const iso = (d) => d.toISOString().slice(0, 10);

async function wipe() {
  // Child-first order so FKs never block the delete.
  const order = [
    'feePayment', 'studentFee', 'marksEntry', 'exam', 'studentAttendance',
    'employeeAttendance', 'attendanceConfirmation', 'employeeDocument',
    'studentDocument', 'achievement', 'payrollPayment', 'payrollRecord',
    'leaveRequest', 'leaveBalance', 'employmentEnd', 'teachingAssignment',
    'timetablePeriod', 'syllabusEntry', 'studentEnrollment', 'reminder',
    'announcement', 'holiday', 'student', 'class', 'employee', 'user',
    'gradeLevel', 'academicYear', 'setting', 'auditEntry',
  ];
  for (const model of order) {
    if (prisma[model]) await prisma[model].deleteMany();
  }
}

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Ishaan', 'Kabir', 'Ananya', 'Diya', 'Myra', 'Saanvi', 'Kiara',
  'Rohan', 'Karthik', 'Sneha', 'Priya', 'Rahul', 'Meera', 'Arjun', 'Nisha', 'Varun', 'Deepa',
  'Harsha', 'Lakshmi', 'Manish', 'Pooja', 'Sai', 'Teja', 'Usha', 'Vikram', 'Yash', 'Zara'];
const LAST = ['Kumar', 'Reddy', 'Sharma', 'Patel', 'Rao', 'Naidu', 'Verma', 'Iyer', 'Nair', 'Gupta'];

async function main() {
  await wipe();
  console.log('Wiped. Building QA school...');

  // ── academic years ─────────────────────────────────────────────────────
  await prisma.academicYear.createMany({
    data: [
      { id: `ay-${PREV}`, label: PREV, startDate: at(`${START - 1}-06-01`), endDate: at(`${START}-05-31`), isCurrent: false },
      { id: `ay-${YEAR}`, label: YEAR, startDate: at(`${START}-06-01`), endDate: at(`${START + 1}-05-31`), isCurrent: true },
    ],
  });
  const curYear = `ay-${YEAR}`;
  const prevYear = `ay-${PREV}`;

  // ── grade levels (named + numbered) ────────────────────────────────────
  await prisma.gradeLevel.createMany({
    data: [
      { id: 'gl-NURSERY', name: 'Nursery', order: -2 },
      { id: 'gl-LKG', name: 'LKG', order: -1 },
      { id: 'gl-UKG', name: 'UKG', order: 0 },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `gl-${i + 1}`, name: String(i + 1), order: i + 1 })),
    ],
  });

  // ── users ──────────────────────────────────────────────────────────────
  await prisma.user.createMany({
    data: [
      { id: 'usr-admin', username: 'admin', passwordHash: PW('Admin@123'), role: 'admin', name: 'Office Admin' },
      { id: 'usr-teacher', username: 'teacher', passwordHash: PW('Teacher@123'), role: 'teacher', name: 'Priya Sharma' },
      { id: 'usr-teacher2', username: 'teacher2', passwordHash: PW('Teacher@123'), role: 'teacher', name: 'Suresh Babu' },
      { id: 'usr-accountant', username: 'accountant', passwordHash: PW('Accounts@123'), role: 'accountant', name: 'Ravi Patel' },
      { id: 'usr-librarian', username: 'librarian', passwordHash: PW('Library@123'), role: 'librarian', name: 'Latha Menon' },
      { id: 'usr-student', username: 'student', passwordHash: PW('Student@123'), role: 'student', name: 'Arjun Kumar' },
      { id: 'usr-student2', username: 'student2', passwordHash: PW('Student@123'), role: 'student', name: 'Sneha Reddy' },
      { id: 'usr-student3', username: 'student3', passwordHash: PW('Student@123'), role: 'student', name: 'Mohan D\u2019Souza' },
    ],
  });

  // ── classes ────────────────────────────────────────────────────────────
  // LKG-A (named level), 1-A, 5-A (BIG), and 8-A (EMPTY on purpose).
  const classes = [
    { id: 'cls-LKGA', grade: -1, section: 'A', levelId: 'gl-LKG' },
    { id: 'cls-1A', grade: 1, section: 'A', levelId: 'gl-1' },
    { id: 'cls-5A', grade: 5, section: 'A', levelId: 'gl-5' },
    { id: 'cls-8A', grade: 8, section: 'A', levelId: 'gl-8' }, // no students
  ];
  await prisma.class.createMany({ data: classes });

  // ── employees ──────────────────────────────────────────────────────────
  const salary = { basicPay: 40000, hra: 8000, transportAllowance: 2000, medicalAllowance: 1000, providentFund: 3000, professionalTax: 200, tds: 1500 };
  await prisma.employee.createMany({
    data: [
      { id: 'emp-001', userId: 'usr-teacher', employeeId: 'EMP001', name: 'Priya Sharma', gender: 'Female', department: 'Academics', designation: 'Senior Teacher', role: 'teacher', mobile: '+91-9000000001', dateOfJoining: at(`${START - 3}-06-01`), employmentType: 'Permanent', ...salary },
      { id: 'emp-002', userId: 'usr-accountant', employeeId: 'EMP002', name: 'Ravi Patel', gender: 'Male', department: 'Accounts', designation: 'Accountant', role: 'accountant', mobile: '+91-9000000002', dateOfJoining: at(`${START - 2}-06-01`), employmentType: 'Permanent', ...salary },
      { id: 'emp-003', userId: 'usr-librarian', employeeId: 'EMP003', name: 'Latha Menon', gender: 'Female', department: 'Library', designation: 'Librarian', role: 'librarian', mobile: '+91-9000000003', dateOfJoining: at(`${START - 1}-06-01`), employmentType: 'Contract' },
      // Teacher 2 has NO timetable and no teaching assignment — the empty-state case.
      { id: 'emp-004', userId: 'usr-teacher2', employeeId: 'EMP004', name: 'Suresh Babu', gender: 'Male', department: 'Academics', designation: 'Teacher', role: 'teacher', mobile: '+91-9000000004', dateOfJoining: at(`${START - 1}-08-01`), employmentType: 'Probation', ...salary },
    ],
  });
  // Class teacher for 5-A.
  await prisma.class.update({ where: { id: 'cls-5A' }, data: { classTeacherId: 'emp-001' } });

  // ── teaching assignments (drives permission scoping) ───────────────────
  await prisma.teachingAssignment.createMany({
    data: [
      { id: 'ta-1', employeeId: 'emp-001', classId: 'cls-5A', subject: 'Mathematics', isClassTeacher: true },
      { id: 'ta-2', employeeId: 'emp-001', classId: 'cls-LKGA', subject: 'English' },
      // emp-004 intentionally has none.
    ],
  });

  // ── timetable (5-A only; emp-002 never appears — no-timetable employee) ─
  const tt = [];
  const subjects = ['Mathematics', 'English', 'Science', 'Social', 'Telugu'];
  const times = [['09:00', '09:45'], ['09:45', '10:30'], ['10:45', '11:30'], ['11:30', '12:15'], ['13:00', '13:45']];
  times.forEach((t, i) => {
    tt.push({ id: `tt-5A-${i + 1}`, classId: 'cls-5A', period: i + 1, timeStart: t[0], timeEnd: t[1], subject: subjects[i], teacherName: 'Priya Sharma', room: 'R101' });
  });
  await prisma.timetablePeriod.createMany({ data: tt });

  // ── syllabus ───────────────────────────────────────────────────────────
  await prisma.syllabusEntry.createMany({
    data: subjects.map((s, i) => ({
      id: `syl-5A-${i + 1}`, classId: 'cls-5A', subject: s,
      topics: [{ topic: `${s} Unit 1`, done: true }, { topic: `${s} Unit 2`, done: i % 2 === 0 }, { topic: `${s} Unit 3`, done: false }],
    })),
  });

  // ── students ───────────────────────────────────────────────────────────
  // 45 in 5-A, 6 in 1-A, 4 in LKG-A. 8-A stays empty.
  const students = [];
  const enrollments = [];
  const rollFor = {};
  const mkStudent = (id, name, classId, opts = {}) => {
    rollFor[classId] = (rollFor[classId] || 0) + 1;
    const roll = String(rollFor[classId]).padStart(3, '0');
    students.push({
      id, name, classId,
      rollNumber: roll,
      parentName: opts.parentName ?? `${pick(FIRST)} ${pick(LAST)}`,
      guardianContact: opts.guardianContact ?? `+91-9${String(int(100000000, 999999999)).slice(0, 9)}`,
      address: opts.address ?? `${int(1, 200)}, ${pick(['MG Road', 'Gandhi Nagar', 'Kukatpally', 'Jubilee Hills'])}`,
      bloodGroup: opts.bloodGroup ?? pick(['A+', 'B+', 'O+', 'AB+', null]),
      dob: opts.dob ?? at(`${START - int(5, 16)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`),
      admissionYear: opts.admissionYear ?? START,
      enrolledAt: opts.enrolledAt ? at(opts.enrolledAt) : at(`${START}-06-01`),
      feeTotal: opts.feeTotal ?? null,
      feeDues: opts.feeDues ?? null,
    });
    enrollments.push({
      id: `enr-${id}`, studentId: id, academicYearId: curYear, classId,
      rollNumber: roll, status: 'active', source: 'live', enrolledOn: opts.enrolledAt ? at(opts.enrolledAt) : at(`${START}-06-01`),
    });
  };

  let sn = 0;
  // 45 in 5-A
  for (let i = 0; i < 45; i += 1) mkStudent(`stu-5a-${String(i + 1).padStart(3, '0')}`, `${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}`, 'cls-5A');
  // 6 in 1-A
  for (let i = 0; i < 6; i += 1) mkStudent(`stu-1a-${String(i + 1).padStart(3, '0')}`, `${pick(FIRST)} ${pick(LAST)}`, 'cls-1A');
  // 4 in LKG-A
  for (let i = 0; i < 4; i += 1) mkStudent(`stu-lkg-${String(i + 1).padStart(3, '0')}`, `${pick(FIRST)} ${pick(LAST)}`, 'cls-LKGA');

  // Messy data on purpose ────────────────────────────────────────────────
  // Telugu / Hindi letters
  mkStudent('stu-telugu', '\u0C05\u0C30\u0C4D\u0C1C\u0C41\u0C28\u0C4D \u0C15\u0C41\u0C2E\u0C3E\u0C30\u0C4D', 'cls-1A'); // అర్జున్ కుమార్
  mkStudent('stu-hindi', '\u0906\u0930\u0935 \u0936\u0930\u094D\u092E\u093E', 'cls-1A'); // आरव शर्मा
  // Apostrophe
  mkStudent('stu-dsouza', 'Mohan D\u2019Souza', 'cls-5A', { parentName: 'Peter D\u2019Souza' });
  // Very long name (≈ 60 chars)
  mkStudent('stu-longname', `${'Lakshminarayanapuram '.repeat(2)}\u0C17\u0C4B\u0C2A\u0C3E\u0C32\u0C41`.slice(0, 60), 'cls-5A');
  // Empty optional fields
  mkStudent('stu-empty', 'Kiran', 'cls-LKGA', { parentName: '', guardianContact: '', address: '', bloodGroup: null });
  // Two students, SAME name, DIFFERENT guardians
  mkStudent('stu-dup-1', 'Ananya Reddy', 'cls-5A', { parentName: 'Suresh Reddy', guardianContact: '+91-9000000101' });
  mkStudent('stu-dup-2', 'Ananya Reddy', 'cls-5A', { parentName: 'Mahesh Reddy', guardianContact: '+91-9000000102' });
  // A student with NO marks at all (excluded from mark entry below).
  mkStudent('stu-nomarks', 'Nikhil Rao', 'cls-5A');

  // Link the student logins.
  await prisma.user.update({ where: { id: 'usr-student' }, data: {} });
  const linked = { 'usr-student': 'stu-5a-001', 'usr-student2': 'stu-dup-1', 'usr-student3': 'stu-dsouza' };

  await prisma.student.createMany({ data: students });

  for (const [uid, sid] of Object.entries(linked)) {
    await prisma.student.update({ where: { id: sid }, data: { userId: uid } });
  }

  // ── enrollment history: previous year for the 1-A students (so class
  //    history / "enter past data" have something real) ───────────────────
  const prevEnr = students
    .filter((s) => s.classId === 'cls-1A')
    .map((s) => ({
      id: `enr-prev-${s.id}`, studentId: s.id, academicYearId: prevYear, classId: 'cls-LKGA',
      rollNumber: s.rollNumber, status: 'promoted', source: 'promoted', enrolledOn: at(`${START - 1}-06-01`),
      endedOn: at(`${START}-05-31`), promotedFromClassId: 'cls-LKGA', matchConfidence: 'exact',
    }));
  await prisma.enrollment ? null : null;
  await prisma.studentEnrollment.createMany({ data: enrollments });
  if (prevEnr.length) await prisma.studentEnrollment.createMany({ data: prevEnr });

  // ── student attendance: a year of FN + AN, Saturdays included ──────────
  // Only for the enrolled current-year students of LKG-A and 5-A (the big
  // classes), limited to a ~10-month window so it stays fast.
  const attStart = `${START}-06-03`;
  const attEnd = iso(new Date(Math.min(now.getTime(), at(`${START + 1}-03-31`).getTime())));
  const attendance = [];
  const attStudents = students.filter((s) => s.classId === 'cls-5A' || s.classId === 'cls-LKGA');
  let ai = 0;
  for (const day of eachDay(attStart, attEnd)) {
    const dow = day.getUTCDay(); // 0 Sun, 6 Sat — both included
    for (const s of attStudents) {
      for (const session of ['FN', 'AN']) {
        const r = rnd();
        const status = r < 0.88 ? 'present' : r < 0.94 ? 'absent' : r < 0.97 ? 'late' : 'half_day';
        attendance.push({ id: `att-${ai++}`, studentId: s.id, date: new Date(day), session, status });
        if (attendance.length >= 20000) break; // keep the seed quick
      }
      if (attendance.length >= 20000) break;
    }
    if (attendance.length >= 20000) break;
  }
  await prisma.studentAttendance.createMany({ data: attendance });
  console.log(`  attendance rows: ${attendance.length}`);

  // ── exams + marks ──────────────────────────────────────────────────────
  const exams = [
    { id: 'exam-5a-1', classId: 'cls-5A', name: 'Unit Test 1', date: at(`${START}-08-10`), academicYearId: curYear },
    { id: 'exam-5a-2', classId: 'cls-5A', name: 'Half Yearly', date: at(`${START}-10-05`), academicYearId: curYear },
    { id: 'exam-5a-3', classId: 'cls-5A', name: 'Unit Test 2', date: at(`${START + 1}-01-20`), academicYearId: curYear },
    // An exam with NO date (backfilled register) and one for 1-A.
    { id: 'exam-5a-old', classId: 'cls-5A', name: 'Annual (backfill)', date: null, academicYearId: prevYear, source: 'historical' },
    { id: 'exam-1a-1', classId: 'cls-1A', name: 'Unit Test 1', date: at(`${START}-08-12`), academicYearId: curYear },
  ];
  await prisma.exam.createMany({ data: exams });

  const marks = [];
  let mi = 0;
  const markStudents = students.filter((s) => s.classId === 'cls-5A' && s.id !== 'stu-nomarks');
  for (const ex of exams.filter((e) => e.classId === 'cls-5A' && e.date)) {
    for (const s of markStudents) {
      for (const subj of subjects) {
        const max = 100;
        marks.push({
          id: `mk-${mi++}`, studentId: s.id, examId: ex.id, subject: subj,
          maxMarks: max, obtained: int(28, 98), enteredBy: 'teacher', enteredAt: new Date(),
          teacherSavedAt: new Date(now.getTime() - int(1, 5) * 86400000),
        });
      }
    }
  }
  // 1-A: a small mark set.
  for (const s of students.filter((x) => x.classId === 'cls-1A')) {
    for (const subj of ['English', 'Mathematics']) {
      marks.push({ id: `mk-${mi++}`, studentId: s.id, examId: 'exam-1a-1', subject: subj, maxMarks: 50, obtained: int(15, 50), enteredBy: 'admin', enteredAt: new Date() });
    }
  }
  await prisma.marksEntry.createMany({ data: marks });
  console.log(`  marks rows: ${marks.length}`);

  // ── fees: current + previous year, partial payments, carried dues ──────
  const fees = [];
  const feePayments = [];
  let fi = 0; let pi = 0;
  // Give the 1-A kids a PREVIOUS-year fee (partly paid) → carried-forward due.
  for (const s of students.filter((x) => x.classId === 'cls-1A')) {
    const total = 20000;
    fees.push({ id: `fee-${fi++}`, studentId: s.id, academicYearId: prevYear, classId: 'cls-LKGA', total });
    feePayments.push({ id: `pay-${pi++}`, studentFeeId: fees[fees.length - 1].id, amount: 12000, paidOn: at(`${START - 1}-07-15`), recordedBy: 'accountant' });
  }
  // Current-year fees for everyone enrolled, with a spread of paid/partial/unpaid.
  for (const s of students) {
    const total = s.classId === 'cls-5A' ? 35000 : s.classId === 'cls-1A' ? 25000 : 18000;
    const feeId = `fee-${fi++}`;
    fees.push({ id: feeId, studentId: s.id, academicYearId: curYear, classId: s.classId, total });
    const bucket = rnd();
    let paid = 0;
    if (bucket < 0.4) paid = total;                 // fully paid
    else if (bucket < 0.75) paid = Math.floor(total * (0.25 + rnd() * 0.5)); // partial
    else paid = 0;                                  // nothing yet
    // Split a non-zero paid amount into one or two receipts.
    if (paid > 0) {
      const first = Math.floor(paid * 0.6);
      feePayments.push({ id: `pay-${pi++}`, studentFeeId: feeId, amount: first, paidOn: at(`${START}-07-01`), recordedBy: 'accountant' });
      if (paid - first > 0) {
        feePayments.push({ id: `pay-${pi++}`, studentFeeId: feeId, amount: paid - first, paidOn: at(`${START}-09-01`), recordedBy: 'accountant' });
      }
    }
  }
  // A student with NO fee row at all (fee "not set" on the dues page).
  //   -> stu-lkg-004 is left out of `fees` on purpose below.
  const noFee = 'stu-lkg-004';
  const feesFinal = fees.filter((f) => f.studentId !== noFee);
  const feeIds = new Set(feesFinal.map((f) => f.id));
  const paysFinal = feePayments.filter((p) => feeIds.has(p.studentFeeId));
  await prisma.studentFee.createMany({ data: feesFinal });
  await prisma.feePayment.createMany({ data: paysFinal });
  console.log(`  fee rows: ${feesFinal.length}, payments: ${paysFinal.length}`);

  // ── employee attendance: a year-ish for the staff (FN + AN) ────────────
  const empAtt = [];
  let ei = 0;
  const empIds = ['emp-001', 'emp-002', 'emp-003', 'emp-004'];
  for (const day of eachDay(`${START}-09-01`, attEnd)) {
    if (empAtt.length >= 900) break;
    for (const id of empIds) {
      for (const session of ['FN', 'AN']) {
        empAtt.push({ id: `eatt-${ei++}`, employeeId: id, date: new Date(day), session, status: rnd() < 0.92 ? 'present' : 'absent' });
      }
    }
  }
  await prisma.employeeAttendance.createMany({ data: empAtt });

  // ── payroll: two months, one partial payment, one fully paid ───────────
  const netOf = (e) => e.basicPay + e.hra + e.transportAllowance + e.medicalAllowance - e.providentFund - e.professionalTax - e.tds;
  const payroll = [];
  const payrollPays = [];
  const months = [`${START}-09`, `${START}-10`];
  for (const id of empIds) {
    for (const m of months) {
      const base = id === 'emp-003' || id === 'emp-004' ? { basicPay: 22000, hra: 4000, transportAllowance: 1500, medicalAllowance: 800, providentFund: 1800, professionalTax: 200, tds: 500 } : salary;
      const rec = { id: `pr-${id}-${m}`, employeeId: id, month: m, ...base, netSalary: netOf(base) };
      payroll.push(rec);
    }
  }
  await prisma.payrollRecord.createMany({ data: payroll });
  // emp-001 Sept fully paid; emp-002 Sept partial; everyone else unpaid.
  const pr1 = payroll.find((p) => p.id === 'pr-emp-001-' + months[0]);
  const pr2 = payroll.find((p) => p.id === 'pr-emp-002-' + months[0]);
  payrollPays.push({ id: 'pp-1', payrollRecordId: pr1.id, amount: pr1.netSalary, paidOn: at(`${START}-10-01`), note: null });
  payrollPays.push({ id: 'pp-2', payrollRecordId: pr2.id, amount: Math.floor(pr2.netSalary / 2), paidOn: at(`${START}-10-01`), note: 'advance' });
  await prisma.payrollPayment.createMany({ data: payrollPays });
  // Reflect the fully-paid one on the record (partial stays null).
  await prisma.payrollRecord.update({ where: { id: pr1.id }, data: { paidOn: at(`${START}-10-01`) } });

  // ── leave balances + requests ──────────────────────────────────────────
  await prisma.leaveBalance.createMany({
    data: empIds.map((id) => ({ employeeId: id, casual: 12, sick: 8, earned: 10 })),
  });
  await prisma.leaveRequest.createMany({
    data: [
      { id: 'lv-1', employeeId: 'emp-001', type: 'casual', fromDate: at(`${START}-09-15`), toDate: at(`${START}-09-16`), reason: 'Personal work', status: 'approved', decidedAt: new Date() },
      { id: 'lv-2', employeeId: 'emp-002', type: 'sick', fromDate: at(`${START}-10-02`), toDate: at(`${START}-10-02`), reason: 'Fever', status: 'pending' },
    ],
  });

  // ── announcements / holidays / reminders ───────────────────────────────
  await prisma.announcement.createMany({
    data: [
      { id: 'ann-1', title: 'Annual Day', body: 'Annual day on 20th.', targetRoles: ['student', 'teacher'], category: 'event', showFrom: at(`${START}-06-01`), showUntil: at(`${START + 1}-05-31`), targetScope: 'ROLES' },
      { id: 'ann-2', title: 'Class 5-A trip', body: 'Field trip.', targetRoles: ['student'], category: 'event', showFrom: at(`${START}-06-01`), showUntil: at(`${START + 1}-05-31`), targetScope: 'CLASS', targetClassId: 'cls-5A' },
      { id: 'ann-3', title: 'Staff meeting', body: 'All staff.', targetRoles: ['teacher', 'accountant', 'librarian'], category: 'general', showFrom: at(`${START}-06-01`), showUntil: at(`${START + 1}-05-31`), targetScope: 'EMPLOYEES' },
      { id: 'ann-4', title: 'Old notice (expired)', body: 'This one has already passed.', targetRoles: ['student'], category: 'general', showFrom: at(`${START - 1}-06-01`), showUntil: at(`${START - 1}-06-30`), targetScope: 'ROLES' },
    ],
  });
  await prisma.holiday.createMany({
    data: [
      { id: 'hol-1', date: at(`${START}-08-15`), name: 'Independence Day' },
      { id: 'hol-2', date: at(`${START}-10-02`), name: 'Gandhi Jayanti' },
      { id: 'hol-3', date: at(`${START + 1}-01-26`), name: 'Republic Day' },
      { id: 'hol-4', date: at(`${START}-12-25`), name: 'Christmas' },
    ],
  });
  await prisma.reminder.create({
    data: { id: 'rem-1', userId: 'usr-admin', date: at(iso(now)), title: 'Follow up on pending fees' },
  });

  // ── setting: weekly off = Sunday ───────────────────────────────────────
  await prisma.setting.create({ data: { key: 'weeklyOffDays', value: [0] } });

  const counts = {
    users: await prisma.user.count(), classes: await prisma.class.count(),
    students: await prisma.student.count(), employees: await prisma.employee.count(),
    attendance: await prisma.studentAttendance.count(), marks: await prisma.marksEntry.count(),
    fees: await prisma.studentFee.count(), payments: await prisma.feePayment.count(),
  };
  console.log('QA seed complete:', counts);
  console.log(`Academic year: ${YEAR} (current), ${PREV} (previous)`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
