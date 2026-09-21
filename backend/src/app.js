const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const config = require('./config/env');
const { apiLimiter } = require('./middleware/rateLimiter.middleware');

// Route modules
const authRoutes = require('./modules/auth/auth.routes');
const studentRoutes = require('./modules/students/students.routes');
const employeeRoutes = require('./modules/employees/employees.routes');
const schoolRoutes = require('./modules/school/school.routes');
const adminRoutes = require('./modules/admin/admin.routes');

const { sendError } = require('./utils/response');

const app = express();

// A rejected promise from an async route (Express 4 has no async error
// propagation) must not take the whole process down — under load, one
// transient DB blip would otherwise crash every in-flight request. The
// global error handler below still owns the HTTP response for sync throws;
// this guard only keeps the process alive and logs.
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED-REJECTION]', err?.message || err);
  if (config.logLevel === 'debug' && err?.stack) console.error(err.stack);
});

// Behind one reverse proxy (nginx/traefik) — makes req.ip and express-rate-limit
// see the real client IP instead of the proxy's.
app.set('trust proxy', 1);

// ─── Security Middleware ───────────────────────────────────────────────────
app.use(helmet()); // Sets secure HTTP headers
app.use(cors({
  origin: (origin, callback) => {
    // Allowed origins (or same-origin/server-to-server requests with no Origin
    // header) get the CORS headers; anything else is answered WITHOUT them.
    // Passing an Error here instead would route every scanner/bot probe through
    // the global error handler as a 500 "SERVER_ERROR" and log an [ERROR] line —
    // noisy in production logs and misleading in the response body. Denying by
    // omission is the standard behaviour: the browser blocks the response.
    callback(null, !origin || config.cors.allowedOrigins.includes(origin));
  },
  credentials: true,
}));

// ─── General Middleware ────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Response compression — JSON list payloads (students/by-class, marks, ...)
// shrink ~80% over the wire. Runs before routes; nginx gzip on the frontend
// container only covers static assets, not the proxied API responses.
app.use(compression());

// Request logging is gated by LOG_LEVEL (config/env.js):
//   - production default 'warn'  → NO per-request access logs at all
//   - development default 'debug'→ morgan 'dev' colored output
//   - production with LOG_LEVEL=debug → morgan 'combined' (temporarily only)
if (config.logLevel === 'debug' && config.nodeEnv !== 'test') {
  app.use(morgan(config.isProd ? 'combined' : 'dev'));
}

// ─── Health Check ─────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ success: true, message: 'School ERP API is running', env: config.nodeEnv });
});

// ─── API Routes ───────────────────────────────────────────────────────────
// General rate limit across the whole API surface
app.use('/api/v1', apiLimiter);

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/students', studentRoutes);
app.use('/api/v1/employees', employeeRoutes);
app.use('/api/v1/school', schoolRoutes);
app.use('/api/v1/admin', adminRoutes);

// ─── 404 Handler ──────────────────────────────────────────────────────────
app.use((req, res) => {
  sendError(res, `Route ${req.method} ${req.originalUrl} not found`, 404, 'NOT_FOUND');
});

// ─── Global Error Handler ─────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Message only by default (no stack, no request data). LOG_LEVEL=debug
  // opts into the stack trace for diagnosis — temporary use only.
  if (config.logLevel === 'debug') {
    console.error('[ERROR]', err.stack || err.message);
  } else {
    console.error('[ERROR]', err.message);
  }
  sendError(res, 'Internal server error', 500, 'SERVER_ERROR');
});

// ─── Server entry lives in src/server.js ──────────────────────────────────
// app.js exports the configured app only, so tests can boot it on an
// ephemeral port without binding the real listener.

module.exports = app;
