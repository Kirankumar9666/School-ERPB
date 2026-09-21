import { useEffect, useState } from 'react';
import { Bell, CalendarClock, Pencil, Send, Trash } from 'lucide-react';
import api from '../../services/api';
import { loadOptions, optionLabel } from '../../services/options';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import ConfirmModal from '../../components/ConfirmModal';
import { ROLES } from '../../constants/roles';

const ROLES_LIST = Object.values(ROLES);

/** Today's local date as 'YYYY-MM-DD'. Display-only: the admin panel's status
 *  chips read the real clock on every render — the authoritative appear/
 *  disappear filtering happens server-side on every /school/announcements
 *  request, from each circular's stored showFrom/showUntil. */
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 'YYYY-MM-DD' → '8 Sep 2026' (en-IN) */
const fmtDay = (iso) => (iso
  ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  : '—');

/**
 * Where the circular sits in its show window right now, computed from the
 * real current date on every render: Scheduled (not started yet), Visible,
 * or Expired (showUntil passed — it has already vanished from the portals).
 */
const scheduleStatus = (a) => {
  const today = todayISO();
  if (today < a.showFrom) return { label: 'Scheduled', cls: 'badge-holiday' };
  if (today <= a.showUntil) return { label: 'Visible', cls: 'badge-active' };
  return { label: 'Expired', cls: 'badge-absent' };
};

/**
 * Admin Announcements — create, schedule, list and delete circulars.
 * Categories are validated server-side (constants/options.js) and served by
 * /school/options; the target-role list comes from the shared ROLES constants.
 *
 * Every circular carries a show window: "Show from" (blank = today) and a
 * required "Show until" — after that date the circular stops appearing on the
 * student/employee portals on its own. The window is editable later (e.g. to
 * extend an exam-schedule notice); the server recomputes visibility from the
 * real current date on every request, so nothing here hardcodes dates.
 */
export default function AdminAnnouncements() {
  const [list, setList] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    title: '', body: '', category: '', targetRoles: [ROLES.STUDENT, ROLES.TEACHER],
    showFrom: '', // blank → server defaults to today
    showUntil: '', // required
  });
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null); // announcement being rescheduled
  const [editForm, setEditForm] = useState({ showFrom: '', showUntil: '' });

  const load = () =>
    Promise.all([api.get('/admin/announcements'), loadOptions()]).then(([r, o]) => {
      setList(r.data.data);
      setCategories(o.enums.announcementCategories);
      setForm((f) => ({ ...f, category: f.category || o.enums.announcementCategories[0] || '' }));
    });

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
    if (!form.showUntil) {
      toast.error('"Show until" is required — it is the last day the circular is visible.');
      return;
    }
    if (form.showFrom && form.showFrom > form.showUntil) {
      toast.error('"Show until" must be on or after "Show from".');
      return;
    }
    setSaving(true);
    try {
      await api.post('/admin/announcements', {
        title: form.title.trim(), body: form.body.trim(), category: form.category, targetRoles: form.targetRoles,
        showUntil: form.showUntil,
        // Omitted when blank — the server makes it visible from today.
        ...(form.showFrom ? { showFrom: form.showFrom } : {}),
      });
      toast.success('Announcement posted!');
      setForm({ title: '', body: '', category: 'general', targetRoles: [ROLES.STUDENT, ROLES.TEACHER], showFrom: '', showUntil: '' });
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not post announcement.');
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (a) => {
    setEditing(a);
    setEditForm({ showFrom: a.showFrom || '', showUntil: a.showUntil || '' });
  };

  const handleEditSave = async (e) => {
    e.preventDefault();
    if (!editForm.showUntil) {
      toast.error('"Show until" is required.');
      return;
    }
    if (editForm.showFrom && editForm.showFrom > editForm.showUntil) {
      toast.error('"Show until" must be on or after "Show from".');
      return;
    }
    setSaving(true);
    try {
      await api.put(`/admin/announcements/${editing.id}`, {
        title: editing.title, body: editing.body, category: editing.category,
        targetRoles: editing.targetRoles, showFrom: editForm.showFrom, showUntil: editForm.showUntil,
      });
      toast.success('Schedule updated.');
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not update the schedule.');
    } finally {
      setSaving(false);
    }
  };

  // Destructive-action confirmation (ConfirmModal replaces window.confirm)
  const [confirm, setConfirm] = useState(null);

  const handleDelete = (a) => {
    setConfirm({
      title: 'Delete Announcement',
      message: `Delete “${a.title}”? This cannot be undone.`,
      onConfirm: async () => {
        try {
          await api.delete(`/admin/announcements/${a.id}`);
          toast.success('Announcement deleted.');
          await load();
        } catch (err) {
          toast.error(err.response?.data?.message || 'Delete failed.');
        }
        setConfirm(null);
      },
    });
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
            <div className="form-grid-2">
              <div className="form-group">
                <label className="form-label">Title *</label>
                <input className="form-input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. PTM on Saturday" />
              </div>
              <div className="form-group">
                <label className="form-label">Category</label>
                <select className="form-input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                  {categories.map((c) => <option key={c} value={c}>{optionLabel(c)}</option>)}
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
            <div className="form-grid-2">
              <div className="form-group">
                <label className="form-label"><CalendarClock size={13} /> Show from (blank = today)</label>
                <input
                  type="date" className="form-input" value={form.showFrom}
                  onChange={(e) => setForm({ ...form, showFrom: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label"><CalendarClock size={13} /> Show until *</label>
                <input
                  type="date" className="form-input" required value={form.showUntil}
                  onChange={(e) => setForm({ ...form, showUntil: e.target.value })}
                />
                <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-xs)' }}>
                  After this day the circular stops appearing — no manual hiding needed.
                </div>
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
            {list.map((a) => {
              const status = scheduleStatus(a);
              return (
                <div key={a.id} className="announcement-card">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--sp-md)' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 15, fontWeight: 700 }}>{a.title}</div>
                      <div className="text-sm text-muted">
                        {a.category} · {new Date(a.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} · For: {a.targetRoles.join(', ')}
                      </div>
                      <div className="text-sm" style={{ marginTop: 'var(--sp-xs)', fontWeight: 600 }}>
                        Visible: {fmtDay(a.showFrom)} → {fmtDay(a.showUntil)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-sm)', flexShrink: 0 }}>
                      <span className={`badge ${status.cls}`}>{status.label}</span>
                      <button className="btn btn-secondary btn-sm" onClick={() => openEdit(a)} aria-label="Edit schedule">
                        <Pencil size={14} />
                      </button>
                      <button className="btn btn-danger btn-sm" onClick={() => handleDelete(a)} aria-label="Delete announcement">
                        <Trash size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Edit schedule — change "Show from"/extend "Show until" at any time */}
      {editing && (
        <Modal title={`Schedule: ${editing.title}`} onClose={() => setEditing(null)}>
          <form onSubmit={handleEditSave} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}>
            <div className="form-group">
              <label className="form-label">Show from</label>
              <input
                type="date" className="form-input" value={editForm.showFrom}
                onChange={(e) => setEditForm({ ...editForm, showFrom: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Show until *</label>
              <input
                type="date" className="form-input" required value={editForm.showUntil}
                onChange={(e) => setEditForm({ ...editForm, showUntil: e.target.value })}
              />
              <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-xs)' }}>
                Extend this to keep a notice visible longer (e.g. an exam-schedule circular).
              </div>
            </div>
            <button className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save schedule'}
            </button>
          </form>
        </Modal>
      )}

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