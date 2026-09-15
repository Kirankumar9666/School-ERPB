/**
 * Minimal in-memory TTL cache (no external dependency).
 *
 * Scope: single-instance reference data that is read on every page load but
 * changes rarely — class options, dashboard summary counters. NEVER used for
 * per-user or security-sensitive data. Every key is namespaced by prefix so
 * `del(prefix)` can invalidate one namespace (all namespaced keys are cleared
 * whenever an admin mutation lands, keeping staleness bounded and predictable).
 *
 * Multi-instance note: this cache is per-process. Horizontal scaling would
 * need a shared store (Redis) — flagged in the perf audit, intentionally not
 * introduced while a single instance serves the load.
 */
const DEFAULT_TTL_MS = 30_000;

const store = new Map(); // key → { value, expiresAt }

/** Returns the cached value, or undefined when missing/expired. */
const get = (key) => {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
};

/** Stores a value under key for ttlMs (default 30s). */
const set = (key, value, ttlMs = DEFAULT_TTL_MS) => {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
};

/** Deletes every key starting with the given prefix ('' clears everything). */
const del = (prefix = '') => {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
};

module.exports = { get, set, del, DEFAULT_TTL_MS };
