/**
 * Duplicate cleanup — merge a school's duplicate students into one record each.
 *
 * ## A duplicate is a PERSON, not a seat
 *
 * The rule is the app's own: name + guardian name + guardian contact, normalised,
 * matching `identityOf` in services/enrollment.js. Roll number and class take no
 * part, because the same child appearing in two classes is the very thing being
 * cleaned up.
 *
 * ## Which record survives
 *
 * The student with the most linked records; if two are tied, the oldest. The loser
 * and its login, enrollments, fee rows, payments, attendance, marks and documents
 * are removed in ONE transaction — never one child's fee row left behind while the
 * rest went.
 *
 * ## Default is a dry run
 *
 * Nothing is deleted unless `--confirm` is passed. The script refuses to run
 * against the test database: cleaning the wrong database would be unfixable
 * without a restore.
 *
 *   node scripts/cleanup-duplicates.js            # dry run (the default)
 *   node scripts/cleanup-duplicates.js --confirm  # actually delete
 */
const prisma = require('../src/services/prisma');
const { identityOf } = require('../src/services/enrollment');
const { classLabel } = require('../src/services/mappers');

/* The URL this script will WRITE to — judged before anything is deleted. A script
   that mass-deletes must never be pointed at the test database by accident: the
   guard for that one is a plain refusal, because "test" is the one database where
   a cleanup is meaningless and a mistake here is expensive. */
if (process.env.TEST_DATABASE_URL) {
  console.error(`
  REFUSING TO RUN: TEST_DATABASE_URL is set, so this would clean the TEST
  database. This script is for the live database only.`);
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('REFUSING TO RUN: no DATABASE_URL is set.');
  process.exit(2);
}
if (/pooler\.supabase\.com/.test(process.env.DATABASE_URL)) {
  // The transaction-pooler multiplexes one connection per query, so a long
  // transaction is likely to time out; the DIRECT_URL is the session pooler.
  console.warn('Note: DATABASE_URL is a Supabase pooler — a long transaction may time out.');
}

const CONFIRM = process.argv.includes('--confirm');

/** A readable one-line summary of a linked-record count. */
const linkedSummary = (counts) => Object.entries(counts)
  .filter(([, n]) => n > 0)
  .map(([model, n]) => `${n} ${model}`)
  .join(', ') || 'no linked records';

/** One student, with the counts of everything hanging off them. */
const detailOf = async (student) => {
  const counts = {};
  for (const model of ['studentEnrollment', 'studentFee', 'studentAttendance', 'marksEntry', 'studentDocument', 'achievement']) {
    counts[model] = await prisma[model].count({ where: { studentId: student.id } });
  }
  // A payment hangs off a StudentFee row, not a Student, so it is counted through
  // the fee rows this student owns.
  const feeIds = await prisma.studentFee.findMany({
    where: { studentId: student.id }, select: { id: true },
  });
  counts.feePayment = await prisma.feePayment.count({
    where: { studentFeeId: { in: feeIds.map((f) => f.id) } },
  });
  // A login is reached through the userId relation, not a studentId column.
  const user = await prisma.user.findFirst({
    where: { student: { id: student.id } },
    select: { id: true, username: true },
  });
  const withLogin = { ...counts, user: user ? 1 : 0 };
  // Ties are broken by age (the id sorts the mock/seed fixtures in creation
  // order), then by the linked-record count — a richer record survives a tidy.
  const weight = Object.values(withLogin).reduce((a, b) => a + b, 0);
  return { student, user, counts: withLogin, weight };
};

const printSection = (title) => console.log(`\n${'─'.repeat(74)}\n${title}\n${'─'.repeat(74)}`);

