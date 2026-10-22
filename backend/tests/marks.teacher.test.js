/**
 * Teacher Marks Entry tests —
 * GET/POST /api/v1/employees/:id/marks(/assignments|/bulk|/bulk-template).
 *
 * Two things are being proved here, and the second matters more than the first:
 *
 *   1. IT IS THE ADMIN PANEL'S MARKS. Same Exam / MarksEntry rows, written
 *      through the same services/marks.js save path, so what a teacher enters is
 *      immediately what the admin's Saved Marks table, the student profile and
 *      the student portal all read. These tests re-read through the ADMIN
 *      endpoints rather than through the teacher's own, so "the same records" is
 *      checked from the other side and not merely asserted.
 *
 *   2. THE SCOPING IS ENFORCED, NOT DISPLAYED. A teacher may enter marks only
 *      for (class, subject) pairs that appear in the TIMETABLE with them as the
 *      assigned teacher. The permitted pairs are derived live, and the write
 *      routes reject an out-of-scope request even when it is sent straight to
 *      the API — the UI hiding an option is explicitly not the control.
 *
 * Nothing is hardcoded: the class/subject the teacher legitimately holds is read
 * from the assignments endpoint, and the classes and students they must NOT touch
 * are created here so the denials rest on real rows.
 *
 * Node built-in test runner, zero extra deps.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { startServer, stopServer, login, request, auth } = require('./helpers');
const { classLabel } = require('../src/services/mappers');

/** The teacher's upload header: no Class and no Subject column. */
const TEACHER_HEADER = 'RollNumber,StudentName,ExamName,ExamDate,MaxMarks,ObtainedMarks';
/** The admin's upload header — must NOT be accepted here (it carries Subject). */
const ADMIN_HEADER = 'RollNumber,StudentName,ExamName,ExamDate,Subject,MaxMarks,ObtainedMarks';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

