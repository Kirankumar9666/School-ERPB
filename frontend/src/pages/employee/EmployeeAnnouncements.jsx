import { useEffect, useState } from 'react';
import { Bell, Download, Megaphone, Send, UserCheck } from 'lucide-react';
import api from '../../services/api';
import LoadErrorState from '../../components/LoadErrorState';
import { useLoadState } from '../../utils/useLoadState';
import { useAuth } from '../../context/AuthContext';
import { loadOptions, optionLabel } from '../../services/options';
import { downloadBlob, filenameFromDisposition } from '../../utils/download';
import toast from '../../services/toast';
import Modal from '../../components/Modal';
import { AnnouncementFields, AnnouncementPdfField } from '../../components/AnnouncementForm';
import { validateAnnouncement } from '../../utils/announcement';
import { useSubmitGuard } from '../../utils/useSubmitGuard';
import AnnouncementTargetDialog from '../../components/AnnouncementTargetDialog';

/**
 * Employee Announcements — the school circulars this employee's role receives,
 * plus the "Push Announcement" flow for teachers.
 *
 * A teacher can push an announcement to ONE of their own classes, with an
 * optional PDF, using the same form fields and the same "Send To…" popup as the
 * admin panel. Two deliberate restrictions, enforced on the server (not just
 * hidden here):
 *   • the class list is their real teaching assignments, so a class they don't
 *     teach is not offered and would be rejected anyway;
 *   • "Employees" (all staff) is not offered at all — that blast radius stays
 *     with the admin.
 * Announcements they push are attributed to them, and the card shows "From:
 * <their name>" so students can tell it apart from an office circular.
 */
