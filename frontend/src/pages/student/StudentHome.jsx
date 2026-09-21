import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import { CalendarDays, BookOpen, ClipboardList, Clock, Bell, Trophy, Sun, Sunrise, Sunset, CalendarCheck, Banknote, PartyPopper } from 'lucide-react';
import { monthShift, todayISO } from '../../utils/date';

const formatINR = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

const getGreeting = () => {
  const h = new Date().getHours();
  if (h < 12) return { text: 'Good Morning', icon: <Sunrise size={20} /> };
  if (h < 17) return { text: 'Good Afternoon', icon: <Sun size={20} /> };
  return { text: 'Good Evening', icon: <Sunset size={20} /> };
};

const OVERVIEW_CARDS = [
  { to: '/student/attendance',   icon: <CalendarDays size={22} />, label: 'Attendance',   sub: 'Monthly overview',    color: 'var(--clr-present)', bg: 'var(--tint-slate)' },
  { to: '/student/syllabus',     icon: <BookOpen size={22} />,     label: 'Syllabus',     sub: 'Class progress',      color: 'var(--clr-accent)',   bg: 'var(--tint-slate)' },
  { to: '/student/marks',        icon: <ClipboardList size={22} />,label: 'Marks',        sub: 'Progress card',       color: 'var(--clr-success)',  bg: 'var(--tint-green)' },
  { to: '/student/timetable',    icon: <Clock size={22} />,        label: 'Time Table',   sub: 'Daily schedule',      color: 'var(--clr-warning)',  bg: 'var(--tint-gold)' },
  { to: '/student/circulars',    icon: <Bell size={22} />,          label: 'Circulars',    sub: 'Announcements',       color: 'var(--clr-primary-h)',bg: 'var(--tint-oxblood)' },
  { to: '/student/achievements', icon: <Trophy size={22} />,        label: 'Achievements', sub: 'Awards & certs',      color: 'var(--clr-warning)',  bg: 'var(--tint-gold)' },
];

export default function StudentHome() {
  const { user } = useAuth();
  const [profile, setProfile] = useState(null);
  // null until loaded → cards render the admin-style '—' placeholder
  const [stats, setStats] = useState(null);
  const greeting = getGreeting();

  useEffect(() => {
    const id = user?.linkedEntityId;
    if (!id) return undefined;

    api.get(`/students/${id}/profile`)
      .then((r) => setProfile(r.data.data))
      .catch(() => {});

    /*
     * Every stat card is computed live from this student's own records (their
     * attendance, their fee dues, their achievements) plus the school-wide
     * announcements/holidays — nothing cached or shared between students.
     * allSettled so one failing endpoint blanks only its own card ('—'),
     * never the whole row.
     */
    let alive = true;
    Promise.allSettled([
      // Same period the Attendance page shows by default: the current month
      api.get(`/students/${id}/attendance?month=${monthShift(0).key}`),
      api.get('/school/announcements'),
      api.get('/school/holidays'),
      api.get(`/students/${id}/achievements`),
    ]).then(([att, ann, hol, ach]) => {
      if (!alive) return;
      const today = todayISO();
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      setStats({
        // summarizeAttendance computes this server-side from the real records
        attendancePercent: att.status === 'fulfilled'
          ? Math.round(att.value.data.data?.summary?.percent ?? 0)
          : null,
        // No read-tracking exists, so "new" = posted in the last 7 days
        newCirculars: ann.status === 'fulfilled'
          ? (ann.value.data.data || []).filter((a) => new Date(a.createdAt).getTime() >= weekAgo).length
          : null,
        // Holidays still ahead of today (all future ones — the "remaining" ones)
        upcomingHolidays: hol.status === 'fulfilled'
          ? (hol.value.data.data || []).filter((h) => h.date >= today).length
          : null,
        achievements: ach.status === 'fulfilled' ? (ach.value.data.data || []).length : null,
      });
    });
    return () => { alive = false; };
  }, [user]);

  const initials = user?.name?.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() || '?';
  const dash = (v) => (v === null || v === undefined ? '—' : v);

  return (
    <div className="page fade-in">

      {/* Greeting Banner */}
      <div className="greeting-banner">
        <div>
          <div className="flex items-center gap-sm" style={{ color: 'var(--clr-accent)', marginBottom: 6 }}>
            {greeting.icon}
            <span style={{ fontSize: 14, fontWeight: 500 }}>{greeting.text}</span>
          </div>
          <div className="greeting-text">{user?.name} 👋</div>
          {profile && (
            <div style={{ marginTop: 8, fontSize: 13, color: 'var(--clr-text-muted)' }}>
              Class {profile.class} – Section {profile.section} &nbsp;|&nbsp; Roll: {profile.rollNumber}
            </div>
          )}
        </div>
        <div className="greeting-avatar">{initials}</div>
      </div>

      {/* Summary stats — the Admin Dashboard's stat-card system, fed with this
          student's own live numbers (same grid, icons, values and labels). */}
      <div className="stat-grid" style={{ marginBottom: 'var(--sp-xl)' }}>
        <div className="stat-card">
          <div className="stat-icon stat-icon-info"><CalendarCheck size={22} /></div>
          <div><div className="stat-value">{stats?.attendancePercent == null ? '—' : `${stats.attendancePercent}%`}</div><div className="stat-label">Attendance</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-warning"><Banknote size={22} /></div>
          <div><div className="stat-value">{profile ? formatINR(profile.feeDues) : '—'}</div><div className="stat-label">Fee Dues</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-primary"><Bell size={22} /></div>
          <div><div className="stat-value">{dash(stats?.newCirculars)}</div><div className="stat-label">New Circulars</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-success"><PartyPopper size={22} /></div>
          <div><div className="stat-value">{dash(stats?.upcomingHolidays)}</div><div className="stat-label">Upcoming Holidays</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-accent"><Trophy size={22} /></div>
          <div><div className="stat-value">{dash(stats?.achievements)}</div><div className="stat-label">Achievements</div></div>
        </div>
      </div>

      {/* Overview Cards */}
      <div className="page-header">
        <div className="page-title">Quick Access</div>
        <div className="page-subtitle">Your academic dashboard</div>
      </div>

      <div className="overview-grid">
        {OVERVIEW_CARDS.map((card) => (
          <Link key={card.to} to={card.to} className="overview-card card--glow">
            <div className="overview-card-icon" style={{ background: card.bg, color: card.color }}>
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
