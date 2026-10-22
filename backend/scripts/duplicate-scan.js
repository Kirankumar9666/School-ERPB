/**
 * Duplicate scan — read a live database with the app's OWN duplicate rule.
 *
 *   node scripts/duplicate-scan.js           # report only
 *   node scripts/duplicate-scan.js --json    # machine-readable
 *
 * Read-only by design. This script never deletes, merges or rewrites anything:
 * finding the duplicates already in a school's data is the admin's decision, not
 * a script's. It exists so the office can see what the identity rule would
 * refuse BEFORE deciding to add any database-level uniqueness.
 *
 * The normalisation is imported from services/enrollment.js rather than
 * reimplemented — a scan that used a slightly different fold would report
 * duplicates the app will not actually refuse, which is worse than no scan.
 */
const prisma = require('../src/services/prisma');
const { identityOf } = require('../src/services/enrollment');
const { classLabel } = require('../src/services/mappers');

(async () => {
  const students = await prisma.student.findMany({
    select: {
      id: true,
      name: true,
      parentName: true,
      guardianContact: true,
      rollNumber: true,
      class: { select: { grade: true, section: true } },
    },
    orderBy: { name: 'asc' },
  });

  const keyOf = (s) => JSON.stringify([
    identityOf(s).name,
    identityOf(s).guardianName,
    identityOf(s).contact,
  ]);

  const groups = new Map();
  for (const s of students) {
    const key = keyOf(s);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const duplicates = [...groups.values()].filter((g) => g.length > 1);

  /* The seats side: one child in more than one class at once is the specific
     mistake the rule now catches that "class + roll number" could not. */
  const seats = new Map();
  for (const s of students) {
    if (!s.class) continue;
    const key = keyOf(s);
    if (!seats.has(key)) seats.set(key, new Set());
    seats.get(key).add(String(classLabel(s.class)));
  }
  const inSeveralClasses = [...seats.entries()].filter(([, set]) => set.size > 1);

  const incomplete = students.filter((s) => {
    const { name, guardianName, contact } = identityOf(s);
    return !name || !guardianName || !contact;
  });

  const report = {
    studentsScanned: students.length,
    duplicateGroups: duplicates.length,
    studentsInvolved: duplicates.reduce((n, g) => n + g.length, 0),
    childrenInMoreThanOneClass: inSeveralClasses.length,
    rowsMissingAnIdentityField: incomplete.length,
    duplicates: duplicates.map((g) => g.map((s) => ({
      id: s.id,
      name: s.name,
      guardian: s.parentName,
      contact: s.guardianContact,
      class: s.class ? String(classLabel(s.class)) : null,
      rollNumber: s.rollNumber,
    }))),
  };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    await prisma.$disconnect();
    return;
  }

  console.log(`Scanned ${report.studentsScanned} student${report.studentsScanned === 1 ? '' : 's'}.`);
  console.log('');
  console.log(`Duplicate groups: ${report.duplicateGroups} (${report.studentsInvolved} rows involved)`);
  duplicates.forEach((g, i) => {
    const first = g[0];
    console.log(`\n  ${i + 1}. ${first.name} / ${first.parentName || '(no guardian)'} / ${first.guardianContact || '(no contact)'}`);
    for (const s of g) {
      const cls = s.class ? String(classLabel(s.class)) : 'no class';
      console.log(`       ${s.id}   ${cls.padEnd(12)} roll ${s.rollNumber ?? '—'}`);
    }
  });

  console.log(`\nSame child in more than one class: ${report.childrenInMoreThanOneClass}`);
  console.log(`Rows missing a name, guardian or contact (never matchable): ${report.rowsMissingAnIdentityField}`);

  console.log('\nNothing has been deleted or merged. Resolve these in Student Management.');
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
