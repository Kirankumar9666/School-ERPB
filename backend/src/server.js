/**
 * Server entry point.
 * Binds the configured Express app to HTTP, or HTTPS when TLS_KEY_PATH +
 * TLS_CERT_PATH are both provided (production recommendation: terminate TLS
 * at a reverse proxy instead).
 *
 * Timeouts keep a slow/hanging client from tying up server resources under
 * load (keepAliveTimeout must exceed the reverse proxy's idle timeout —
 * nginx proxy_read_timeout is 60s in frontend/nginx.conf — otherwise Node
 * may close a keep-alive socket nginx is about to reuse).
 */
const fs = require('fs');
const http = require('http');
const https = require('https');
const config = require('./config/env');
const app = require('./app');

const applyTimeouts = (server) => {
  server.keepAliveTimeout = 65_000;   // > nginx 60s idle timeout
  server.headersTimeout = 70_000;     // > keepAliveTimeout (Node requirement)
  server.requestTimeout = 30_000;     // cap total request duration (slow-loris + hung handlers)
};

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
  const server = https.createServer(credentials, app);
  applyTimeouts(server);
  server.listen(config.port, () => printBanner('https'));
} else {
  const server = http.createServer(app);
  applyTimeouts(server);
  server.listen(config.port, () => printBanner('http'));
}