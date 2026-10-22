/**
 * The test-database guard.
 *
 * ## Why this exists
 *
 * The test suite seeds the database before every file, and seeding begins by
 * deleting every table. For a long time `tests/helpers.js` pointed that at
 * whatever `DATABASE_URL` happened to be — which in development was the real
 * database — so `npm test` erased a school's students, classes and fees. Nothing
 * in the code disagreed; it did exactly what it was told.
 *
 * This module is the single place a connection string is judged fit to wipe.
 * Every destructive entry point loads it and asks first: the test runner's
 * helpers, the fixture seed, and every script that deletes rows.
 *
 * ## The rule
 *
 * A database is deletable only when its URL names the TEST database — the
 * explicit allowlist, or a database / user name containing the marker `test`.
 * Anything else is refused and NOTHING is deleted.
 *
 * The default is refusal, not permission: an unset variable, a typo, a production
 * file copied over the test one, or a developer with no `.env.test` at all all
 * fail closed. Refusing costs one message; consenting to a wipe of the wrong
 * database costs a school its records, so the guard errs the one direction that
 * is recoverable.
 *
 * @module config/test-env
 */

/**
 * Substrings that mark a URL as the disposable test database. Matched
 * case-insensitively against the database and user name.
 *
 * These are WHOLE WORDS from a URL path, not substrings of one, and the
 * difference is not academic: "latest", "testament" and "attest" all contain the
 * letters "test", and any one of them would otherwise be accepted as a test
 * database. A word is delimited by path separators, underscores, dashes and the
 * string boundaries.
 */
const MARKERS = ['test'];

/** Split "schoolerp_test" / "schoolerp-test" / "schoolerpTest" into words. */
const wordsOf = (value) => String(value || '')
  .toLowerCase()
  .split(/[^a-z0-9]+/i)
  .filter(Boolean);

/**
 * Extra hosts the suite may wipe, from ALLOWED_TEST_DB_HOSTS (comma-separated).
 * Usually empty — the point is that nobody has to configure anything — but a
 * project can name its own CI host when the database name cannot carry "test".
 */
const EXTRA_HOSTS = (process.env.ALLOWED_TEST_DB_HOSTS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** Thrown when a destructive script is aimed at something that is not a test db. */
class UnsafeDatabaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeDatabaseError';
    this.code = 'UNSAFE_DATABASE';
  }
}

/**
 * The parts of a Postgres URL that tell us what it points at.
 *
 * Parsed by hand rather than with `new URL()` on purpose: a password containing
 * `@` or `/` mis-parses one, and we would rather say "unrecognised" than
 * silently mis-read a real connection string.
 *
 * @param {string} rawUrl
 * @returns {{raw: string, database: string|null, user: string|null, host: string|null}}
 */
const describeDatabase = (rawUrl) => {
  if (!rawUrl) return { raw: null, database: null, user: null, host: null };
  const original = String(rawUrl);
  // Strip the scheme so the rest parses the same with or without it.
  let rest = original.replace(/^[a-z0-9+]+:\/\//i, '');

  const at = rest.lastIndexOf('@');
  const credential = at === -1 ? '' : rest.slice(0, at);
  const tail = at === -1 ? rest : rest.slice(at + 1);

  const colon = credential.indexOf(':');
  const user = colon === -1 ? credential : credential.slice(0, colon);

  // The database name is everything after the first slash, minus the query string.
  const slash = tail.indexOf('/');
  const host = (slash === -1 ? tail : tail.slice(0, slash)).split(':')[0] || '';
  const afterSlash = slash === -1 ? '' : tail.slice(slash + 1);
  const database = afterSlash.split('?')[0];

  const safe = (v) => {
    const decoded = decodeURIComponent(v || '');
    return decoded || null;
  };

  return {
    raw: original,
    database: safe(database),
    user: safe(user),
    host: (host || '').toLowerCase() || null,
  };
};

/**
 * True when the URL names something that is unmistakably the test database.
 *
 * @param {string} rawUrl
 * @returns {boolean}
 */
const isTestDatabaseUrl = (rawUrl) => {
  const info = describeDatabase(rawUrl);
  if (!info.database) return false;

  // An explicitly configured host always passes: it is the strongest statement a
  // project can make, and the escape hatch for a database that cannot be named
  // around the marker.
  if (info.host && EXTRA_HOSTS.includes(info.host)) return true;

  const parts = [info.database, info.user].filter(Boolean).map((v) => String(v).toLowerCase());
  return parts.some((part) => wordsOf(part).some((w) => MARKERS.includes(w)));
};

/**
 * The refusal text. Written for whoever just typed `npm test`: it names what was
 * refused with the password masked — so neither a terminal nor a CI log shows a
 * secret — and says what to do instead.
 */
const unsafeMessage = (rawUrl, label) => {
  const info = describeDatabase(rawUrl);
  const masked = info.raw
    ? info.raw.replace(/(:\/\/)[^@/]+@/i, '$1***@')
    : '(no database URL is set)';
  const target = info.database
    ? `database "${info.database}" on ${info.host || 'an unknown host'}`
    : 'an unknown database';

  const lines = [
    '',
    `  REFUSING TO DELETE DATA${label ? ` (${label})` : ''}: ${target} is NOT the test database.`,
    '',
    `      URL: ${masked}`,
    '',
    '      The test suite and the fixture seed delete every table. They may only',
    '      ever run against the disposable test database.',
    '',
    '      Set TEST_DATABASE_URL in backend/.env.test to a database whose name',
    '      contains "test" — for example:',
    '        postgresql://user:pass@127.0.0.1:5432/schoolerp_test',
    '',
    '      (or add its host to ALLOWED_TEST_DB_HOSTS to allowlist it.)',
    '',
    '      Nothing has been deleted.',
    '',
  ];
  return lines.join('\n');
};

/**
 * Assert that a URL is safe to wipe. Throws {@link UnsafeDatabaseError} otherwise.
 *
 * @param {string} rawUrl the connection string about to be used destructively
 * @param {string|null} [label] what wants it, for the error message
 * @returns {string} the same URL, so callers can chain
 */
const assertSafeToWipe = (rawUrl, label) => {
  if (!isTestDatabaseUrl(rawUrl)) throw new UnsafeDatabaseError(unsafeMessage(rawUrl, label));
  return rawUrl;
};

/**
 * Stop the process with the refusal printed. For the entry points a caller
 * cannot catch usefully — a script started from the command line, where an
 * exception would only print a stack trace nobody wants to read.
 *
 * @param {string} rawUrl
 * @param {string|null} [label]
 */
const refuse = (rawUrl, label) => {
  console.error(unsafeMessage(rawUrl, label));
  process.exit(2);
};

module.exports = {
  MARKERS,
  UnsafeDatabaseError,
  describeDatabase,
  isTestDatabaseUrl,
  assertSafeToWipe,
  refuse,
  unsafeMessage,
};
