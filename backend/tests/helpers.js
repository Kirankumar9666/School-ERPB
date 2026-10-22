/**
 * Shared test helpers for the Node built-in test runner.
 * Sets NODE_ENV=test (disables morgan) BEFORE the app/config modules load,
 * re-seeds the TEST database so every test file starts from the same state the
 * in-memory mock stores used to provide, boots the Express app on an
 * ephemeral port, and provides small fetch utils.
 *
 * ## The tests NEVER touch the app's database
 *
 * The seed wipes every table, so the URL is judged by the guard in
 * src/config/test-env.js before anything is loaded. A `.env.test` pointing at a
 * database whose name does not carry the "test" marker stops the whole run with
 * a message and deletes nothing.
 */
process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertSafeToWipe } = require('../src/config/test-env');

/* ---- 1. Load .env.test, and ONLY .env.test ---------------------------------
   dotenv's default `config()` reads `.env` when nothing overrides it, which would
   silently pick up the developer's DATABASE_URL. `path` pins it to the test file,
   and `override: true` keeps a value already in the process environment (CI) on
   top — so a CI job that exports TEST_DATABASE_URL itself wins. */
const envTestPath = path.join(__dirname, '..', '.env.test');
if (fs.existsSync(envTestPath)) {
  require('dotenv').config({ path: envTestPath, override: true });
} else {
  require('dotenv').config({ path: envTestPath, override: true });
}

/* ---- 2. The database the tests will wipe, judged before anything can delete --- */
const seedUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
try {
  assertSafeToWipe(seedUrl, 'the test suite (tests/helpers.js)');
} catch (err) {
  // Not a test database: print the refusal and stop the run. Nothing has been
  // deleted, and no server has been started, so no test can act on the app's
  // database.
  console.error(err.message);
  process.exit(2);
}

/** Boot the API on a random port → { app, server, base } */
async function startServer() {
  // Fresh seeded state per test file (equivalent of fresh mock stores).
  const { seed, prisma: seedPrisma } = require('../prisma/seed');
  try {
    await seed();
  } finally {
    await seedPrisma.$disconnect();
  }

  const app = require('../src/app'); // lazy require: NODE_ENV must be set first
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  return { app, server, base };
}

/** Stop the server, close DB connections and drop kept-alive sockets */
async function stopServer(server) {
  if (!server) return;
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await require('../src/services/prisma').$disconnect();
}

/** POST /auth/login → resolves with the `data` payload (asserts success) */
async function login(base, username, password) {
  const res = await request(base, '/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(res.status, 200, `login as "${username}" should succeed — got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

/** Minimal JSON request helper → { status, body } */
async function request(base, path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

/** Authorization header for a bearer token */
const auth = (token) => ({ Authorization: `Bearer ${token}` });

module.exports = { startServer, stopServer, login, request, auth };
