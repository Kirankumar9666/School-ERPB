#!/usr/bin/env node
/**
 * Staging / production-boot verification smoke test.
 *
 * Two modes:
 *
 *   1. Deployed environment (the release gate for a real staging/production host)
 *        node scripts/staging-smoke.js --base-url https://staging.example.com/api/v1
 *      (or SMOKE_BASE_URL=... ; no server is started, the remote one is probed)
 *
 *   2. Production-mode rehearsal on this machine (no deploy needed)
 *        npm run smoke:staging
 *      Boots `src/server.js` with NODE_ENV=production on a free port with
 *      freshly generated JWT secrets, verifies the exact production
 *      configuration path (fail-fast guard included), then shuts it down.
 *
 * The suite is strictly READ-ONLY: /health, logins, authenticated GETs and a
 * few deliberately forbidden requests. Nothing is written, so it is safe to
 * run against production for a post-deploy check.
 *
 * Exit code 0 = every check passed, 1 = at least one failed (details printed).
 *
 * Credentials default to the seeded demo accounts; override for a real
 * environment with SMOKE_ADMIN_USERNAME / SMOKE_ADMIN_PASSWORD,
 * SMOKE_STUDENT_USERNAME / SMOKE_STUDENT_PASSWORD and SMOKE_TEACHER_* .
 */
'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BACKEND_DIR = path.resolve(__dirname, '..');

const EXPECT_ENV = process.env.SMOKE_EXPECT_ENV || 'production';
const STUDENT_ID = process.env.SMOKE_STUDENT_ID || 'stu-001';
const OTHER_STUDENT_ID = process.env.SMOKE_OTHER_STUDENT_ID || 'stu-002';

const CREDENTIALS = {
  admin: {
    username: process.env.SMOKE_ADMIN_USERNAME || 'admin',
    password: process.env.SMOKE_ADMIN_PASSWORD || 'Admin@123',
  },
  student: {
    username: process.env.SMOKE_STUDENT_USERNAME || 'student',
    password: process.env.SMOKE_STUDENT_PASSWORD || 'Student@123',
  },
  teacher: {
    username: process.env.SMOKE_TEACHER_USERNAME || 'teacher',
    password: process.env.SMOKE_TEACHER_PASSWORD || 'Teacher@123',
  },
};

// ─── tiny assertions / reporting ──────────────────────────────────────────

const results = [];

const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`  [ok]   ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── HTTP helpers ─────────────────────────────────────────────────────────

/** Request helper → { status, headers, json, text } (never throws on 4xx/5xx) */
async function api(base, route, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      Accept: 'application/json',
      // Pin gzip so the compression assertion below is deterministic
      'Accept-Encoding': 'gzip, deflate',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json, text };
}

/** POST /auth/login, asserting success → data payload */
async function login(base, role) {
  const { username, password } = CREDENTIALS[role];
  const res = await api(base, '/auth/login', { method: 'POST', body: { username, password } });
  expect(res.status === 200, `login as "${username}" failed (${res.status} ${res.json?.code || ''})`);
  expect(res.json?.data?.accessToken, 'login response has no accessToken');
  return res.json.data;
}

/** Free localhost port obtained from the OS */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}


// ─── production-mode server (rehearsal mode) ──────────────────────────────

async function startProdServer() {
  const port = await freePort();
  const output = [];

  const child = spawn(process.execPath, [path.join(BACKEND_DIR, 'src', 'server.js')], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      // Generated per run — the rehearsal must not depend on (or leak) real secrets
      JWT_SECRET: process.env.SMOKE_JWT_SECRET || crypto.randomBytes(48).toString('hex'),
      JWT_REFRESH_SECRET: process.env.SMOKE_JWT_REFRESH_SECRET || crypto.randomBytes(48).toString('hex'),
      LOG_LEVEL: process.env.SMOKE_LOG_LEVEL || 'warn',
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || 'http://localhost:8080',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  const root = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (code ${child.exitCode}):\n${output.join('').trim()}`);
    }
    try {
      const res = await fetch(`${root}/health`);
      if (res.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`no /health answer within 30s:\n${output.join('').trim()}`);
    }
    await sleep(250);
  }

  return {
    child,
    root,
    base: `${root}/api/v1`,
    log: () => output.join(''),
  };
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    child.once('close', done);
    child.kill();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done();
    }, 5_000);
    timer.unref();
  });
}

