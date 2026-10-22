import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ROLES, EMPLOYEE_ROLES, TEACHER_ROLES } from '../constants/roles';
import {
  LayoutDashboard, User, CalendarDays, BookOpen, ClipboardList,
  Bell, Umbrella, DollarSign, Clock, Users, FileText,
  LogOut, Trophy, PartyPopper, Upload, KeyRound, FolderUp, Menu,
  GraduationCap, Banknote,
} from 'lucide-react';

/**
 * Navigation config per role.
 *
 * An item may carry `roles: [...]` to restrict it to specific roles — the
 * employee portal shares one config object across teacher, accountant and
 * librarian, so this is how a teaching-only page (Marks Entry) is offered to
 * the one role that can actually use it. Items without `roles` are shown to
 * every role that reaches the config, and a section whose items are all
 * filtered out is not rendered at all, so no orphan heading is left behind.
 */
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
          { to: '/student/circulars',   icon: <Bell size={16} />,            label: 'Announcements' },
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
          // Fees are the accountant's own desk as well as the office's. The page
          // is the same one the admin panel shows (it reads the shared /fees
          // endpoint), offered here only to the role that can act on it — a
          // teacher or librarian has no fee responsibilities and gets no link.
          { to: '/employee/fees',         icon: <Banknote size={16} />,        label: 'Fee Dues', roles: [ROLES.ACCOUNTANT] },
          { to: '/employee/timetable',    icon: <Clock size={16} />,           label: 'Timetable' },
          // Marks Entry writes the same records as the admin panel, but only for
          // the (class, subject) pairs this teacher holds in their timetable.
          // Gated to teaching roles here so a librarian/accountant is not offered
          // a page that can only ever be empty for them.
          { to: '/employee/marks',        icon: <ClipboardList size={16} />,   label: 'Marks Entry', roles: TEACHER_ROLES },
          // ("My Classes" sat here until 2026-09-29 and was removed: it listed
          // teaching assignments that Timetable, the scoped Mark Attendance tab
          // and Marks Entry already cover, and it was the only nav item whose
          // page did not work. /employee/classes now redirects to the dashboard
          // instead of 404ing, so old bookmarks still land somewhere real. It was
          // deleted from this shared config rather than hidden per-view, so it
          // disappears from the expanded rail, the icon rail and the mobile
          // drawer at once.)
        ],
      },
      {
        title: 'School',
        items: [
          { to: '/employee/announcements',icon: <Bell size={16} />,            label: 'Announcements' },
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
        { to: '/admin/fees',         icon: <Banknote size={16} />,        label: 'Fee Dues' },
        { to: '/admin/classes',       icon: <GraduationCap size={16} />,   label: 'Class Management' },
        { to: '/admin/employees',    icon: <User size={16} />,            label: 'Employees' },
        { to: '/admin/payroll',      icon: <DollarSign size={16} />,      label: 'Payroll' },
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
        { to: '/admin/calendar',     icon: <CalendarDays size={16} />,    label: 'Calendar' },
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
 * Collapsible icon rail: expanded it shows the logo block, the user profile and
 * icon+label nav items; collapsed it shrinks to a narrow icon-only rail (the
 * labels, brand text and profile text are hidden by CSS). On desktop the panel
 * never leaves the screen, so the ☰ toggle pinned top-left above the logo is
 * always reachable. Below that breakpoint "collapsed" takes the whole panel
 * off-canvas instead — ProtectedLayout then owns a hamburger in the top bar and
 * a backdrop, and this same ☰ becomes the drawer's close button.
 *
 * @param {object} props
 * @param {boolean} props.sidebarOpen Current state (drives aria-expanded).
 * @param {Function} props.onToggleSidebar Toggle handler owned by ProtectedLayout.
 * @param {object} [props.toggleRef] Ref to the toggle, used to restore focus.
 * @param {Function} [props.onNavigate] Fired when a nav item is chosen; the
 *   layout uses it to collapse the drawer on small screens.
 */
export default function Sidebar({ sidebarOpen, onToggleSidebar, toggleRef, onNavigate }) {
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

  const toggleLabel = sidebarOpen ? 'Hide navigation menu' : 'Show navigation menu';

  return (
    <aside id="app-sidebar" className="sidebar">
      {/* ☰ — pinned TOP-LEFT, directly above the logo, in BOTH states (CSS pins
          it at the same pixels whether the panel is a rail or expanded); it
          flips the panel between the two. A real button: keyboard-reachable,
          aria-expanded mirrors the state, aria-controls points at this
          sidebar. */}
      <div className="sidebar-top">
        <button
          type="button"
          ref={toggleRef}
          className="sidebar-toggle"
          onClick={onToggleSidebar}
          aria-expanded={sidebarOpen}
          aria-controls="app-sidebar"
          aria-label={toggleLabel}
          title={toggleLabel}
        >
          <Menu size={18} />
        </button>
      </div>

      {/* Logo */}
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon">🏫</div>
        <div>
          <div className="sidebar-logo-text">School ERP</div>
          <div className="sidebar-logo-sub">{config.label}</div>
        </div>
      </div>

      {/* User */}
      <div className="sidebar-user">
        <div className="sidebar-avatar">{initials}</div>
        <div>
          <div className="sidebar-username">{user?.name}</div>
          <div className="sidebar-role-badge">{user?.role}</div>
        </div>
      </div>

      {/* Navigation — items may be restricted to certain roles, and a section
          left with nothing to show is dropped rather than left as a bare heading */}
      <nav className="sidebar-nav">
        {config.sections.map((section) => {
          const visible = section.items.filter(
            (item) => !item.roles || item.roles.includes(user?.role),
          );
          if (visible.length === 0) return null;
          return (
            <div key={section.title}>
              <div className="nav-section-title">{section.title}</div>
              {visible.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/student' || item.to === '/employee' || item.to === '/admin'}
                  className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                  onClick={onNavigate}
                >
                  {item.icon}
                  <span className="nav-label">{item.label}</span>
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="sidebar-footer">
        <button className="nav-item" onClick={handleLogout} id="btn-logout">
          <LogOut size={16} />
          <span className="nav-label">Sign Out</span>
        </button>
      </div>
    </aside>
  );
}
