import { useEffect, useState } from 'react';
import { Trophy, Plus, Trash } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';

const TYPES = ['academic', 'sports', 'cultural', 'other'];

/**
 * Admin Achievements — record and manage student achievements.
 */
export default function AdminAchievements() {
  const [achievements, setAchievements] = useState([]);
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ studentId: '', title: '', description: '', date: '', type: 'academic' });
  const [saving, setSaving] = useState(false);

  const load = () =>
    Promise.all([api.get('/admin/achievements'), api.get('/admin/students')]).then(([a, s]) => {
      setAchievements(a.data.data);
      setStudents(s.data.data);
      setForm((f) => ({ ...f, studentId: f.studentId || s.data.data[0]?.id || '' }));
    });

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!form.studentId || form.title.trim().length < 3 || form.description.trim().length < 10 || !form.date) {
      toast.error('Fill all fields (description needs at least 10 characters).');
      return;
    }
    setSaving(true);
    try {
      await api.post('/admin/achievements', {
        studentId: form.studentId,
        title: form.title.trim(),
        description: form.description.trim(),
        date: form.date,
        type: form.type,
      });
      toast.success('Achievement added!');
      setForm({ studentId: form.studentId, title: '', description: '', date: '', type: 'academic' });
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not add achievement.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (ach) => {
    try {
      await api.delete(`/admin/achievements/${ach.id}`);
      toast.success('Achievement deleted.');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not delete achievement.');
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Achievements Management</div>
        <div className="page-subtitle">{achievements.length} achievement records</div>
      </div>

      <div className="section">
        <div className="section-title"><Plus size={14} /> Add Achievement</div>
        <div className="card">
          <form onSubmit={handleAdd} style={{ display: 'grid', gap: 'var(--sp-md)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-md)' }}>
              <div className="form-group">
                <label className="form-label">Student *</label>
                <select className="form-input" value={form.studentId} onChange={(e) => setForm({ ...form, studentId: e.target.value })}>
                  <option value="" disabled>Select student</option>
                  {students.map((s) => (
                    <option key={s.id} value={s.id}>{s.name} — Class {s.class}{s.section}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Type *</label>
                <select className="form-input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  {TYPES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
                </select>
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Title *</label>
              <input
                className="form-input"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="e.g. First place — State Science Fair"
              />
            </div>
            <div className="form-group">
              <label className="form-label">Description * (min 10 characters)</label>
              <textarea
                className="form-input"
                rows={3}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Describe the achievement..."
              />
            </div>
            <div className="form-group" style={{ maxWidth: 280 }}>
              <label className="form-label">Date *</label>
              <input className="form-input" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </div>
            <button className="btn btn-primary" disabled={saving} style={{ justifySelf: 'start' }}>
              <Plus size={16} /> {saving ? 'Adding...' : 'Add Achievement'}
            </button>
          </form>
        </div>
      </div>

      <div className="section">
        <div className="section-title"><Trophy size={14} /> All Achievements</div>
        {achievements.length === 0 ? (
          <div className="empty-state"><Trophy size={40} />No achievements recorded yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}>
            {achievements.map((a) => (
              <div key={a.id} className="doc-item">
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-md)' }}>
                  <div className="doc-icon" style={{ background: 'var(--tint-gold)', color: 'var(--clr-warning)' }}>
                    <Trophy size={20} />
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{a.title}</div>
                    <div className="text-sm text-muted">
                      {a.studentName} • {a.type} • {new Date(`${a.date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </div>
                    <div className="text-sm text-muted">{a.description}</div>
                  </div>
                </div>
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(a)} aria-label="Delete achievement">
                  <Trash size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
