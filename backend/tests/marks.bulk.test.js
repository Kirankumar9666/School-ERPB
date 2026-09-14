/**
 * Bulk marks entry (CSV/XLSX) tests — POST /api/v1/admin/marks/bulk.
 * Covers long/tidy parsing, roll-number matching, per-row/per-column
 * validation, atomic rejection, free-text subjects, the derived success
 * message and the recomputed class-summary/marks re-read.
 * Also covers the template download and the manual single-student path.
 * Node built-in test runner, zero extra deps.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { startServer, stopServer, login, auth, request } = require('./helpers');

/** Multipart POST of a file buffer → { status, body } */
async function upload(base, token, buffer, filename, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mime }), filename);
  const res = await fetch(`${base}/admin/marks/bulk`, { method: 'POST', headers: auth(token), body: fd });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const CSV_HEADER = 'RollNumber,StudentName,Class,Section,ExamName,ExamDate,Subject,MaxMarks,ObtainedMarks';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

test('marks bulk upload: CSV/XLSX, atomic validation, derived stats, template', async (t) => {
  const { server, base } = await startServer();
  const admin = await login(base, 'admin', 'Admin@123');

  /** Students seeded for class 10-A — matched by their real roll number */
  const students = (await request(base, '/admin/students', { token: admin.accessToken })).body.data;
  const tenA = students.filter((s) => s.class === '10' && s.section === 'A');
  const [s1, s2] = tenA;
  const roll1 = s1.rollNumber;
  const roll2 = s2.rollNumber;

  const marksOf = async (studentId) =>
    (await request(base, `/admin/marks?studentId=${studentId}`, { token: admin.accessToken })).body.data;

  await t.test('CSV long-format rows are matched by RollNumber and saved', async () => {
    const csv = [
      CSV_HEADER,
      // s1 has two subjects (two rows), s2 has one — subjects are free text
      `${roll1},${s1.name},10,A,Bulk Exam A,14-09-2026,Mathematics,100,88`,
      `${roll1},${s1.name},10,A,Bulk Exam A,14-09-2026,Environmental Studies,50,41`,
      `${roll2},${s2.name},10,A,Bulk Exam A,14-09-2026,Mathematics,100,79`,
    ].join('\r\n');
    const res = await upload(base, admin.accessToken, csv, 'marks.csv', 'text/csv');

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.saved, 3);
    assert.equal(res.body.data.students, 2);
    assert.equal(res.body.data.exams, 1);
    // message is derived from what was actually stored, never hardcoded
    assert.equal(res.body.message, '3 mark rows saved for 2 students in 1 exam');

    // a free-text subject that is not in any fixed list was accepted
    const bulkExam = (await marksOf(s1.id)).find((e) => e.examName === 'Bulk Exam A');
    assert.ok(bulkExam, 'bulk exam visible for the matched student');
    assert.equal(bulkExam.date, '2026-09-14');
    assert.equal(bulkExam.subjects.length, 2);
    assert.deepEqual(
      bulkExam.subjects.map((s) => [s.subject, s.maxMarks, s.obtained]).sort(),
      [['Environmental Studies', 50, 41], ['Mathematics', 100, 88]],
    );

    // the student with a single row is unaffected by the other student's rows
    const other = (await marksOf(s2.id)).find((e) => e.examName === 'Bulk Exam A');
    assert.equal(other.subjects.length, 1);
  });

  await t.test('re-uploading the same rows upserts instead of duplicating', async () => {
    const csv = [
      CSV_HEADER,
      `${roll1},${s1.name},10,A,Bulk Exam A,14-09-2026,Mathematics,100,95`,
    ].join('\r\n');
    const res = await upload(base, admin.accessToken, csv, 'marks.csv', 'text/csv');
    assert.equal(res.status, 201);
    assert.equal(res.body.data.saved, 1);

    const bulkExam = (await marksOf(s1.id)).find((e) => e.examName === 'Bulk Exam A');
    assert.equal(bulkExam.subjects.length, 2, 'no duplicate subject rows created');
    const maths = bulkExam.subjects.find((s) => s.subject === 'Mathematics');
    assert.equal(maths.obtained, 95, 'existing row was updated in place');
  });
await t.test('invalid rows reject the whole file and name the row + column', async () => {
    const before = (await marksOf(s1.id)).length;
    const csv = [
      CSV_HEADER,
      `${roll1},${s1.name},10,A,Rejected Exam,14-09-2026,Mathematics,100,80`, // valid — must not be saved
      `${roll2},${s2.name},10,A,Rejected Exam,14-09-2026,Science,100,120`, // ObtainedMarks > MaxMarks
      'STU-9999-999,Nobody,10,A,Rejected Exam,14-09-2026,Science,100,50', // unknown roll number
      `${roll1},${s1.name},10,A,Rejected Exam,31-02-2026,Science,100,50`, // impossible calendar date
      `${roll2},${s2.name},10,A,Rejected Exam,14-09-2026,,100,50`, // missing Subject
      `${roll2},${s2.name},10,A,Rejected Exam,14-09-2026,Science,100,abc`, // non-numeric marks
    ].join('\r\n');
    const res = await upload(base, admin.accessToken, csv, 'bad.csv', 'text/csv');

    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'VALIDATION_ERROR');
    assert.equal(res.body.errors.row_2, undefined, 'the valid row reports no error');
    assert.match(res.body.errors.row_3.ObtainedMarks, /Cannot exceed MaxMarks/);
    assert.match(res.body.errors.row_4.RollNumber, /No student with this roll number/);
    assert.match(res.body.errors.row_5.ExamDate, /valid date/);
    assert.equal(res.body.errors.row_6.Subject, 'Required');
    assert.match(res.body.errors.row_7.ObtainedMarks, /whole number/);
    assert.match(res.body.errors.file, /Nothing was saved/);

    // atomic — the valid row in the same file was not written either
    const after = await marksOf(s1.id);
    assert.equal(after.length, before, 'no partial save from a rejected file');
    assert.equal(after.some((e) => e.examName === 'Rejected Exam'), false);
  });

  await t.test('wrong header, missing file, bad extension, empty body and >200 rows are rejected', async () => {
    const wrong = await upload(base, admin.accessToken, 'RollNumber,Subject\nx,Maths', 'wrong.csv', 'text/csv');
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.errors.file, /RollNumber, StudentName, Class, Section, ExamName, ExamDate, Subject, MaxMarks, ObtainedMarks/);

    const none = await fetch(`${base}/admin/marks/bulk`, { method: 'POST', headers: auth(admin.accessToken) });
    assert.equal(none.status, 400);

    const badExt = await upload(base, admin.accessToken, 'x', 'marks.txt', 'text/plain');
    assert.equal(badExt.status, 400);

    const headerOnly = await upload(base, admin.accessToken, CSV_HEADER, 'empty.csv', 'text/csv');
    assert.equal(headerOnly.status, 400);
    assert.match(headerOnly.body.errors.file, /no data rows/);

    const tooMany = [CSV_HEADER];
    for (let i = 0; i < 201; i += 1) {
      tooMany.push(`${roll1},${s1.name},10,A,Big Exam,14-09-2026,Subject ${i},100,50`);
    }
    const over = await upload(base, admin.accessToken, tooMany.join('\r\n'), 'big.csv', 'text/csv');
    assert.equal(over.status, 400);
    assert.match(over.body.errors.file, /Up to 200 rows/);
  });

  await t.test('duplicate student/exam/subject rows inside one file are rejected', async () => {
    const csv = [
      CSV_HEADER,
      `${roll1},${s1.name},10,A,Dup Exam,14-09-2026,Mathematics,100,70`,
      `${roll1},${s1.name},10,A,Dup Exam,14-09-2026,Mathematics,100,80`,
    ].join('\r\n');
    const res = await upload(base, admin.accessToken, csv, 'dup.csv', 'text/csv');
    assert.equal(res.status, 400);
    assert.match(res.body.errors.row_3.Subject, /Duplicate row/);
  });