/**
 * Production fail-fast guard: with NODE_ENV=production and no JWT secrets the
 * process must refuse to start (exit 1 + the config error) instead of falling
 * back to the insecure development secret. Run from a directory without a
 * .env so dotenv cannot paper over the missing configuration.
 */
async function prodFailFastResult() {
  const env = { ...process.env, NODE_ENV: 'production' };
  delete env.JWT_SECRET;
  delete env.JWT_REFRESH_SECRET;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(BACKEND_DIR, 'src', 'server.js')], {
      cwd: os.tmpdir(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => { out += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: 'timeout', out });
    }, 20_000);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

// ─── the checks ───────────────────────────────────────────────────────────

async function runChecks({ base, root, log, spawned }) {
  console.log(`\nVerifying ${base}\n`);

  // ---- platform / infra ----
  // /health lives at the server root (NOT under /api/v1) — reachable publicly
  // through the frontend container's own `location = /health` proxy.
  await check(`GET /health → 200, env=${EXPECT_ENV}`, async () => {
    const res = await api(root, '/health');
    expect(res.status === 200, `status ${res.status}`);
    expect(res.json?.success === true, `unexpected body ${res.text.slice(0, 120)}`);
    expect(res.json?.env === EXPECT_ENV, `env is "${res.json?.env}", expected "${EXPECT_ENV}"`);
    return res.json.message;
  });

  await check('helmet headers present, x-powered-by hidden', async () => {
    const res = await api(root, '/health');
    expect(res.headers.get('x-content-type-options') === 'nosniff', 'x-content-type-options missing');
    expect(res.headers.get('x-powered-by') === null, 'x-powered-by leaked');
    return 'nosniff + no framework header';
  });

  // ---- auth ----
  const adminToken = (await login(base, 'admin')).accessToken;

  await check('login: admin → access token, role, no password fields', async () => {
    const data = await login(base, 'admin');
    expect(data.user?.role === 'admin', `role is "${data.user?.role}"`);
    expect(data.user?.passwordHash === undefined && data.user?.password_hash === undefined, 'password hash returned');
    return `user=${data.user.username} role=${data.user.role}`;
  });

  await check('GET /auth/me → 200 with matching username', async () => {
    const res = await api(base, '/auth/me', { token: adminToken });
    expect(res.status === 200, `status ${res.status}`);
    expect(res.json?.data?.username === CREDENTIALS.admin.username, `username ${res.json?.data?.username}`);
    return res.json.data.username;
  });

  await check('login with a wrong password → 401 INVALID_CREDENTIALS', async () => {
    // Each run spends one of the 5 failure slots the login limiter allows per
    // IP and 15 minutes, so a high-frequency monitor should set
    // SMOKE_SKIP_FAILED_LOGIN=1 (see DEPLOYMENT.md §4) — otherwise the monitor
    // itself can lock the IP out for real users.
    if (process.env.SMOKE_SKIP_FAILED_LOGIN === '1') return 'skipped (SMOKE_SKIP_FAILED_LOGIN=1)';
    const res = await api(base, '/auth/login', {
      method: 'POST',
      body: { username: CREDENTIALS.admin.username, password: 'definitely-not-the-password' },
    });
    expect(res.status === 401, `status ${res.status}`);
    expect(res.json?.code === 'INVALID_CREDENTIALS', `code ${res.json?.code}`);
    expect(!/passwordHash|password_hash/i.test(res.text), 'response leaks password fields');
    return 'rejected, no field leakage';
  });

  await check('protected route without a token → 401 UNAUTHORIZED', async () => {
    const res = await api(base, '/admin/users');
    expect(res.status === 401, `status ${res.status}`);
    expect(res.json?.code === 'UNAUTHORIZED', `code ${res.json?.code}`);
    return 'rejected';
  });

  // ---- RBAC + data scoping (the security regression guards) ----
  await check('student token on an admin route → 403 FORBIDDEN', async () => {
    const student = await login(base, 'student');
    const res = await api(base, '/admin/users', { token: student.accessToken });
    expect(res.status === 403, `status ${res.status}`);
    expect(res.json?.code === 'FORBIDDEN', `code ${res.json?.code}`);
    return 'blocked';
  });

  await check('teacher token on an admin route → 403 FORBIDDEN', async () => {
    const teacher = await login(base, 'teacher');
    const res = await api(base, '/admin/payroll', { token: teacher.accessToken });
    expect(res.status === 403, `status ${res.status}`);
    expect(res.json?.code === 'FORBIDDEN', `code ${res.json?.code}`);
    return 'blocked';
  });

  await check("student can read own profile, not another student's", async () => {
    const student = await login(base, 'student');
    const own = await api(base, `/students/${STUDENT_ID}/profile`, { token: student.accessToken });
    expect(own.status === 200, `own profile returned ${own.status}`);
    const foreign = await api(base, `/students/${OTHER_STUDENT_ID}/profile`, { token: student.accessToken });
    expect(foreign.status === 403, `another student's profile returned ${foreign.status} (expected 403)`);
    return `${STUDENT_ID}=200, ${OTHER_STUDENT_ID}=403`;
  });

  // ---- API surface / transport ----
  await check('read-only admin list endpoint → 200 + compressible', async () => {
    const res = await api(base, '/admin/students', { token: adminToken });
    expect(res.status === 200, `status ${res.status}`);
    expect(res.json?.success === true, `unexpected envelope ${res.text.slice(0, 120)}`);
    // `compression()` always advertises Accept-Encoding; it only actually gzips
    // bodies above its 1 kB threshold, so a small seeded payload legitimately
    // arrives uncompressed — assert gzip exactly when it should kick in.
    const vary = res.headers.get('vary') || '';
    expect(vary.includes('Accept-Encoding'), `Vary missing Accept-Encoding ("${vary}")`);
    const encoding = res.headers.get('content-encoding');
    if (res.text.length >= 1024) {
      expect(encoding === 'gzip', `payload ${res.text.length} B but content-encoding=${encoding}`);
      return `${res.text.length} B decoded → gzip`;
    }
    return `${res.text.length} B decoded (below the 1 kB gzip threshold), Vary present`;
  });

  await check('rate-limit headers advertised on /api/v1', async () => {
    const res = await api(base, '/auth/me', { token: adminToken });
    const header = res.headers.get('ratelimit') || res.headers.get('ratelimit-policy');
    expect(header, 'no RateLimit header on the response');
    return `RateLimit: ${header}`;
  });

  await check('unknown route → 404 NOT_FOUND (no SPA fallthrough in the API)', async () => {
    const res = await api(base, '/not-a-real-route', { token: adminToken });
    expect(res.status === 404, `status ${res.status}`);
    expect(res.json?.code === 'NOT_FOUND', `code ${res.json?.code}`);
    return '404 envelope';
  });

  await check('CORS: unknown origin gets 200 but no ACAO header', async () => {
    const res = await api(root, '/health', { headers: { Origin: 'https://not-allowed.example' } });
    const granted = res.headers.get('access-control-allow-origin');
    expect(granted === null, `unknown origin was granted (${granted})`);
    expect(res.status === 200, `deny-by-omission should not error, got ${res.status}`);
    return 'no ACAO header, request not turned into a 5xx';
  });

  // ---- production-only guards (rehearsal mode) ----
  if (!spawned) return;

  await check('production logs are quiet (no request logs, no errors)', async () => {
    const captured = log();
    const lines = captured.split('\n').filter(Boolean);
    expect(captured.trim().length > 0, 'server produced no startup output at all');
    const requestLogs = lines.filter((l) => /"GET |"POST |morgan/i.test(l));
    const errors = lines.filter((l) => l.includes('[ERROR]') || l.includes('[UNHANDLED-REJECTION]'));
    const insecure = lines.filter((l) => l.includes('[config] WARNING'));
    expect(insecure.length === 0, `insecure development JWT fallback was used:\n    ${insecure.join('\n    ')}`);
    expect(requestLogs.length === 0, `request logging is active in production:\n    ${requestLogs.join('\n    ')}`);
    expect(errors.length === 0, `errors logged during the run:\n    ${errors.join('\n    ')}`);
    return `${lines.length} startup line(s), 0 request logs, 0 errors`;
  });

  await check('production fail-fast without JWT secrets → exit 1', async () => {
    const { code, out } = await prodFailFastResult();
    expect(code === 1, `exit code ${code} (expected 1)`);
    expect(out.includes('JWT_SECRET is required in production'), `guard message missing, got:\n${out.trim()}`);
    return 'refused to start, clear config error';
  });
}

