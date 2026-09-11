import { useEffect, useState } from 'react';

/** Format time as HH:MM AM/PM */
const formatTime = (date) =>
  date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

const formatDate = (date) =>
  date.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

export default function Navbar({ title, subtitle }) {
  const [time, setTime] = useState(formatTime(new Date()));

  useEffect(() => {
    const interval = setInterval(() => setTime(formatTime(new Date())), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="navbar">
      <div className="navbar-left">
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
