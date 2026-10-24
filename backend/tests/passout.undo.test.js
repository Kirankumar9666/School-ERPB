/**
 * Pass-out undo — the window closes only for attendance or marks written AFTER
 * the pass-out, not for the final year's pre-existing records.
 *
 * The fixture's top class already has seeded attendance and marks for the year.
 * That is exactly the case that used to refuse an immediate undo.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, stopServer, login, request } = require('./helpers');
const prisma = require('../src/services/prisma');

let server;
let base;
let token;
let top;
let year;
let roster;

before(async () => {
  ({ server, base } = await startServer());
  token = (await login(base, 'admin', 'Admin@123')).accessToken;

  const overview = (await request(base, '/admin/class-management/overview', { token })).body.data;
  year = overview.currentAcademicYear;
  top = overview.classes.find((c) => c.action === 'passed_out');
  assert.ok(top, 'the fixture must contain a graduating class');

  roster = (await request(base,
    `/admin/class-management/years/${year.id}/classes/${top.id}/roster`,
    { token })).body.data;
  assert.ok(roster.length >= 2, 'this test needs two graduates');
});

after(async () => { await stopServer(server); });

const passOut = () => request(base, `/admin/class-management/classes/${top.id}/pass-out`, {
  method: 'POST', token, body: {},
});
const undo = (studentId) => request(base, `/admin/class-management/students/${studentId}/undo`, {
  method: 'POST', token,
});
const panel = async () => (await request(base,
  `/admin/class-management/classes/${top.id}/students`, { token })).body.data.students;

test('a fresh pass-out can be undone even though the year already has attendance and marks', async () => {
  const out = await passOut();
  assert.equal(out.status, 200, JSON.stringify(out.body));

  const row = (await panel()).find((r) => r.studentId === roster[0].studentId);
  assert.equal(row.canUndo, true, 'the panel must offer undo for a fresh pass-out');

  const res = await undo(roster[0].studentId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.kind, 'undone_pass_out');

  const seat = await prisma.studentEnrollment.findUnique({
    where: { studentId_academicYearId: { studentId: roster[0].studentId, academicYearId: year.id } },
  });
  assert.equal(seat.status, 'active');
  assert.equal(seat.endedOn, null);
  assert.equal(seat.passedOutAt, null);
});

test('attendance written after the pass-out keeps the window closed', async () => {
  const id = roster[1].studentId; // still passed out from the first test
  const day = new Date().toISOString().slice(0, 10);
  const saved = await request(base, '/admin/attendance', {
    method: 'POST', token,
    body: { entityType: 'student', entityId: id, date: day, session: 'FN', status: 'present' },
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));

  const res = await undo(id);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'UNDO_WINDOW_CLOSED');
});

test('marks written after the pass-out keep the window closed', async () => {
  // The first test restored roster[0]; pass the class out again so that student
  // has a fresh pass-out to test against. roster[1] is already passed out.
  const again = await passOut();
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const id = roster[0].studentId;

  const exam = await prisma.exam.create({
    data: {
      id: `exam-post-passout-${crypto.randomUUID()}`,
      classId: top.id,
      academicYearId: year.id,
      name: 'Post-pass-out check',
      date: new Date(),
      source: 'live',
    },
  });
  await prisma.marksEntry.create({
    data: {
      studentId: id,
      examId: exam.id,
      subject: 'Post-pass-out check',
      maxMarks: 100,
      obtained: 50,
      enteredAt: new Date(),
      updatedAt: new Date(),
    },
  });

  const res = await undo(id);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'UNDO_WINDOW_CLOSED');
});

test('a legacy pass-out with no passedOutAt keeps the old conservative guard', async () => {
  const id = roster[1].studentId;
  await prisma.studentEnrollment.update({
    where: { studentId_academicYearId: { studentId: id, academicYearId: year.id } },
    data: { passedOutAt: null },
  });

  const res = await undo(id);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'UNDO_WINDOW_CLOSED');
});
