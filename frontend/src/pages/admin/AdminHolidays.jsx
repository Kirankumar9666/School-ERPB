import { useEffect, useRef, useState } from 'react';
import { PartyPopper, Pencil, Plus, Trash } from 'lucide-react';
import api from '../../services/api';
import toast from '../../services/toast';
import ConfirmModal from '../../components/ConfirmModal';
import LoadErrorState from '../../components/LoadErrorState';
import { useLoadState } from '../../utils/useLoadState';

/**
 * Admin Holidays — add and manage school holiday calendar.
 */
export default function AdminHolidays() {
  const [holidays, setHolidays] = useState([]);
  const { loading, setLoading, error, reloadKey, retry, fail } = useLoadState();
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null);
  const formRef = useRef(null);
  // Destructive-action confirmation (ConfirmModal replaces window.confirm)
  const [confirm, setConfirm] = useState(null);

  const load = () => api.get('/admin/holidays').then((r) => setHolidays(r.data.data));

  useEffect(() => {
    load().catch(fail).finally(() => setLoading(false));
  }, [reloadKey, fail, setLoading]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !date) {
      toast.error('Enter a holiday name and date.');
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/admin/holidays/${editing.id}`, { date, name: name.trim() });
        toast.success('Holiday updated!');
      } else {
        await api.post('/admin/holidays', { date, name: name.trim() });
        toast.success('Holiday added!');
      }
      setName('');
      setDate('');
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(
        err.response?.data?.message
        || (editing ? 'Could not update holiday.' : 'Could not add holiday.')
      );
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (h) => {
    setEditing(h);
    setName(h.name);
    setDate(h.date);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const cancelEdit = () => {
    setEditing(null);
    setName('');
    setDate('');
  };

  const handleDelete = (h) => {
    setConfirm({
      title: 'Delete Holiday',
      message: `Delete holiday “${h.name}”? This cannot be undone.`,
      onConfirm: async () => {
        try {
          await api.delete(`/admin/holidays/${h.id}`);
          if (editing?.id === h.id) cancelEdit();
          toast.success('Holiday removed.');
          await load();
        } catch (err) {
          toast.error(err.response?.data?.message || 'Could not remove holiday.');
        }
        setConfirm(null);
      },
    });
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  // A failed request is not "no holidays yet" — the two are told apart before
  // the empty state below can ever be reached.
  if (error) {
    return (
      <LoadErrorState
        title="Holiday Management"
        subtitle="Holidays scheduled"
        detail={error}
        onRetry={retry}
        icon={PartyPopper}
      />
    );
  }

  const sorted = [...holidays].sort((a, b) => (a.date < b.date ? -1 : 1));

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Holiday Management</div>
        <div className="page-subtitle">{holidays.length} holidays scheduled</div>
      </div>

      <div className="section">
        <div className="section-title">
          {editing ? <Pencil size={14} /> : <Plus size={14} />} {editing ? 'Edit Holiday' : 'Add Holiday'}
        </div>
        <div className="card" ref={formRef}>
          <form onSubmit={handleSubmit} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 'var(--sp-md)', alignItems: 'end' }}>
            <div className="form-group">
              <label className="form-label">Holiday Name *</label>
              <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Diwali" />
            </div>
            <div className="form-group">
              <label className="form-label">Date *</label>
              <input className="form-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div style={{ display: 'flex', gap: 'var(--sp-sm)' }}>
              <button className="btn btn-primary" disabled={saving}>
                {editing ? <Pencil size={16} /> : <Plus size={16} />}
                {saving
                  ? (editing ? 'Saving...' : 'Adding...')
                  : (editing ? 'Save Changes' : 'Add')}
              </button>
              {editing && (
                <button type="button" className="btn btn-secondary" onClick={cancelEdit} disabled={saving}>
                  Cancel
                </button>
              )}
            </div>
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
                <div style={{ display: 'flex', gap: 'var(--sp-sm)' }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => startEdit(h)}
                    aria-label={`Edit ${h.name}`}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => handleDelete(h)}
                    aria-label="Delete holiday"
                  >
                    <Trash size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {confirm && (
        <ConfirmModal
          title={confirm.title}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          tone="danger"
          onClose={() => setConfirm(null)}
          onConfirm={confirm.onConfirm}
        >
          <p>{confirm.message}</p>
        </ConfirmModal>
      )}
    </div>
  );
}