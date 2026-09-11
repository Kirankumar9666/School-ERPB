/**
 * Server entry point.
 * Binds the configured Express app to HTTP, or HTTPS when TLS_KEY_PATH +
 * TLS_CERT_PATH are both provided (production recommendation: terminate TLS
 * at a reverse proxy instead).
 */
const fs = require('fs');
const http = require('http');
const https = require('https');
const config = require('./config/env');
const app = require('./app');

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