export default function EmployeeAnnouncements() {
  const { user } = useAuth();
  const [announcements, setAnnouncements] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const { loading, setLoading, error, reloadKey, retry, fail } = useLoadState();

  // Push flow
  const [categories, setCategories] = useState([]);
  const [classOptions, setClassOptions] = useState([]);
  const [classesLoading, setClassesLoading] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [targetOpen, setTargetOpen] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', category: '', showFrom: '', showUntil: '' });
  const [attachment, setAttachment] = useState(null);
  const [guard, cooling] = useSubmitGuard();

  const employeeId = user?.linkedEntityId;
  // Teachers can push; an accountant/librarian has no class of their own, so
  // the button is hidden for them (the API rejects it either way).
  const canPush = user?.role === 'teacher' && Boolean(employeeId);

  const load = () =>
    api.get('/school/announcements').then((r) => setAnnouncements(r.data.data || []));

  useEffect(() => {
    load().catch(fail).finally(() => setLoading(false));
  }, [reloadKey, fail, setLoading]);

  /**
   * Open the push dialog and load what the form needs from the API:
   * the shared category list, and — the part that matters — the classes THIS
   * teacher may target, from the assignment-scoped endpoint (never /school/options,
   * which would offer classes the send would be rejected for).
   */
  const openPush = () => {
    setForm({ title: '', body: '', category: categories[0] || 'general', showFrom: '', showUntil: '' });
    setAttachment(null);
    setPushOpen(true);
    setClassesLoading(true);

    loadOptions()
      .then((o) => {
        const cats = o.enums.announcementCategories || [];
        setCategories(cats);
        setForm((f) => ({ ...f, category: f.category || cats[0] || 'general' }));
      })
      .catch(() => {})
      .finally(() =>
        api.get(`/employees/${employeeId}/announcement/classes`)
          .then((r) => setClassOptions(r.data.data || []))
          .catch(() => setClassOptions([]))
          .finally(() => setClassesLoading(false))
      );
  };

  const buildPayload = (extra = {}) => {
    const data = new FormData();
    data.append('title', form.title.trim());
    data.append('body', form.body.trim());
    data.append('category', form.category);
    data.append('showUntil', form.showUntil);
    if (form.showFrom) data.append('showFrom', form.showFrom);
    if (attachment) data.append('file', attachment);
    Object.entries(extra).forEach(([k, v]) => { if (v !== undefined) data.append(k, v); });
    return data;
  };

  const openTarget = () => {
    const problem = validateAnnouncement(form);
    if (problem) { toast.error(problem); return; }
    if (classOptions.length === 0) {
      toast.error('You have no classes assigned, so there is nobody to send to.');
      return;
    }
    setTargetOpen(true);
  };

  // One burst of clicking runs the validation once; `cooling` greys the
  // "Send To…" button while the message is being read.
  const guardedOpenTarget = guard(openTarget);

  const handlePush = async ({ scope, targetClassId }) => {
    setSending(true);
    try {
      const res = await api.post(`/employees/${employeeId}/announcements`, buildPayload({ targetScope: scope, targetClassId }));
      toast.success(res.data.message || 'Announcement sent.');
      setTargetOpen(false);
      setPushOpen(false);
      setForm({ title: '', body: '', category: categories[0] || 'general', showFrom: '', showUntil: '' });
      setAttachment(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not send the announcement.');
    } finally {
      setSending(false);
    }
  };

  const downloadAttachment = async (a) => {
    try {
      const res = await api.get(`/school/announcements/${a.id}/pdf`, { responseType: 'blob' });
      const filename = filenameFromDisposition(res.headers?.['content-disposition'])
        || `${a.title.replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '')}.pdf`;
      downloadBlob(new Blob([res.data], { type: 'application/pdf' }), filename);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not download the attachment.');
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  if (error) {
    return (
      <LoadErrorState
        title="Announcements"
        subtitle="Staff meetings, exams, events & announcements"
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
        <div className="page-subtitle">Staff meetings, exams, events & announcements</div>
      </div>

      {canPush && (
        <div className="section">
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-primary" onClick={openPush}>
              <Send size={16} /> Push Announcement
            </button>
          </div>
          <div className="text-sm text-muted" style={{ textAlign: 'right' }}>
            Send a notice to one of your own classes, with an optional PDF.
          </div>
        </div>
      )}

      {announcements.length === 0 ? (
        <div className="empty-state">
          <Bell size={40} />
          No announcements right now.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}>
          {announcements.map((a) => {
            const isOpen = expanded === a.id;
            return (
              <div
                key={a.id}
                className={`announcement-card${isOpen ? ' expanded' : ''}`}
                onClick={() => setExpanded(isOpen ? null : a.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && setExpanded(isOpen ? null : a.id)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-md)' }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: 'var(--r-md)', flexShrink: 0,
                    background: 'var(--tint-oxblood)', color: 'var(--clr-primary-h)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Megaphone size={20} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>{a.title}</div>
                    <div className="text-sm text-muted">
                      {a.category} · {new Date(a.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                      {a.fromTeacher && a.authorName ? ` · From: ${a.authorName}` : ''}
                    </div>
                    {a.hasAttachment && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        style={{ marginTop: 'var(--sp-sm)' }}
                        onClick={(e) => { e.stopPropagation(); downloadAttachment(a); }}
                      >
                        <Download size={14} /> {a.attachmentName || 'Download attachment'}
                      </button>
                    )}
                  </div>
                  <span className="badge" style={{ background: 'var(--tint-gold)', color: 'var(--clr-warning)' }}>
                    {isOpen ? 'Hide' : 'View'}
                  </span>
                </div>
                {isOpen && (
                  <div className="slide-up" style={{ marginTop: 'var(--sp-md)', color: 'var(--clr-text-muted)', fontSize: 14, lineHeight: 1.7 }}>
                    {a.body}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Push dialog — same fields and the same "Send To…" popup as the admin */}
      {pushOpen && (
        <Modal title="Push Announcement" onClose={() => setPushOpen(false)}>
          <form
            onSubmit={guardedOpenTarget}
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}
          >
            <div className="text-sm text-muted">
              This notice goes to the students of one of your classes only — it is attributed to
              you and appears on their Announcements page.
            </div>
            <AnnouncementFields
              value={form}
              onChange={setForm}
              categories={categories}
              optionLabel={optionLabel}
              disabled={sending}
            />
            <AnnouncementPdfField
              file={attachment}
              onChange={setAttachment}
              onClear={() => setAttachment(null)}
              disabled={sending}
            />
            <div style={{ display: 'flex', gap: 'var(--sp-sm)' }}>
              <button type="submit" className="btn btn-primary" disabled={sending || classesLoading || cooling}>
                <UserCheck size={16} /> Send To…
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setPushOpen(false)} disabled={sending}>
                Cancel
              </button>
            </div>
          </form>

          <AnnouncementTargetDialog
            open={targetOpen}
            title={form.title.trim()}
            classOptions={classOptions}
            classesLoading={classesLoading}
            allowEmployees={false}
            sending={sending}
            onClose={() => setTargetOpen(false)}
            onConfirm={handlePush}
          />
        </Modal>
      )}
    </div>
  );
}