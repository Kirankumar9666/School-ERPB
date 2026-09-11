/**
 * Shared test helpers for the Node built-in test runner.
 * Sets NODE_ENV=test (disables morgan) BEFORE the app/config modules load,
 * boots the Express app on an ephemeral port, and provides small fetch utils.
 */
process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');

/** Boot the API on a random port → { app, server, base } */
async function startServer() {
  const app = require('../src/app'); // lazy require: NODE_ENV must be set first
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  return { app, server, base };
}

/** Stop the server, dropping kept-alive sockets so the runner exits cleanly */
async function stopServer(server) {
  if (!server) return;
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

/** POST /auth/login → resolves with the `data` payload (asserts success) */
async function login(base, username, password) {
  const res = await request(base, '/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(res.status, 200, `login as "${username}" should succeed — got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

/** Minimal JSON request helper → { status, body } */
async function request(base, path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

/** Authorization header for a bearer token */
const auth = (token) => ({ Authorization: `Bearer ${token}` });

module.exports = { startServer, stopServer, login, request, auth };