import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import { CalendarDays, BookOpen, ClipboardList, Clock, Bell, Trophy, Sun, Sunrise, Sunset } from 'lucide-react';

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
  const greeting = getGreeting();

  useEffect(() => {
    if (user?.linkedEntityId) {
      api.get(`/students/${user.linkedEntityId}/profile`)
        .then((r) => setProfile(r.data.data))
        .catch(() => {});
    }
  }, [user]);

  const initials = user?.name?.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() || '?';

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
