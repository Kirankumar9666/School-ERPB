/**
 * Audit log store — in-memory record of every successful mutating action
 * performed through the admin API (who, what, when).
 *
 * SECURITY: recordAudit never captures request bodies or query strings, so
 * passwords/tokens can never leak into the log. Entries are capped to keep
 * memory bounded. In production this maps to an `audit_log` table.
 */
const MOCK_AUDIT_LOG = [];
const MAX_AUDIT_ENTRIES = 500;

/**
 * Record an admin action.
 * @param {import('express').Request} req - request (actor taken from req.user)
 * @param {{entityType: string, entityId?: string|null, message?: string}} event
 */
function recordAudit(req, { entityType, entityId = null, message = '' }) {
  MOCK_AUDIT_LOG.unshift({
    id: `aud-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    actor: {
      id: req.user?.id || null,
      username: req.user?.username || 'unknown',
      role: req.user?.role || 'unknown',
    },
    method: req.method,
    route: message || req.originalUrl,
    entityType,
    entityId,
  });
  if (MOCK_AUDIT_LOG.length > MAX_AUDIT_ENTRIES) {
    MOCK_AUDIT_LOG.length = MAX_AUDIT_ENTRIES;
  }
}

module.exports = { MOCK_AUDIT_LOG, recordAudit, MAX_AUDIT_ENTRIES };