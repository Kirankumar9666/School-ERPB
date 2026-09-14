import { useEffect, useState } from 'react';
import { Menu } from 'lucide-react';

/** Format time as HH:MM AM/PM */
const formatTime = (date) =>
  date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

const formatDate = (date) =>
  date.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Top bar — the sidebar hamburger (☰) plus the portal title on the left, the
 * live clock and date on the right.
 *
 * The toggle is a real button, so it is reachable by keyboard and announces the
 * collapsed state: `aria-expanded` mirrors it and `aria-controls` points at the
 * sidebar (`id="app-sidebar"`). The button never shrinks, so it can neither
 * overlap nor displace the title or the date/time block.
 *
 * @param {object} props
 * @param {string} [props.title] Portal heading, e.g. "Admin Panel".
 * @param {string} [props.subtitle] Small meta line under the heading.
 * @param {boolean} props.sidebarOpen Current sidebar state (drives aria-expanded).
 * @param {Function} props.onToggleSidebar Toggle handler owned by ProtectedLayout.
 * @param {object} [props.toggleRef] Ref to the button, used to restore focus.
 */
export default function Navbar({ title, subtitle, sidebarOpen, onToggleSidebar, toggleRef }) {
  const [time, setTime] = useState(formatTime(new Date()));

  useEffect(() => {
    const interval = setInterval(() => setTime(formatTime(new Date())), 1000);
    return () => clearInterval(interval);
  }, []);

  const toggleLabel = sidebarOpen ? 'Hide navigation menu' : 'Show navigation menu';

  return (
    <header className="navbar">
      <div className="navbar-left">
        <button
          type="button"
          ref={toggleRef}
          className="navbar-toggle"
          onClick={onToggleSidebar}
          aria-expanded={sidebarOpen}
          aria-controls="app-sidebar"
          aria-label={toggleLabel}
          title={toggleLabel}
        >
          <Menu size={18} />
        </button>
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
