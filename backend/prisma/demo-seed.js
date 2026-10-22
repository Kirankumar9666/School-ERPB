/**
 * DEMO seed — adds the fixture data WITHOUT deleting anything.
 *
 * Runs `seed()` from ./seed.js with `wipe: false`. Every id it writes is
 * deterministic (`usr-001`, `stu-001`, `cls-10A`, …), so a second run must not
 * duplicate rows — which is what the idempotency pass before the build is for.
 * Running it on a database that already holds real data ADDS the fixtures
 * alongside it.
 *
 * This is the seed for a developer's machine, a staging box or a demo instance:
 * anywhere the data matters and a wipe would be a disaster. `npx prisma db seed`
 * is wired to this, so the command a developer is most likely to type is the safe
 * one.
 *
 *   npm run seed:demo                  # add fixtures, keep everything
 *   DATABASE_URL=... npm run seed:demo # choose the database
 *
 * REFUSES TO RUN IN PRODUCTION (NODE_ENV=production), with no override. The
 * fixtures include accounts with well-known passwords (`admin` / `Admin@123` and
 * the other demo logins), and seeding them into a production database would hand
 * out working admin credentials that anyone could guess. There is deliberately no
 * escape hatch: a real production database is populated by the operator through
 * `npm run create-admin`, the app's own admin screens and (for real records) the
 * live flows — never by a demo seeder.
 *
 * For the fixture seed that wipes and rebuilds — only ever against the test
 * database — see ./seed.js, which `npm test` uses.
 *
 * @module prisma/demo-seed
 */
/**
 * The known demo passwords the fixtures ship — named in the refusal so an
 * operator who forced this file into a production path can see exactly what it
 * would have created. Read from the one mock store, never re-typed here.
 */
const { MOCK_USERS } = require('../src/mock/users');
const demoUsernames = MOCK_USERS.map((u) => u.username).join(', ');

/** Thrown when the demo seed is aimed at production; carries a stable code. */
class DemoSeedInProductionError extends Error {
  constructor() {
    super(
      [
        '',
        '  REFUSING TO DEMO-SEED: NODE_ENV=production.',
        '',
        '      This seed inserts demo accounts with well-known passwords',
        `      (${demoUsernames}) that anyone could log in with. It is for a`,
        '      developer machine, a staging box or a demo instance — never a',
        '      production database.',
        '',
        '      There is no override. Create the real first admin with',
        '      `npm run create-admin`, then use the app\'s own admin screens.',
        '',
        '      Nothing has been written.',
        '',
      ].join('\n'),
    );
    this.name = 'DemoSeedInProductionError';
    this.code = 'DEMO_SEED_IN_PRODUCTION';
  }
}

/**
 * The production refusal, evaluated at IMPORT time and thrown before ./seed.js
 * is loaded.
 *
 * Order matters: requiring ./seed.js runs its own top-level
 * `assertSafeToWipe(...)` (it deletes every table, so it is test-only). That
 * guard is a second, independent refusal — but this one must be the FIRST thing
 * that happens, so a production boot cannot even load the fixture machinery, and
 * the failure an operator sees names production rather than the test-db guard.
 */
if (process.env.NODE_ENV === 'production') throw new DemoSeedInProductionError();

const { seed: buildFixtures, prisma } = require('./seed');

/**
 * True when the database already holds the fixtures, so a second run is a no-op.
 *
 * The user table is the first thing the seed fills and the last thing anything
 * else cascades from, so "does usr-001 exist" is a cheap and reliable answer to
 * "has this database been demo-seeded". A developer who wants the fixtures back
 * after deleting them gets them from a plain re-run.
 */
const alreadySeeded = async () => {
  const user = await prisma.user.findUnique({ where: { id: 'usr-001' }, select: { id: true } });
  return Boolean(user);
};

async function seedDemo({ force = false } = {}) {
  if (!force && (await alreadySeeded())) {
    const counts = await Promise.all([
      prisma.user.count(), prisma.class.count(), prisma.student.count(), prisma.employee.count(),
    ]);
    console.log(`Demo seed already present: ${counts[0]} users, ${counts[1]} classes, ${counts[2]} students, ${counts[3]} employees.`);
    console.log('Nothing was deleted. Use `node prisma/demo-seed.js --force` to re-apply.');
    return counts;
  }

  const result = await buildFixtures({ wipe: false });
  return result;
}

module.exports = { seedDemo, prisma, DemoSeedInProductionError };

/* CLI entry (npx prisma db seed) */
if (require.main === module) {
  const force = process.argv.includes('--force');
  seedDemo({ force })
    .catch((err) => {
      if (err && (err.code === 'UNSAFE_DATABASE' || err.code === 'DEMO_SEED_IN_PRODUCTION')) {
        console.error(err.message);
        process.exit(2);
      }
      console.error(err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
