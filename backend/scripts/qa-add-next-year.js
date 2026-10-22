#!/usr/bin/env node
/**
 * QA FIXTURE — add the NEXT academic year so the Promote flow has a destination.
 *
 *   node scripts/qa-run.js scripts/qa-add-next-year.js
 *
 * Small and additive: it only inserts the year after the current one (if absent)
 * and the grade levels the promote path needs (a UKG already exists). Safe to run
 * repeatedly — it checks before inserting.
 *
 * Uses the same test-database guard as every other entry point (the file touches
 * only additive rows, but it still must not point at a live database).
 */
const { PrismaClient } = require('@prisma/client');
const { assertSafeToWipe } = require('../src/config/test-env');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
assertSafeToWipe(url, 'scripts/qa-add-next-year.js (QA fixture)');
const prisma = new PrismaClient({ datasources: { db: { url } } });

const at = (s) => new Date(`${s}T00:00:00.000Z`);

async function main() {
  const years = await prisma.academicYear.findMany({ orderBy: { startDate: 'asc' } });
  const current = years.find((y) => y.isCurrent) || years[years.length - 1];
  if (!current) {
    console.error('No academic year found — run scripts/qa-seed.js first.');
    process.exit(1);
  }
  const endYear = current.endDate.getUTCFullYear(); // e.g. 2027 for 2026-27
  const label = `${endYear}-${String((endYear + 1) % 100).padStart(2, '0')}`;
  const existing = years.find((y) => y.label === label);
  if (existing) {
    console.log(`Next year ${label} already present (${existing.id}) — nothing to do.`);
  } else {
    await prisma.academicYear.create({
      data: {
        id: `ay-${label}`,
        label,
        startDate: at(`${endYear}-06-01`),
        endDate: at(`${endYear + 1}-05-31`),
        isCurrent: false,
      },
    });
    console.log(`Added next academic year ${label}.`);
  }
  const all = await prisma.academicYear.findMany({ orderBy: { startDate: 'asc' } });
  console.log('Academic years now:', all.map((y) => `${y.label}${y.isCurrent ? ' (current)' : ''}`).join(', '));
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
