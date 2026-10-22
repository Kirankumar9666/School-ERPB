import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Toaster, toast as rht } from 'react-hot-toast';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { TOAST_MS } from '../services/toast';

/**
 * ToastHost — the single place toasts are mounted and presented.
 *
 * It takes over two things the library does not do well on its own:
 *
 *  1. **Positioning.** The library anchors its stack to the viewport's top-right
 *     corner, which lands directly on top of the sticky `.navbar` and the live
 *     clock. This component measures the real header and publishes its height as
 *     the `--navbar-h` custom property, which `.toast-stack` offsets itself by —
 *     so the stack sits just under the header, whatever height it happens to be
 *     (it wraps to two rows on a phone). Re-measuring per navigation covers the
 *     portal pages that have a header and the login page that has none.
 *  2. **Appearance.** Rendering each toast through the `children` prop replaces
 *     the library's built-in bar (a generic white box with a red ✗) with this
 *     app's own: a cream surface and coloured left accent, matching `.att-note`
 *     and `.announcement-card`, using the lucide icons the rest of the UI uses,
 *     and a real ✕ button on every toast so it can be dismissed immediately
 *     instead of waiting out its timer. The library keeps doing what it is good
 *     at — stacking, offsets, enter/exit and the auto-dismiss timer.
 *
 * The per-message dedup that stops duplicate messages stacking lives in
 * `services/toast.js`, where toasts are fired: each message carries a stable id,
 * so a repeat updates the toast already on screen (restarting its timer)
 * rather than queueing a second copy.
 */

/** Publish the header's measured height so the toast stack can clear it. */
const publishHeaderHeight = (el) => {
  const px = el ? Math.round(el.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--navbar-h', `${px}px`);
};

/** One toast, in the app's own style. `t` is react-hot-toast's toast object. */
function ToastBar({ t }) {
  const Icon = t.type === 'error' ? AlertCircle : t.type === 'success' ? CheckCircle2 : Info;

  return (
    <div
      className={`toast toast--${t.type}`}
      data-visible={String(Boolean(t.visible))}
      role={t.type === 'error' ? 'alert' : 'status'}
    >
      <Icon size={16} className="toast-icon" aria-hidden="true" />
      <div className="toast-msg">{t.message}</div>
      <button
        type="button"
        className="toast-close"
        onClick={() => rht.dismiss(t.id)}
        aria-label="Dismiss notification"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export default function ToastHost() {
  const { pathname } = useLocation();

  // Re-measure per route: the header belongs to ProtectedLayout, so it mounts
  // and unmounts with the navigation.
  useEffect(() => {
    const navbar = document.querySelector('.navbar');
    publishHeaderHeight(navbar);
    if (!navbar) return undefined;

    const observer = new ResizeObserver(() => publishHeaderHeight(navbar));
    observer.observe(navbar);
    return () => observer.disconnect();
  }, [pathname]);

  return (
    <Toaster
      position="top-right"
      toastOptions={{ duration: TOAST_MS }}
      containerClassName="toast-stack"
      // The library writes `top/left/right` on the container as inline styles,
      // which outrank any class rule — so the values are read from the custom
      // properties that components.css defines (and the phone media query
      // overrides). This is what keeps the stack below the header bar.
      containerStyle={{
        top: 'var(--toast-top)',
        left: 'var(--toast-inset)',
        right: 'var(--toast-inset)',
        bottom: 'auto',
      }}
    >
      {(t) => <ToastBar t={t} />}
    </Toaster>
  );
}
