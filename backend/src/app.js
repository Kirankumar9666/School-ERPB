const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const fs = require('fs');
const http = require('http');
const https = require('https');
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

// ─── Start Server ─────────────────────────────────────────────────────────
// HTTPS is enabled automatically when TLS_KEY_PATH + TLS_CERT_PATH are set.
// In production it is recommended to terminate TLS at a reverse proxy instead.
const printBanner = (scheme) => {
  console.log(`\n🏫 School ERP API running on ${scheme}://localhost:${config.port}`);
  console.log(`   Environment : ${config.nodeEnv}`);
  console.log(`   Health check: ${scheme}://localhost:${config.port}/health\n`);
};

if (config.tls.keyPath && config.tls.certPath) {
  const credentials = {
    key: fs.readFileSync(config.tls.keyPath),
    cert: fs.readFileSync(config.tls.certPath),
  };
  https.createServer(credentials, app).listen(config.port, () => printBanner('https'));
} else {
  http.createServer(app).listen(config.port, () => printBanner('http'));
}

module.exports = app;
