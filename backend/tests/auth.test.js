/**
 * Unit/integration tests: auth service — login, tokens, RBAC, password reset.
 * Run with: npm test (Node built-in runner)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const config = require('../src/config/env');
const { startServer, stopServer, login, request, auth } = require('./helpers');

let ctx;

test('setup — boot API', async () => { ctx = await startServer(); });

test('login success returns tokens and a sanitized user', async () => {
  const data = await login(ctx.base, 'admin', 'Admin@123');
  assert.ok(data.accessToken, 'has accessToken');
  assert.ok(data.refreshToken, 'has refreshToken');
  assert.equal(data.user.username, 'admin');
  assert.equal(data.user.role, 'admin');
  assert.ok(!JSON.stringify(data).toLowerCase().includes('passwordhash'), 'no passwordHash in response');
});

test('login with wrong password → 401 INVALID_CREDENTIALS', async () => {
  const res = await request(ctx.base, '/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong-pass' } });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'INVALID_CREDENTIALS');
});

test('login with unknown username → 401', async () => {
  const res = await request(ctx.base, '/auth/login', { method: 'POST', body: { username: 'ghost', password: 'whatever' } });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'INVALID_CREDENTIALS');
});

test('login with missing fields → 400 VALIDATION_ERROR with field errors', async () => {
  const res = await request(ctx.base, '/auth/login', { method: 'POST', body: { username: '' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  assert.ok(res.body.errors);
});

test('access token is a valid JWT with the correct payload', async () => {
  const data = await login(ctx.base, 'student', 'Student@123');
  const decoded = jwt.verify(data.accessToken, config.jwt.secret);
  assert.equal(decoded.username, 'student');
  assert.equal(decoded.role, 'student');
  assert.equal(decoded.linkedEntityId, 'stu-001');
  assert.ok(decoded.exp > Math.floor(Date.now() / 1000), 'token not expired');
});

test('GET /auth/me returns the current user', async () => {
  const data = await login(ctx.base, 'teacher', 'Teacher@123');
  const res = await request(ctx.base, '/auth/me', { token: data.accessToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.username, 'teacher');
  assert.equal(res.body.data.linkedEntityId, 'emp-001');
  assert.ok(!('passwordHash' in res.body.data));
});

test('GET /auth/me without token → 401', async () => {
  const res = await request(ctx.base, '/auth/me');
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('refresh: valid refresh token issues a new access token', async () => {
  const data = await login(ctx.base, 'admin', 'Admin@123');
  const res = await request(ctx.base, '/auth/refresh', { method: 'POST', body: { refreshToken: data.refreshToken } });
  assert.equal(res.status, 200);
  assert.ok(res.body.data.accessToken);
  const decoded = jwt.verify(res.body.data.accessToken, config.jwt.secret);
  assert.equal(decoded.role, 'admin');
});

test('refresh: bogus token → 401 INVALID_REFRESH_TOKEN', async () => {
  const res = await request(ctx.base, '/auth/refresh', { method: 'POST', body: { refreshToken: 'totally-not-a-jwt-token' } });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'INVALID_REFRESH_TOKEN');
});

test('RBAC: student token cannot list admin users → 403', async () => {
  const data = await login(ctx.base, 'student', 'Student@123');
  const res = await request(ctx.base, '/admin/users', { token: data.accessToken });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'FORBIDDEN');
});

test('RBAC: admin token can list admin users → 200, sanitized', async () => {
  const data = await login(ctx.base, 'admin', 'Admin@123');
  const res = await request(ctx.base, '/admin/users', { token: data.accessToken });
  assert.equal(res.status, 200);
  assert.ok(!JSON.stringify(res.body.data).includes('passwordHash'));
});

test('password reset: admin can reset, student cannot; new password works', async () => {
  // student attempts reset → 403
  const student = await login(ctx.base, 'student', 'Student@123');
  const denied = await request(ctx.base, '/auth/reset-password', {
    method: 'POST',
    token: student.accessToken,
    body: { userId: 'usr-004', newPassword: 'Hacked@123' },
  });
  assert.equal(denied.status, 403);

  // too-short password → 400
  const admin = await login(ctx.base, 'admin', 'Admin@123');
  const invalid = await request(ctx.base, '/auth/reset-password', {
    method: 'POST',
    token: admin.accessToken,
    body: { userId: 'usr-004', newPassword: 'short' },
  });
  assert.equal(invalid.status, 400);

  // successful reset → login with the new password works
  const ok = await request(ctx.base, '/auth/reset-password', {
    method: 'POST',
    token: admin.accessToken,
    body: { userId: 'usr-004', newPassword: 'NewPass@123' },
  });
  assert.equal(ok.status, 200);
  const reLogin = await request(ctx.base, '/auth/login', { method: 'POST', body: { username: 'accountant', password: 'NewPass@123' } });
  assert.equal(reLogin.status, 200);
  assert.equal(reLogin.body.data.user.username, 'accountant');
});

test('unknown route → 404 NOT_FOUND envelope', async () => {
  const admin = await login(ctx.base, 'admin', 'Admin@123');
  const res = await request(ctx.base, '/nope/does-not-exist', { token: admin.accessToken });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'NOT_FOUND');
});

test('teardown — stop server', async () => { await stopServer(ctx.server); });