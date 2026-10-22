/**
 * Fees — the per-year ledger, the individual promotion's carry-forward, and the
 * undo that reverses it.
 *
 * Written against the HTTP API for the same reason the class-management suite is:
 * the failures that matter (a route reading the current class instead of the
 * year's, a promotion that forgets the old balance, an undo that leaves a fee row
 * behind) only exist at that boundary.
 *
 * All figures are read from the seed rather than hardcoded where possible; the
 * three students the fixture provides are the only fixed points, and they are
 * pinned by id because the seed defines them.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

let server;
let base;
let token;

before(async () => {
  ({ server, base } = await startServer());
  token = (await login(base, 'admin', 'Admin@123')).accessToken;
});

after(async () => {
  await stopServer(server);
});

/** One student's fee summary, asserting the read succeeded. */
const summaryOf = async (studentId) => {
  const res = await request(base, `/fees/students/${studentId}`, { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.summary;
};

const duesList = async (query = '') => {
  const res = await request(base, `/fees/dues${query}`, { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};

test('a student’s fee is read per year: total, paid and balance', async () => {
  const s = await summaryOf('stu-001');
  assert.equal(s.current.total, 45000);
  assert.equal(s.current.paid, 40000);
  assert.equal(s.current.balance, 5000);
  assert.equal(s.current.isSet, true);
  assert.equal(s.previousDues, 0);
  assert.equal(s.totalDue, 5000);
});

test('the dues list separates students who owe from students with no fee set', async () => {
  const dues = await duesList('?filter=dues');
  const owing = dues.students.map((r) => r.studentId);
  assert.ok(owing.includes('stu-001'), 'stu-001 owes the current year');
  assert.ok(owing.includes('stu-003'), 'stu-003 owes the current year');
  assert.ok(!owing.includes('stu-002'), 'stu-002 has paid in full');

  const notSet = await duesList('?filter=not_set');
  assert.equal(notSet.students.length, 0, 'every seeded student has an amount entered');
});

test('setting and clearing the fee distinguishes “not set” from zero', async () => {
  const set = await request(base, '/fees/students/stu-002/amount', {
    method: 'PUT', token, body: { amount: 60000 },
  });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  let s = await summaryOf('stu-002');
  assert.equal(s.current.total, 60000);
  assert.equal(s.current.balance, 15000, 'the opening payment is preserved');

  const clear = await request(base, '/fees/students/stu-002/amount', {
    method: 'PUT', token, body: { amount: null },
  });
  assert.equal(clear.status, 200, JSON.stringify(clear.body));
  s = await summaryOf('stu-002');
  assert.equal(s.current.isSet, false);
  assert.equal(s.current.total, null);

  const notSet = await duesList('?filter=not_set');
  assert.ok(
    notSet.students.some((r) => r.studentId === 'stu-002'),
    'a cleared fee shows under the “fee not set” filter',
  );

  // Restore, so later reads are not surprised by a cleared fee.
  await request(base, '/fees/students/stu-002/amount', {
    method: 'PUT', token, body: { amount: 45000 },
  });
});

test('a payment settles the outstanding and cannot exceed it', async () => {
  const pay = await request(base, '/fees/students/stu-001/payments', {
    method: 'POST', token, body: { amount: 5000 },
  });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  let s = await summaryOf('stu-001');
  assert.equal(s.totalDue, 0);

  const over = await request(base, '/fees/students/stu-001/payments', {
    method: 'POST', token, body: { amount: 1 },
  });
  assert.equal(over.status, 409, 'nothing outstanding — the ledger has no credit balance');
  assert.equal(over.body.code, 'NO_DUES');
});

test('promoting one student carries the unpaid balance forward as previous dues', async () => {
  const move = await request(base, '/admin/class-management/students/stu-003/move', {
    method: 'POST', token, body: { action: 'promote' },
  });
  assert.equal(move.status, 200, JSON.stringify(move.body));

  const s = await summaryOf('stu-003');
  assert.equal(s.current.isSet, false, 'the new year starts blank');
  assert.equal(s.current.total, null, 'blank is NULL, not zero');
  assert.equal(s.previousDues, 10000, 'the old balance becomes previous dues');
  assert.equal(s.previous[0].classLabel, 'Class 9B');
  assert.equal(s.totalDue, 10000, 'the total is unchanged by the move');

  const roster = await request(base, '/admin/class-management/classes/cls-9B/students', { token });
  assert.equal(roster.status, 200, JSON.stringify(roster.body));
  const row = roster.body.data.students.find((r) => r.studentId === 'stu-003');
  assert.equal(row.handled, true);
  assert.match(row.stateLabel, /Promoted to/);
  assert.equal(row.canUndo, true, 'nothing recorded in the new year yet');

  const again = await request(base, '/admin/class-management/students/stu-003/move', {
    method: 'POST', token, body: { action: 'promote' },
  });
  assert.equal(again.status, 409, 'nobody is promoted twice in one cycle');
  assert.equal(again.body.code, 'ALREADY_HANDLED');
});

test('undo restores the old fee year and discards the untouched new one', async () => {
  const undo = await request(base, '/admin/class-management/students/stu-003/undo', {
    method: 'POST', token,
  });
  assert.equal(undo.status, 200, JSON.stringify(undo.body));

  const s = await summaryOf('stu-003');
  assert.equal(s.previousDues, 0, 'the carried-forward year is gone');
  assert.equal(s.current.total, 40000, 'the original year is back in charge');
  assert.equal(s.current.balance, 10000, 'and it is untouched');
});

test('“keep in the same class” opens a fresh fee year in the same class', async () => {
  const keep = await request(base, '/admin/class-management/students/stu-002/move', {
    method: 'POST', token, body: { action: 'keep' },
  });
  assert.equal(keep.status, 200, JSON.stringify(keep.body));
  assert.equal(keep.body.data.kind, 'kept');

  const s = await summaryOf('stu-002');
  assert.equal(s.current.isSet, false, 'the repeated year starts blank');
  assert.equal(s.current.classLabel, 'Class 10A', 'the seat is in the same class');
  assert.equal(s.totalDue, 0, 'a fully-paid family carries nothing forward');
});

test('the undo window closes once money is recorded for the new year', async () => {
  const set = await request(base, '/fees/students/stu-002/amount', {
    method: 'PUT', token, body: { amount: 20000 },
  });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const pay = await request(base, '/fees/students/stu-002/payments', {
    method: 'POST', token, body: { amount: 1000 },
  });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));

  const undo = await request(base, '/admin/class-management/students/stu-002/undo', {
    method: 'POST', token,
  });
  assert.equal(undo.status, 409, 'a real payment must never be erased by an undo');
  assert.equal(undo.body.code, 'UNDO_WINDOW_CLOSED');
});

test('the whole-class promotion resets fees through the same carry-forward', async () => {
  const promote = await request(base, '/admin/class-management/classes/cls-9B/promote', {
    method: 'POST', token, body: { confirm: ['stu-003'] },
  });
  assert.equal(promote.status, 200, JSON.stringify(promote.body));

  const s = await summaryOf('stu-003');
  assert.equal(s.current.isSet, false, 'the new year is blank for a whole-class move too');
  assert.equal(s.previousDues, 10000);
});
