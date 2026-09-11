import { useEffect, useState } from 'react';
import { Users, KeyRound } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';

/**
 * Admin Users — account list and password reset (admin-only).
 * Backend never returns password hashes; reset uses PUT /admin/users/:id/reset-password.
 */
export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(null); // user being reset
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => api.get('/admin/users').then((r) => setUsers(r.data.data));

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  const openReset = (user) => {
    setResetting(user);
    setNewPassword('');
  };

  const handleReset = async (e) => {
    e.preventDefault();
    if (newPassword.length < 8) {
      toast.error('Password must be at least 8 characters.');
      return;
    }
    setSaving(true);
    try {
      await api.put(`/admin/users/${resetting.id}/reset-password`, { newPassword });
      toast.success(`Password reset for "${resetting.username}".`);
      setResetting(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not reset password.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">User Accounts</div>
        <div className="page-subtitle">{users.length} accounts • reset passwords from here</div>
      </div>

      <div className="section">
        <div className="section-title"><Users size={14} /> All Users</div>
        <div className="table-wrapper">
          <table>
            <thead>
              <tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>{''}</th></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td><b>{u.name}</b></td>
                  <td>{u.username}</td>
                  <td><span className="badge badge-info">{u.role}</span></td>
                  <td>
                    <span className={`badge ${u.status === 'active' ? 'badge-success' : 'badge-muted'}`}>{u.status}</span>
                  </td>
                  <td>
                    <button className="btn btn-secondary btn-sm" onClick={() => openReset(u)}>
                      <KeyRound size={14} /> Reset Password
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {resetting && (
        <Modal title={`Reset Password — ${resetting.name}`} onClose={() => setResetting(null)}>
          <form onSubmit={handleReset} style={{ display: 'grid', gap: 'var(--sp-md)' }}>
            <div className="form-group">
              <label className="form-label">New Password * (min 8 characters)</label>
              <input
                className="form-input"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter a new password"
                autoFocus
              />
            </div>
            <div className="text-sm text-muted">
              The user will use this password on their next login. Share it through a secure channel.
            </div>
            <div style={{ display: 'flex', gap: 'var(--sp-md)', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setResetting(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={saving}>
                <KeyRound size={16} /> {saving ? 'Resetting...' : 'Reset Password'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
