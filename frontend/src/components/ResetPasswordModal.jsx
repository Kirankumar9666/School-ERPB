import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import toast from 'react-hot-toast';
import Modal from './Modal';
import api from '../services/api';

const MIN_LENGTH = 8;

/**
 * Shared "Reset Password" modal for the admin panel — rendered by the User
 * Accounts screen and the per-row Reset Password buttons on the Students and
 * Employees screens, so all three behave identically (same validation, same
 * endpoint, same feedback).
 *
 * Validates on the client (min length + upper/lower/digit complexity, matching
 * the server's zod rule) and then really calls
 * PUT /admin/users/:id/reset-password — the password is hashed with bcrypt
 * server-side. Success/error feedback comes from the actual API response.
 *
 * @param {object} props
 * @param {{ id: string, name?: string, username?: string }} props.user
 *   The account being reset (user id, NOT student/employee id).
 * @param {Function} props.onClose Close without saving.
 * @param {Function} [props.onSuccess] Fired after a successful reset.
 */
export default function ResetPasswordModal({ user, onClose, onSuccess }) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const label = user.name || user.username;

  /** Mirrors the server's rule so obvious mistakes never leave the browser. */
  const validate = (pw) => {
    if (pw.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters.`;
    if (!/[a-z]/.test(pw)) return 'Password must include a lowercase letter.';
    if (!/[A-Z]/.test(pw)) return 'Password must include an uppercase letter.';
    if (!/[0-9]/.test(pw)) return 'Password must include a digit.';
    return '';
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const problem = validate(newPassword);
    if (problem) {
      setError(problem);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setError('');
    setSaving(true);
    try {
      await api.put(`/admin/users/${user.id}/reset-password`, { newPassword });
      toast.success(`Password updated for ${label}.`);
      onClose();
      onSuccess?.();
    } catch (err) {
      const message = err.response?.data?.message || 'Could not reset the password.';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`Reset Password — ${label}`} onClose={onClose}>
      <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 'var(--sp-md)' }} noValidate>
        {error && <div className="login-error" style={{ marginBottom: 0 }}>{error}</div>}
        <div className="form-group">
          <label className="form-label" htmlFor="reset-new-password">
            New Password * (min {MIN_LENGTH} characters, with upper &amp; lower case letters and a digit)
          </label>
          <input
            id="reset-new-password"
            className="form-input"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Enter a new password"
            autoComplete="new-password"
            autoFocus
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="reset-confirm-password">Confirm Password *</label>
          <input
            id="reset-confirm-password"
            className="form-input"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Re-enter the new password"
            autoComplete="new-password"
          />
        </div>
        <div className="text-sm text-muted">
          {label} will use this password on their next login. Share it through a secure channel.
        </div>
        <div style={{ display: 'flex', gap: 'var(--sp-md)', justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            <KeyRound size={16} /> {saving ? 'Resetting...' : 'Reset Password'}
          </button>
        </div>
      </form>
    </Modal>
  );
}