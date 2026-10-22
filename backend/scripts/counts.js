/* Pre/post-migration invariant check — read-only.
 * Usage: node scripts/counts.js            (prints, writes counts.json)
 *        node scripts/counts.js compare   (compares current DB to counts.json)
 */
const fs = require('node:fs');
const path = require('node:path');
const prisma = require('../src/services/prisma');

const MODELS = [
  'student', 'class', 'academicYear', 'studentEnrollment', 'studentFee',
  'feePayment', 'studentAttendance', 'marksEntry', 'exam', 'achievement',
  'studentDocument', 'syllabusEntry', 'timetablePeriod', 'teachingAssignment',
  'employee', 'user', 'holiday', 'announcement',
];

(async () => {
  const counts = {};
  for (const m of MODELS) counts[m] = await prisma[m].count();

  // Student fee figures: the per-year ledger must survive untouched.
  const feeAgg = await prisma.studentFee.aggregate({ _sum: { total: true } });
  const payAgg = await prisma.feePayment.aggregate({ _sum: { amount: true } });
  const studentAgg = await prisma.student.aggregate({ _sum: { feeTotal: true, feeDues: true } });
  const money = {
    studentFeeTotalSum: feeAgg._sum.total ?? 0,
    feePaymentAmountSum: payAgg._sum.amount ?? 0,
    studentFeeTotalCache: studentAgg._sum.feeTotal ?? 0,
    studentFeeDuesCache: studentAgg._sum.feeDues ?? 0,
  };

  const file = path.join(__dirname, '..', 'prisma', 'snapshots', 'counts.json');

  if (process.argv[2] === 'compare') {
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    const diffs = [];
    for (const m of MODELS) {
      if (before.counts[m] !== counts[m]) diffs.push(`${m}: ${before.counts[m]} → ${counts[m]}`);
    }
    for (const k of Object.keys(money)) {
      if (before.money[k] !== money[k]) diffs.push(`${k}: ${before.money[k]} → ${money[k]}`);
    }
    if (diffs.length) {
      console.log('DIFFERENCES FOUND:');
      diffs.forEach((d) => console.log(`   ${d}`));
      process.exitCode = 1;
    } else {
      console.log('Every count and money figure matches the recorded baseline.');
      console.log(`   students ${counts.student}, classes ${counts.class}, fee rows ${counts.studentFee}, payments ${counts.feePayment}`);
      console.log(`   fee total sum ${money.studentFeeTotalSum}, payments sum ${money.feePaymentAmountSum}`);
    }
    await prisma.$disconnect();
    return;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    takenAt: new Date().toISOString(), counts, money,
  }, null, 2));
  console.log(`Baseline written to ${path.relative(process.cwd(), file)}`);
  for (const [m, n] of Object.entries(counts)) if (n) console.log(`   ${m.padEnd(22)} ${n}`);
  console.log(`   fee total sum         ${money.studentFeeTotalSum}`);
  console.log(`   payments sum          ${money.feePaymentAmountSum}`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