test('teacher marks entry: timetable-scoped, same records as the admin panel', async (t) => {
  const { server, base } = await startServer();
  const admin = await login(base, 'admin', 'Admin@123');
  const teacher = await login(base, 'teacher', 'Teacher@123'); // emp-001 — Priya Sharma
  const accountant = await login(base, 'accountant', 'Accounts@123'); // emp-002 — no periods
  const studentToken = (await login(base, 'student', 'Student@123')).accessToken;

  const prisma = require('../src/services/prisma');

  /* A class the teacher is NOT assigned in the timetable, with a student in it,
     created live so the "not permitted" assertions never rest on a guessed id. */
  const foreignClassId = 'cls-8C';
  const foreignStudentId = 'stu-8c-001';
  await prisma.class.create({ data: { id: foreignClassId, grade: 8, section: 'C' } });
  await prisma.student.create({
    data: { id: foreignStudentId, name: 'Untaught Class Student', classId: foreignClassId, rollNumber: 'STU-2026-999' },
  });

  const assignments = (employeeId = 'emp-001', token = teacher.accessToken) =>
    request(base, `/employees/${employeeId}/marks/assignments`, { token });

  const grid = (params, token = teacher.accessToken) =>
    request(base, `/employees/emp-001/marks?${new URLSearchParams(params)}`, { token });

  const save = (body, token = teacher.accessToken) =>
    request(base, '/employees/emp-001/marks', { method: 'POST', token, body });

  /** Multipart upload of a marks file, scoped to one class + subject. */
  const upload = (buffer, filename, mime, { classId, subject }, token = teacher.accessToken) => {
    const fd = new FormData();
    fd.append('file', new Blob([buffer], { type: mime }), filename);
    if (classId) fd.append('classId', classId);
    if (subject) fd.append('subject', subject);
    return fetch(`${base}/employees/emp-001/marks/bulk`, {
      method: 'POST', headers: auth(token), body: fd,
    }).then(async (res) => ({ status: res.status, body: JSON.parse((await res.text()) || '{}') }));
  };

  /** The seeded teacher's own single permitted pair, read from the API. */
  const own = (await assignments()).body.data;
  assert.ok(own.length > 0, 'the seeded teacher holds at least one timetable period');
  const { classId: ownClassId, subject: ownSubject, classLabel: ownClassLabel } = own[0];

  /* The students of that class, read live — the grid is built from real rows. */
  const classStudents = await prisma.student.findMany({
    where: { classId: ownClassId }, select: { id: true, name: true, rollNumber: true }, orderBy: { rollNumber: 'asc' },
  });
  assert.ok(classStudents.length > 0, 'the permitted class has a roster');

  /* ---- 1. the permission list is the timetable, live ---- */

  await t.test('permitted pairs are derived from the timetable, never a stored list', async () => {
    const res = await assignments();
    assert.equal(res.status, 200);
    const list = res.body.data;

    // Exactly the (class, subject) pairs TimetablePeriod records for this teacher.
    const periods = await prisma.timetablePeriod.findMany({
      where: { teacherName: (await prisma.employee.findUnique({ where: { id: 'emp-001' } })).name },
      select: { classId: true, subject: true },
    });
    const expected = [...new Set(periods.map((p) => `${p.classId}::${p.subject}`))].sort();
    assert.deepEqual(list.map((p) => `${p.classId}::${p.subject}`).sort(), expected,
      'the list is the collapsed set of this teacher\'s timetable periods');

    // A class that exists but has no period for this teacher is never offered.
    assert.ok(!list.some((p) => p.classId === foreignClassId),
      'a class with no period of theirs is absent even though the class exists');

    // Headcount, label and period count are real, not placeholders.
    const entry = list.find((p) => p.classId === ownClassId && p.subject === ownSubject);
    assert.equal(entry.studentCount, classStudents.length);
    // The label is the shared classLabel, which is correct for a named level too.
    assert.equal(entry.classLabel, classLabel({ grade: Number(entry.grade), section: entry.section }));
    assert.ok(entry.periods >= 1, 'the pair carries its live period count');
  });

  await t.test('adding and re-pointing a period changes access on the next request', async () => {
    // Give this teacher a SECOND subject in the same class: it must appear as its
    // own option, not be merged into the existing pair.
    const addPeriod = (body) => request(base, '/admin/timetable', { method: 'POST', token: admin.accessToken, body });
    const add = await addPeriod({
      classKey: ownClassId, period: 8, timeStart: '14:30', timeEnd: '15:15',
      subject: 'Environmental Studies', teacher: 'Priya Sharma', room: '106',
    });
    assert.equal(add.status, 201);

    let list = (await assignments()).body.data;
    const pair = list.find((p) => p.classId === ownClassId && p.subject === 'Environmental Studies');
    assert.ok(pair, 'the newly added period is offered as its own (class, subject) pair');
    assert.equal(pair.periods, 1);

    // Re-point that period at another teacher: the pair must disappear, i.e. the
    // permission is genuinely read from the timetable rather than snapshotted.
    assert.equal((await request(base, `/admin/timetable/${ownClassId}/8`, { method: 'DELETE', token: admin.accessToken })).status, 200);
    const replace = await addPeriod({
      classKey: ownClassId, period: 8, timeStart: '14:30', timeEnd: '15:15',
      subject: 'Environmental Studies', teacher: 'Somebody Else', room: '106',
    });
    assert.equal(replace.status, 201);

    list = (await assignments()).body.data;
    assert.ok(!list.some((p) => p.subject === 'Environmental Studies'),
      're-pointing the period at another teacher revokes the pair');
  });

  /* ---- 2. the scoping is enforced server-side ---- */

  await t.test('writes outside the teacher\'s timetable are rejected, not hidden', async () => {
    // Another teacher's subject in a class this teacher DOES hold a period for.
    const other = await prisma.timetablePeriod.findFirst({
      where: { classId: ownClassId, subject: { not: ownSubject } },
      select: { subject: true },
    });
    assert.ok(other, 'the seeded class has a subject taught by somebody else');

    const denied = await save({
      classId: ownClassId,
      subject: other.subject,
      examName: 'Forged Exam',
      date: '2026-09-20',
      maxMarks: 100,
      entries: [{ studentId: classStudents[0].id, obtained: 50 }],
    });
    assert.equal(denied.status, 403, 'a subject this teacher does not teach is refused');
    assert.match(denied.body.message, /timetable/i);

    // A class the teacher has no period in at all.
    const otherClass = await save({
      classId: foreignClassId,
      subject: ownSubject,
      examName: 'Forged Exam',
      date: '2026-09-20',
      maxMarks: 100,
      entries: [{ studentId: foreignStudentId, obtained: 50 }],
    });
    assert.equal(otherClass.status, 403, 'a class the teacher does not teach is refused');

    // Nothing was written by either attempt.
    const forged = await prisma.exam.findFirst({ where: { name: 'Forged Exam' } });
    assert.equal(forged, null, 'no exam was created by a refused request');

    // The bulk upload and the template are gated the same way.
    const csv = [TEACHER_HEADER, `${classStudents[0].rollNumber},${classStudents[0].name},Forged Exam,20-09-2026,100,50`].join('\r\n');
    const bulkDenied = await upload(csv, 'marks.csv', 'text/csv', { classId: foreignClassId, subject: ownSubject });
    assert.equal(bulkDenied.status, 403, 'the bulk upload refuses an unassigned class');

    const tplDenied = await request(base, `/employees/emp-001/marks/bulk-template?classId=${foreignClassId}&subject=${encodeURIComponent(ownSubject)}`, { token: teacher.accessToken });
    assert.equal(tplDenied.status, 403, 'the template download refuses an unassigned class');
  });

  await t.test('non-teaching staff get an empty list, never an error', async () => {
    const res = await assignments('emp-002', accountant.accessToken);
    assert.equal(res.status, 200, 'an accountant with no periods is not an error');
    assert.deepEqual(res.body.data, [], 'they simply have nothing to enter marks for');

    // The grid is a teacher-only surface, so it IS refused for them.
    const gridRes = await request(base, `/employees/emp-002/marks?classId=${ownClassId}&subject=${ownSubject}`, { token: accountant.accessToken });
    assert.equal(gridRes.status, 403);
  });

  await t.test("a teacher cannot reach another employee's marks", async () => {
    const res = await request(base, `/employees/emp-002/marks?classId=${ownClassId}&subject=${ownSubject}`, { token: teacher.accessToken });
    assert.equal(res.status, 403, 'the employee id in the path is not trusted');
  });

  /* ---- 3. the grid, the save, and the records it produces ---- */

  await t.test('the grid returns the real roster and the marks already saved', async () => {
    const fresh = await grid({ classId: ownClassId, subject: ownSubject });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.data.subject, ownSubject, 'the subject comes back as the timetable spells it');
    assert.equal(fresh.body.data.studentCount, classStudents.length);
    assert.deepEqual(
      fresh.body.data.roster.map((r) => r.studentId),
      classStudents.map((s) => s.id),
      'every student in the class is present, in roll order',
    );
    assert.ok(fresh.body.data.roster.every((r) => r.obtained === null), 'a fresh exam starts empty');
    assert.equal(fresh.body.data.exam, null);

    // The seed already holds this subject's marks for one exam, so the "already
    // saved" list must be non-empty and derived from those real rows.
    assert.ok(fresh.body.data.exams.length > 0, 'saved exams for this class+subject are listed');
    const listed = fresh.body.data.exams[0];
    assert.equal(typeof listed.examName, 'string');
    assert.ok(listed.saved > 0 && listed.average !== null);
  });

  let savedExamName = 'Teacher Unit Test';
  let savedDate = '2026-09-21';

  await t.test('saving the class writes ONE atomic, attributed set of rows', async () => {
    const res = await save({
      classId: ownClassId,
      subject: ownSubject,
      examName: savedExamName,
      date: savedDate,
      maxMarks: 100,
      entries: classStudents.map((s, i) => ({ studentId: s.id, obtained: 70 + i })),
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.saved, classStudents.length);
    assert.equal(res.body.data.subject, ownSubject, 'the stored subject is the timetable spelling');
    assert.equal(res.body.message, `Saved ${classStudents.length} ${ownSubject} marks for ${ownClassLabel}`);

    // Read back through the ADMIN endpoint — the same records, not a second store.
    // `/admin/marks?classId=` returns { [studentId]: [{ examName, date, subjects }] },
    // so one mark row is one (student, exam, subject) triple and has to be
    // reassembled across the per-student grouping.
    const byStudent = (await request(base, `/admin/marks?classId=${ownClassId}`, { token: admin.accessToken })).body.data;
    const rowsFor = (examName, subject) => Object.entries(byStudent).flatMap(([studentId, exams]) =>
      exams
        .filter((e) => e.examName === examName)
        .flatMap((e) => e.subjects.filter((s) => s.subject === subject).map((s) => ({ studentId, ...s }))));

    const dates = Object.values(byStudent).flat().filter((e) => e.examName === savedExamName).map((e) => e.date);
    assert.ok(dates.length > 0, 'the admin Saved Marks read sees the teacher\'s exam');
    assert.ok(dates.every((d) => d === savedDate), 'with the exam date the teacher chose');

    const stored = rowsFor(savedExamName, ownSubject);
    assert.equal(stored.length, classStudents.length, 'one row per student, no duplicates');
    assert.deepEqual(
      stored.map((r) => r.obtained).sort(),
      classStudents.map((_, i) => 70 + i).sort(),
    );

    // Attribution recorded for the admin to see.
    assert.ok(stored.every((r) => r.enteredBy === 'teacher'), 'each row records who entered it');
    assert.ok(stored.every((r) => r.enteredAt), 'and when');
    assert.ok(stored.every((r) => r.updatedBy === null), 'a first save is not a correction');
  });

  await t.test('re-saving the same exam corrects the rows instead of duplicating them', async () => {
    const before = await prisma.marksEntry.count({ where: { subject: ownSubject } });

    const res = await save({
      classId: ownClassId,
      subject: ownSubject,
      examName: savedExamName,
      date: savedDate,
      maxMarks: 100,
      // Correct only the first student; leave the rest untouched.
      entries: [{ studentId: classStudents[0].id, obtained: 95 }],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.saved, 1, 'only the entered row is written');
    assert.equal(res.body.data.notEntered, classStudents.length - 1,
      'a blank row is reported as not entered, never saved as zero');

    const after = await prisma.marksEntry.count({ where: { subject: ownSubject } });
    assert.equal(after, before, 'correcting adds no rows');

    const rows = await prisma.marksEntry.findMany({
      where: { subject: ownSubject, student: { classId: ownClassId }, exam: { name: savedExamName } },
    });
    const corrected = rows.find((r) => r.studentId === classStudents[0].id);
    assert.equal(corrected.obtained, 95);
    assert.equal(corrected.enteredBy, 'teacher', 'who entered is preserved through a correction');
    assert.equal(corrected.updatedBy, 'teacher', 'and who last changed it is recorded');
    assert.ok(corrected.updatedAt, 'with a timestamp');

    // The untouched student keeps the mark they had — a blank cell is a skip, not
    // a zero and not an erasure.
    const untouched = rows.find((r) => r.studentId === classStudents[1].id);
    assert.equal(untouched.obtained, 71);
  });

  await t.test('the same exam name in a different case loads, not duplicates', async () => {
    const res = await grid({ classId: ownClassId, subject: ownSubject, examName: savedExamName.toUpperCase() });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.exam, 'a re-typed exam name still resolves the saved exam');
    assert.equal(res.body.data.exam.examName, savedExamName, 'and comes back in its stored spelling');
    const first = res.body.data.roster.find((r) => r.studentId === classStudents[0].id);
    assert.equal(first.obtained, 95, 'the corrected value is loaded into the grid');
  });

  /* ---- 4. subject identity ---- */

  await t.test('the subject is stored as the TIMETABLE spells it', async () => {
    // Different case and padding still passes the permission check...
    const res = await save({
      classId: ownClassId,
      subject: `  ${ownSubject.toUpperCase()}  `,
      examName: 'Case Test',
      date: '2026-09-22',
      maxMarks: 100,
      entries: [{ studentId: classStudents[0].id, obtained: 60 }],
    });
    assert.equal(res.status, 201, 'the permission match is case- and whitespace-insensitive');
    assert.equal(res.body.data.subject, ownSubject, 'but the stored spelling is the timetable\'s');

    const row = await prisma.marksEntry.findFirst({
      where: { subject: ownSubject, exam: { name: 'Case Test' } },
    });
    assert.ok(row, 'the row is stored under the timetable spelling, so "Mathematics" in the timetable IS the same string as in Marks');
  });

  /* ---- 5. atomicity ---- */

  await t.test('one invalid row means the whole save is rejected and nothing is written', async () => {
    const before = await prisma.marksEntry.count();

    // Obtained above Max Marks.
    const over = await save({
      classId: ownClassId,
      subject: ownSubject,
      examName: 'Atomic Test',
      date: '2026-09-23',
      maxMarks: 100,
      entries: [
        { studentId: classStudents[0].id, obtained: 80 },
        { studentId: classStudents[1].id, obtained: 140 },
      ],
    });
    assert.equal(over.status, 400);
    assert.ok(over.body.errors.entry_2, 'the offending row is named');
    assert.match(over.body.errors.entry_2.obtained, /100/, 'and the limit it broke');

    // A student who is not in the selected class — the roster is checked on the
    // server, so a forged id cannot file marks against this exam.
    const foreign = await save({
      classId: ownClassId,
      subject: ownSubject,
      examName: 'Atomic Test',
      date: '2026-09-23',
      maxMarks: 100,
      entries: [
        { studentId: classStudents[0].id, obtained: 80 },
        { studentId: foreignStudentId, obtained: 90 },
      ],
    });
    assert.equal(foreign.status, 400);
    assert.match(foreign.body.errors.entry_2.studentId, /not in the selected class/);

    // The same student twice.
    const dupe = await save({
      classId: ownClassId,
      subject: ownSubject,
      examName: 'Atomic Test',
      date: '2026-09-23',
      maxMarks: 100,
      entries: [
        { studentId: classStudents[0].id, obtained: 80 },
        { studentId: classStudents[0].id, obtained: 85 },
      ],
    });
    assert.equal(dupe.status, 400);
    assert.match(dupe.body.errors.entry_2.studentId, /more than once/);

    // Not one exam, not one mark.
    assert.equal(await prisma.exam.count({ where: { name: 'Atomic Test' } }), 0, 'no exam was created');
    assert.equal(await prisma.marksEntry.count(), before, 'no mark was written');

    // A completely empty save is refused rather than silently doing nothing.
    const empty = await save({
      classId: ownClassId, subject: ownSubject, examName: 'Atomic Test',
      date: '2026-09-23', maxMarks: 100, entries: [],
    });
    assert.equal(empty.status, 400);
  });

  /* ---- 6. bulk upload ---- */

  await t.test('bulk upload saves the page\'s class and subject, with no Class/Subject columns', async () => {
    const csv = [
      TEACHER_HEADER,
      ...classStudents.map((s, i) => `${s.rollNumber},${s.name},Bulk Teacher Exam,24-09-2026,100,${60 + i}`),
    ].join('\r\n');

    const res = await upload(csv, 'marks.csv', 'text/csv', { classId: ownClassId, subject: ownSubject });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.saved, classStudents.length);
    assert.equal(res.body.data.subject, ownSubject, 'every row landed under the subject the page fixed');
    assert.equal(res.body.data.rows[0].subject, ownSubject);

    // The admin's template header carries a Subject column and must be refused —
    // a file must not be able to name a subject the page did not select.
    const wrongHeader = [
      ADMIN_HEADER,
      `${classStudents[0].rollNumber},${classStudents[0].name},X,24-09-2026,English,100,50`,
    ].join('\r\n');
    const refused = await upload(wrongHeader, 'admin-style.csv', 'text/csv', { classId: ownClassId, subject: ownSubject });
    assert.equal(refused.status, 400);
    assert.match(refused.body.errors.file, /Header row must be exactly/);
    assert.equal(
      await prisma.marksEntry.count({ where: { subject: 'English', exam: { name: 'X' } } }),
      0,
      'a Subject column cannot smuggle marks into another subject',
    );
  });

  await t.test('bulk upload rejects foreign roll numbers and saves nothing', async () => {
    const before = await prisma.marksEntry.count();
    const foreignRoll = (await prisma.student.findUnique({ where: { id: foreignStudentId } })).rollNumber;

    const csv = [
      TEACHER_HEADER,
      `${classStudents[0].rollNumber},${classStudents[0].name},Foreign Roll Exam,25-09-2026,100,70`,
      `${foreignRoll},${'Untaught Class Student'},Foreign Roll Exam,25-09-2026,100,70`,
    ].join('\r\n');

    const res = await upload(csv, 'marks.csv', 'text/csv', { classId: ownClassId, subject: ownSubject });
    assert.equal(res.status, 400);
    assert.ok(res.body.errors.row_3, 'the offending row is named');
    assert.match(res.body.errors.row_3.RollNumber, /No student with this roll number/);
    assert.match(res.body.errors.file, /Nothing was saved/);
    assert.equal(await prisma.marksEntry.count(), before, 'the valid row was not saved either');
  });

  await t.test('bulk upload validates every row together, with per-row errors and a 200-row cap', async () => {
    // Obtained > MaxMarks on the second row rejects the whole file.
    const bad = [
      TEACHER_HEADER,
      `${classStudents[0].rollNumber},${classStudents[0].name},Bad Rows,26-09-2026,100,70`,
      `${classStudents[1].rollNumber},${classStudents[1].name},Bad Rows,26-09-2026,100,999`,
    ].join('\r\n');
    const res = await upload(bad, 'marks.csv', 'text/csv', { classId: ownClassId, subject: ownSubject });
    assert.equal(res.status, 400);
    assert.match(res.body.errors.row_3.ObtainedMarks, /Cannot exceed MaxMarks/);
    assert.equal(await prisma.marksEntry.count({ where: { subject: ownSubject, exam: { name: 'Bad Rows' } } }), 0);

    // 201 rows is over the cap.
    const header = TEACHER_HEADER;
    const rows = Array.from({ length: 201 }, (_, i) => `R${i},N${i},Too Many,27-09-2026,100,10`);
    const tooMany = await upload([header, ...rows].join('\r\n'), 'marks.csv', 'text/csv', { classId: ownClassId, subject: ownSubject });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.errors.file, /Up to 200 rows per file/);

    // Wrong extension / no file at all.
    const wrongType = await upload('a,b', 'marks.txt', 'text/plain', { classId: ownClassId, subject: ownSubject });
    assert.equal(wrongType.status, 400);
    const noFile = await request(base, '/employees/emp-001/marks/bulk', { method: 'POST', token: teacher.accessToken });
    assert.equal(noFile.status, 400);
  });

  await t.test('re-uploading the same bulk exam corrects rather than duplicates', async () => {
    const before = await prisma.marksEntry.count({ where: { subject: ownSubject } });
    const csv = [
      TEACHER_HEADER,
      ...classStudents.map((s, i) => `${s.rollNumber},${s.name},Bulk Teacher Exam,24-09-2026,100,${30 + i}`),
    ].join('\r\n');
    const res = await upload(csv, 'marks.csv', 'text/csv', { classId: ownClassId, subject: ownSubject });
    assert.equal(res.status, 201);
    assert.equal(await prisma.marksEntry.count({ where: { subject: ownSubject } }), before, 'the same rows were overwritten');

    const rows = await prisma.marksEntry.findMany({
      where: { subject: ownSubject, exam: { name: 'Bulk Teacher Exam' } },
    });
    assert.deepEqual(rows.map((r) => r.obtained).sort(), classStudents.map((_, i) => 30 + i).sort());
    assert.ok(rows.every((r) => r.updatedBy === 'teacher'), 'the re-upload is recorded as a change');
  });

  await t.test('XLSX upload works, and both templates download and round-trip', async () => {
    /* Build a real workbook the way Excel would, with a date-formatted cell. */
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Marks');
    sheet.addRow(['RollNumber', 'StudentName', 'ExamName', 'ExamDate', 'MaxMarks', 'ObtainedMarks']);
    classStudents.forEach((s, i) => {
      const row = sheet.addRow([s.rollNumber, s.name, 'Xlsx Teacher Exam', null, 100, 40 + i]);
      row.getCell(4).value = new Date(Date.UTC(2026, 8, 28));
      row.getCell(4).numFmt = 'dd-mm-yyyy';
    });
    const buffer = Buffer.from(await book.xlsx.writeBuffer());

    const res = await upload(buffer, 'marks.xlsx', XLSX_MIME, { classId: ownClassId, subject: ownSubject });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.saved, classStudents.length);
    assert.equal(res.body.data.rows[0].examDate, '2026-09-28', 'a real spreadsheet date cell is read correctly');

    /* Templates: the XLSX carries an Instructions sheet, the CSV is header-only. */
    const tplQuery = `classId=${ownClassId}&subject=${encodeURIComponent(ownSubject)}`;
    const xlsxRes = await fetch(`${base}/employees/emp-001/marks/bulk-template?${tplQuery}`, { headers: auth(teacher.accessToken) });
    assert.equal(xlsxRes.status, 200);
    assert.match(xlsxRes.headers.get('content-disposition'), /marks_upload_template\.xlsx/);
    const tplBook = new ExcelJS.Workbook();
    await tplBook.xlsx.load(await xlsxRes.arrayBuffer());
    assert.deepEqual(tplBook.worksheets.map((w) => w.name), ['Marks', 'Instructions']);
    const tplHeader = [];
    tplBook.worksheets[0].getRow(1).eachCell((cell, col) => { tplHeader[col - 1] = String(cell.text).trim(); });
    assert.deepEqual(tplHeader, TEACHER_HEADER.split(','), 'the template header is exactly what the importer accepts');
    assert.ok(!tplHeader.includes('Subject'), 'and carries no Subject column');

    const csvRes = await fetch(`${base}/employees/emp-001/marks/bulk-template?format=csv&${tplQuery}`, { headers: auth(teacher.accessToken) });
    assert.equal(csvRes.status, 200);
    const csvText = (await csvRes.text()).replace(/^\uFEFF/, '');
    assert.equal(csvText.split('\r\n')[0], TEACHER_HEADER);

    // Uploading the untouched template must fail loudly, not invent marks.
    const untouched = await upload(csvText, 'template.csv', 'text/csv', { classId: ownClassId, subject: ownSubject });
    assert.equal(untouched.status, 400, 'the placeholder row is rejected');
    assert.match(untouched.body.errors.row_2.RollNumber, /No student with this roll number/);
  });

  /* ---- 7. the admin is not restricted ---- */

  await t.test('the admin keeps unrestricted access to every class and subject', async () => {
    // A subject no teacher holds, on a class this teacher does not teach.
    const res = await request(base, '/admin/marks', {
      method: 'POST',
      token: admin.accessToken,
      body: {
        studentId: foreignStudentId,
        examName: 'Admin Only Exam',
        date: '2026-09-29',
        subjects: [{ subject: 'Home Economics', maxMarks: 50, obtained: 40 }],
      },
    });
    assert.equal(res.status, 201, 'the admin can still enter any subject for any class');

    const stored = await prisma.marksEntry.findFirst({
      where: { subject: 'Home Economics', exam: { name: 'Admin Only Exam' } },
    });
    assert.ok(stored);
    assert.equal(stored.enteredBy, 'admin', 'and it is attributed to the admin');

    // The teacher still cannot see or touch it: it is not in their timetable.
    const denied = await save({
      classId: foreignClassId,
      subject: 'Home Economics',
      examName: 'Admin Only Exam',
      date: '2026-09-29',
      maxMarks: 50,
      entries: [{ studentId: foreignStudentId, obtained: 40 }],
    });
    assert.equal(denied.status, 403);
  });

  await t.test('admin reads expose attribution; student reads do not', async () => {
    const byStudent = (await request(base, `/admin/marks?classId=${ownClassId}`, { token: admin.accessToken })).body.data;
    const row = Object.entries(byStudent).flatMap(([studentId, exams]) => exams
      .filter((e) => e.examName === savedExamName)
      .flatMap((e) => e.subjects.filter((s) => s.subject === ownSubject).map((s) => ({ studentId, ...s }))))
      .find((r) => r.studentId === classStudents[0].id);
    assert.ok(row, 'the admin sees the mark the teacher entered');
    assert.equal(row.enteredBy, 'teacher', 'and who entered it');

    // A row that predates attribution reports no author rather than inventing one.
    const seeded = Object.values(byStudent).flat().find((e) => e.examName !== savedExamName);
    const seededRow = seeded && seeded.subjects.find((s) => s.subject === ownSubject);
    if (seededRow) assert.equal(seededRow.enteredBy, null, 'an unattributed row reads as "—", not a guess');

    // The student-facing read shares the grouping function but must not leak staff
    // usernames to a student.
    const studentRead = await request(base, `/students/${classStudents[0].id}/marks`, { token: studentToken });
    const subject = studentRead.body.data.flatMap((e) => e.subjects).find((s) => s.subject === ownSubject);
    assert.ok(subject, 'the student still sees the marks themselves');
    assert.equal(subject.enteredBy, undefined, 'but not who recorded them');
  });

  await t.test('teardown — stop server', async () => {
    await stopServer(server);
  });
});
