import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Sidebar from './Sidebar';
import Navbar from './Navbar';
import ReminderPopup from './ReminderPopup';

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
 *
 * Collapsible sidebar: this layout owns the expanded/collapsed state. Expanded,
 * the panel is pinned open on desktop (pushing the content) or overlays as a
 * dismissable drawer on small screens; collapsed, it shrinks to a pinned
 * icon-only rail on every viewport. A saved preference survives reloads.
 */
export default function ProtectedLayout({ allowedRoles, navTitle, navSubtitle }) {
  const { user, isAuthenticated, loading } = useAuth();

  /* ---------- Collapsible sidebar ----------
     Pinned open by default on desktop, off-canvas (closed) on smaller screens.
     A saved preference always wins, so the choice survives reloads and route
     changes — the layout stays mounted while admin pages come and go. */
  const [isDesktop, setIsDesktop] = useState(isDesktopViewport);
  // Desktop honours the saved preference (default: expanded). Smaller screens
  // start on the collapsed icon rail, so the drawer never covers the page on load.
  const [sidebarOpen, setSidebarOpen] = useState(() => (
    isDesktopViewport() ? (storedPreference() ?? true) : false
  ));
  const sidebarToggleRef = useRef(null);

  /** Close the sidebar; optionally hand focus back to the sidebar toggle */
  const closeSidebar = useCallback((restoreFocus = false) => {
    setSidebarOpen(false);
    if (restoreFocus) sidebarToggleRef.current?.focus();
  }, []);

  /**
   * Flip the sidebar. Only desktop toggles are remembered: a drawer left open
   * on a phone must not switch off the pinned-open default on a desktop.
   */
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => {
      const next = !prev;
      if (isDesktopViewport()) localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? 'open' : 'closed');
      return next;
    });
  }, []);

  // Crossing the breakpoint swaps layout modes: the drawer never stays open over
  // the content, and the saved preference returns when there is room to pin it.
  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`);
    const onChange = (event) => {
      setIsDesktop(event.matches);
      setSidebarOpen(event.matches ? (storedPreference() ?? true) : false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // Escape dismisses the drawer — the keyboard equivalent of tapping the backdrop
  useEffect(() => {
    if (!sidebarOpen || isDesktop) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') closeSidebar(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sidebarOpen, isDesktop, closeSidebar]);

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
        onNavigate={() => { if (!isDesktop) closeSidebar(); }}
      />

      {/* Backdrop for the off-canvas drawer — tapping it dismisses the sidebar */}
      {sidebarOpen && !isDesktop && (
        <div className="sidebar-overlay" onClick={() => closeSidebar(true)} aria-hidden="true" />
      )}

      <div className="main-content">
        <Navbar
          title={navTitle}
          subtitle={navSubtitle}
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
