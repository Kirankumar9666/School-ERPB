import { useCallback, useMemo, useRef } from 'react';

/**
 * Lets several async requests overlap but only lets the newest one win.
 *
 * Every call to `next()` returns a token; pass it to `isLatest(token)` when the
 * work comes back and it answers "is this still the one the page is waiting
 * for?". Anything that resolved after a newer request started is reported as
 * stale, so the caller can drop it instead of letting it overwrite newer truth.
 *
 * Why this exists: a page that fetches on load AND on a click can easily have
 * two requests in flight, and the responses can come back in either order. When
 * the loser is written to state the result is not a harmless flicker — a
 * response for "just the class" landing after "this class plus this exam" leaves
 * the two halves of the form disagreeing about which exam is open. Discarding
 * the superseded response is the only way to keep them consistent.
 *
 * The counter is a ref rather than state on purpose: it must be readable and
 * writable synchronously inside the same callback that starts the request, and
 * it must never itself trigger a render — no component should re-render because
 * a request number changed.
 *
 * The returned object is memoised so it keeps ONE identity for the life of the
 * component. That matters more than it looks: callers put it in `useCallback`
 * and `useEffect` dependency lists, and a fresh object each render would make
 * every one of those hooks re-fire on every render — which for a hook that
 * loads data on mount means an endless reload loop.
 */
export function useLatestRequest() {
  const latest = useRef(0);

  /** Start a new request and get the token that identifies it. */
  const next = useCallback(() => {
    latest.current += 1;
    return latest.current;
  }, []);

  /** Has a newer request been started since this token was issued? */
  const isLatest = useCallback((token) => token === latest.current, []);

  return useMemo(() => ({ next, isLatest }), [next, isLatest]);
}

export default useLatestRequest;
