const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
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

// Behind one reverse proxy (nginx/traefik) — makes req.ip and express-rate-limit
// see the real client IP instead of the proxy's.
app.set('trust proxy', 1);

// ─── Security Middleware ───────────────────────────────────────────────────
app.use(helmet()); // Sets secure HTTP headers
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || config.cors.allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// ─── General Middleware ────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

if (config.nodeEnv !== 'test') {
  app.use(morgan('dev'));
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
  console.error('[ERROR]', err.message);
  sendError(res, 'Internal server error', 500, 'SERVER_ERROR');
});

// ─── Server entry lives in src/server.js ──────────────────────────────────
// app.js exports the configured app only, so tests can boot it on an
// ephemeral port without binding the real listener.

module.exports = app;
