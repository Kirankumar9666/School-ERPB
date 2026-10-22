import api from '../services/api';

/**
 * Reminders cache — fetch once per session, then once every few minutes.
 *
 * ## Why this exists
 *
 * Every page in every portal mounts `ReminderPopup` (in ProtectedLayout), and
 * the Attendance/Calendar pages mount `ReminderSection` and read reminders
 * again. Navigating around the app therefore issued a `GET /school/reminders`
 * on EVERY page transition — a chatty call that, multiplied across a school
 * sharing one IP, helped exhaust the general API rate limit for no benefit:
 * a user's own reminders barely change between one click and the next.
 *
 * One module-level cache now serves them all. The first caller triggers the
 * fetch; every caller after it (for the next few minutes) gets the same data
 * without a request. Writes (set/delete) invalidate the cache so the change is
 * visible immediately, and a timer refreshes in the background so a change made
 * in another tab is picked up without a page reload.
 *
 * It is deliberately NOT a general-purpose cache: it holds exactly one list
 * (the signed-in user's own reminders), keyed to nothing else, and the server
 * scopes that list to the caller. Logging out/in is handled by clearing it (see
 * `resetRemindersCache`), so one user's list can never be shown to the next.
 */

/** How long a fetched list stays fresh before a background refetch. A few
 *  minutes: long enough to kill page-navigation chatter, short enough that a
 *  reminder added elsewhere shows up without a reload. */
const TTL_MS = 3 * 60 * 1000;

/** @type {{ data: Array|null, at: number, inflight: Promise<Array>|null }} */
let cache = { data: null, at: 0, inflight: null };

/** Listeners to notify when a background refresh brings new data. */
const listeners = new Set();

const notify = (data) => { listeners.forEach((fn) => fn(data)); };

/** Is the cached list still within its freshness window? */
const isFresh = () => cache.data !== null && (Date.now() - cache.at) < TTL_MS;

/**
 * Read the signed-in user's reminders, using the cache when fresh.
 * @param {object} [opts]
 * @param {boolean} [opts.force] skip the cache and refetch
 * @returns {Promise<Array>}
 */
export const getReminders = async ({ force = false } = {}) => {
  if (!force && isFresh()) return cache.data;
  if (cache.inflight) return cache.inflight;

  cache.inflight = api.get('/school/reminders')
    .then((r) => {
      const data = r.data.data || [];
      cache = { data, at: Date.now(), inflight: null };
      if (force) notify(data);
      return data;
    })
    .catch((err) => {
      cache.inflight = null;
      // A stale-but-present list beats an error banner for a background read;
      // callers that need to surface the failure use `force` and catch.
      if (cache.data) return cache.data;
      throw err;
    });

  return cache.inflight;
};

/** Invalidate after a write, so the next read reflects it immediately. */
export const invalidateReminders = () => { cache = { ...cache, data: null, at: 0 }; };

/** Subscribe to background refreshes → returns an unsubscribe function. */
export const subscribeReminders = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Drop everything — call on logout so the next user starts clean. */
export const resetRemindersCache = () => {
  cache = { data: null, at: 0, inflight: null };
  listeners.clear();
};

export const REMINDERS_TTL_MS = TTL_MS;
