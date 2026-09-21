import { useEffect, useState } from 'react';
import { Upload, Plus, Check, Pencil, BookMarked } from 'lucide-react';
import Modal from '../../components/Modal';
import api from '../../services/api';
import { loadOptions } from '../../services/options';
import { classChoices } from '../../utils/classes';
import ClassSelect from '../../components/ClassSelect';
import toast from 'react-hot-toast';

const EMPTY = { subject: '', topics: '' };

/**
 * Derived completion: (done topics / total topics) × 100, rounded to the
 * nearest whole number. Never stored, never entered by hand — every display
 * here (and in the student portal) computes it from the topic list.
 */
const percentOf = (topics) =>
  topics.length === 0
    ? 0
    : Math.round((topics.filter((t) => t.done).length / topics.length) * 100);

/** 'Algebra\nGeometry' → [{ topic: 'Algebra', done: false }, ...] (blanks + duplicates dropped) */
const parseTopicLines = (text) => {
  const seen = new Set();
  const out = [];
  text.split('\n').map((t) => t.trim()).filter(Boolean).forEach((topic) => {
    if (!seen.has(topic)) {
      seen.add(topic);
      out.push({ topic, done: false });
    }
  });
  return out;
};

/** Keep each fresh topic's done state when its name is unchanged (exact match) */
const mergeDoneState = (previous, fresh) =>
  fresh.map((f) => ({ ...f, done: previous.some((p) => p.topic === f.topic && p.done) }));

const linesOf = (topics) => topics.map((t) => t.topic).join('\n');

/**
 * Admin Syllabus — track syllabus coverage per class and subject.
 * The subjects table renders every topic as a chip (green = done, outline =
 * not done) with a completion percentage DERIVED from the chips; "Edit" opens
 * the shared modal where clicking a chip toggles it (local state until saved)
 * and an "Edit topic list" section handles renames/additions/removals.
 * The backend upserts by (classKey, subject), so re-submitting a subject
 * updates it. New subjects are uploaded below with every topic starting as
 * not done — there is no manual percentage anywhere.
 */
