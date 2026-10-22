/**
 * Global error-handler behaviour.
 *
 * Body-parser failures are the caller's mistake, not the server's. Before this
 * test existed the global handler in src/app.js answered every throw with
 * 500 SERVER_ERROR, so a client that sent malformed JSON (or a body over the
 * 1mb limit) got a "broken server" response and an [ERROR] line in production
 * logs. These tests pin the 4xx mapping and, just as importantly, prove that a
 * genuine unexpected error still reports 500 — the fix must not turn real
 * server faults into client errors.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer } = require('./helpers');

let ctx;

test('setup — boot API', async () => { ctx = await startServer(); });

/**
 * fetch with a RAW body — the shared `request` helper JSON-stringifies, which
 * cannot express malformed JSON. This one sends the bytes exactly as given.
 */
const raw = async (path, { method = 'POST', headers = {}, body } = {}) => {
  const res = await fetch(`${ctx.base}${path}`, { method, headers, body });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
};

test('malformed JSON → 400 INVALID_JSON, not a 500', async () => {
  const res = await raw('/auth/login', {
    headers: { 'Content-Type': 'application/json' },
    body: '{bad json',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, 'INVALID_JSON');
});

test('body over the 1mb limit → 413 PAYLOAD_TOO_LARGE, not a 500', async () => {
  const res = await raw('/auth/login', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'x'.repeat(1_200_000), password: 'y' }),
  });
  assert.equal(res.status, 413);
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, 'PAYLOAD_TOO_LARGE');
});

test('a well-formed but invalid body is still a 400 VALIDATION_ERROR', async () => {
  const res = await raw('/auth/login', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('an unknown route is still a clean 404 envelope', async () => {
  const res = await raw('/does/not/exist', { method: 'GET' });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'NOT_FOUND');
});

/* ---- The rule itself: what counts as a client error -------------------------
   Tested directly against the exported helper so every throw shape is covered,
   including ones a live request cannot easily produce. */
test('clientErrorFor maps known body-parser types and leaves real faults alone', () => {
  const { clientErrorFor } = require('../src/app');

  assert.deepEqual(clientErrorFor({ type: 'entity.parse.failed' }), [400, 'INVALID_JSON']);
  assert.deepEqual(clientErrorFor({ type: 'entity.too.large' }), [413, 'PAYLOAD_TOO_LARGE']);
  assert.deepEqual(clientErrorFor({ type: 'encoding.unsupported' }), [415, 'UNSUPPORTED_ENCODING']);
  assert.deepEqual(clientErrorFor({ type: 'request.aborted' }), [400, 'REQUEST_ABORTED']);

  // Any other 4xx-carrying error is a client error, without a bespoke mapping.
  assert.deepEqual(clientErrorFor({ status: 422 }), [422, 'BAD_REQUEST']);
  assert.deepEqual(clientErrorFor({ statusCode: 404 }), [404, 'BAD_REQUEST']);

  // A genuine fault (no status, or a 5xx) must NOT be treated as a client error.
  assert.equal(clientErrorFor(new Error('kaboom')), null);
  assert.equal(clientErrorFor({ status: 500 }), null);
  assert.equal(clientErrorFor({ statusCode: 503 }), null);
  // `undefined`/null must not throw — a rethrow can carry anything.
  assert.equal(clientErrorFor(undefined), null);
  assert.equal(clientErrorFor(null), null);
});

test('a genuine server error through the real handler still reports 500', async () => {
  // Build a minimal app from the REAL exported handler so an unexpected
  // (status-less) throw is answered by the same code production uses.
  const express = require('express');
  const { globalErrorHandler } = require('../src/app');
  const probe = express();
  probe.get('/boom', () => { throw new Error('unexpected failure'); });
  probe.use(globalErrorHandler);
  const probeServer = probe.listen(0);
  await new Promise((resolve) => probeServer.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${probeServer.address().port}/boom`);
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.code, 'SERVER_ERROR');
    assert.equal(body.success, false);
    // No stack trace leaks to the client.
    assert.equal(body.stack, undefined);
  } finally {
    probeServer.closeAllConnections?.();
    await new Promise((resolve) => probeServer.close(resolve));
  }
});

test('teardown — stop server', async () => { await stopServer(ctx.server); });
