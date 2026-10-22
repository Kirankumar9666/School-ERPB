/* read-only: did the migration link every class, and leave every row alone? */
const prisma = require('../src/services/prisma');

(async () => {
  const levels = await prisma.gradeLevel.findMany({ orderBy: { order: 'asc' } });
  console.log(`grade levels: ${levels.length}`);
  console.log(levels.map((l) => `${l.name}(${l.order})`).join('  '));

  const classes = await prisma.class.findMany({
    orderBy: [{ grade: 'asc' }, { section: 'asc' }],
    include: { level: true, _count: { select: { students: true } } },
  });
  console.log(`\nclasses: ${classes.length}`);
  classes.forEach((c) => console.log(
    `   ${c.id.padEnd(14)} grade=${String(c.grade).padEnd(4)} level=${String(c.level ? c.level.name : 'NULL').padEnd(8)} students=${c._count.students}`,
  ));

  const orphans = classes.filter((c) => !c.level);
  const mismatched = classes.filter((c) => c.level && c.grade !== c.level.order);
  console.log(`\nclasses with no level: ${orphans.length}`);
  console.log(`classes whose grade disagrees with its level order: ${mismatched.length}`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
