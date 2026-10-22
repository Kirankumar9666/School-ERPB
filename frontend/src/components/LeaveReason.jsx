import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import Modal from './Modal';
import { LEAVE_STATUS_BADGE } from '../utils/leave';
import { shortDate } from '../utils/date';

/** 'sick' → 'Sick' — the leave type is a lowercase LeaveType enum value. */
const typeLabel = (type) => (type ? type.charAt(0).toUpperCase() + type.slice(1) : '—');

/**
 * Clamped long text with a "View more" link that appears only when the text is
 * genuinely clipped — and only that.
 *
 * The overflow test is a real measurement, never a character count. How much
 * text fits in two lines depends on the font that actually loaded, the column
 * width the table happened to give this row, the user's font-size setting and
 * the zoom level, so any fixed threshold is wrong somewhere: too low and short
 * reasons grow a useless link, too high and a clipped reason gets no link at
 * all. Measuring `scrollHeight` against `clientHeight` on the clamped box asks
 * the only question that matters — "is there more text than I am showing?" —
 * and it re-asks whenever the answer could have changed:
 *
 *   - the text itself changed (the effect re-runs on `text`)
 *   - the box was resized, at any depth (ResizeObserver on the clamped element,
 *     which fires for column-width changes as well as window changes)
 *   - the viewport changed (window resize, belt and braces for browsers or
 *     zoom paths where the observer's threshold is not crossed)
 *   - a webfont finished loading *after* first paint, which re-flows the text
 *     with different metrics (document.fonts.ready)
 *
 * State updates with an identical value are a no-op in React, so re-measuring
 * on every resize cannot cause a render loop even though showing the link
 * changes the row's height.
 *
 * @param {string}  text              the full, untruncated text
 * @param {function} [onOpen]         called with the trigger element when "View more" is clicked
 * @param {number}  [lines]           how many lines to clamp to (default 2)
 * @param {string}  [className]       extra class on the clamped text element
 * @param {string}  [linkLabel]       the link's wording
 * @param {string}  [ariaLabel]       the link's accessible name
 */
export function ClampableText({
  text,
  onOpen,
  lines = 2,
  className = '',
  linkLabel = 'View more',
  ariaLabel,
}) {
  const [clipped, setClipped] = useState(false);
  const boxRef = useRef(null);
  const triggerRef = useRef(null);
  const value = String(text ?? '');

  // One measurement function, used by every trigger below. `scrollHeight` is the
  // height the text would occupy unclamped, `clientHeight` the height of the
  // 2-line box, so "is there more text than I am showing?" is answered directly.
  // The 1px tolerance absorbs sub-pixel rounding at fractional zoom levels and
  // fractional font sizes, where a two-line box can report a hair more than its
  // own content — that is not a clip.
  const measure = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- measuring rendered layout
    setClipped(el.scrollHeight > el.clientHeight + 1);
  }, []);

  useEffect(() => {
    measure();

    // A zero-height element (display:none ancestor, or a not-yet-laid-out mount)
    // reports 0/0, which is not clipped — correct, and it re-measures when the
    // `ResizeObserver` below fires as soon as it gets a real box.
    // `ResizeObserver` on the clamped element is the primary trigger: it fires
    // when the element's own box changes size, which covers a column-width
    // change (a wider table, a different page padding) as well as a window
    // resize. The window listener is the fallback, and also covers zoom changes
    // that alter the layout viewport without resizing this element.
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(boxRef.current);
      window.addEventListener('resize', measure);
      return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure, value, lines]);

  // Webfonts arrive after first paint and change the metrics, so a reason that
  // fitted at first render can overflow once the real face is applied.
  useEffect(() => {
    const fonts = document.fonts;
    if (!fonts?.ready) return undefined;
    let live = true;
    fonts.ready.then(() => { if (live) measure(); }).catch(() => {});
    return () => { live = false; };
  }, [measure, value]);

  const open = () => {
    if (onOpen) onOpen(triggerRef.current);
  };

  return (
    <div className="clamp">
      <div
        ref={boxRef}
        className={`clamp-text${className ? ` ${className}` : ''}`}
        style={{ '--clamp-lines': lines }}
      >
        {value}
      </div>
      {clipped && (
        <button
          ref={triggerRef}
          type="button"
          className="clamp-more"
          onClick={open}
          aria-label={ariaLabel || `View more: ${value.slice(0, 60)}`}
        >
          {linkLabel}
        </button>
      )}
    </div>
  );
}

