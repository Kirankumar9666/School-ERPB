import { useEffect, useState } from 'react';
import { Menu } from 'lucide-react';

/** Format time as HH:MM AM/PM */
const formatTime = (date) =>
  date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

const formatDate = (date) =>
  date.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Top bar — the portal title on the left, the live clock and date on the right.
 *
 * Below the sidebar breakpoint the panel is off-canvas when closed, which takes
 * the sidebar's own ☰ with it, so this bar carries the only control that can
 * bring the menu back. It is rendered for every portal (all three share this
 * component through ProtectedLayout) but hidden by CSS above the breakpoint —
 * there the sidebar's ☰ stays where it has always been.
 *
 * @param {object} props
 * @param {string} [props.title] Portal heading, e.g. "Admin Panel".
 * @param {string} [props.subtitle] Small meta line under the heading.
 * @param {object} [props.menuRef] Ref for the hamburger — the layout restores
 *   focus to it whenever the drawer closes.
 * @param {Function} [props.onToggleMenu] Opens/closes the mobile drawer.
 * @param {boolean} [props.menuOpen] Mirrors the drawer state into aria-expanded.
 */
export default function Navbar({ title, subtitle, menuRef, onToggleMenu, menuOpen }) {
  const [time, setTime] = useState(formatTime(new Date()));

  useEffect(() => {
    const interval = setInterval(() => setTime(formatTime(new Date())), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="navbar">
      <div className="navbar-left">
        {onToggleMenu && (
          <button
            type="button"
            ref={menuRef}
            className="navbar-menu-btn"
            onClick={onToggleMenu}
            aria-expanded={menuOpen}
            aria-controls="app-sidebar"
            aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
            title="Menu"
          >
            <Menu size={18} />
          </button>
        )}
        <div className="navbar-title">{title || 'School ERP Portal'}</div>
        {subtitle && <div className="navbar-subtitle">{subtitle}</div>}
      </div>
      <div className="navbar-right">
        <span className="navbar-time">{time}</span>
        <span className="navbar-time" style={{ color: 'var(--clr-text-dim)' }}>|</span>
        <span className="navbar-time">{formatDate(new Date())}</span>
      </div>
    </header>
  );
}
