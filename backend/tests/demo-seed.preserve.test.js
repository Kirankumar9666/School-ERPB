/**
 * FIX 6 — the DEMO seed path must PRESERVE the school's final class.
 *
 * ## The two seeds, and why only one may reset the flag
 *
 * `seed()` (prisma/seed.js) is the DESTRUCTIVE fixture seed: it wipes every table
 * and rebuilds it. `seed({ wipe: false })` is the DEMO path (prisma/demo-seed.js),
 * documented as "adds fixtures WITHOUT deleting anything — a database that already
 * holds real data".
 *
 * Clearing `GradeLevel.isFinal` there would SILENTLY ERASE a real school's
 * configuration: an admin marks Class 10 final, someone runs the demo seed to add
 * sample rows, and the setting is gone with no record and no warning. So the reset
 * lives ONLY in the destructive wipe (`prisma/fixture-seed.wipe.js`), which the
 * demo path never reaches.
 *
 * ## What this file holds, and what it deliberately does not
 *
 * It holds the CONTRACT at the two places it is expressed:
 *
 *   1. the demo path does not call the wipe — `wipeAll` is the ONLY place the flag
 *      is cleared, and `seed({ wipe: false })` skips it;
 *   2. the only write the demo path makes to the level table is a `createMany`
 *      with `skipDuplicates`, which inserts missing rows and NEVER updates an
 *      existing one — so a flag already set survives by construction.
 *
 * It does NOT run the full demo seed against the fixture database: that path's
 * non-level inserts use plain `createMany` (no `skipDuplicates`), so re-running it
 * over the fixture ids collides on a unique constraint. That is a pre-existing
 * property of the demo seed against an already-fixture-populated database, not
 * something this change introduced, and not what Fix 6 is about.
 *
 * ## DO NOT RUN THIS AGAINST THE LIVE DATABASE
 *
 * `tests/helpers.js` loads `.env.test`, and `src/config/test-env.js` refuses any
 * URL that is not a test database. Never point this at live Supabase.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer } = require('./helpers');

let server;

before(async () => {
  ({ server } = await startServer());
});

after(async () => {
  await stopServer(server);
});

test('demo seed: the flag reset lives ONLY in the wipe, which the demo path skips', () => {
  const { wipeAll } = require('../prisma/fixture-seed.wipe');
  // The wipe is the destructive half and the only place a level is un-marked.
  assert.equal(typeof wipeAll, 'function', 'wipeAll is the destructive door');

  /* `seed({ wipe: false })` must NOT call it. Read the source rather than trusting
     the doc comment: the branch is `if (wipe) await wipeAll(prisma)` and `wipe`
     defaults true, so `wipe: false` is the one path that skips the reset. */
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'seed.js'), 'utf8');
  assert.match(src, /const wipe = opts\.wipe !== false/, 'wipe defaults to true');
  assert.match(src, /if \(wipe\) await wipeAll\(prisma\)/, 'the wipe runs only when wipe is true');
});

test('demo seed: the level insert never overwrites an existing row, so a flag survives', async () => {
  const prisma = require('../src/services/prisma');

  const level = await prisma.gradeLevel.findFirst({ orderBy: { order: 'asc' } });
  assert.ok(level, 'the seed must leave at least one level');

  // Mark it final the way the office would.
  await prisma.gradeLevel.updateMany({ data: { isFinal: false } });
  await prisma.gradeLevel.update({ where: { id: level.id }, data: { isFinal: true } });

  /* The demo path's level write, exactly as seed.js performs it: `createMany` with
     `skipDuplicates: true` over the SAME deterministic ids. A duplicate is skipped,
     never updated — so the flag on the existing row cannot be cleared by it. */
  const { readFileSync } = require('node:fs');
  const path = require('node:path');
  const seedSrc = readFileSync(path.join(__dirname, '..', 'prisma', 'seed.js'), 'utf8');
  assert.match(
    seedSrc,
    /gradeLevel\.createMany\(\{[\s\S]*?skipDuplicates: true/,
    'the level insert skips duplicates rather than updating existing rows',
  );

  await prisma.gradeLevel.createMany({
    data: [{ id: level.id, name: level.name, order: level.order }],
    skipDuplicates: true,
  });

  const stillFinal = await prisma.gradeLevel.findMany({ where: { isFinal: true } });
  assert.equal(stillFinal.length, 1, 'the skip-duplicate insert did not clear the final class');
  assert.equal(stillFinal[0].id, level.id, 'and it is the same level the office marked');

  // Clean up, so the next file starts from the fixture default.
  await prisma.gradeLevel.updateMany({ data: { isFinal: false } });
});
