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

module.exports = { loginRateLimiter };
