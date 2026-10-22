import { useEffect, useState } from 'react';

/**
 * A clock that ticks, for anything whose text is a function of "now".
 *
 * Returns epoch milliseconds, refreshed every `intervalMs`, starting immediately.
 *
 * Why it exists: a countdown that is computed once at render is only correct for
 * as long as the page sits still, and a countdown that starts its own timer when
 * the component mounts resets every time the user navigates back to the page. So
 * every such value in this app is derived from `savedAt` (a real timestamp from
 * the server) and this clock — the only thing that ticks is the reading of the
 * current time, never a counter of elapsed seconds kept in state. Reloading the
 * page therefore shows the same remaining time it would have shown without the
 * reload, because both are measuring the same two real instants.
 *
 * `intervalMs` defaults to 30 s: fine enough that a "23 hours left" label and the
 * moment a window actually closes are both close to the truth, coarse enough that
 * a page with a roster grid does not re-render every second. Pass 0 to freeze it
 * (a static "saved 3 days ago" has nothing to tick).
 *
 * The reading is initialised at mount and re-read on every tick, so the value can
 * be at most `intervalMs` behind the real clock — and that is a deliberate,
 * stated tolerance rather than a drift that accumulates: nothing here is
 * decremented, so the error is always one tick wide no matter how long the page
 * is left open.
 */
export function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!intervalMs) return undefined;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}

export default useNow;
