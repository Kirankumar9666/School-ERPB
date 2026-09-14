import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * Reusable modal dialog. Click outside (overlay), ✕ or Esc to close.
 * Keyboard support: the panel receives focus when opened, Tab is trapped
 * inside while it is open, and focus returns to the trigger element on
 * close. Body scroll is locked for the lifetime of the dialog.
 * @param {string} title     - modal heading (also the accessible name)
 * @param {node} children    - body content
 * @param {node} [footer]    - optional footer actions
 * @param {function} onClose - called when the modal should close
 * @param {boolean} [wide]   - wider panel for tables/rosters
 * @param {{current: HTMLElement|null}} [returnFocusRef] - element to refocus on close
 */
export default function Modal({ title, children, footer, onClose, wide = false, returnFocusRef = null }) {
  const panelRef = useRef(null);
  // Latest-ref pattern: handlers stay fresh without re-running the setup effect
  // (which would steal focus back to the first element on every parent render).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const returnFocusRef2 = useRef(returnFocusRef);
  returnFocusRef2.current = returnFocusRef;

  useEffect(() => {
    const panel = panelRef.current;
    // Latest-ref reads are deliberate: they must resolve at effect-run/cleanup
    // time, not at first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const returnRefAtMount = returnFocusRef2.current;
    const previouslyFocused = returnRefAtMount?.current || document.activeElement;

    const focusables = () =>
      Array.from(panel.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null);

    focusables()[0]?.focus();

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
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

    document.addEventListener('keydown', onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const target = returnFocusRef2.current?.current || previouslyFocused;
      if (target && typeof target.focus === 'function' && target.isConnected) target.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal${wide ? ' modal--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : 'Dialog'}
        ref={panelRef}
      >
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button className="btn btn-secondary btn-sm" onClick={onClose} aria-label="Close dialog">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}