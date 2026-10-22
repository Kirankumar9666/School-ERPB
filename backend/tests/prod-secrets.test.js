/**
 * Production JWT-secret guard.
 *
 * The single most damaging misconfiguration this app can ship with is a
 * production process signing sessions with a secret that is already published
 * in the repository (a development fallback, a CI value, or a `.env.example`
 * template). Anyone reading the repo could then mint a valid admin token.
 *
 * `src/config/env.js` refuses to load in that case. This test proves the refusal
 * for every denied shape AND proves the guard does not fire on a normal dev
 * boot or on a genuine random secret — a denylist that rejected everything would
 * be useless in the other direction.
 *
 * It runs each case in a fresh child process (the check happens at module import
 * time, so `require` caching would otherwise hide the second case), against a
 * scratch cwd with no `.env` so `dotenv` cannot supply a value.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BACKEND_DIR = path.join(__dirname, '..');

/**
 * Boot `src/config/env.js` in a child process with the given env and report
 * whether it threw. `NODE_ENV=production` + a scratch cwd (so no `.env` is
 * loaded) is the production path exactly as a real deploy exercises it.
 *
 * @param {object} env  extra environment for the child
 * @returns {{ ok: boolean, stderr: string }}
 */
function loadEnvFresh(env) {
  const child = spawnSync(
    process.execPath,
    ['-e', "require('./src/config/env.js'); console.log('LOADED')"],
    {
      cwd: BACKEND_DIR,
      env: { ...process.env, NODE_ENV: 'production', ...env },
      encoding: 'utf8',
    },
  );
  return { ok: child.status === 0 && child.stdout.includes('LOADED'), stderr: child.stderr || '' };
}

test('a production boot refuses every known dev/test/template JWT secret', () => {
  const forbidden = require('../src/config/env').FORBIDDEN_JWT_SECRETS;
  assert.ok(Array.isArray(forbidden) && forbidden.length > 0, 'the denylist must not be empty');

  // A valid random counterpart, so ONLY the secret under test can be the cause.
  const good = 'a'.repeat(96);

  for (const secret of forbidden) {
    const asAccess = loadEnvFresh({ JWT_SECRET: secret, JWT_REFRESH_SECRET: good });
    assert.equal(asAccess.ok, false, `JWT_SECRET=${secret} must refuse to boot`);
    assert.match(asAccess.stderr, /known development\/test\/template value/, `guard message for JWT_SECRET=${secret}`);

    const asRefresh = loadEnvFresh({ JWT_SECRET: good, JWT_REFRESH_SECRET: secret });
    assert.equal(asRefresh.ok, false, `JWT_REFRESH_SECRET=${secret} must refuse to boot`);
  }
});

test('a production boot refuses a missing JWT secret', () => {
  const { ok, stderr } = loadEnvFresh({ JWT_SECRET: '', JWT_REFRESH_SECRET: 'b'.repeat(96) });
  assert.equal(ok, false, 'a missing JWT_SECRET must refuse to boot');
  assert.match(stderr, /JWT_SECRET/);
});

test('a production boot accepts a genuine random secret', () => {
  const { ok, stderr } = loadEnvFresh({
    JWT_SECRET: require('crypto').randomBytes(48).toString('hex'),
    JWT_REFRESH_SECRET: require('crypto').randomBytes(48).toString('hex'),
  });
  assert.equal(ok, true, `a real secret must boot, got stderr:\n${stderr}`);
});

test('the guard does NOT fire outside production', () => {
  // In development the fallback is allowed (with a warning), so a dev boot with
  // a forbidden value must still come up — the denylist is production-only.
  const child = spawnSync(
    process.execPath,
    ['-e', "require('./src/config/env.js'); console.log('LOADED')"],
    {
      cwd: BACKEND_DIR,
      env: { ...process.env, NODE_ENV: 'development', JWT_SECRET: 'dev-only-insecure-jwt-secret-change-me' },
      encoding: 'utf8',
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /LOADED/);
});
