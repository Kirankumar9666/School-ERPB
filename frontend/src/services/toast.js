/**
 * App toasts — one helper for every success / validation / failure message.
 *
 * Screens used to import `react-hot-toast` directly, which produced two bugs
 * visible on the Announcements form:
 *
 *  1. **Duplicates stacked.** Every call pushed a brand-new toast, so mashing
 *     "Publish Announcement" with an empty title queued a separate copy of
 *     "Title is required" per click. Here each message is fired under a stable
 *     id derived from its own text, so an identical message *updates* the toast
 *     already on screen (react-hot-toast restarts its dismiss timer) instead of
 *     stacking a second copy — while a genuinely different message still gets
 *     its own toast.
 *  2. **Unstyled and in the wrong place.** The library's default rendering is a
 *     plain white box pinned to the viewport's top-right corner, which sits on
 *     top of the sticky header bar and the live clock. The presentation is now
 *     ours: `.toast` in styles/components.css reuses the same cream surface +
 *     coloured left accent as `.att-note` / `.announcement-card`, and
 *     `ToastHost` anchors the stack below the measured header height.
 *
 * Every toast auto-dismisses (see TOAST_MS) and carries a ✕ control, so nothing
 * persists indefinitely. Call sites keep the familiar `toast.error(msg)` /
 * `toast.success(msg)` shape — only the import path changes.
 */
import rht from 'react-hot-toast';

/** How long a toast stays before it dismisses itself. */
export const TOAST_MS = 4000;

/**
 * A stable id for a message, so repeats collapse into the visible toast.
 * The kind is part of the id: a success and an error never merge, even if a
 * screen ever shows the same sentence for both.
 */
const idFor = (kind, message) => `toast-${kind}-${String(message).trim()}`;

/**
 * Fire `fn`'s toast under the shared id, so a repeat collapses onto the toast
 * already on screen instead of stacking a second copy.
 */
const fire = (kind, fn) => (message, options = {}) => {
  const text = typeof message === 'string' ? message.trim() : String(message ?? '');
  if (!text) return '';
  return fn(text, {
    ...options,
    id: options.id || idFor(kind, text),
    // The dismiss timer restarts on an update, so a repeated validation
    // message keeps itself readable for a full duration from the last click
    // rather than vanishing on the original click's schedule.
    duration: options.duration ?? TOAST_MS,
  });
};

/**
 * The toast API. Deliberately the same shape as the library's default export so
 * a call site is only ever an import-path change.
 */
export const toast = {
  error: fire('error', rht.error),
  success: fire('success', rht.success),
  /**
   * Dismiss every toast, or just the one(s) showing `message`. The text is
   * matched against both kinds, so a caller never has to remember which one it
   * raised.
   */
  dismiss: (message) => {
    if (message === undefined) return rht.dismiss();
    rht.dismiss(idFor('error', message));
    return rht.dismiss(idFor('success', message));
  },
  remove: rht.remove,
};

export default toast;
