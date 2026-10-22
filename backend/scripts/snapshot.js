/**
 * Snapshot / restore the live database as JSON.
 *
 * ## Why this exists
 *
 * `backend/prisma/seed.js` starts by calling `deleteMany()` on every table, and
 * `backend/tests/helpers.js` calls `seed()` before every test file. Running the
 * test suite therefore WIPES the database — the cause of the disappearing
 * students. That is fine for a dev database that holds nothing but fixtures, and
 * catastrophic for one that holds real admissions.
 *
 * So: snapshot before you test, restore if you need to. Both are plain
 * JSON, checked in nowhere, gitignored, and safe to delete.
 *
 *   node scripts/snapshot.js            → writes prisma/snapshots/<stamp>.json
 *   node scripts/snapshot.js list
 *   node scripts/snapshot.js restore <file|stamp>
 *
 * Nothing here is run automatically — this is a deliberate, manual act, because
 * an automatic snapshot before a wipe would hide the fact that a wipe is about
 * to happen.
 */
const fs = require('node:fs');
const path = require('node:path');
const { assertSafeToWipe } = require('../src/config/test-env');
const prisma = require('../src/services/prisma');

const DIR = path.join(__dirname, '..', 'prisma', 'snapshots');

/**
 * Every model in the schema, in safe restore order (parents before children).
 * Restore does not rely on this being complete — it makes several passes so a
 * table whose parent has not been inserted yet is simply retried in the next one
 * — but starting in the right order avoids almost all of the retries.
 */
const MODELS = [
  'setting', 'user', 'academicYear', 'employee', 'class',
  'student', 'studentEnrollment', 'studentFee', 'feePayment',
  'exam', 'marksEntry', 'studentAttendance', 'employeeAttendance',
  'attendanceConfirmation', 'teachingAssignment', 'leaveRequest', 'leaveBalance',
  'payrollRecord', 'payrollPayment', 'employeeDocument', 'studentDocument',
  'achievement', 'syllabusEntry', 'timetablePeriod', 'reminder', 'announcement',
  'holiday', 'employmentEnd', 'auditEntry',
];

const serialise = (rows) => rows.map((row) => {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? v.toISOString()
      : (typeof v === 'bigint' ? Number(v) : (Buffer.isBuffer(v) ? { __buffer: [...v] } : v));
  }
  return out;
});

/** Undo `serialise`: ISO strings → Date, buffers → bytes, numbers stay. */
const revive = (value) => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value;
  // Three shapes a binary column can arrive in, depending on which Prisma type
  // returned it and who serialised it: our own marker, Node's Buffer marker, and
  // the plain numeric-keyed object that JSON.stringify makes of a Uint8Array.
  if (Array.isArray(value.__buffer)) return Uint8Array.from(value.__buffer);
  if (value.type === 'Buffer' && Array.isArray(value.data)) return Uint8Array.from(value.data);
  const keys = Object.keys(value);
  if (keys.length && keys.every((k) => /^\d+$/.test(k))) return Uint8Array.from(Object.values(value));
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)) return new Date(value);
  return value;
};

const reviveRow = (row) => {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = revive(v);
  return out;
};

const snapshot = async () => {
  const data = {};
  const counts = {};
  for (const model of MODELS) {
    const rows = await prisma[model].findMany();
    data[model] = serialise(rows);
    counts[model] = rows.length;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), counts, data }, null, 2));

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`Snapshot written: ${path.relative(process.cwd(), file)}`);
  console.log(`${total} rows across ${MODELS.length} tables`);
  for (const [m, n] of Object.entries(counts)) if (n) console.log(`   ${m.padEnd(24)} ${n}`);
  return file;
};

const restore = async (target) => {
  /* restore() deletes every table before re-inserting the snapshot, so it is
     held to the same rule as the fixture seed: a test database or nothing. */
  assertSafeToWipe(
    process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
    'scripts/snapshot.js restore',
  );
  const name = target.endsWith('.json') ? target : `${target}.json`;
  const file = path.isAbsolute(name) ? name : path.join(DIR, name);
  if (!fs.existsSync(file)) throw new Error(`No snapshot at ${file}`);
  const { takenAt, data } = JSON.parse(fs.readFileSync(file, 'utf8'));

  console.log(`Restoring the snapshot taken ${takenAt} (${file})`);
  const missing = MODELS.filter((m) => !data[m]);
  if (missing.length) console.log(`   (no rows recorded for: ${missing.join(', ')})`);

  /* Wipe in reverse so children go before parents, then re-insert in order. */
  for (const model of [...MODELS].reverse()) await prisma[model].deleteMany();

  /* Insert in passes. A table can name a row of a table that appears later in the
     list (an employee who is a class teacher, say), and re-deriving the whole
     dependency graph here would be more code than the retries. Each pass inserts
     whatever it can and leaves the rest for the next one; a pass that makes no
     progress at all is a genuine failure and is reported with the constraint that
     blocked it, rather than looped through silently. */
  let remaining = MODELS.filter((m) => data[m]?.length);
  let pass = 0;
  while (remaining.length && pass < MODELS.length) {
    pass += 1;
    const failures = [];
    const next = [];
    for (const model of remaining) {
      try {
        await prisma[model].createMany({
          data: data[model].map(reviveRow),
          skipDuplicates: true,
        });
        console.log(`   ${model.padEnd(24)} ${data[model].length} rows`);
      } catch (err) {
        if (err?.code !== 'P2003') throw err;
        next.push(model);
        failures.push(`${model} (${err.meta?.constraint || 'unknown constraint'})`);
      }
    }
    if (next.length === remaining.length) {
      throw new Error(`Could not restore — unresolvable dependencies: ${failures.join(', ')}`);
    }
    remaining = next;
  }
  if (remaining.length) throw new Error(`Could not restore: ${remaining.join(', ')}`);
  console.log('Restore complete.');
};

const list = () => {
  if (!fs.existsSync(DIR)) { console.log('No snapshots yet — run: node scripts/snapshot.js'); return; }
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort().reverse();
  console.log(`${files.length} snapshot(s) in ${path.relative(process.cwd(), DIR)}`);
  files.forEach((f) => {
    const { takenAt, counts } = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    console.log(`   ${f}  (taken ${takenAt}, ${counts.student ?? 0} students)`);
  });
};

(async () => {
  const [cmd = 'snapshot', arg] = process.argv.slice(2);
  if (cmd === 'snapshot') await snapshot();
  else if (cmd === 'list') list();
  else if (cmd === 'restore') await restore(arg);
  else console.error('Usage: node scripts/snapshot.js [snapshot|list|restore <file|stamp>]');
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
