/**
 * The test-database guard.
 *
 * A unit test of src/config/test-env.js — the one place a connection string is
 * judged fit to wipe. This is the test that proves `npm test` refuses a
 * developer's real database, so it runs as a plain script and is registered with
 * the runner as one test.
 */
const test = require('node:test');

let pass = 0;
let fail = 0;
const ok = (label, cond, extra) => {
  if (cond) pass += 1; else fail += 1;
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? ' -- ' + extra : ''));
};

const {
  assertSafeToWipe,
  isTestDatabaseUrl,
  describeDatabase,
} = require('../src/config/test-env');

/* A database is the test database when a WORD in its name or user name is "test".
   A substring is not enough: "latest", "attest" and "testament" all contain those
   letters, and a rule that accepted them would happily wipe a developer's copy of
   production. */
const cases = [
  ['the live Supabase database', 'postgresql://postgres.abc:pass@aws-0-ap-south-1.pooler.supabase.com:6543/postgres', false],
  ['a local dev database', 'postgresql://postgres:postgres@127.0.0.1:5432/schoolerp', false],
  ['the obvious production name', 'postgresql://user:pass@db.example.com:5432/production', false],
  ['a database that merely contains the letters test', 'postgresql://u:p@h:5432/latest', false],
  ['a database with tests (plural)', 'postgresql://u:p@h:5432/integration_tests', false],
  ['a user merely named testuser', 'postgresql://testuser:p@h:5432/scratch', false],
  ['a database called attest', 'postgresql://u:p@h:5432/attest', false],
  ['a database called testament', 'postgresql://u:p@h:5432/testament', false],
  ['no URL at all', null, false],
  ['a non-string URL', 42, false],
  ['the test database', 'postgresql://schoolerp_test:pw@127.0.0.1:5432/schoolerp_test?schema=public', true],
  ['a database with test as a word among others', 'postgresql://u:p@h:5432/schoolerp_test', true],
  ['a database named test_db', 'postgresql://u:p@h:5432/test_db', true],
  ['a user named exactly test', 'postgresql://test:p@h:5432/scratch', true],
];

test('the guard accepts only the test database', () => {
  for (const [label, url, want] of cases) {
    const got = isTestDatabaseUrl(url);
    ok(`${label} is ${want ? 'ACCEPTED' : 'REFUSED'}`, got === want, `got ${got}`);
  }
});

test('the guard throws rather than returning, and says nothing was deleted', () => {
  let threw = null;
  try {
    assertSafeToWipe('postgresql://u:p@127.0.0.1:5432/schoolerp', 'the check');
  } catch (err) {
    threw = err;
  }
  ok('assertSafeToWipe throws on an unsafe URL', Boolean(threw));
  ok('with the code UNSAFE_DATABASE', threw && threw.code === 'UNSAFE_DATABASE', threw && threw.code);
  if (threw) {
    ok('the message names the target database', threw.message.indexOf('schoolerp') !== -1);
    ok('the message masks the password', threw.message.indexOf('u:p@') === -1 && threw.message.indexOf('***') !== -1);
    ok('the message says nothing was deleted', threw.message.indexOf('Nothing has been deleted') !== -1);
    ok('the message tells you what to do', threw.message.indexOf('TEST_DATABASE_URL') !== -1);
  }
});

test('describeDatabase parses a URL into its parts', () => {
  const parsed = describeDatabase('postgresql://u:p%40ss@127.0.0.1:5432/tests_db?schema=public');
  ok('strips the query string', parsed.database === 'tests_db', String(parsed.database));
  ok('reads the host', parsed.host === '127.0.0.1', String(parsed.host));
  const noScheme = describeDatabase('u:p@127.0.0.1:5432/schoolerp');
  ok('a URL with no scheme still parses', noScheme.database === 'schoolerp' && noScheme.user === 'u');
  const nothing = describeDatabase(null);
  ok('a missing URL is reported as missing, not guessed', nothing.database === null && nothing.host === null);
});

test('the guard test itself', () => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
});
