import { useEffect, useState } from 'react';
import { Bell, CalendarClock, Download, Megaphone, Pencil, Send, Target, Trash, Users } from 'lucide-react';
import api from '../../services/api';
import { loadOptions, optionLabel } from '../../services/options';
import { downloadBlob, filenameFromDisposition } from '../../utils/download';
import toast from '../../services/toast';
import Modal from '../../components/Modal';
import ConfirmModal from '../../components/ConfirmModal';
import { AnnouncementPdfField } from '../../components/AnnouncementForm';
import { validateAnnouncement } from '../../utils/announcement';
import { useSubmitGuard } from '../../utils/useSubmitGuard';
import AnnouncementTargetDialog from '../../components/AnnouncementTargetDialog';
import { ROLES } from '../../constants/roles';
import LoadErrorState from '../../components/LoadErrorState';
import { useLoadState } from '../../utils/useLoadState';

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
 * Who a circular actually went to, from the server's `targetScope`:
 * the Audience tags for a broad publish, the one class for a targeted class
 * send, or all employees. Targeted sends are listed here too — a circular sent
 * to one class is still a circular, and the admin manages every circular from
 * one screen.
 */
const audienceLabel = (a) => {
  if (a.targetScope === 'CLASS') return a.targetClassLabel || 'one class';
  if (a.targetScope === 'EMPLOYEES') return 'All employees';
  return a.targetRoles.join(', ');
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
  const [classOptions, setClassOptions] = useState([]);
  const [classesLoading, setClassesLoading] = useState(false);
  const { loading, setLoading, error, reloadKey, retry, fail } = useLoadState();
  const [form, setForm] = useState({
    title: '', body: '', category: '', targetRoles: [ROLES.STUDENT, ROLES.TEACHER],
    showFrom: '', // blank → server defaults to today
    showUntil: '', // required
  });
  // The picked PDF stays outside `form` (a File is not a form value) and is
  // sent as multipart alongside the text fields.
  const [attachment, setAttachment] = useState(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null); // announcement being rescheduled
  const [editForm, setEditForm] = useState({ showFrom: '', showUntil: '' });
  // "Send To…" popup
  const [targetOpen, setTargetOpen] = useState(false);
  const [targetSending, setTargetSending] = useState(false);
  // One burst of clicking runs the validation once; `cooling` greys the
  // buttons while the message is being read. Wrapped around the handlers
  // below, once they exist.
  const [guard, cooling] = useSubmitGuard();

  const load = () =>
    Promise.all([api.get('/admin/announcements'), loadOptions()]).then(([r, o]) => {
      setList(r.data.data);
      setCategories(o.enums.announcementCategories);
      setClassOptions(o.classes || []);
      setForm((f) => ({ ...f, category: f.category || o.enums.announcementCategories[0] || '' }));
    });

  useEffect(() => {
    load().catch(fail).finally(() => setLoading(false));
  }, [reloadKey, fail, setLoading]);

  const toggleRole = (role) => {
    const has = form.targetRoles.includes(role);
    setForm({
      ...form,
      targetRoles: has ? form.targetRoles.filter((r) => r !== role) : [...form.targetRoles, role],
    });
  };

  /** Multipart body shared by the broad publish and the targeted send. */
  const buildPayload = (extra = {}) => {
    const data = new FormData();
    data.append('title', form.title.trim());
    data.append('body', form.body.trim());
    data.append('category', form.category);
    data.append('showUntil', form.showUntil);
    // Omitted when blank — the server makes it visible from today.
    if (form.showFrom) data.append('showFrom', form.showFrom);
    if (attachment) data.append('file', attachment);
    Object.entries(extra).forEach(([k, v]) => { if (v !== undefined) data.append(k, v); });
    return data;
  };

  const resetForm = () => {
    setForm({ title: '', body: '', category: categories[0] || 'general', targetRoles: [ROLES.STUDENT, ROLES.TEACHER], showFrom: '', showUntil: '' });
    setAttachment(null);
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (form.targetRoles.length === 0) {
      toast.error('Pick at least one audience for a broadcast.');
      return;
    }
    const problem = validateAnnouncement(form);
    if (problem) { toast.error(problem); return; }

    setSaving(true);
    try {
      const data = buildPayload();
      form.targetRoles.forEach((r) => data.append('targetRoles', r));
      await api.post('/admin/announcements', data);
      toast.success('Announcement posted!');
      resetForm();
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not post announcement.');
    } finally {
      setSaving(false);
    }
  };

  /** Open the "Send To…" popup (the class list is already loaded live). */
  const openTargetDialog = () => {
    const problem = validateAnnouncement(form);
    if (problem) { toast.error(problem); return; }
    setClassesLoading(false);
    setTargetOpen(true);
  };

  // Both action buttons run through the guard, so an empty title raises ONE
  // "Title is required" message per burst of clicking rather than one per click.
  const guardedCreate = guard(handleCreate);
  const guardedOpenTarget = guard(openTargetDialog);

  /**
   * Confirm step accepted — POST the same text to the one chosen target. The
   * server resolves the audience from `targetScope`, so the Audience tags above
   * are deliberately not sent.
   */
  const handleTargetedSend = async ({ scope, targetClassId }) => {
    setTargetSending(true);
    try {
      const res = await api.post('/admin/announcements/targeted', buildPayload({ targetScope: scope, targetClassId }));
      toast.success(res.data.message || 'Announcement sent.');
      setTargetOpen(false);
      resetForm();
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not send the announcement.');
    } finally {
      setTargetSending(false);
    }
  };

  /** Download a circular's PDF attachment (admin may fetch any circular's). */
  const downloadAttachment = async (a) => {
    try {
      const res = await api.get(`/admin/announcements/${a.id}/pdf`, { responseType: 'blob' });
      const filename = filenameFromDisposition(res.headers?.['content-disposition'])
        || `${a.title.replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '')}.pdf`;
      downloadBlob(new Blob([res.data], { type: 'application/pdf' }), filename);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not download the attachment.');
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

  // A failed request is not "no announcements yet" — the two are told apart
  // before the empty state below can ever be reached.
  if (error) {
    return (
      <LoadErrorState
        title="Announcements"
        subtitle="Post circulars for students & staff"
        detail={error}
        onRetry={retry}
        icon={Bell}
      />
    );
  }

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
          <form onSubmit={guardedCreate} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}>
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
              <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-xs)' }}>
                These tags apply to <b>Publish Announcement</b> only. “Send To…” below sends to one
                exact target instead, whatever is selected here.
              </div>
            </div>
            <AnnouncementPdfField
              file={attachment}
              onChange={setAttachment}
              onClear={() => setAttachment(null)}
              disabled={saving || targetSending}
            />
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
            <div style={{ display: 'flex', gap: 'var(--sp-sm)', flexWrap: 'wrap' }}>
              <button className="btn btn-primary" disabled={saving || targetSending || cooling}>
                <Bell size={16} /> {saving ? 'Posting...' : 'Publish Announcement'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={guardedOpenTarget}
                disabled={saving || targetSending || cooling}
                title="Send this same announcement to one exact target instead of the audience tags"
              >
                <Target size={16} /> Send To…
              </button>
            </div>
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
                        {a.category} · {new Date(a.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} · For: {audienceLabel(a)}
                      </div>
                      <div className="text-sm" style={{ marginTop: 'var(--sp-xs)', fontWeight: 600 }}>
                        Visible: {fmtDay(a.showFrom)} → {fmtDay(a.showUntil)}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-sm)', marginTop: 'var(--sp-sm)' }}>
                        {a.targetScope !== 'ROLES' && (
                          <span className="badge">
                            {a.targetScope === 'CLASS' ? <Users size={12} /> : <Megaphone size={12} />} Targeted
                          </span>
                        )}
                        {a.isTeacherPush && <span className="badge">From: {a.authorName || 'a teacher'}</span>}
                        {a.hasAttachment && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => downloadAttachment(a)}
                            title={a.attachmentName || 'Download the attached PDF'}
                          >
                            <Download size={14} /> {a.attachmentName || 'Attachment'}
                          </button>
                        )}
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

      {/* "Send To…" — targeted send: one class or all employees, with a
          confirm step. The class list is the live /school/options list, so it
          is never a hardcoded set of classes. */}
      <AnnouncementTargetDialog
        open={targetOpen}
        title={form.title.trim()}
        classOptions={classOptions}
        classesLoading={classesLoading}
        allowEmployees
        sending={targetSending}
        onClose={() => setTargetOpen(false)}
        onConfirm={handleTargetedSend}
      />

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