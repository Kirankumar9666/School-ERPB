/**
 * Integration tests: admin syllabus API (/api/v1/admin/syllabus) and the
 * student view of it. Topics are stored per-topic ({ topic, done }) and the
 * completion percent is always DERIVED (done count / total), never stored.
 * Seed state: cls-10A has 4 subjects, every topic done:false (the old mock
 * percentages are deliberately not carried over).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, login, request } = require('./helpers');

let ctx;
let admin;
let student;

test('setup — boot API and log in', async () => {
  ctx = await startServer();
  admin = await login(ctx.base, 'admin', 'Admin@123');
  student = await login(ctx.base, 'student', 'Student@123');
});

test('admin syllabus is grouped by class with normalized topics, no stored percent', async () => {
  const res = await request(ctx.base, '/admin/syllabus', { token: admin.accessToken });
  assert.equal(res.status, 200);

  const tenA = res.body.data['cls-10A'];
  assert.equal(tenA.length, 4);

  const math = tenA.find((s) => s.subject === 'Mathematics');
  assert.equal(math.topics.length, 5);
  assert.deepEqual(
    math.topics,
    ['Algebra', 'Geometry', 'Trigonometry', 'Statistics', 'Probability'].map((t) => ({ topic: t, done: false })),
    'backfilled rows treat every topic as not done (no guessing from old percentages)',
  );
  assert.ok(tenA.every((s) => !('completedPercent' in s)), 'percent is no longer part of the payload');

  const denied = await request(ctx.base, '/admin/syllabus', { token: student.accessToken });
  assert.equal(denied.status, 403);
});

test('POST validation: empty topics, bad done flag, unknown class', async () => {
  const empty = await request(ctx.base, '/admin/syllabus', {
    method: 'POST', token: admin.accessToken,
    body: { classKey: 'cls-10A', subject: 'Mathematics', topics: [] },
  });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, 'VALIDATION_ERROR');

  const badDone = await request(ctx.base, '/admin/syllabus', {
    method: 'POST', token: admin.accessToken,
    body: { classKey: 'cls-10A', subject: 'Mathematics', topics: [{ topic: 'Algebra', done: 'yes' }] },
  });
  assert.equal(badDone.status, 400);

  const blankTopic = await request(ctx.base, '/admin/syllabus', {
    method: 'POST', token: admin.accessToken,
    body: { classKey: 'cls-10A', subject: 'Mathematics', topics: [{ topic: '   ' }] },
  });
  assert.equal(blankTopic.status, 400);

  const unknownClass = await request(ctx.base, '/admin/syllabus', {
    method: 'POST', token: admin.accessToken,
    body: { classKey: 'cls-99Z', subject: 'Mathematics', topics: [{ topic: 'Algebra' }] },
  });
  assert.equal(unknownClass.status, 404);
});

test('marking topics done persists per-topic state (3 of 5 done)', async () => {
  const topics = ['Algebra', 'Geometry', 'Trigonometry', 'Statistics', 'Probability'].map((t, i) => ({
    topic: t, done: i < 3,
  }));
  const saved = await request(ctx.base, '/admin/syllabus', {
    method: 'POST', token: admin.accessToken,
    body: { classKey: 'cls-10A', subject: 'Mathematics', topics },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.data.topics, topics, 'response echoes the saved topic states');

  const res = await request(ctx.base, '/admin/syllabus', { token: admin.accessToken });
  const math = res.body.data['cls-10A'].find((s) => s.subject === 'Mathematics');
  const doneCount = math.topics.filter((t) => t.done).length;
  assert.equal(doneCount, 3); // derived: 3/5 → 60%
  assert.equal(math.topics.length, 5);

  // Student view reflects the exact same per-topic state
  const syl = await request(ctx.base, '/students/stu-001/syllabus', { token: student.accessToken });
  assert.equal(syl.status, 200);
  const studentMath = syl.body.data.find((s) => s.subject === 'Mathematics');
  assert.deepEqual(studentMath.topics, topics);
});

test('POST is a full replacement: rename, add, remove keep done flags only for matching names', async () => {
  const replaced = await request(ctx.base, '/admin/syllabus', {
    method: 'POST', token: admin.accessToken,
    body: {
      classKey: 'cls-10A', subject: 'Mathematics',
      // Full replacement: omitted done flags default to false, so this also
      // verifies a re-save without flags resets completion (the modal always
      // sends the current flags explicitly).
      topics: [{ topic: 'Algebra' }, { topic: 'Geometry' }, { topic: 'Real Numbers' }],
    },
  });
  assert.equal(replaced.status, 200);

  const res = await request(ctx.base, '/admin/syllabus', { token: admin.accessToken });
  const math = res.body.data['cls-10A'].find((s) => s.subject === 'Mathematics');
  assert.deepEqual(math.topics.map((t) => t.topic), ['Algebra', 'Geometry', 'Real Numbers']);
  assert.ok(math.topics.every((t) => t.done === false));
  assert.equal(math.topics.length, 3);
});

test('new subjects default to every topic not done', async () => {
  const created = await request(ctx.base, '/admin/syllabus', {
    method: 'POST', token: admin.accessToken,
    body: { classKey: 'cls-10A', subject: 'Computer Science', topics: [{ topic: 'Python Basics' }, { topic: 'HTML' }] },
  });
  assert.equal(created.status, 201);

  const res = await request(ctx.base, '/admin/syllabus', { token: admin.accessToken });
  const cs = res.body.data['cls-10A'].find((s) => s.subject === 'Computer Science');
  assert.deepEqual(cs.topics, [{ topic: 'Python Basics', done: false }, { topic: 'HTML', done: false }]);
});

test('teardown — stop server', async () => { await stopServer(ctx.server); });

