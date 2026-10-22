import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Sidebar from './Sidebar';
import Navbar from './Navbar';
import ReminderPopup from './ReminderPopup';
import ForcePasswordChange from './ForcePasswordChange';

/** Viewport width (px) from which the sidebar is pinned open by default. */
const DESKTOP_MIN_WIDTH = 1024;

/** localStorage key remembering the sidebar preference ('open' | 'closed'). */
const SIDEBAR_STORAGE_KEY = 'sidebarOpen';

/** True when the viewport is wide enough for the pinned (push) layout. */
const isDesktopViewport = () => window.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`).matches;

/** Saved preference — null until the user has toggled the sidebar at least once. */
const storedPreference = () => {
  const saved = localStorage.getItem(SIDEBAR_STORAGE_KEY);
  if (saved === null) return null;
  return saved === 'open';
};

/**
 * ProtectedLayout — wraps all authenticated pages.
 * If user is not logged in → redirect to login.
 * If user role is not in allowedRoles → redirect to their home.
 * If the account still uses its school-chosen initial password → show the
 * forced-change screen instead of the portal (the API is blocked for it too).
 *
 * Collapsible sidebar: this layout owns the expanded/collapsed state. Expanded,
 * the panel is pinned open on desktop (pushing the content) or overlays as a
 * dismissable drawer on small screens; collapsed, it shrinks to a pinned
 * icon-only rail on desktop and goes fully off-canvas below the breakpoint —
 * the top bar's hamburger is then the only way back in. A saved desktop
 * preference survives reloads; the mobile drawer always starts closed.
 */
export default function ProtectedLayout({ allowedRoles, navTitle, navSubtitle }) {
  const { user, isAuthenticated, loading } = useAuth();

  /* ---------- Collapsible sidebar ----------
     Pinned open by default on desktop, off-canvas (closed) on smaller screens.
     A saved preference always wins, so the choice survives reloads and route
     changes — the layout stays mounted while admin pages come and go. */
  const [isDesktop, setIsDesktop] = useState(isDesktopViewport);
  // Desktop honours the saved preference (default: expanded). Smaller screens
  // always start CLOSED and never read the saved value — a desktop "expanded"
  // preference would otherwise throw the drawer over every mobile page load.
  const [sidebarOpen, setSidebarOpen] = useState(() => (
    isDesktopViewport() ? (storedPreference() ?? true) : false
  ));
  const sidebarToggleRef = useRef(null);
  /** The top-bar hamburger — the only control that reopens the drawer once the
      panel itself has gone off-canvas, so it owns every focus-return. */
  const menuButtonRef = useRef(null);
  /** Mirror of sidebarOpen for the route effect below: depending on
      `sidebarOpen` itself would make it close the drawer the instant it opened. */
  const sidebarOpenRef = useRef(sidebarOpen);
  const { pathname } = useLocation();

  /**
   * Close the sidebar; optionally hand focus back to the control that can
   * reopen it. That control differs by viewport: on desktop the panel never
   * leaves the screen, so focus stays on its own ☰; below the breakpoint the
   * panel is about to become visibility:hidden, so focus has to move to the top
   * bar's hamburger (which is hidden by CSS on desktop, hence the live
   * matchMedia read rather than the possibly stale `isDesktop` state).
   */
  const closeSidebar = useCallback((restoreFocus = false) => {
    setSidebarOpen(false);
    if (!restoreFocus) return;
    const target = () => (isDesktopViewport()
      ? sidebarToggleRef.current
      : (menuButtonRef.current ?? sidebarToggleRef.current));
    // On mobile, land one frame later — once the backdrop has unmounted — so the
    // new focus target is not momentarily covered (and flashes no focus ring).
    if (isDesktopViewport()) target()?.focus();
    else requestAnimationFrame(() => target()?.focus());
  }, []);

  /**
   * Flip the sidebar. Only desktop toggles are remembered: a drawer left open
   * on a phone must not switch off the pinned-open default on a desktop.
   * Closing routes through closeSidebar so the in-drawer ☰ hands focus back the
   * same way the backdrop, Escape and a nav item do.
   */
  const toggleSidebar = useCallback(() => {
    if (sidebarOpen) {
      if (isDesktopViewport()) localStorage.setItem(SIDEBAR_STORAGE_KEY, 'closed');
      closeSidebar(true);
      return;
    }
    if (isDesktopViewport()) localStorage.setItem(SIDEBAR_STORAGE_KEY, 'open');
    setSidebarOpen(true);
  }, [sidebarOpen, closeSidebar]);

  // Crossing the breakpoint swaps layout modes: the drawer never stays open over
  // the content, and the saved preference returns when there is room to pin it.
  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`);
    const onChange = (event) => {
      setIsDesktop(event.matches);
      setSidebarOpen(event.matches ? (storedPreference() ?? true) : false);
      // Dropping to the mobile layout can hide the control focus is sitting on
      // (the rail's ☰). Park it on the top-bar hamburger — but only after the
      // class swap has painted, or the button is still display:none and
      // focus() silently does nothing.
      if (event.matches) return;
      const sidebar = document.getElementById('app-sidebar');
      if (!sidebar?.contains(document.activeElement)) return;
      requestAnimationFrame(() => menuButtonRef.current?.focus());
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // Small-screen drawer: hold focus inside it, and let Escape dismiss it. Both
  // live in one listener so they cannot drift apart. The guard above means this
  // only ever runs while the drawer is genuinely on screen — closing it, or
  // resizing across the breakpoint, tears the trap down on the same tick.
  useEffect(() => {
    if (!sidebarOpen || isDesktop) return undefined;

    const sidebar = document.getElementById('app-sidebar');
    const focusables = () => (sidebar
      ? Array.from(sidebar.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      )).filter((el) => el.getClientRects().length > 0)
      : []);

    // The drawer opens ON TOP of the page, so focus goes in with it rather than
    // staying on a hamburger the backdrop now covers. First stop is the panel's
    // own ☰ — the drawer's close button.
    focusables()[0]?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSidebar(true);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = sidebar.contains(active);
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sidebarOpen, isDesktop, closeSidebar]);

  // Backdrop up → the page behind it must not scroll. Setting `overflow` on
  // <body> propagates to the viewport; the cleanup restores the previous value
  // on close, on unmount and on a breakpoint change, so no lock is ever left on.
  useEffect(() => {
    if (!sidebarOpen || isDesktop) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [sidebarOpen, isDesktop]);

  // Keep the mirror fresh before the route effect below reads it (effects run
  // in declaration order, so it must be declared first).
  useEffect(() => { sidebarOpenRef.current = sidebarOpen; }, [sidebarOpen]);

  // The mobile drawer never survives a navigation — including ones that do not
  // go through a nav item (browser Back, a programmatic navigate() from a page
  // button). Deliberately keyed on pathname alone and reading the live viewport
  // and the mirror, so it fires on navigation only, never when the drawer opens
  // or when the desktop layout mounts with the panel pinned open.
  useEffect(() => {
    if (!sidebarOpenRef.current || isDesktopViewport()) return;
    closeSidebar(true);
  }, [pathname, closeSidebar]);

  if (loading) {
    return (
      <div className="loading-center" style={{ minHeight: '100vh' }}>
        <div className="spinner" />
      </div>
    );
  }

  if (!isAuthenticated) return <Navigate to="/login" replace />;

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return <Navigate to="/login" replace />;
  }

  /*
   * An account still on the password the school chose for it (a student
   * login provisioned from the guardian contact) may sign in — it has to, in
   * order to replace that password — but may not use the portal. The backend
   * refuses every business endpoint for it anyway, so showing this instead of
   * a sidebar full of failing requests is the honest presentation of the
   * state. Flipping user.mustChangePassword re-renders straight back into the
   * normal layout, with no navigation needed.
   */
  if (user.mustChangePassword) return <ForcePasswordChange />;

  const layoutClass = [
    'app-layout',
    isDesktop ? 'viewport-desktop' : 'viewport-mobile',
    sidebarOpen ? 'sidebar-open' : 'sidebar-closed',
  ].join(' ');

  return (
    <div className={layoutClass}>
      {/* Choosing a link collapses the drawer on small screens; the pinned panel stays */}
      <Sidebar
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
        toggleRef={sidebarToggleRef}
        onNavigate={() => { if (!isDesktop) closeSidebar(true); }}
      />

      {/* Backdrop for the off-canvas drawer — tapping it dismisses the sidebar */}
      {sidebarOpen && !isDesktop && (
        <div className="sidebar-overlay" onClick={() => closeSidebar(true)} aria-hidden="true" />
      )}

      <div className="main-content">
        <Navbar
          title={navTitle}
          subtitle={navSubtitle}
          menuRef={menuButtonRef}
          onToggleMenu={toggleSidebar}
          menuOpen={sidebarOpen}
        />
        <main>
          <Outlet />
        </main>
      </div>

      {/* Due-today reminders for the signed-in user — checked on every portal
          load (mounted once here, shared by student/employee/admin). */}
      <ReminderPopup />
    </div>
  );
}