export default function AdminSyllabus() {
  const [syllabus, setSyllabus] = useState({});
  const [classes, setClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [classKey, setClassKey] = useState('');
  const [form, setForm] = useState(EMPTY); // "Upload Syllabus" (new subjects only)
  const [saving, setSaving] = useState(false);

  // Edit dialog (existing subjects): local state until Save — Cancel discards.
  const [editSubject, setEditSubject] = useState(null); // entry being edited
  const [editTopics, setEditTopics] = useState([]); // [{ topic, done }]
  const [showTopicList, setShowTopicList] = useState(false);
  const [topicsText, setTopicsText] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // Load failure must never look like "no data" — a dead API would otherwise
  // render an empty class dropdown and a misleading "no syllabus" message.
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  /** Fetch the syllabus map (classId → entries) */
  const fetchSyllabus = () => api.get('/admin/syllabus').then((r) => r.data.data || {});
  const load = () => fetchSyllabus().then(setSyllabus);

  useEffect(() => {
    Promise.all([fetchSyllabus(), loadOptions()])
      .then(([data, o]) => {
        setSyllabus(data);
        setClasses(o.classes);
        // Prefer a class that already has entries, else the first real class
        setClassKey((current) => current || Object.keys(data)[0] || o.classes[0]?.id || '');
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, [reloadKey]);

  /* Class options: database classes ∪ classes already in the payload, sorted */
  const choices = classChoices(Object.keys(syllabus), classes);
  const activeLabel = choices.find((c) => c.id === classKey)?.label || '';
  const entries = syllabus[classKey] || [];

  /* ---- New-subject upload: every topic starts as not done ---- */
  const handleUpload = async (e) => {
    e.preventDefault();
    const topics = parseTopicLines(form.topics);
    if (!form.subject.trim() || topics.length === 0) {
      toast.error('Enter a subject and at least one topic (one per line).');
      return;
    }
    setSaving(true);
    try {
      const res = await api.post('/admin/syllabus', { classKey, subject: form.subject.trim(), topics });
      toast.success(res.data.message || 'Syllabus uploaded!');
      setForm(EMPTY);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save syllabus.');
    } finally {
      setSaving(false);
    }
  };

  /* ---- Edit dialog: chip toggles (local), topic list editing, save ---- */
  const openEdit = (entry) => {
    setEditSubject(entry);
    setEditTopics(entry.topics.map((t) => ({ ...t })));
    setTopicsText(linesOf(entry.topics));
    setShowTopicList(false);
  };

  const closeEdit = () => setEditSubject(null);

  const toggleTopic = (index) =>
    setEditTopics((list) => list.map((t, i) => (i === index ? { ...t, done: !t.done } : t)));

  /** Apply the textarea: renames, additions, removals (done state survives exact matches) */
  const applyTopicList = () => {
    const fresh = parseTopicLines(topicsText);
    if (fresh.length === 0) {
      toast.error('Keep at least one topic (one per line).');
      return;
    }
    setEditTopics(mergeDoneState(editTopics, fresh));
    setShowTopicList(false);
  };

  const saveEdit = async () => {
    if (!editSubject) return;
    setSavingEdit(true);
    try {
      const res = await api.post('/admin/syllabus', {
        classKey,
        subject: editSubject.subject,
        topics: editTopics,
      });
      toast.success(res.data.message || 'Syllabus updated!');
      closeEdit();
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save syllabus.');
    } finally {
      setSavingEdit(false);
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  if (loadError) {
    return (
      <div className="page fade-in">
        <div className="page-header">
          <div className="page-title">Syllabus Management</div>
          <div className="page-subtitle">Upload and track syllabus coverage per class</div>
        </div>
        <div className="empty-state">
          <BookMarked size={40} />
          Could not load the class list or syllabus. Check that the API is running.
          <button
            className="btn btn-primary btn-sm"
            style={{ marginTop: 'var(--sp-md)' }}
            onClick={() => { setLoadError(false); setLoading(true); setReloadKey((k) => k + 1); }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Syllabus Management</div>
        <div className="page-subtitle">Upload and track syllabus coverage per class</div>
      </div>

      <ClassSelect
        id="syllabus-class"
        value={classKey}
        onChange={setClassKey}
        choices={choices}
        style={{ maxWidth: 280, marginBottom: 'var(--sp-lg)' }}
      />

      <div className="section">
        <div className="section-title"><BookMarked size={14} /> Subjects — {activeLabel}</div>
        {!classKey ? (
          <div className="empty-state"><BookMarked size={40} />Select a class to view or upload its syllabus.</div>
        ) : entries.length === 0 ? (
          <div className="empty-state"><BookMarked size={40} />No syllabus uploaded for this class yet.</div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr><th>Subject</th><th>Topics</th><th>Completion</th><th>{''}</th></tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const pct = percentOf(entry.topics);
                  const finished = pct === 100;
                  return (
                    <tr key={entry.subject}>
                      <td><b>{entry.subject}</b></td>
                      <td>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-xs)' }}>
                          {entry.topics.map((t) => (
                            <span key={t.topic} className={`topic-chip${t.done ? ' topic-chip--done' : ''}`}>
                              {t.done && <Check size={11} />}
                              {t.topic}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td style={{ minWidth: 160 }}>
                        <div className="progress-track">
                          <div className="progress-fill" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-sm">{finished ? '100% — Finished' : `${pct}%`}</span>
                      </td>
                      <td>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => openEdit(entry)}
                          aria-label={`Edit ${entry.subject} syllabus`}
                        >
                          <Pencil size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {classKey && (
        <div className="section" id="syllabus-form">
          <div className="section-title"><Upload size={14} /> Upload Syllabus</div>
          <div className="card">
            <form onSubmit={handleUpload} style={{ display: 'grid', gap: 'var(--sp-md)' }}>
              <div className="form-group">
                <label className="form-label">Subject *</label>
                <input
                  className="form-input"
                  value={form.subject}
                  onChange={(e) => setForm({ ...form, subject: e.target.value })}
                  placeholder="e.g. Mathematics"
                />
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
                <div className="text-sm text-muted" style={{ marginTop: 4 }}>
                  Every topic starts as not done — track completion with the chips on each subject row.
                </div>
              </div>
              <div>
                <button className="btn btn-primary" disabled={saving}>
                  <Plus size={16} /> {saving ? 'Uploading...' : 'Upload Syllabus'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editSubject && (
        <Modal
          title={`Update "${editSubject.subject}" syllabus`}
          onClose={closeEdit}
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={closeEdit}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={saveEdit} disabled={savingEdit}>
                {savingEdit ? 'Saving...' : 'Save Changes'}
              </button>
            </>
          }
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sp-md)' }}>
            <div className="text-sm text-muted">Tap a topic to toggle it done / not done.</div>
            <span className={`badge ${percentOf(editTopics) === 100 ? 'badge-success' : 'badge-warning'}`}>
              {percentOf(editTopics)}% complete
            </span>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-sm)', marginBottom: 'var(--sp-md)' }}>
            {editTopics.map((t, i) => (
              <button
                key={t.topic}
                type="button"
                className={`topic-chip${t.done ? ' topic-chip--done' : ''}`}
                onClick={() => toggleTopic(i)}
                aria-pressed={t.done}
                aria-label={`Toggle ${t.topic}`}
              >
                {t.done && <Check size={11} />}
                {t.topic}
              </button>
            ))}
          </div>

          <div className="progress-track" style={{ marginBottom: 'var(--sp-md)' }}>
            <div className="progress-fill" style={{ width: `${percentOf(editTopics)}%` }} />
          </div>

          {showTopicList ? (
            <div className="card" style={{ padding: 'var(--sp-md)' }}>
              <div className="form-group">
                <label className="form-label" htmlFor="syllabus-topics-list">Topics (one per line)</label>
                <textarea
                  id="syllabus-topics-list"
                  className="form-input"
                  rows={6}
                  value={topicsText}
                  onChange={(e) => setTopicsText(e.target.value)}
                />
              </div>
              <div className="text-sm text-muted" style={{ marginBottom: 'var(--sp-md)' }}>
                Renamed topics start as not done again; unchanged names keep their done state; removed topics are dropped.
              </div>
              <div style={{ display: 'flex', gap: 'var(--sp-md)' }}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={applyTopicList}>Apply List</button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowTopicList(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowTopicList(true)}>
              <Pencil size={14} /> Edit topic list
            </button>
          )}
        </Modal>
      )}
    </div>
  );
}