(async () => {
  const students = await prisma.student.findMany({
    include: { class: true },
    orderBy: { id: 'asc' },
  });

  /* Group by the identity triple — the same rule the app enforces. */
  const groups = new Map();
  for (const s of students) {
    const { name, guardianName, contact } = identityOf(s);
    const key = JSON.stringify([name, guardianName, contact]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const duplicateGroups = [...groups.values()].filter((g) => g.length > 1);

  printSection(`DUPLICATE SCAN — ${duplicateGroups.length} group${duplicateGroups.length === 1 ? '' : 's'} among ${students.length} students`);
  /* An empty scan is a valid outcome, but it must not exit before the confirm
     path has had its say: there may still be orphaned logins to sweep. */
  const details = await Promise.all(
    duplicateGroups.map((group) => Promise.all(group.map(detailOf))),
  );

  /* Order each group: keeper first (most records, then the oldest), then the
     rest. "Oldest" is `createdAt`, with the id's embedded millisecond stamp as a
     fallback for a row where it is somehow missing — the tie is reported, because
     a reviewer should know the choice was a coin toss rather than a verdict. */
  const decisions = details.map((group) => {
    const age = (d) => (d.student.createdAt ? new Date(d.student.createdAt).getTime()
      : Number(/^stu-(\d+)/.exec(d.student.id)?.[1] ?? 0));
    const sorted = [...group].sort((a, b) => b.weight - a.weight || age(a) - age(b));
    return { keeper: sorted[0], removed: sorted.slice(1), tie: sorted[0].weight === sorted[1].weight };
  });

  const withPayments = [];
  const withAttendanceOrMarks = [];

  for (const [index, { keeper, removed, tie }] of decisions.entries()) {
    const k = keeper.student;
    console.log(`\n  ${index + 1}. ${k.name} — guardian ${k.parentName || '—'}, ${k.guardianContact || '—'}`);
    console.log(`     KEEP   ${k.id}  ${k.class ? classLabel(k.class) : 'no class'}  roll ${k.rollNumber ?? '—'}`);
    console.log(`            linked: ${linkedSummary(keeper.counts)}`);
    if (tie) {
      console.log('            (tied on record count — kept the older row)');
    }
    for (const r of removed) {
      console.log(`     DELETE ${r.student.id}  ${r.student.class ? classLabel(r.student.class) : 'no class'}  roll ${r.student.rollNumber ?? '—'}`);
      console.log(`            linked: ${linkedSummary(r.counts)}`);
      if (r.counts.feePayment > 0) {
        console.log(`            ** PAYMENTS: ${r.counts.feePayment} payment${r.counts.feePayment === 1 ? '' : 's'} recorded on this record — deleting the student discards that payment`);
        withPayments.push(r);
      }
      if (r.counts.marksEntry > 0 || r.counts.studentAttendance > 0) {
        console.log('            ** ATTENDANCE/MARKS recorded against this record');
        withAttendanceOrMarks.push(r);
      }
    }
  }

  printSection('SUMMARY');
  const totalRemoved = decisions.reduce((n, d) => n + d.removed.length, 0);
  const totalPayments = withPayments.reduce((n, r) => n + r.counts.feePayment, 0);
  const totalLogin = decisions.reduce((n, d) => n + d.removed.reduce((m, r) => m + r.counts.user, 0), 0);
  console.log(`  duplicate groups   : ${decisions.length}`);
  console.log(`  students kept      : ${decisions.length}`);
  console.log(`  students DELETED   : ${totalRemoved}`);
  console.log(`  logins DELETED     : ${totalLogin}`);
  console.log(`  payments lost       : ${totalPayments} ${totalPayments > 0 ? '(** rows carrying real money)' : '(none)'}`);
  console.log(`  attendance/marks rows lost: ${withAttendanceOrMarks.reduce((n, r) => n + r.counts.marksEntry + r.counts.studentAttendance, 0)}`);
  console.log(`  students after      : ${students.length - totalRemoved}`);

  /* A login left with no student is a real account that can still sign in against
     a student that no longer exists. The sweep runs on EVERY confirm, not only
     when duplicates were found: its job is to keep "every student login has a
     student" true, which covers a run interrupted between the two deletes as much
     as a clean one. Staff accounts (admin, teacher, accountant) legitimately have
     no student and are never touched, because the filter is on role too. */
  const sweepOrphanLogins = async () => {
    const orphans = await prisma.user.findMany({
      where: { student: null, role: 'student' },
      select: { id: true, username: true },
    });
    if (!orphans.length) return 0;
    await prisma.$transaction(
      orphans.map((u) => prisma.user.delete({ where: { id: u.id } })),
      { timeout: 60000, maxWait: 30000 },
    );
    console.log(`  Removed ${orphans.length} login${orphans.length === 1 ? '' : 's'} left with no student.`);
    return orphans.length;
  };

  const report = async () => {
    const after = {
      student: await prisma.student.count(),
      user: await prisma.user.count(),
      studentEnrollment: await prisma.studentEnrollment.count(),
      studentFee: await prisma.studentFee.count(),
      feePayment: await prisma.feePayment.count(),
    };
    printSection('FINAL COUNTS');
    Object.entries(after).forEach(([k, v]) => console.log(`  ${k.padEnd(20)} ${v}`));
    console.log(`  (students were ${students.length}, now ${after.student})`);
    console.log('\n  Verify with:  node scripts/counts.js compare');
  };

  if (!CONFIRM) {
    printSection('DRY RUN — nothing was deleted');
    console.log('  No rows were removed. Re-run with --confirm to apply.');
    await prisma.$disconnect();
    return;
  }

  if (duplicateGroups.length === 0) {
    printSection('NOTHING TO MERGE');
    console.log('  No duplicate groups, so no students were removed.');
    await sweepOrphanLogins();
    await report();
    await prisma.$disconnect();
    return;
  }

  printSection('DELETING');

  const ids = decisions.flatMap((d) => d.removed.map((r) => r.student.id));
  try {
    /* One transaction: a failure mid-way leaves every row exactly as it is now. */
    await prisma.$transaction(async (tx) => {
      for (const id of ids) {
        /* The rows that do NOT cascade in the schema. StudentEnrollment and
           StudentFee are declared onDelete: Cascade, but attendance, marks,
           documents and achievements are not — a student with any of those
           would block the delete entirely (P2003), which is why the app's own
           DELETE /students/:id refuses a student with dependent records. Child
           order, so nothing is ever left pointing at a student that is gone. */
        const feeIds = (await tx.studentFee.findMany({
          where: { studentId: id }, select: { id: true },
        })).map((f) => f.id);
        if (feeIds.length) {
          await tx.feePayment.deleteMany({ where: { studentFeeId: { in: feeIds } } });
          await tx.studentFee.deleteMany({ where: { studentId: id } });
        }
        await tx.marksEntry.deleteMany({ where: { studentId: id } });
        await tx.studentAttendance.deleteMany({ where: { studentId: id } });
        await tx.studentDocument.deleteMany({ where: { studentId: id } });
        await tx.achievement.deleteMany({ where: { studentId: id } });
        await tx.studentEnrollment.deleteMany({ where: { studentId: id } });

        /* The login is resolved BEFORE the student row goes. `User.student` is a
           back-relation whose FK lives on Student.userId, so once the student is
           deleted the lookup finds nothing — the account survives, orphaned, and
           still authenticates. Capturing the id first is what makes the login
           actually go; it mirrors DELETE /admin/students/:id, which looks the user
           up before deleting for exactly this reason. */
        const userId = (await tx.user.findFirst({
          where: { student: { id } }, select: { id: true },
        }))?.id;
        await tx.student.delete({ where: { id } });
        if (userId) await tx.user.delete({ where: { id: userId } });
      }
    }, { timeout: 120000, maxWait: 30000 });
    console.log(`  Removed ${ids.length} student${ids.length === 1 ? '' : 's'} and ${totalLogin} login${totalLogin === 1 ? '' : 's'}, in one transaction.`);
  } catch (err) {
    console.error(`  FAILED — nothing was deleted. ${err.message.split('\n')[0]}`);
    await prisma.$disconnect();
    process.exit(1);
  }

  await sweepOrphanLogins();
  await report();

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
