/**
 * Marks Entry edit-window helpers — the browser's half of the teacher's
 * 48-hour rule.
 *
 * The rule itself lives on the server (services/marks.js): every mark a teacher
 * saves records when THEY saved it, and the save endpoint refuses the batch
 * 48 hours later. Nothing here decides whether a save is allowed. What this file
 * does is take the real `teacherSavedAt` the API returns and answer two display
 * questions against the real current time — "how long is left?" and "is it still
 * open?" — so the page can show a live countdown and grey out the inputs at the
 * right moment.
 *
 * Two things are deliberately NOT done here:
 *
 *   - No duration is hardcoded in a component. `MARKS_EDIT_WINDOW_MS` is the one
 *     place the length is written down, mirroring the server's own constant the
 *     same way `LEAVE_REASON_MAX` mirrors its `max(500)`. Frontend and backend
 *     are separate packages with no shared module, so the duplication is the
 *     price of not having a third one; a component that inlined "48 * 60 * 60 *
 *     1000" would be a third copy to keep in step.
 *
 *   - No timer is counted. `editRemainingMs()` subtracts two real instants every
 *     time it is called, so a page left open for a day, reloaded, or closed and
 *     reopened days later all agree about how much is left. A `setInterval` that
 *     decremented a counter would drift from the truth and would restart at 48
 *     hours on every mount.
 */

/**
 * How long a teacher may keep correcting marks they saved, in ms.
 * Mirrors `MARKS_TEACHER_EDIT_WINDOW_MS` in backend/src/services/marks.js.
 */
export const MARKS_EDIT_WINDOW_MS = 48 * 60 * 60 * 1000;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Milliseconds left before this batch locks, from its real save time.
 *
 * Returns null when there is nothing to count from — no `teacherSavedAt` means no
 * teacher has ever saved the batch (a marks set only the office entered, or a
 * brand-new exam), so there is no window to close and nothing to count down.
 * Returns 0 — not a negative number — once the window is over, so callers can
 * treat "locked" and "just locked" identically instead of each re-deriving that.
 */
export function editRemainingMs(savedAt, now = Date.now()) {
  if (!savedAt) return null;
  const anchor = new Date(savedAt).getTime();
  if (Number.isNaN(anchor)) return null;
  return Math.max(0, anchor + MARKS_EDIT_WINDOW_MS - now);
}

/** Has this batch's window closed? The same test the server makes, on the same data. */
export const isEditLocked = (savedAt, now = Date.now()) =>
  editRemainingMs(savedAt, now) === 0;

/**
 * The long form, for prose: "1 day 23 hours", "23 hours", "under a minute".
 * Rounded DOWN, so the label never promises time that is already gone.
 */
export function formatEditRemaining(ms) {
  if (ms === null) return '';
  if (ms <= 0) return 'no time left';
  if (ms < MINUTE) return 'under a minute';
  if (ms < HOUR) {
    const m = Math.floor(ms / MINUTE);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  if (days === 0) return `${hours} hour${hours === 1 ? '' : 's'}`;
  if (hours === 0) return `${days} day${days === 1 ? '' : 's'}`;
  return `${days} day${days === 1 ? '' : 's'} ${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * The short form for a badge: "1d 23h", "23h", "1h", "under 1h".
 * Same rounding as the long form — the badge must not claim more time than is
 * left, or it would contradict the sentence next to it.
 */
export function shortEditRemaining(ms) {
  if (ms === null) return '';
  if (ms < HOUR) return 'under 1h';
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  if (days === 0) return `${hours}h`;
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/** "Locked" — the one word shown wherever a closed window has to be named. */
export const EDIT_LOCKED_LABEL = 'Locked';

/**
 * Upper bound on Max Marks and on a single obtained mark. Mirrors `MARKS_MAX`
 * in backend/src/services/marks.js, for the same reason the window does: the
 * bound is written down once per package, never re-derived in a component.
 */
export const MARKS_MAX = 10000;

/**
 * Validate one "Obtained" cell against Max Marks.
 *
 * Shared by the Employee Portal's roster grid and the Admin Panel's batch
 * editor, because it is ONE rule about a mark and both places must draw it the
 * same line — a value the teacher page accepts but the admin page rejects (or the
 * reverse) is not a difference of opinion, it is a bug in one of them.
 *
 * `empty` is a legitimate state, not an error: a student who was absent has no
 * mark, and a blank cell must never be written as a zero. `maxMarks` may be NaN,
 * which means "Max Marks is not a usable number yet" — the upper bound is then
 * simply not checked here, and the Max Marks field reports its own problem.
 *
 * Feedback, not the control: the server validates every one of these bounds again
 * on save (see `adminClassMarkEntrySchema` / `teacherMarksSchema`).
 */
export function parseObtained(raw, maxMarks) {
  const text = String(raw ?? '').trim();
  if (text === '') return { state: 'empty' };
  // A leading '-' is allowed through the format test on purpose, so a typed "-5"
  // gets told it is below zero rather than being told it is not a number.
  if (!/^-?\d+$/.test(text)) return { state: 'invalid', reason: 'Whole numbers only' };
  const value = Number(text);
  if (value < 0) return { state: 'invalid', reason: 'Cannot be below 0' };
  if (value > MARKS_MAX) return { state: 'invalid', reason: `Cannot be more than ${MARKS_MAX}` };
  if (maxMarks >= 1 && value > maxMarks) return { state: 'invalid', reason: `Cannot exceed ${maxMarks}` };
  return { state: 'ok', value };
}
