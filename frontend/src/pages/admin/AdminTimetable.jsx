import { useEffect, useState } from 'react';
import { Clock, Plus, Trash } from 'lucide-react';
import api from '../../services/api';
import { loadOptions } from '../../services/options';
import { classChoices } from '../../utils/classes';
import toast from 'react-hot-toast';

/**
 * Admin Timetable — manage class schedules (add / delete periods).
 * The class selector lists the classes that exist in the database
 * (GET /school/options) plus any class the payload already references.
 */
export default function AdminTimetable() {
  const [timetables, setTimetables] = useState({});
  const [classes, setClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [classKey, setClassKey] = useState('');
  const [form, setForm] = useState({ period: '', timeStart: '08:00', timeEnd: '08:45', subject: '', teacher: '', room: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([api.get('/admin/timetable'), loadOptions()])
      .then(([t, o]) => {
        const data = t.data.data || {};
        setTimetables(data);
        setClasses(o.classes);
        // Prefer a class that already has periods, else the first real class
        setClassKey((current) => current || Object.keys(data)[0] || o.classes[0]?.id || '');
      })
      .finally(() => setLoading(false));
  }, []);

  /* Class options: database classes ∪ classes already in the payload, sorted */
  const choices = classChoices(Object.keys(timetables), classes);
  const periods = timetables[classKey] || [];
  const activeLabel = choices.find((c) => c.id === classKey)?.label || '';

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!form.period || !form.subject.trim() || !form.teacher.trim() || !form.room.trim()) {
      toast.error('Fill all period fields.');
      return;
    }
    setSaving(true);
    try {
      await api.post('/admin/timetable', {
        classKey,
        period: Number(form.period),
        timeStart: form.timeStart,
        timeEnd: form.timeEnd,
        subject: form.subject.trim(),
        teacher: form.teacher.trim(),
        room: form.room.trim(),
      });
      toast.success('Period added!');
      setForm({ period: '', timeStart: '08:00', timeEnd: '08:45', subject: '', teacher: '', room: '' });
      const r = await api.get('/admin/timetable');
      setTimetables(r.data.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not add period.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (ck, period) => {
    const label = choices.find((c) => c.id === ck)?.label || ck;
    if (!window.confirm(`Delete period ${period} of ${label}? This cannot be undone.`)) return;
    try {
      await api.delete(`/admin/timetable/${ck}/${period}`);
      toast.success('Period removed.');
      const r = await api.get('/admin/timetable');
      setTimetables(r.data.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not remove period.');
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Timetable Editor</div>
        <div className="page-subtitle">Add and manage class schedules</div>
      </div>

      <div className="form-group" style={{ maxWidth: 280, marginBottom: 'var(--sp-lg)' }}>
        <label className="form-label">Select Class</label>
        <select className="form-input" value={classKey} onChange={(e) => setClassKey(e.target.value)}>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
      </div>

      <div className="section">
        <div className="section-title"><Clock size={14} /> Periods — {activeLabel}</div>
        {periods.length === 0 ? (
          <div className="empty-state">
            <Clock size={40} />
            No periods scheduled yet.
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr><th>Period</th><th>Time</th><th>Subject</th><th>Teacher</th><th>Room</th><th>{''}</th></tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={`${p.period}`}>
                    <td><b>{p.period}</b></td>
                    <td>{p.timeStart} – {p.timeEnd}</td>
                    <td>{p.subject}</td>
                    <td>{p.teacher}</td>
                    <td>{p.room}</td>
                    <td>
                      <button className="btn btn-danger btn-sm" onClick={() => handleDelete(classKey, p.period)} aria-label="Delete period">
                        <Trash size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="section">
        <div className="section-title"><Plus size={14} /> Add Period</div>
        <div className="card">
          <form onSubmit={handleAdd} style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 'var(--sp-md)' }}>
            <div className="form-group">
              <label className="form-label">Period *</label>
              <input className="form-input" type="number" min="1" max="12" value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Time Start</label>
              <input className="form-input" type="time" value={form.timeStart} onChange={(e) => setForm({ ...form, timeStart: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Time End</label>
              <input className="form-input" type="time" value={form.timeEnd} onChange={(e) => setForm({ ...form, timeEnd: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Subject *</label>
              <input className="form-input" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Teacher *</label>
              <input className="form-input" value={form.teacher} onChange={(e) => setForm({ ...form, teacher: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Room *</label>
              <input className="form-input" value={form.room} onChange={(e) => setForm({ ...form, room: e.target.value })} />
            </div>
            <button className="btn btn-primary" disabled={saving} style={{ gridColumn: '1 / -1' }}>
              <Plus size={16} /> {saving ? 'Adding...' : 'Add Period'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}