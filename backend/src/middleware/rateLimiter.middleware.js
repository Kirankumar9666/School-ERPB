const rateLimit = require('express-rate-limit');
const config = require('../config/env');

/**
 * Rate limiting.
 *
 * Three concerns, three shapes:
 *
 *   1. LOGIN / change-password — strict and per-IP. These are the only
 *      unauthenticated guess-a-secret surfaces, so tight limits are worth the
 *      nuisance. Login ALSO carries a per-account backoff (below), because a
 *      whole school behind one IP must not be able to lock each other out.
 *   2. The general API — generous, and keyed on the USER once authenticated
 *      (per-IP only for anonymous requests). A school behind one IP gives each
 *      signed-in user their own budget, so ordinary page loads never collide.
 *   3. Refresh — middling, failed attempts only.
 *
 * `config.trustProxy` (TRUST_PROXY env) decides whether the IP Express sees is
 * the real client or the proxy's — see config/env.js.
 */

/** The message shape every limiter answers with (matches sendError's fields). */
const limitedBody = (message) => ({
  success: false,
  message,
  code: 'RATE_LIMITED',
});

/**
 * Rate limiter for login endpoint (per-IP).
 * Blocks after 5 failed attempts within a 15-minute window.
 */
const loginRateLimiter = rateLimit({
  windowMs: config.rateLimit.loginWindowMs,
  max: config.rateLimit.loginMaxAttempts,
  standardHeaders: true,
  legacyHeaders: false,
  message: limitedBody('Too many login attempts. Please try again in 15 minutes.'),
  skipSuccessfulRequests: true, // Only count failed attempts
});

/**
 * Per-ACCOUNT backoff on repeated failed logins for the same username.
 *
 * Keyed on the submitted username, NOT the IP — so someone grinding one
 * account is throttled no matter which address they come from, while every
 * other user (including everyone else on the same school IP) is untouched.
 * Eight/ten failures within the window and that username is blocked until it
 * passes; a successful login is never counted, so the legitimate owner can
 * always get in.
 *
 * This limiter runs ALONGSIDE the per-IP one, not instead of it: both must
 * allow the request. Its job is to add account-scoped protection the IP limit
 * fundamentally cannot provide behind NAT or a proxy.
 *
 * Applied inside the login handler (see auth.routes.js) because the username
 * only exists after the body is parsed.
 */
const loginAccountLimiter = rateLimit({
  windowMs: config.rateLimit.loginAccountWindowMs,
  max: config.rateLimit.loginAccountMaxFailures,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // a correct password is never counted
  keyGenerator: (req) => {
    // Absent/lowercased so 'Priya' and 'priya' share one budget; a request with
    // no username collapses to a shared bucket (the per-IP limiter still covers
    // anonymous probing).
    const u = req.body && typeof req.body.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    return u || 'anonymous';
  },
  // The key is the username, not the IP; the library's IP-fallback validation
  // only applies to an IP key, so it is switched off for this limiter.
  validate: { ip: false, xForwardedForHeader: false },
  message: limitedBody('Too many failed attempts for this account. Please try again in 15 minutes.'),
});

/**
 * General limiter applied to every /api/v1 request.
 *
 * Keyed by USER when the access token is present and decodable, and by IP
 * otherwise. That is the fix for the real-world failure this carried before: a
 * whole school shares one NAT IP, so a single per-IP bucket of 300/15min was
 * split across every student — 40 users loading a normal page exhausted it and
 * everyone got 429s. With per-user keying each signed-in user gets
 * `apiUserMax` of their own (default 3000), and the per-IP bucket only governs
 * anonymous traffic.
 *
 * The token is only PARSED here (no DB lookup, no verification): a forged token
 * simply yields a user key the attacker would have to forge consistently, and
 * every route behind this still verifies the token properly. Reading `sub`-less
 * or malformed tokens falls back to the IP key.
 */
const bearerUserId = (req) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return json && (json.id || json.username) ? String(json.id || json.username) : null;
  } catch {
    return null;
  }
};

const apiLimiter = rateLimit({
  windowMs: config.rateLimit.apiWindowMs,
  // A single max cannot be conditional, so the limit is read per-request from
  // the resolved key: a logged-in user gets the (higher) per-user ceiling, an
  // anonymous caller the per-IP one.
  max: (req) => (bearerUserId(req) ? config.rateLimit.apiUserMax : config.rateLimit.apiMax),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const userId = bearerUserId(req);
    return userId ? `user:${userId}` : `ip:${req.ip}`;
  },
  message: limitedBody('Too many requests. Please slow down.'),
});

/**
 * Limiter for the refresh endpoint (stricter than general, looser than login).
 * Only failed/invalid refreshes count against the limit.
 */
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: limitedBody('Too many refresh attempts. Please log in again in a few minutes.'),
});

/**
 * Limiter for POST /auth/change-password.
 *
 * The route already requires a valid access token, so this is not about
 * anonymous abuse: it stops an authenticated attacker who holds a stolen token
 * from brute-forcing the CURRENT password in order to change it. Same shape as
 * the login limiter — 5 failures per 15 min per IP, successful changes not
 * counted — because "guess a password" is the same abuse in both places.
 */
const changePasswordLimiter = rateLimit({
  windowMs: config.rateLimit.loginWindowMs,
  max: config.rateLimit.changePasswordMaxAttempts,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Only count failed attempts
  message: limitedBody('Too many attempts. Please try again in 15 minutes.'),
});

module.exports = {
  loginRateLimiter,
  loginAccountLimiter,
  apiLimiter,
  refreshLimiter,
  changePasswordLimiter,
  bearerUserId,
};
