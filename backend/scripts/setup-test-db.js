/**
 * Prepare the TEST database: apply the migrations, then nothing else.
 *
 * The fixture seed wipes, so it is safe to run against a database that has no
 * tables yet — `deleteMany` on a table that does not exist fails, so migrations
 * must land first. Run this once after creating the test database.
 *
 *   node scripts/setup-test-db.js
 *
 * It refuses to run against anything that is not a test database, like every
 * other destructive entry point.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { assertSafeToWipe } = require('../src/config/test-env');

// Or the explicit override, or the environment's own.
const url = process.env.TEST_DATABASE_URL;
assertSafeToWipe(url, 'scripts/setup-test-db.js (it applies migrations to this database)');

console.log('Applying migrations to the test database...');
try {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: {
      ...process.env,
      // `prisma migrate` reads the URL from the environment under the name the
      // schema declares, so it has to be set from here rather than only living in
      // TEST_DATABASE_URL.
      DATABASE_URL: url,
      DIRECT_URL: url,
    },
  });
} catch (err) {
  console.error('\nMigration failed. Is the database running and reachable?');
  process.exit(1);
}

console.log('\nTest database ready. Run the suite with:  npm test');
