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

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['error'] : ['error', 'warn'],
}).$extends({
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
