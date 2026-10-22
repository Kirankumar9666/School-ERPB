import { useState } from 'react';
import { AlertCircle, BookOpen, Eye, EyeOff, KeyRound, Lock, LogOut } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import toast from '../services/toast';

/** Same rules the server enforces in POST /auth/change-password (zod schema). */
const MIN_LENGTH = 8;

/** Client-side mirror of the server's rule, so obvious mistakes never leave the browser. */
const validate = (pw) => {
  if (pw.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters.`;
  if (!/[a-z]/.test(pw)) return 'Password must include a lowercase letter.';
  if (!/[A-Z]/.test(pw)) return 'Password must include an uppercase letter.';
  if (!/[0-9]/.test(pw)) return 'Password must include a digit.';
  return '';
};

/**
 * ForcePasswordChange — the full-screen gate shown in place of the portal when
 * the signed-in account is still using the password the school chose for it
 * (user.mustChangePassword, set when a student login is provisioned from the
 * guardian contact).
 *
 * The backend refuses every business endpoint for such an account anyway
 * (middleware/passwordGate.middleware.js), so this is the honest front end for
 * that state: no sidebar, no routes, no dead-end API calls — just the change.
 * On success the context swaps in the token the server returns (flag already
 * cleared) and the layout re-renders straight into the normal portal.
 *
 * Nothing here reads or displays an existing password, and nothing is ever
 * written to storage except through AuthContext.changePassword.
 */
export default function ForcePasswordChange() {
  const { user, changePassword, logout } = useAuth();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    if (!currentPassword) {
      setError('Enter your current password.');
      return;
    }
    const problem = validate(newPassword);
    if (problem) {
      setError(problem);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSaving(true);
    try {
      await changePassword(currentPassword, newPassword);
      toast.success('Password updated. Welcome!');
    } catch (err) {
      // The server's own message — wrong current password, or a new password
      // it refused (e.g. one that repeats the guardian contact number).
      setError(err.response?.data?.message || 'Could not change the password.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <div className="login-logo-icon">
            <BookOpen size={28} color="#fff" />
          </div>
          <div>
            <div className="login-title">School ERP</div>
            <div className="login-subtitle">Set your own password</div>
          </div>
        </div>

        <p style={{ color: 'var(--clr-text-dim)', fontSize: '0.9rem', lineHeight: 1.55 }}>
          Your account was created with an initial password chosen by the school.
          Choose your own before continuing — the app stays locked until you do.
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}>
          {error && (
            <div className="login-error" role="alert">
              <AlertCircle size={16} />
              {error}
            </div>
          )}

          <div className="form-group">
            <label className="form-label" htmlFor="current-password">Current Password</label>
            <div className="input-wrapper">
              <Lock size={16} className="input-icon" />
              <input
                id="current-password"
                type={showPasswords ? 'text' : 'password'}
                className="form-input has-icon"
                placeholder="Enter your current password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                disabled={saving}
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="new-password">
              New Password * (min {MIN_LENGTH} characters, with upper &amp; lower case letters and a digit)
            </label>
            <div className="input-wrapper">
              <KeyRound size={16} className="input-icon" />
              <input
                id="new-password"
                type={showPasswords ? 'text' : 'password'}
                className="form-input has-icon has-icon-right"
                placeholder="Enter a new password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                disabled={saving}
              />
              <span
                className="input-icon-right"
                onClick={() => setShowPasswords((v) => !v)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && setShowPasswords((v) => !v)}
                aria-label={showPasswords ? 'Hide passwords' : 'Show passwords'}
              >
                {showPasswords ? <EyeOff size={16} /> : <Eye size={16} />}
              </span>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="confirm-password">Confirm New Password</label>
            <div className="input-wrapper">
              <KeyRound size={16} className="input-icon" />
              <input
                id="confirm-password"
                type={showPasswords ? 'text' : 'password'}
                className="form-input has-icon"
                placeholder="Re-enter the new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                disabled={saving}
              />
            </div>
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-full"
            disabled={saving}
            style={{ marginTop: 'var(--sp-sm)', padding: '12px' }}
          >
            {saving ? 'Saving...' : 'Set Password & Continue'}
          </button>
        </form>

        <p className="forgot-note">
          Signed in as {user?.username || '—'} · Changed your mind? Sign in with another account.
        </p>

        <button
          type="button"
          className="btn btn-full"
          onClick={logout}
          disabled={saving}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
        >
          <LogOut size={16} />
          Sign out
        </button>
      </div>
    </div>
  );
}
