import { useEffect, useState } from 'react';
import { PartyPopper, Plus, Trash } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';

/**
 * Admin Holidays — add and manage school holiday calendar.
 */
export default function AdminHolidays() {
  const [holidays, setHolidays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => api.get('/admin/holidays').then((r) => setHolidays(r.data.data));

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!name.trim() || !date) {
      toast.error('Enter a holiday name and date.');
      return;
    }
    setSaving(true);
    try {
      await api.post('/admin/holidays', { date, name: name.trim() });
      toast.success('Holiday added!');
      setName('');
      setDate('');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not add holiday.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (h) => {
    if (!window.confirm(`Delete holiday "${h.name}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/admin/holidays/${h.id}`);
      toast.success('Holiday removed.');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not remove holiday.');
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  const sorted = [...holidays].sort((a, b) => (a.date < b.date ? -1 : 1));

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Holiday Management</div>
        <div className="page-subtitle">{holidays.length} holidays scheduled</div>
      </div>

      <div className="section">
        <div className="section-title"><Plus size={14} /> Add Holiday</div>
        <div className="card">
          <form onSubmit={handleAdd} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 'var(--sp-md)', alignItems: 'end' }}>
            <div className="form-group">
              <label className="form-label">Holiday Name *</label>
              <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Diwali" />
            </div>
            <div className="form-group">
              <label className="form-label">Date *</label>
              <input className="form-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <button className="btn btn-primary" disabled={saving}>
              <Plus size={16} /> {saving ? 'Adding...' : 'Add'}
            </button>
          </form>
        </div>
      </div>

      <div className="section">
        <div className="section-title"><PartyPopper size={14} /> Upcoming Holidays</div>
        {sorted.length === 0 ? (
          <div className="empty-state"><PartyPopper size={40} />No holidays scheduled.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}>
            {sorted.map((h) => (
              <div key={h.id} className="doc-item">
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-md)' }}>
                  <div className="doc-icon" style={{ background: 'var(--tint-green)', color: 'var(--clr-success)' }}>
                    <PartyPopper size={20} />
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{h.name}</div>
                    <div className="text-sm text-muted">
                      {new Date(`${h.date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                    </div>
                  </div>
                </div>
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(h)} aria-label="Delete holiday">
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