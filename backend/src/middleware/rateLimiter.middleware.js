const rateLimit = require('express-rate-limit');
const config = require('../config/env');

/**
 * Rate limiter for login endpoint.
 * Blocks after 5 failed attempts within a 15-minute window.
 */
const loginRateLimiter = rateLimit({
  windowMs: config.rateLimit.loginWindowMs,
  max: config.rateLimit.loginMaxAttempts,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many login attempts. Please try again in 15 minutes.',
    code: 'RATE_LIMITED',
  },
  skipSuccessfulRequests: true, // Only count failed attempts
});

/**
 * General limiter applied to every /api/v1 request.
 * Generous ceiling — protects against abuse/DoS without disturbing normal use.
 */
const apiLimiter = rateLimit({
  windowMs: config.rateLimit.apiWindowMs,
  max: config.rateLimit.apiMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests. Please slow down.',
    code: 'RATE_LIMITED',
  },
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
  message: {
    success: false,
    message: 'Too many refresh attempts. Please log in again in a few minutes.',
    code: 'RATE_LIMITED',
  },
});

module.exports = { loginRateLimiter, apiLimiter, refreshLimiter };
