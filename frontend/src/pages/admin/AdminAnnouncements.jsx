import { useEffect, useState } from 'react';
import { Bell, Send, Trash } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';
import { ROLES } from '../../constants/roles';

const ROLES_LIST = Object.values(ROLES);
const CATEGORIES = ['event', 'exam', 'holiday', 'meeting', 'general'];

/**
 * Admin Announcements — create, list and delete circulars.
 */
export default function AdminAnnouncements() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    title: '', body: '', category: 'general', targetRoles: [ROLES.STUDENT, ROLES.TEACHER],
  });
  const [saving, setSaving] = useState(false);

  const load = () => api.get('/admin/announcements').then((r) => setList(r.data.data));

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  const toggleRole = (role) => {
    const has = form.targetRoles.includes(role);
    setForm({
      ...form,
      targetRoles: has ? form.targetRoles.filter((r) => r !== role) : [...form.targetRoles, role],
    });
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.title.trim() || form.body.trim().length < 10 || form.targetRoles.length === 0) {
      toast.error('Title, body (min 10 chars) and at least one audience are required.');
      return;
    }
    setSaving(true);
    try {
      await api.post('/admin/announcements', {
        title: form.title.trim(), body: form.body.trim(), category: form.category, targetRoles: form.targetRoles,
      });
      toast.success('Announcement posted!');
      setForm({ title: '', body: '', category: 'general', targetRoles: [ROLES.STUDENT, ROLES.TEACHER] });
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not post announcement.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (a) => {
    if (!window.confirm(`Delete "${a.title}"?`)) return;
    try {
      await api.delete(`/admin/announcements/${a.id}`);
      toast.success('Announcement deleted.');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed.');
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Announcements</div>
        <div className="page-subtitle">Post circulars for students & staff</div>
      </div>

      {/* Create */}
      <div className="section">
        <div className="section-title"><Send size={14} /> New Announcement</div>
        <div className="card">
          <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-md)' }}>
              <div className="form-group">
                <label className="form-label">Title *</label>
                <input className="form-input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. PTM on Saturday" />
              </div>
              <div className="form-group">
                <label className="form-label">Category</label>
                <select className="form-input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Body *</label>
              <textarea className="form-input" rows={4} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Announcement details..." />
            </div>
            <div className="form-group">
              <label className="form-label">Audience</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-sm)' }}>
                {ROLES_LIST.map((r) => (
                  <button
                    key={r}
                    type="button"
                    style={{
                      cursor: 'pointer', border: '1px solid var(--clr-border)',
                      background: form.targetRoles.includes(r) ? 'var(--tint-oxblood)' : 'transparent',
                      color: form.targetRoles.includes(r) ? 'var(--clr-primary-h)' : 'var(--clr-text-dim)',
                    }}
                    className="badge"
                    onClick={() => toggleRole(r)}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <button className="btn btn-primary" disabled={saving}>
              <Bell size={16} /> {saving ? 'Posting...' : 'Publish Announcement'}
            </button>
          </form>
        </div>
      </div>

      {/* List */}
      <div className="section">
        <div className="section-title"><Bell size={14} /> Published ({list.length})</div>
        {list.length === 0 ? (
          <div className="empty-state"><Bell size={40} />No announcements yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}>
            {list.map((a) => (
              <div key={a.id} className="announcement-card">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--sp-md)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>{a.title}</div>
                    <div className="text-sm text-muted">
                      {a.category} · {new Date(a.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} · For: {a.targetRoles.join(', ')}
                    </div>
                  </div>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDelete(a)} aria-label="Delete announcement">
                    <Trash size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}