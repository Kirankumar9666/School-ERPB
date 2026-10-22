/**
 * Environment configuration
 * All env vars are read here. No process.env calls scattered in the codebase.
 */
require('dotenv').config();

const nodeEnv = process.env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';

/**
 * Log verbosity gate: 'debug' | 'info' | 'warn' | 'error'.
 * Production defaults to 'warn' (errors + essential warnings only — no
 * request logs). 'debug' turns on per-request access logs (morgan combined)
 * and error stack traces; never ship production with 'debug' enabled.
 */
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const rawLevel = (process.env.LOG_LEVEL || '').toLowerCase();
const logLevel = LOG_LEVELS.includes(rawLevel) ? rawLevel : (isProd ? 'warn' : 'debug');

/**
 * Values that must NEVER sign a production token, whatever they are called.
 *
 * The two dev fallbacks below are the ones this module would otherwise hand out
 * on a dev machine; listing them here means a production process that was
 * started with `JWT_SECRET=dev-only-insecure-jwt-secret-change-me` (copied from
 * a developer's `.env`, a blog post, or the fallback itself) refuses to boot
 * instead of signing every session with a secret published in this repository.
 *
 * The CI secrets and the obvious `change-me`/`your_...` templates are included
 * for the same reason: a staging box that copies them is one `NODE_ENV=production`
 * away from handing out forgeable tokens. The check is a denylist of VALUES, not
 * a strength meter — a real random secret is judged only by being absent here.
 */
const FORBIDDEN_JWT_SECRETS = Object.freeze([
  // the dev fallbacks this module hands out (see resolveJwtSecret callers)
  'dev-only-insecure-jwt-secret-change-me',
  'dev-only-insecure-refresh-secret-change-me',
  // the CI-only secrets in .github/workflows/ci.yml
  'ci-only-secret-not-used-in-production',
  'ci-only-refresh-secret-not-used-in-production',
  // the templates shipped in the .env examples / compose defaults
  'change-me-to-a-long-random-string',
  'change-me-to-another-long-random-string',
  'your_super_secret_jwt_key_here',
  'your_super_secret_refresh_key_here',
]);

/**
 * JWT secrets must be provided explicitly. In production a missing secret — or
 * one that is a known dev/test/template value — is a fatal startup error (fail
 * fast). In development we fall back to a clearly labelled insecure value so the
 * app still runs out of the box.
 */
function resolveJwtSecret(envVar, devFallback) {
  const value = process.env[envVar];
  if (value) {
    if (isProd && FORBIDDEN_JWT_SECRETS.includes(value)) {
      throw new Error(
        `[config] ${envVar} is set to a known development/test/template value. `
        + 'Production refuses to start with a published secret — generating a real one with '
        + '`node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"` and set that instead.',
      );
    }
    return value;
  }
  if (isProd) {
    throw new Error(`[config] ${envVar} is required in production. Set it in the environment or backend/.env (see .env.example).`);
  }
  console.warn(`[config] WARNING: ${envVar} is not set — using an INSECURE development fallback. Never ship this to production.`);
  return devFallback;
}

