/**
 * Prisma Client singleton.
 *
 * One shared PrismaClient instance for the whole backend process (creating a
 * client per module would exhaust database connections). Import from here:
 *
 *   const prisma = require('../../services/prisma');
 *
 * The client is extended to transparently retry transient connection errors
 * (the remote Supabase pooler occasionally drops connections). Only clearly
 * transient failures are retried; logic errors fail immediately.
 */
const { PrismaClient } = require('@prisma/client');

const TRANSIENT = ['P1001', 'P1002', 'P1017', "Can't reach database server", 'Server has closed the connection', 'Connection terminated', 'Timed out fetching'];
const isTransient = (err) => TRANSIENT.some((t) => (err?.code && err.code === t) || String(err?.message || '').includes(t));

async function withRetry(fn, attempts = 3, baseDelayMs = 750) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
  throw lastErr;
}

/** Read-only Prisma actions — safe to retry (no side effects) */
const READ_ACTIONS = new Set([
  'findMany', 'findUnique', 'findFirst', 'findUniqueOrThrow', 'findFirstOrThrow',
  'count', 'aggregate', 'groupBy',
]);

/**
 * The URL this process talks to.
 *
 * Under NODE_ENV=test the tests set TEST_DATABASE_URL, and it must win: this
 * client is built before any test file loads its own dotenv, so honouring it
 * here is what puts every query — the app's as much as the seed's — on the test
 * database rather than the developer's. PrismaClient reads DATABASE_URL itself at
 * construction and would otherwise never notice.
 *
 * In every other environment TEST_URL is undefined and Prisma falls back to
 * DATABASE_URL exactly as before, so nothing outside the test run changes.
 */
const TEST_URL = process.env.NODE_ENV === 'test'
  ? (process.env.TEST_DATABASE_URL || process.env.DATABASE_URL)
  : undefined;

const clientOptions = { log: process.env.NODE_ENV === 'production' ? ['error'] : ['error', 'warn'] };
if (TEST_URL) clientOptions.datasources = { db: { url: TEST_URL } };

const prisma = new PrismaClient(clientOptions).$extends({
  query: {
    $allModels: {
      $allOperations({ action, args, query }) {
        // Retry READS only: a lost response on a write may have already
        // committed, so blindly re-running it would duplicate rows (or trip
        // unique constraints). Writes fail fast; the bulk-upload loop does
        // its own safe per-row recovery.
        if (!READ_ACTIONS.has(action)) return query(args);
        return withRetry(() => query(args));
      },
    },
  },
});

module.exports = prisma;
module.exports.isTransientDbError = isTransient;
