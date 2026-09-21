import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Users, User, Banknote, Bell, PartyPopper, Umbrella, ArrowRight, CalendarDays, ClipboardList, Clock } from 'lucide-react';
import api from '../../services/api';

const formatINR = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

/**
 * Admin Dashboard — summary cards + quick management shortcuts.
 */
export default function AdminDashboard() {
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    api.get('/admin/reports/summary')
      .then((r) => setSummary(r.data.data))
      .catch(() => {});
  }, []);

  const dateStr = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Admin Dashboard</div>
        <div className="page-subtitle">{dateStr} · Manage the entire school</div>
      </div>

      {/* Summary stats */}
      <div className="stat-grid" style={{ marginBottom: 'var(--sp-xl)' }}>
        <div className="stat-card">
          <div className="stat-icon stat-icon-primary"><Users size={22} /></div>
          <div><div className="stat-value">{summary?.totalStudents ?? '—'}</div><div className="stat-label">Total Students</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-accent"><User size={22} /></div>
          <div><div className="stat-value">{summary?.totalEmployees ?? '—'}</div><div className="stat-label">Total Employees</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-warning"><Banknote size={22} /></div>
          <div><div className="stat-value">{formatINR(summary?.totalFeeDues ?? 0)}</div><div className="stat-label">Fee Dues</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-info"><Bell size={22} /></div>
          <div><div className="stat-value">{summary?.totalAnnouncements ?? '—'}</div><div className="stat-label">Announcements</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-success"><PartyPopper size={22} /></div>
          <div><div className="stat-value">{summary?.totalHolidays ?? '—'}</div><div className="stat-label">Holidays</div></div>
        </div>
      </div>

      {/* Quick management */}
      <div className="page-header">
        <div className="page-title">Quick Management</div>
        <div className="page-subtitle">Common admin actions</div>
      </div>

      <div className="overview-grid">
        {[
          { to: '/admin/students',      icon: <Users size={22} />,         label: 'Students',     sub: 'Admissions & records' },
          { to: '/admin/employees',     icon: <User size={22} />,          label: 'Employees',    sub: 'Staff onboarding' },
          { to: '/admin/attendance',    icon: <CalendarDays size={22} />,  label: 'Attendance',   sub: 'Mark & edit' },
          { to: '/admin/marks',         icon: <ClipboardList size={22} />, label: 'Marks Entry',  sub: 'Upload results' },
          { to: '/admin/timetable',     icon: <Clock size={22} />,         label: 'Timetable',    sub: 'Class schedules' },
          { to: '/admin/announcements', icon: <Bell size={22} />,          label: 'Announcements',sub: 'Post circulars' },
          { to: '/admin/holidays',      icon: <PartyPopper size={22} />,   label: 'Holidays',     sub: 'Calendar mgmt' },
          { to: '/admin/leaves',        icon: <Umbrella size={22} />,      label: 'Leave Approval',sub: `Approve (${summary?.pendingLeaves ?? 0} pending)` },
        ].map((c) => (
          <Link key={c.to} to={c.to} className="overview-card card--glow">
            <div className="overview-card-icon" style={{ background: 'var(--tint-oxblood)', color: 'var(--clr-primary-h)' }}>
              {c.icon}
            </div>
            <div className="overview-card-title">{c.label}</div>
            <div className="overview-card-sub">{c.sub}</div>
          </Link>
        ))}
      </div>

      <div style={{ marginTop: 'var(--sp-xl)', display: 'flex', gap: 'var(--sp-md)', flexWrap: 'wrap' }}>
        <Link to="/admin/students" className="btn btn-secondary">
          Open student management <ArrowRight size={15} />
        </Link>
        <Link to="/admin/employees" className="btn btn-secondary">
          Open employees management <ArrowRight size={15} />
        </Link>
      </div>
    </div>
  );
}