#!/usr/bin/env node
/** QA DEBUG — print classes + enrollments per class. Read-only. */
const { PrismaClient } = require('@prisma/client');
const { assertSafeToWipe } = require('../src/config/test-env');
const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
assertSafeToWipe(url, 'scripts/qa-inspect-classes.js (read-only)');
const prisma = new PrismaClient({ datasources: { db: { url } } });

async function main() {
  const classes = await prisma.class.findMany({
    orderBy: { grade: 'asc' },
    include: { level: true, _count: { select: { students: true, enrollments: true } } },
  });
  for (const c of classes) {
    console.log(`${c.label || c.id} | id=${c.id} grade=${c.grade} section=${c.section} level=${c.level?.name} students=${c._count.students} enrollments=${c._count.enrollments}`);
  }
  console.log('--- enrollments by class/year ---');
  const enr = await prisma.studentEnrollment.groupBy({ by: ['classId', 'academicYearId'], _count: { _all: true } });
  for (const e of enr) console.log(`${e.classId} ${e.academicYearId} -> ${e._count._all}`);
  console.log('--- students total ---', await prisma.student.count());
  console.log('--- students by classId ---');
  const byClass = await prisma.student.groupBy({ by: ['classId'], _count: { _all: true } });
  for (const b of byClass) console.log(`${b.classId} -> ${b._count._all}`);
}
main().catch(e=>{console.error(e);process.exit(1)}).finally(()=>prisma.$disconnect());
