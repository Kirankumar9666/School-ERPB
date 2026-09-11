/**
 * Environment configuration
 * All env vars are read here. No process.env calls scattered in the codebase.
 */
require('dotenv').config();

const nodeEnv = process.env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';

/**
 * JWT secrets must be provided explicitly. In production a missing secret is a
 * fatal startup error (fail fast) — in development we fall back to a clearly
 * labelled insecure value so the app still runs out of the box.
 */
function resolveJwtSecret(envVar, devFallback) {
  const value = process.env[envVar];
  if (value) return value;
  if (isProd) {
    throw new Error(`[config] ${envVar} is required in production. Set it in the environment or backend/.env (see .env.example).`);
  }
  console.warn(`[config] WARNING: ${envVar} is not set — using an INSECURE development fallback. Never ship this to production.`);
  return devFallback;
}

const config = {
  port: process.env.PORT || 5000,
  nodeEnv,

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
    loginMaxAttempts: 5,
    loginWindowMs: 15 * 60 * 1000, // 15 minutes
  },
};

module.exports = config;