const config = {
  port: process.env.PORT || 5000,
  nodeEnv,
  isProd,
  logLevel,

  /**
   * How many reverse proxies sit in front of the app. Express uses this to
   * read the client IP from X-Forwarded-For instead of the socket address.
   *
   * TRUST_PROXY=0 (default) → off: don't trust the header at all (a direct
   * connection, or local dev). Every request is the socket's own address, and a
   * client cannot spoof req.ip by sending its own X-Forwarded-For.
   * TRUST_PROXY=1 → one proxy (nginx/traefik/CDN edge in front of the app).
   * TRUST_PROXY=2 → two hops (e.g. CDN → load balancer → app), and so on.
   *
   * The number must be exactly right: too low and every user looks like the
   * proxy (one shared IP for the whole school); too high and a client can forge
   * X-Forwarded-For to impersonate another IP and dodge the per-IP limits.
   */
  trustProxy: (() => {
    const raw = process.env.TRUST_PROXY;
    if (raw === undefined || raw === '' || raw === '0' || raw === 'false') return false;
    if (raw === 'true') return true;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : false;
  })(),

  jwt: {
    secret: resolveJwtSecret('JWT_SECRET', 'dev-only-insecure-jwt-secret-change-me'),
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshSecret: resolveJwtSecret('JWT_REFRESH_SECRET', 'dev-only-insecure-refresh-secret-change-me'),
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  supabase: {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
  },

  cors: {
    // Comma-separated list. Dev default covers Vite's primary port (5173),
    // its auto-increment fallback (5174, used when 5173 is busy) and the
    // production-build preview port (4173). Entries are trimmed so
    // "a, b" works too.
    allowedOrigins: (process.env.ALLOWED_ORIGINS
      || 'http://localhost:5173,http://localhost:5174,http://localhost:4173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  /** Optional TLS termination in-app (typically handled by a reverse proxy instead) */
  tls: {
    keyPath: process.env.TLS_KEY_PATH,
    certPath: process.env.TLS_CERT_PATH,
  },

  rateLimit: {
    /*
     * Per-IP login cap. Kept as a hard cap on anonymous brute force from one
     * address, but set ABOVE the per-account backoff on purpose: a whole school
     * shares one NAT IP (and, before TRUST_PROXY is configured, one proxy IP),
     * so a tight per-IP login limit locks out the entire building after a
     * handful of ordinary typos. The targeted work is done by the per-account
     * limiter below; this one only stops a single address hammering the endpoint.
     * Raise via LOGIN_IP_MAX_ATTEMPTS if a very large site needs more headroom.
     */
    loginMaxAttempts: parseInt(process.env.LOGIN_IP_MAX_ATTEMPTS || '50', 10),
    loginWindowMs: 15 * 60 * 1000, // 15 minutes

    /*
     * Per-ACCOUNT backoff on repeated failed logins for the same username.
     *
     * The per-IP login limiter above cannot see this: a whole school shares one
     * NAT IP (and behind a proxy without trust proxy, everyone shares one IP),
     * so one student fat-fingering their password could lock out the entire
     * building. Keying a SECOND limiter on the submitted username stops someone
     * grinding a single account — from any IP — without touching their
     * classmates. The two limits are independent: both must pass.
     *
     * 10 failures within the window, then the account is slowed/blocked for the
     * rest of it. Successful logins are NOT counted (skipSuccessfulRequests),
     * so a correct password always gets through.
     */
    loginAccountMaxFailures: parseInt(process.env.LOGIN_ACCOUNT_MAX_FAILURES || '10', 10),
    loginAccountWindowMs: 15 * 60 * 1000,

    /*
     * change-password is a DIFFERENT situation from login: the route already
     * requires a valid token, so the caller is one authenticated account, not an
     * anonymous crowd on a shared IP. A strict per-IP 5/15min is therefore safe
     * here (it cannot lock out a school the way a login IP cap would) and stops
     * a stolen token being used to grind the current password.
     */
    changePasswordMaxAttempts: parseInt(process.env.CHANGE_PASSWORD_MAX_ATTEMPTS || '5', 10),

    /*
     * Global /api/v1 ceiling.
     *
     * Once a request is AUTHENTICATED the limit keys on the USER, not the IP —
     * `apiUserMax` per user, so 40 students behind one school IP each get their
     * own budget and none of them can exhaust it for the others. A whole school
     * behind one NAT IP (or a load test) used to trip the per-IP limit
     * instantly; keying logged-in traffic to the user removes that failure mode
     * entirely. Requests with no valid token fall back to the per-IP limit
     * (`apiMax`), because there is no user to key on.
     *
     * Both ceilings come from the environment so a school can raise them without
     * a code change. Defaults suit a busy day of normal page loads.
     */
    apiMax: parseInt(process.env.API_RATE_LIMIT_MAX || '300', 10),
    apiWindowMs: 15 * 60 * 1000,
    apiUserMax: parseInt(process.env.API_RATE_LIMIT_USER_MAX || '3000', 10),
  },
};

module.exports = config;
module.exports.FORBIDDEN_JWT_SECRETS = FORBIDDEN_JWT_SECRETS;