await t.test('XLSX upload parses server-side (real date cells included)', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Marks');
    sheet.addRow(CSV_HEADER.split(','));
    sheet.addRow([roll1, s1.name, 10, 'A', 'Excel Exam', new Date(Date.UTC(2026, 8, 14)), 'Computer Science', 100, 91]);
    const buf = await book.xlsx.writeBuffer();
    const res = await upload(base, admin.accessToken, buf, 'marks.xlsx', XLSX_MIME);

    assert.equal(res.status, 201);
    assert.equal(res.body.data.saved, 1);
    const exam = (await marksOf(s1.id)).find((e) => e.examName === 'Excel Exam');
    assert.ok(exam, 'XLSX row saved');
    assert.equal(exam.date, '2026-09-14', 'Date cell parsed to the matching calendar day');
    assert.equal(exam.subjects[0].subject, 'Computer Science');
  });

  await t.test('downloaded template has both sheets, the exact header, and its own examples fail cleanly', async () => {
    const res = await fetch(`${base}/admin/marks/bulk-template`, { headers: auth(admin.accessToken) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /spreadsheetml\.sheet/);
    assert.match(res.headers.get('content-disposition'), /marks_bulk_upload_template\.xlsx/);

    const buf = Buffer.from(await res.arrayBuffer());
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buf);

    const marksSheet = book.worksheets.find((ws) => ws.name === 'Marks');
    const instructions = book.worksheets.find((ws) => ws.name === 'Instructions');
    assert.ok(marksSheet, 'template has a Marks sheet');
    assert.ok(instructions, 'template has an Instructions sheet');

    const header = [];
    marksSheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => { header[col - 1] = cell.text; });
    assert.deepEqual(header, CSV_HEADER.split(','));

    // The template's sample rows use placeholder roll numbers, so uploading the
    // template untouched is rejected row-by-row — never silently saved.
    const sameBuf = await book.xlsx.writeBuffer();
    const roundTrip = await upload(base, admin.accessToken, sameBuf, 'template.xlsx', XLSX_MIME);
    assert.equal(roundTrip.status, 400);
    assert.match(roundTrip.body.errors.row_2.RollNumber, /No student with this roll number/);
  });

  await t.test('manual single-student entry still works and feeds the same tables', async () => {
    const res = await request(base, '/admin/marks', {
      method: 'POST',
      token: admin.accessToken,
      body: {
        studentId: s1.id,
        examName: 'Manual Exam',
        date: '2026-09-15',
        subjects: [{ subject: 'Telugu', maxMarks: 50, obtained: 45 }], // free-text subject
      },
    });
    assert.equal(res.status, 201);

    const exam = (await marksOf(s1.id)).find((e) => e.examName === 'Manual Exam');
    assert.ok(exam, 'manually entered exam is readable');
    assert.equal(exam.subjects[0].subject, 'Telugu');
    assert.equal(exam.subjects[0].obtained, 45);
  });

  await t.test('class summary recomputes from the newly saved marks (nothing hardcoded)', async () => {
    const summary = (await request(base, '/admin/students/by-class', { token: admin.accessToken })).body.data;
    const classRow = summary.find((r) => r.key === '10-A');
    assert.ok(classRow, 'class 10-A summary present');

    // Independently recompute the same aggregates straight from the stored rows
    const percents = [];
    for (const s of tenA) {
      const exams = await marksOf(s.id);
      let obtained = 0;
      let max = 0;
      exams.forEach((ex) => ex.subjects.forEach((sub) => {
        obtained += Number(sub.obtained) || 0;
        max += Number(sub.maxMarks) || 0;
      }));
      if (max > 0) percents.push((obtained / max) * 100);
    }

    assert.equal(classRow.markedCount, percents.length);
    assert.equal(classRow.topScore, Math.round(Math.max(...percents)));
    assert.equal(
      classRow.avgMarks,
      Math.round(percents.reduce((a, b) => a + b, 0) / percents.length),
    );

    // and the totals grew because of this test's uploads
    assert.ok(classRow.markedCount >= 2, 'both uploaded students are counted');
  });

  await t.test('non-admin callers are rejected on upload and template', async () => {
    const student = await login(base, 'student', 'Student@123');
    const up = await fetch(`${base}/admin/marks/bulk`, { method: 'POST', headers: auth(student.accessToken) });
    assert.equal(up.status, 403);
    const tpl = await fetch(`${base}/admin/marks/bulk-template`, { headers: auth(student.accessToken) });
    assert.equal(tpl.status, 403);
  });

  await t.test('teardown — stop server', async () => {
    await stopServer(server);
  });
});