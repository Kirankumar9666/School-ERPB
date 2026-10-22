import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useSubmitGuard — stop a form's action from being entered twice in quick
 * succession, and report the lockout so the triggering button can be disabled.
 *
 * The Announcements form made this visible: mashing "Publish Announcement" with
 * an empty title ran the same validation once per click, and while the repeated
 * toasts are already collapsed by `services/toast.js`, re-running the check is
 * still wasted work and it left the button looking live while it was busy.
 *
 * The window is deliberately short (default 600ms) rather than the toast's full
 * lifetime: a user who just failed validation needs to fix the field and try
 * again immediately, so the lockout only has to span a burst of clicking — the
 * length of a human double-click — not the four seconds the message stays up.
 *
 * The wrapper preventDefaults the incoming event BEFORE the rate-limit check.
 * That matters on a submit handler: when a second click is throttled away the
 * browser's default form submission would otherwise still fire, because
 * `preventDefault()` inside the guarded function would never be reached. On a
 * plain click it is a harmless no-op.
 *
 * @param {number} [waitMs] Lockout window in milliseconds.
 * @returns {[(fn: Function) => Function, boolean]} `[guard, cooling]` — wrap a
 *   handler with `guard`, and disable the button while `cooling` is true.
 */
export function useSubmitGuard(waitMs = 600) {
  const [cooling, setCooling] = useState(false);
  const until = useRef(0);
  const timer = useRef(null);

  // Clear a pending unlock on unmount so a closed form cannot set state after
  // it is gone.
  useEffect(() => () => clearTimeout(timer.current), []);

  const guard = useCallback(
    (fn) =>
      (event, ...rest) => {
        event?.preventDefault?.();
        if (Date.now() < until.current) return undefined;
        until.current = Date.now() + waitMs;
        setCooling(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCooling(false), waitMs);
        return fn(event, ...rest);
      },
    [waitMs],
  );

  return [guard, cooling];
}

export default useSubmitGuard;
