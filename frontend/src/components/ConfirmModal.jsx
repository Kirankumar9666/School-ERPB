import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { TriangleAlert, X } from 'lucide-react';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * Reusable styled confirmation dialog — replaces every native window.confirm()
 * / window.alert() in the app. Same portal + centered-panel chrome as `Modal`
 * (see components.css MODAL section), plus:
 *
 *   - a gold warning icon in the header and a single clear action pair
 *     (cancel = outline, confirm = solid danger or primary);
 *   - STACKED-MODAL support: it renders above an already-open `Modal`
 *     (`.confirm-overlay` z-index 120 vs the modal's 100), so an in-progress
 *     form stays visible-but-dimmed behind it and keeps its state. Its
 *     keydown handler runs in the CAPTURE phase and calls
 *     stopImmediatePropagation, so Esc closes only this dialog (returning to
 *     the untouched form behind) and Tab is trapped only inside it — the
 *     modal underneath never sees those keys while the confirm is open.
 *
 * @param {string}   title         - dialog heading (also the accessible name)
 * @param {node}     children      - body: message text and/or conflict list
 * @param {function} onClose       - cancelled (Esc / backdrop / ✕ / Cancel)
 * @param {function} onConfirm     - confirmed ("Add Anyway" / "Delete" / …)
 * @param {string}   [confirmLabel] - action button label (default 'Confirm')
 * @param {string}   [cancelLabel]  - cancel button label (default 'Cancel')
 * @param {'danger'|'primary'} [tone] - confirm button style (default 'danger')
 * @param {boolean}  [busy]        - disables both buttons while onConfirm runs
 */
export default function ConfirmModal({
  title,
  children,
  onClose,
  onConfirm,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  busy = false,
}) {
  const panelRef = useRef(null);
  // Latest-ref pattern: handlers stay fresh without re-running the mount effect.
  // Synced in an effect (not during render) — refs must not be written while rendering.
  const onCloseRef = useRef(onClose);
  const onConfirmRef = useRef(onConfirm);
  useEffect(() => {
    onCloseRef.current = onClose;
    onConfirmRef.current = onConfirm;
  });

  useEffect(() => {
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement;

    const focusables = () =>
      Array.from(panel.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null);

    // The safe default (Cancel in the footer, or the ✕) gets initial focus —
    // confirm is the destructive path, so it is never auto-focused.
    (panel.querySelector('.modal-footer .btn-secondary') || focusables()[0])?.focus();

    // Capture phase + stopImmediatePropagation: an open `Modal` underneath also
    // listens on document for Esc/Tab. This dialog must consume those keys
    // first so only the topmost layer reacts while stacked.
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      e.stopImmediatePropagation();
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const outside = !panel.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      if (previouslyFocused && typeof previouslyFocused.focus === 'function' && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, []);

  return createPortal(
    <div
      className="modal-overlay confirm-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : 'Confirmation'}
        ref={panelRef}
      >
        <div className="modal-header">
          <div className="confirm-head">
            <div className="confirm-icon">
              <TriangleAlert size={18} />
            </div>
            <div className="modal-title">{title}</div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={onClose} aria-label="Close dialog">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            className={`btn ${tone === 'primary' ? 'btn-primary' : 'btn-danger'}`}
            onClick={() => onConfirmRef.current()}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
