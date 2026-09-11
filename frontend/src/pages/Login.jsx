import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Lock, User, AlertCircle, BookOpen } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { ROLES } from '../constants/roles';
import toast from 'react-hot-toast';

/** Login credentials for demo — displayed in UI for easy testing */
const DEMO_CREDENTIALS = [
  { role: 'Admin',       username: 'admin',      password: 'Admin@123'    },
  { role: 'Teacher',     username: 'teacher',     password: 'Teacher@123'  },
  { role: 'Accountant',  username: 'accountant',  password: 'Accounts@123' },
  { role: 'Student',     username: 'student',     password: 'Student@123'  },
];

/** Map role → dashboard path */
const ROLE_HOME = {
  [ROLES.ADMIN]:      '/admin',
  [ROLES.STUDENT]:    '/student',
  [ROLES.TEACHER]:    '/employee',
  [ROLES.ACCOUNTANT]: '/employee',
  [ROLES.LIBRARIAN]:  '/employee',
  [ROLES.PARENT]:     '/student',
};

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!username.trim() || !password.trim()) {
      setError('Please enter your username and password.');
      return;
    }
    setLoading(true);
    try {
      const user = await login(username.trim(), password);
      const destination = ROLE_HOME[user.role] || '/';
      toast.success(`Welcome back, ${user.name.split(' ')[0]}!`);
      navigate(destination, { replace: true });
    } catch (err) {
      const msg = err.response?.data?.message || 'Login failed. Please try again.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const fillCredential = (cred) => {
    setUsername(cred.username);
    setPassword(cred.password);
    setError('');
  };

  return (
    <div className="login-page">
      <div className="login-card">

        {/* Logo */}
        <div className="login-logo">
          <div className="login-logo-icon">
            <BookOpen size={28} color="#fff" />
          </div>
          <div>
            <div className="login-title">School ERP</div>
            <div className="login-subtitle">Portal Management System</div>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}>
          {error && (
            <div className="login-error">
              <AlertCircle size={16} />
              {error}
            </div>
          )}

          <div className="form-group">
            <label className="form-label" htmlFor="username">Username</label>
            <div className="input-wrapper">
              <User size={16} className="input-icon" />
              <input
                id="username"
                type="text"
                className="form-input has-icon"
                placeholder="Enter your username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                disabled={loading}
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="password">Password</label>
            <div className="input-wrapper">
              <Lock size={16} className="input-icon" />
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                className="form-input has-icon has-icon-right"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={loading}
              />
              <span
                className="input-icon-right"
                onClick={() => setShowPassword((v) => !v)}
                role="button"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </span>
            </div>
          </div>

          <button
            id="btn-login"
            type="submit"
            className="btn btn-primary btn-full"
            disabled={loading}
            style={{ marginTop: 'var(--sp-sm)', padding: '12px' }}
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        {/* Forgot password note */}
        <p className="forgot-note">
          Forgot your password? Contact your school administrator.
        </p>

        {/* Demo credentials */}
        <div className="demo-creds">
          <div className="demo-creds-title">Demo Credentials — click to fill</div>
          {DEMO_CREDENTIALS.map((cred) => (
            <div
              key={cred.role}
              className="demo-cred-item"
              onClick={() => fillCredential(cred)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && fillCredential(cred)}
            >
              <span className="demo-cred-role">{cred.role}</span>
              <span style={{ color: 'var(--clr-text-dim)' }}>
                {cred.username} /
              </span>
              <span className="demo-cred-pass">{cred.password}</span>
            </div>
          ))}
        </div>

      </div>
    </div>
  );
}
