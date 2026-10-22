import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Users, User, Banknote, Bell, PartyPopper, Umbrella, ArrowRight, CalendarDays,
  ClipboardList, Clock, LayoutDashboard,
} from 'lucide-react';
import api from '../../services/api';
import LoadErrorState from '../../components/LoadErrorState';
import { useLoadState } from '../../utils/useLoadState';

const formatINR = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

/**
 * Admin Dashboard — summary cards + quick management shortcuts.
 */
export default function AdminDashboard() {
  const [summary, setSummary] = useState(null);
  const { loading, setLoading, error, reloadKey, retry, fail } = useLoadState();

  /* The summary is every number this page renders. A rejected request must not
     leave ₹0 fee dues and "0 pending" standing in for values the server never
     delivered — `.catch(fail)` records it so the render can say so. */
  useEffect(() => {
    api.get('/admin/reports/summary')
      .then((r) => setSummary(r.data.data))
      .catch(fail)
      .finally(() => setLoading(false));
  }, [reloadKey, fail, setLoading]);

  const dateStr = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  if (error) {
    return (
      <LoadErrorState
        title="Admin Dashboard"
        subtitle={`${dateStr} · Manage the entire school`}
        detail={error}
        onRetry={retry}
        icon={LayoutDashboard}
      />
    );
  }

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Admin Dashboard</div>
        <div className="page-subtitle">{dateStr} · Manage the entire school</div>
      </div>

      {/* Summary stats — each card navigates to the view behind its number.
          The values stay exactly what `/admin/reports/summary` computed from the
          database; only the destination is new. Built from an array the same way
          Quick Management is below, so the two rows cannot drift apart. */}
      <div className="stat-grid" style={{ marginBottom: 'var(--sp-xl)' }}>
        {[
          { to: '/admin/students',     icon: <Users size={22} />,        tint: 'stat-icon-primary', value: summary?.totalStudents ?? '—',              label: 'Total Students' },
          { to: '/admin/employees',    icon: <User size={22} />,         tint: 'stat-icon-accent',  value: summary?.totalEmployees ?? '—',             label: 'Total Employees' },
          { to: '/admin/fees',         icon: <Banknote size={22} />,     tint: 'stat-icon-warning', value: formatINR(summary?.totalFeeDues ?? 0),      label: 'Fee Dues' },
          { to: '/admin/announcements',icon: <Bell size={22} />,         tint: 'stat-icon-info',    value: summary?.totalAnnouncements ?? '—',         label: 'Announcements' },
          { to: '/admin/holidays',     icon: <PartyPopper size={22} />,  tint: 'stat-icon-success', value: summary?.totalHolidays ?? '—',              label: 'Holidays' },
        ].map((c) => (
          <Link key={c.to} to={c.to} className="stat-card stat-card--link">
            <div className={`stat-icon ${c.tint}`}>{c.icon}</div>
            <div>
              <div className="stat-value">{c.value}</div>
              <div className="stat-label">{c.label}</div>
            </div>
          </Link>
        ))}
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