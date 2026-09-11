import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import { initials } from '../../utils/date';
import { CalendarDays, Umbrella, DollarSign, Clock, BookMarked, Bell, FileText, Briefcase } from 'lucide-react';

/** Quick-access shortcuts */
const SHORTCUTS = [
  { to: '/employee/profile',      icon: <Briefcase size={22} />,            label: 'My Profile',       sub: 'Personal & professional' },
  { to: '/employee/attendance',   icon: <CalendarDays size={22} />,         label: 'Attendance',       sub: 'Calendar & summary' },
  { to: '/employee/leave',        icon: <Umbrella size={22} />,             label: 'Leave',            sub: 'Apply & track' },
  { to: '/employee/payroll',      icon: <DollarSign size={22} />,           label: 'Payroll',          sub: 'Salary details' },
  { to: '/employee/timetable',    icon: <Clock size={22} />,                label: 'Timetable',        sub: 'Teaching schedule' },
  { to: '/employee/classes',      icon: <BookMarked size={22} />,           label: 'My Classes',       sub: 'Assigned classes' },
  { to: '/employee/announcements',icon: <Bell size={22} />,                 label: 'Notices',          sub: 'Announcements' },
  { to: '/employee/documents',    icon: <FileText size={22} />,             label: 'Documents',        sub: 'Files & records' },
];

/**
 * Employee Dashboard — profile summary + date + quick-access shortcuts.
 */
export default function EmployeeDashboard() {
  const { user } = useAuth();
  const [profile, setProfile] = useState(null);

  useEffect(() => {
    if (user?.linkedEntityId) {
      api.get(`/employees/${user.linkedEntityId}/profile`)
        .then((r) => setProfile(r.data.data))
        .catch(() => {});
    }
  }, [user]);

  const today = new Date();
  const dateStr = today.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="page fade-in">
      {/* Greeting / summary banner */}
      <div className="greeting-banner">
        <div>
          <div style={{ fontSize: 13, color: 'var(--clr-text-muted)' }}>{dateStr}</div>
          <div className="greeting-text" style={{ marginTop: 4 }}>Welcome back, {user?.name?.split(' ')[0]} 👋</div>
          {profile && (
            <div style={{ marginTop: 8, fontSize: 13, color: 'var(--clr-text-muted)' }}>
              {profile.employeeId} &nbsp;|&nbsp; {profile.designation} · {profile.department}
            </div>
          )}
          {profile && (
            <span
              className="badge"
              style={{
                marginTop: 10,
                background: profile.status === 'active' ? 'var(--tint-green)' : 'var(--tint-gold)',
                color: profile.status === 'active' ? 'var(--clr-success)' : 'var(--clr-warning)',
              }}
            >
              {profile.status === 'active' ? 'Active' : profile.status}
            </span>
          )}
        </div>
        <div className="greeting-avatar">{initials(user?.name)}</div>
      </div>

      {/* Quick access */}
      <div className="page-header">
        <div className="page-title">Quick Access</div>
        <div className="page-subtitle">Everything you need, one tap away</div>
      </div>

      <div className="overview-grid">
        {SHORTCUTS.map((card) => (
          <Link key={card.to} to={card.to} className="overview-card card--glow">
            <div className="overview-card-icon" style={{ background: 'var(--tint-oxblood)', color: 'var(--clr-primary-h)' }}>
              {card.icon}
            </div>
            <div className="overview-card-title">{card.label}</div>
            <div className="overview-card-sub">{card.sub}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}