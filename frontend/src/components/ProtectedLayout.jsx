import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Sidebar from './Sidebar';
import Navbar from './Navbar';

/**
 * ProtectedLayout — wraps all authenticated pages.
 * If user is not logged in → redirect to login.
 * If user role is not in allowedRoles → redirect to their home.
 */
export default function ProtectedLayout({ allowedRoles, navTitle, navSubtitle }) {
  const { user, isAuthenticated, loading } = useAuth();

  if (loading) {
    return (
      <div className="loading-center" style={{ minHeight: '100vh' }}>
        <div className="spinner" />
      </div>
    );
  }

  if (!isAuthenticated) return <Navigate to="/login" replace />;

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="app-layout">
      <Sidebar />
      <div className="main-content">
        <Navbar title={navTitle} subtitle={navSubtitle} />
        <main>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
