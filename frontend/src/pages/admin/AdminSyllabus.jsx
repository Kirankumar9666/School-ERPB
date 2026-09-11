import { useEffect, useState } from 'react';
import { Upload, Plus, BookMarked } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';

const CLASS_KEYS = ['cls-10A', 'cls-9B'];

const EMPTY = { subject: '', topics: '', completedPercent: '0' };

/**
 * Admin Syllabus — upload / update syllabus coverage per class and subject.
 * Backend upserts by (classKey, subject), so re-submitting a subject updates it.
 */
export default function AdminSyllabus() {
  const [syllabus, setSyllabus] = useState({});
  const [loading, setLoading] = useState(true);
  const [classKey, setClassKey] = useState(CLASS_KEYS[0]);
  const [form, setForm] = useState(EMPTY);
  const [editingSubject, setEditingSubject] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = () => api.get('/admin/syllabus').then((r) => setSyllabus(r.data.data || {}));

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  const startEdit = (entry) => {
    setEditingSubject(entry.subject);
    setForm({
      subject: entry.subject,
      topics: entry.topics.join('\n'),
      completedPercent: String(entry.completedPercent),
    });
    document.querySelector('#syllabus-form')?.scrollIntoView({ behavior: 'smooth' });
  };

  const resetForm = () => {
    setEditingSubject(null);
    setForm(EMPTY);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const topics = form.topics.split('\n').map((t) => t.trim()).filter(Boolean);
    if (!form.subject.trim() || topics.length === 0) {
      toast.error('Enter a subject and at least one topic (one per line).');
      return;
    }
    const percent = Number(form.completedPercent);
    if (Number.isNaN(percent) || percent < 0 || percent > 100) {
      toast.error('Completion must be between 0 and 100.');
      return;
    }
    setSaving(true);
    try {
      const res = await api.post('/admin/syllabus', {
        classKey,
        subject: form.subject.trim(),
        topics,
        completedPercent: percent,
      });
      toast.success(res.data.message || (editingSubject ? 'Syllabus updated!' : 'Syllabus uploaded!'));
      resetForm();
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save syllabus.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  const entries = syllabus[classKey] || [];

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Syllabus Management</div>
        <div className="page-subtitle">Upload and track syllabus coverage per class</div>
      </div>

      <div className="form-group" style={{ maxWidth: 280, marginBottom: 'var(--sp-lg)' }}>
        <label className="form-label">Select Class</label>
        <select className="form-input" value={classKey} onChange={(e) => { setClassKey(e.target.value); resetForm(); }}>
          {Object.keys(syllabus).concat(CLASS_KEYS.filter((k) => !syllabus[k])).map((k) => (
            <option key={k} value={k}>{k.replace('cls-', 'Class ')}</option>
          ))}
        </select>
      </div>

      <div className="section">
        <div className="section-title"><BookMarked size={14} /> Subjects — {classKey.replace('cls-', 'Class ')}</div>
        {entries.length === 0 ? (
          <div className="empty-state"><BookMarked size={40} />No syllabus uploaded for this class yet.</div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr><th>Subject</th><th>Topics</th><th>Completion</th><th>{''}</th></tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.subject}>
                    <td><b>{entry.subject}</b></td>
                    <td className="text-sm text-muted">{entry.topics.join(', ')}</td>
                    <td style={{ minWidth: 140 }}>
                      <div className="progress-track">
                        <div className="progress-fill" style={{ width: `${entry.completedPercent}%` }} />
                      </div>
                      <span className="text-sm">{entry.completedPercent}%</span>
                    </td>
                    <td>
                      <button className="btn btn-secondary btn-sm" onClick={() => startEdit(entry)}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="section" id="syllabus-form">
        <div className="section-title">
          <Upload size={14} /> {editingSubject ? `Update "${editingSubject}"` : 'Upload Syllabus'}
        </div>
        <div className="card">
          <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 'var(--sp-md)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 'var(--sp-md)' }}>
              <div className="form-group">
                <label className="form-label">Subject *</label>
                <input
                  className="form-input"
                  value={form.subject}
                  onChange={(e) => setForm({ ...form, subject: e.target.value })}
                  placeholder="e.g. Mathematics"
                  disabled={Boolean(editingSubject)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Completed (%) *</label>
                <input
                  className="form-input"
                  type="number"
                  min="0"
                  max="100"
                  value={form.completedPercent}
                  onChange={(e) => setForm({ ...form, completedPercent: e.target.value })}
                />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Topics (one per line) *</label>
              <textarea
                className="form-input"
                rows={5}
                value={form.topics}
                onChange={(e) => setForm({ ...form, topics: e.target.value })}
                placeholder={'Algebra\nGeometry\nTrigonometry'}
              />
            </div>
            <div style={{ display: 'flex', gap: 'var(--sp-md)' }}>
              <button className="btn btn-primary" disabled={saving}>
                <Plus size={16} /> {saving ? 'Saving...' : editingSubject ? 'Update Syllabus' : 'Upload Syllabus'}
              </button>
              {editingSubject && (
                <button type="button" className="btn btn-secondary" onClick={resetForm}>
                  Cancel Edit
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