/**
 * The "Leave Reason" popup: the whole reason, plus just enough context to know
 * which request it belongs to.
 *
 * The context comes entirely from the leave record that was passed in — there is
 * no separate lookup and no hardcoded text, so an employee and an admin looking
 * at the same request see the same facts. `variant="admin"` adds the two things
 * only an admin has: who submitted it, and the decision buttons.
 *
 * The admin's Approve/Reject buttons are the caller's own handlers passed
 * straight through, not a second copy of the decision logic, so deciding from
 * inside the popup and deciding from the list are the same code path by
 * construction. Because a decision removes the row from the pending list, the
 * parent unmounts this popup on its own once the decision lands.
 *
 * @param {object} leave     the real leave record (id/type/fromDate/toDate/reason/status/appliedAt)
 * @param {function} onClose called on ✕, backdrop click or Esc
 * @param {string} [variant] 'admin' adds the employee header and the decision buttons
 * @param {function} [onDecide] (leave, 'approved'|'rejected') — required for the admin actions
 * @param {object} [returnFocusRef] element to refocus on close (the "View more" link)
 */
export function LeaveReasonModal({ leave, onClose, variant, onDecide, returnFocusRef }) {
  if (!leave) return null;
  const isAdmin = variant === 'admin';
  const canDecide = isAdmin && typeof onDecide === 'function' && leave.status === 'pending';

  return (
    <Modal
      title="Leave Reason"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      footer={(
        canDecide ? (
          <>
            <button className="btn btn-danger btn-sm" onClick={() => onDecide(leave, 'rejected')}>
              <X size={15} /> Reject
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => onDecide(leave, 'approved')}>
              <Check size={15} /> Approve
            </button>
          </>
        ) : null
      )}
    >
      {/* Who submitted it — admin only, because the employee's own Leave History
          has no second person to disambiguate against. */}
      {isAdmin && (
        <div className="lr-who">
          <div className="lr-who-name">{leave.employeeName || 'Unknown employee'}</div>
          {leave.employeeDesignation && (
            <div className="text-sm text-muted">{leave.employeeDesignation}</div>
          )}
        </div>
      )}

      {/* Context chips, so the admin can decide without re-reading the list.
          Every value is read off the record the caller passed in. */}
      <div className="lr-facts">
        <span className="lr-chip">{typeLabel(leave.type)} Leave</span>
        <span className="lr-chip lr-chip-dates">
          {shortDate(leave.fromDate)} <span className="lr-chip-arrow">→</span> {shortDate(leave.toDate)}
        </span>
        <span className="lr-chip">Applied {shortDate(leave.appliedAt)}</span>
        <span className={`badge ${LEAVE_STATUS_BADGE[leave.status] || 'badge-pending'}`}>
          {leave.status}
        </span>
      </div>

      {/* The full reason, as a plain text CHILD. React escapes it, so a reason
          containing markup is displayed literally and cannot execute — there is
          no `dangerouslySetInnerHTML` or `innerHTML` anywhere in this path.
          `.lr-full` keeps the typed line breaks and wraps unbroken strings, and
          the modal body (not the panel) is what scrolls, so the header and the
          ✕ button stay put when the reason is tall. */}
      <div className="lr-full">{leave.reason}</div>
    </Modal>
  );
}

/**
 * The Reason cell for a leave table/list row: the clamped text, the conditional
 * "View more" link, and the popup it opens.
 *
 * One component for both portals so the clamp, the overflow test and the popup
 * can never drift apart. Self-contained: the open/close state and the focus
 * restoration live here, so a caller only has to supply the record — plus, for
 * the admin variant, its decision handler.
 */
export default function LeaveReasonCell({ leave, variant, onDecide, className }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const rootRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);

  // Focus returns to the "View more" link. The one case where that link is gone:
  // the popup locks body scroll, but a window resize while it is open can widen
  // the column enough to un-clip the reason, which unmounts the link. Falling back
  // to the cell keeps focus inside the table instead of dumping it on <body>.
  // `tabIndex={-1}` makes the cell focusable without adding a tab stop.
  const returnRef = useMemo(() => ({
    get current() {
      const el = triggerRef.current;
      return el && el.isConnected ? el : rootRef.current;
    },
  }), []);

  return (
    <div className={className || undefined} ref={rootRef} tabIndex={-1}>
      <ClampableText
        text={leave?.reason}
        onOpen={(el) => { triggerRef.current = el; setOpen(true); }}
        ariaLabel={`View the full reason for this ${typeLabel(leave?.type).toLowerCase()} leave request`}
      />
      {open && (
        <LeaveReasonModal
          leave={leave}
          variant={variant}
          onDecide={onDecide}
          returnFocusRef={returnRef}
          onClose={close}
        />
      )}
    </div>
  );
}