// ─── entry point ──────────────────────────────────────────────────────────

function usage() {
  console.log(`
Staging / production verification smoke test (read-only)

  node scripts/staging-smoke.js                  prod-mode rehearsal (boots a local server)
  node scripts/staging-smoke.js --base-url <url> verify a deployed API, e.g. https://staging.example.com/api/v1

Environment overrides:
  SMOKE_BASE_URL            same as --base-url
  SMOKE_EXPECT_ENV          expected /health env value (default: production)
  SMOKE_ADMIN_USERNAME / SMOKE_ADMIN_PASSWORD
  SMOKE_STUDENT_USERNAME / SMOKE_STUDENT_PASSWORD
  SMOKE_TEACHER_USERNAME / SMOKE_TEACHER_PASSWORD
  SMOKE_STUDENT_ID          id the student account belongs to (default: stu-001)
  SMOKE_OTHER_STUDENT_ID    a student that account must NOT be able to read (default: stu-002)
  SMOKE_LOG_LEVEL           log level of the rehearsal server (default: warn)
  SMOKE_SKIP_FAILED_LOGIN   '1' skips the wrong-password check — use it for a
                            monitor that runs more often than every ~15 min,
                            because each run spends one failure against the
                            login rate limiter for the caller's IP.
`);
}

/** A bad invocation (typo, missing value) — reported without a stack trace. */
function usageError(message) {
  const err = new Error(message);
  err.usage = true;
  return err;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return 0;
  }

  const urlFlag = argv.indexOf('--base-url');
  // Reject anything unrecognised: a typo (--base_url, --url) would otherwise
  // silently fall back to the local rehearsal and "pass" without ever touching
  // the environment being released.
  const known = urlFlag === -1 ? [] : ['--base-url', argv[urlFlag + 1]];
  const unknown = argv.filter((a) => !known.includes(a));
  if (unknown.length) {
    throw usageError(`unknown argument(s): ${unknown.join(', ')} — run with --help for usage`);
  }
  if (urlFlag !== -1 && (!argv[urlFlag + 1] || argv[urlFlag + 1].startsWith('--'))) {
    throw usageError('--base-url needs a URL, e.g. --base-url https://staging.example.com/api/v1');
  }

  let baseUrl = (urlFlag !== -1 ? argv[urlFlag + 1] : process.env.SMOKE_BASE_URL || '').replace(/\/+$/, '');
  // A bare origin (`https://staging.example.com`) is a natural thing to pass —
  // the API prefix is fixed, so fill it in instead of failing every request.
  if (baseUrl) {
    let pathname;
    try {
      ({ pathname } = new URL(baseUrl));
    } catch {
      throw usageError(`"${baseUrl}" is not a valid URL — include the scheme, e.g. https://staging.example.com`);
    }
    if (pathname === '/' || pathname === '') baseUrl += '/api/v1';
  }

  let server;
  try {
    if (baseUrl) {
      console.log('\nMode: deployed environment');
      const root = baseUrl.replace(/\/api\/v1$/, '');
      // Reachability preflight: a bare `fetch failed` per check is the least
      // useful way to learn that the host is down or the URL is wrong. /health
      // is served at the origin root, not under the /api/v1 prefix.
      try {
        const probe = await fetch(`${root}/health`, { signal: AbortSignal.timeout(10_000) });
        if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
      } catch (err) {
        throw new Error(`cannot reach ${root}/health — is the environment up and the URL correct? (${err.message})`);
      }
      await runChecks({ base: baseUrl, root, log: () => '', spawned: false });
    } else {
      console.log('\nMode: production-mode rehearsal (local server, NODE_ENV=production)');
      server = await startProdServer();
      console.log(`  server up on ${server.root} (pid ${server.child.pid})`);
      await runChecks({ base: server.base, root: server.root, log: server.log, spawned: true });
    }
  } catch (err) {
    console.error(`\n[FATAL] ${err.message}`);
    return 1;
  } finally {
    await stopServer(server?.child);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('Failed checks:');
    failed.forEach((r) => console.log(`  - ${r.name}`));
    return 1;
  }
  console.log(baseUrl ? 'Staging environment verified.\n' : 'Production-mode rehearsal passed.\n');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // A typo in the invocation is not a stack-worthy crash — print the message.
    console.error(err.usage ? `[FATAL] ${err.message}` : `[FATAL] ${err.stack || err.message}`);
    process.exit(1);
  });
