import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ROLES, EMPLOYEE_ROLES } from '../constants/roles';
import {
  LayoutDashboard, User, CalendarDays, BookOpen, ClipboardList,
  Bell, Umbrella, DollarSign, Clock, Users, FileText,
  LogOut, BookMarked, Trophy, PartyPopper, Upload, KeyRound, FolderUp, X
} from 'lucide-react';

/** Navigation config per role */
const NAV_CONFIG = {
  [ROLES.STUDENT]: {
    label: 'Student Portal',
    sections: [
      {
        title: 'Academics',
        items: [
          { to: '/student',             icon: <LayoutDashboard size={16} />, label: 'Home' },
          { to: '/student/profile',     icon: <User size={16} />,            label: 'My Profile' },
          { to: '/student/attendance',  icon: <CalendarDays size={16} />,    label: 'Attendance' },
          { to: '/student/marks',       icon: <ClipboardList size={16} />,   label: 'Marks' },
          { to: '/student/timetable',   icon: <Clock size={16} />,           label: 'Time Table' },
          { to: '/student/syllabus',    icon: <BookOpen size={16} />,        label: 'Syllabus' },
          { to: '/student/achievements',icon: <Trophy size={16} />,          label: 'Achievements' },
        ],
      },
      {
        title: 'School',
        items: [
          { to: '/student/circulars',   icon: <Bell size={16} />,            label: 'Circulars' },
          { to: '/student/holidays',    icon: <PartyPopper size={16} />,     label: 'Holidays' },
        ],
      },
    ],
  },
};

// Employee nav shared for teacher/accountant/librarian
EMPLOYEE_ROLES.forEach((role) => {
  NAV_CONFIG[role] = {
    label: 'Employee Portal',
    sections: [
      {
        title: 'My Work',
        items: [
          { to: '/employee',              icon: <LayoutDashboard size={16} />, label: 'Dashboard' },
          { to: '/employee/profile',      icon: <User size={16} />,            label: 'My Profile' },
          { to: '/employee/attendance',   icon: <CalendarDays size={16} />,    label: 'Attendance' },
          { to: '/employee/leave',        icon: <Umbrella size={16} />,        label: 'Leave' },
          { to: '/employee/payroll',      icon: <DollarSign size={16} />,      label: 'Payroll' },
          { to: '/employee/timetable',    icon: <Clock size={16} />,           label: 'Timetable' },
          { to: '/employee/classes',      icon: <BookMarked size={16} />,      label: 'My Classes' },
        ],
      },
      {
        title: 'School',
        items: [
          { to: '/employee/announcements',icon: <Bell size={16} />,            label: 'Notices' },
          { to: '/employee/documents',    icon: <FileText size={16} />,        label: 'Documents' },
        ],
      },
    ],
  };
});

NAV_CONFIG[ROLES.ADMIN] = {
  label: 'Admin Panel',
  sections: [
    {
      title: 'Management',
      items: [
        { to: '/admin',              icon: <LayoutDashboard size={16} />, label: 'Dashboard' },
        { to: '/admin/students',     icon: <Users size={16} />,           label: 'Students' },
        { to: '/admin/employees',    icon: <User size={16} />,            label: 'Employees' },
        { to: '/admin/attendance',   icon: <CalendarDays size={16} />,    label: 'Attendance' },
        { to: '/admin/marks',        icon: <ClipboardList size={16} />,   label: 'Marks Entry' },
        { to: '/admin/timetable',    icon: <Clock size={16} />,           label: 'Timetable' },
      ],
    },
    {
      title: 'Records',
      items: [
        { to: '/admin/syllabus',     icon: <Upload size={16} />,          label: 'Syllabus' },
        { to: '/admin/achievements', icon: <Trophy size={16} />,          label: 'Achievements' },
        { to: '/admin/documents',    icon: <FolderUp size={16} />,        label: 'Documents' },
      ],
    },
    {
      title: 'Communications',
      items: [
        { to: '/admin/announcements',icon: <Bell size={16} />,            label: 'Announcements' },
        { to: '/admin/holidays',     icon: <PartyPopper size={16} />,     label: 'Holidays' },
        { to: '/admin/leaves',       icon: <Umbrella size={16} />,        label: 'Leave Approval' },
      ],
    },
    {
      title: 'Security',
      items: [
        { to: '/admin/users',        icon: <KeyRound size={16} />,        label: 'User Accounts' },
      ],
    },
  ],
};

/**
 * Sidebar — the portal's navigation panel (same nav list for every role).
 *
 * It renders inside the collapsible container owned by ProtectedLayout: the
 * layout decides whether the panel is pinned open (desktop), slid off-canvas, or
 * open as an overlay drawer — this component only supplies the content plus the
 * callbacks the drawer needs.
 *
 * @param {object} props
 * @param {Function} [props.onNavigate] Fired when a nav item is chosen; the
 *   layout uses it to dismiss the drawer on small screens.
 * @param {Function} [props.onClose] Dismisses the drawer (mobile close button).
 */
export default function Sidebar({ onNavigate, onClose }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const config = NAV_CONFIG[user?.role];
  if (!config) return null;

  const initials = user?.name
    ? user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()
    : '?';

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <aside id="app-sidebar" className="sidebar">
      {/* Logo */}
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon">🏫</div>
        <div>
          <div className="sidebar-logo-text">School ERP</div>
          <div className="sidebar-logo-sub">{config.label}</div>
        </div>
        {/* Drawer dismiss — visible on small screens only (CSS), where the open
            panel sits over the hamburger. */}
        <button
          type="button"
          className="sidebar-close"
          onClick={onClose}
          aria-label="Close navigation menu"
        >
          <X size={15} />
        </button>
      </div>

      {/* User */}
      <div className="sidebar-user">
        <div className="sidebar-avatar">{initials}</div>
        <div>
          <div className="sidebar-username">{user?.name}</div>
          <div className="sidebar-role-badge">{user?.role}</div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="sidebar-nav">
        {config.sections.map((section) => (
          <div key={section.title}>
            <div className="nav-section-title">{section.title}</div>
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/student' || item.to === '/employee' || item.to === '/admin'}
                className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                onClick={onNavigate}
              >
                {item.icon}
                {item.label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="sidebar-footer">
        <button className="nav-item" onClick={handleLogout} id="btn-logout">
          <LogOut size={16} />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
