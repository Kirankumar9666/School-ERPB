import { useEffect, useRef, useState } from 'react';
import { ChevronRight, GraduationCap, Plus, Pencil, Trash, Upload, KeyRound, Eye, TriangleAlert } from 'lucide-react';
import Modal from '../../components/Modal';
import ConfirmModal from '../../components/ConfirmModal';
import ResetPasswordModal from '../../components/ResetPasswordModal';
import StudentProfileModal from '../../components/StudentProfileModal';
import LoadErrorState from '../../components/LoadErrorState';
import CreateClassModal from '../../components/CreateClassModal';
import BulkAddModal from '../../components/BulkAddModal';
import { contactToField, fieldToContact } from '../../utils/phone';
import { apiErrorMessage } from '../../utils/apiError';
import api from '../../services/api';
import { loadOptions } from '../../services/options';
import toast from '../../services/toast';
import studentForm from './studentForm';

/**
 * Blank form. Class/section start empty and are seeded from the classes that
 * exist in the database when the modal opens — no hardcoded grade/section.
 */
const EMPTY_FORM = {
  name: '', class: '', section: '', rollNumber: '', parentName: '', guardianContact: '',
  admissionYear: '', bloodGroup: '', dob: '', feeTotal: '', feeDues: '', address: '',
  // The class chosen from the shared list; class/section mirror it so the legacy
  // typed form still travels in the payload.
  classId: '',
};

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;


/**
 * Admin Students — class-grouped overview with search, per-class member
 * management (add / edit / delete) and CSV/XLSX bulk admissions parsed
 * and validated on the backend.
 */
export default function AdminStudents() {
  const [classes, setClasses] = useState([]);
  const [students, setStudents] = useState([]);
  const [options, setOptions] = useState({ enums: {}, classes: [] });
  const [loading, setLoading] = useState(true);
  /* Why the last load failed, in words the office can act on. Without this the
     page had no way to tell "the school has no students" apart from "I could not
     ask" — it rendered a confident "0 students across 0 classes" and an empty
     state telling you to add your first admission, while every student was still
     in the database. A blank list and a failed request must not look alike. */
  const [loadError, setLoadError] = useState('');
  const [q, setQ] = useState('');
  const [modal, setModal] = useState(null); // { mode: 'create' | 'edit' | 'bulk' | 'roster', ... }
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [rowRefs] = useState(() => new Map()); // class key → row element, for focus return
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Reset-password modal: the user account of the student being reset.
  // Null when the student has no account (the button only renders when userId exists).
  const [resettingUser, setResettingUser] = useState(null);
  // Full profile view: the student whose profile is open from the class roster.
  const [viewing, setViewing] = useState(null);
  // Create Class / Add Level. The level list is read alongside the class list so
  // both dropdowns share one source.
  const [creatingClass, setCreatingClass] = useState(false);
  const [levels, setLevels] = useState([]);

  const load = (query = q) =>
    Promise.all([
      api.get('/admin/students/by-class', { params: query ? { q: query } : undefined }),
      api.get('/admin/students'),
      loadOptions(), // classes are re-read because this page can create them
      api.get('/admin/class-levels'),
    ]).then(([c, s, o, lv]) => {
      const classRows = c.data.data;
      setClasses(classRows);
      setStudents(s.data.data);
      setOptions(o);
      setLevels(lv.data.data || []);
      setLoadError('');
      return { classes: classRows }; // so callers can sync an open roster modal
    })
    /* Promise.all rejects as soon as ANY of the three does, so one failed request
       used to abandon the .then entirely — leaving the arrays at their `[]`
       initial values and the page showing a blank but authoritative-looking
       summary. The failure is now recorded so the render can say so; it still
       re-throws, because the callers after a save/delete have their own try/catch
       and should hear that the refresh did not happen. */
    .catch((err) => {
      setLoadError(err.response?.data?.message || err.message || 'Could not reach the server.');
      throw err;
    });

  useEffect(() => {
    load()
      .catch(() => { /* already recorded in loadError; render below reports it */ })
      .finally(() => setLoading(false));
  }, []);

  /** Re-run the same load from the error state — the failure may have been a blip. */
  const retry = () => {
    setLoading(true);
    load().catch(() => {}).finally(() => setLoading(false));
  };

  /* How many students hold no current class. `mapStudent` reports that as a null
     `class`, so this is derivable from the list the page already has — no extra
     request, and it can never disagree with the count on the same line. */
  const unassignedCount = students.filter((s) => !s.class).length;

  // Live search as you type (debounced): only the class-group list is refetched —
  // the students list and dropdown options are unaffected by the query.
  const firstSearch = useRef(true);
  useEffect(() => {
    if (firstSearch.current) {
      firstSearch.current = false;
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await api.get('/admin/students/by-class', { params: q ? { q } : undefined });
        setClasses(res.data.data);
      } catch {
        /* keep the current view; the page reload / toast will surface API errors */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [q]);

  const membersFor = (c) => {
    const byId = new Map(students.map((s) => [s.id, s]));
    return (c.studentIds || []).map((id) => byId.get(id)).filter(Boolean);
  };

  const openRoster = (c) =>
    setModal({ mode: 'roster', cls: c, returnRef: { current: rowRefs.get(c.key) || null } });

  const openCreate = (preset = {}) => {
    // Default to the first class that exists (lowest level order), never a fixed
    // grade/section - a school with no pre-primary must not see Nursery offered.
    const first = options.classes[0];
    setForm({
      ...EMPTY_FORM,
      classId: preset.classId ?? first?.id ?? '',
      class: preset.class ?? first?.grade ?? '',
      section: preset.section ?? first?.section ?? '',
    });
    setError('');
    setModal({ mode: 'create' });
  };

  const openEdit = (s) => {
    setForm({
      name: s.name || '', class: s.class || '', section: s.section || '', rollNumber: s.rollNumber || '',
      // The real class id, so editing a student in Nursery works and the form
      // shows the class they are actually in rather than an order number.
      classId: s.classId || '',
      parentName: s.parentName || '', guardianContact: contactToField(s.guardianContact),
      admissionYear: s.admissionYear || '', bloodGroup: s.bloodGroup || '', dob: s.dob || '',
      feeTotal: s.feeTotal ?? '', feeDues: s.feeDues ?? '', address: s.address || '',
    });
    setError('');
    setModal({ mode: 'edit', student: s });
  };

  // Destructive-action confirmation (ConfirmModal replaces window.confirm)
  const [confirm, setConfirm] = useState(null);
  // The empty class awaiting delete confirmation. Kept apart from `confirm` so the
  // class panel can stay open behind it.
  const [deleteClass, setDeleteClass] = useState(null);

  const handleDelete = (s) => {
    setConfirm({
      title: 'Delete Student',
      message: `Delete student “${s.name}”? This cannot be undone.`,
      onConfirm: async () => {
        try {
          await api.delete(`/admin/students/${s.id}`);
          toast.success('Student deleted.');
          const fresh = await load();
          // Keep an open roster modal, but rebind it to the refreshed summary row
          // (close it if the class no longer exists after the delete).
          setModal((m) => {
            if (m?.mode !== 'roster') return m;
            const updated = fresh.classes.find((x) => x.key === m.cls.key);
            return updated ? { ...m, cls: updated } : null;
          });
        } catch (err) {
          toast.error(err.response?.data?.message || 'Delete failed.');
        }
        setConfirm(null);
      },
    });
  };

  const toPayload = (f) => ({
    name: f.name.trim(),
    // The class id is the payload; the typed form is only the legacy fallback.
    classId: f.classId || undefined,
    class: String(f.class).trim(),
    section: String(f.section).trim().toUpperCase(),
    rollNumber: f.rollNumber.trim() || undefined,
    parentName: f.parentName.trim() || undefined,
    guardianContact: fieldToContact(f.guardianContact) || undefined,
    address: f.address.trim() || undefined,
    admissionYear: f.admissionYear === '' ? undefined : Number(f.admissionYear),
    bloodGroup: f.bloodGroup.trim() || undefined,
    dob: f.dob || undefined,
    feeTotal: f.feeTotal === '' ? undefined : Number(f.feeTotal),
    feeDues: f.feeDues === '' ? undefined : Number(f.feeDues),
  });

  const handleSave = async () => {
    setError('');
    if (!form.name.trim() || !form.classId) {
      setError('Name and Class are required.');
      return;
    }
    /* Guardian name and contact are REQUIRED, marked * on the form. They are the
       identity a duplicate student is recognised by, and the contact is what the
       student's login password is derived from — a blank one would leave a child
       the duplicate rule cannot see and the login service cannot provision. The
       server enforces exactly the same rule; this only avoids the round trip. */
    if (!form.parentName.trim()) {
      setError('Parent / Guardian is required.');
      return;
    }
    if (form.guardianContact.length !== 10) {
      setError('Enter a valid 10-digit guardian contact number.');
      return;
    }
    /* The same two rules the server enforces, checked here only to spare the
       round trip: a future date of birth and a fee that is not whole rupees.
       Neither is a warning — the API refuses both. */
    const today = new Date().toISOString().slice(0, 10);
    if (form.dob && form.dob > today) {
      setError('Date of birth cannot be in the future');
      return;
    }
    if ((form.feeTotal !== '' && Number(form.feeTotal) % 1 !== 0)
      || (form.feeDues !== '' && Number(form.feeDues) % 1 !== 0)) {
      setError('Enter a whole rupee amount');
      return;
    }
    setSaving(true);
    try {
      const payload = toPayload(form);
      if (modal.mode === 'create') {
        const res = await api.post('/admin/students', payload);
        // The server auto-provisions the login (username from the name, initial
        // password = guardian contact) — this response is the ONLY place it is
        // ever stated, so surface it here for the handover. It cannot be read
        // back afterwards, and the student must change it at first login.
        const acc = res.data.data?.account;
        toast.success(acc?.username
          ? `Student added — login ${acc.username} · initial password = guardian contact (shown now only — it can't be retrieved later)`
          : 'Student added!');
      } else {
        await api.put(`/admin/students/${modal.student.id}`, payload);
        toast.success('Student updated.');
      }
      setModal(null);
      await load();
    } catch (err) {
      // Surface the server's per-field messages (QA-A1-010): a rejected field
      // used to arrive as a bare "Validation failed" with no clue which one.
      setError(apiErrorMessage(err, {}, 'Could not save the student.'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  /* Per-row / per-column bulk failures, under the banner. Row numbers count the
     header line, so "Row 2" is the file's second line — the same numbering the
     server reports on, which the admin sees in their spreadsheet. */

  /* A failed load must NOT fall through to the empty state further down. "0
     students across 0 classes" paired with "No students yet. Add your first
     admission." is a statement that the school has no students — a completely
     different claim from "I could not ask". Presenting the second as the first
     is what made a single 500 response look like the whole database had been
     emptied, so the two are now told apart before anything else renders. */
  if (loadError) {
    return (
      <LoadErrorState
        title="Student Management"
        detail={loadError}
        onRetry={retry}
        icon={TriangleAlert}
      />
    );
  }

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Student Management</div>
        <div className="page-subtitle">
          {students.length} student{students.length === 1 ? '' : 's'} across{' '}
          {classes.length} {classes.length === 1 ? 'class' : 'classes'}
          {/* Students with no current class are counted above because they still
              exist, but they belong to no class card — they are alumni and
              past-year records, and saying so keeps the two numbers from
              looking like a discrepancy. */}
          {unassignedCount > 0 && (
            <span className="text-muted">
              {' · '}
              {unassignedCount} not in a current class (see Class History)
            </span>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--sp-md)', flexWrap: 'wrap', marginBottom: 'var(--sp-lg)' }}>
        <div style={{ flex: 1, maxWidth: 380 }}>
          <input
            className="form-input"
            placeholder="Search name, roll no, class…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search students"
          />
        </div>
        <div style={{ display: 'flex', gap: 'var(--sp-sm)' }}>
          <button
            className="btn btn-secondary"
            onClick={() => setModal({ mode: 'bulk' })}
          >
            <Upload size={16} /> Bulk Add
          </button>
          {/* Same outline style as Bulk Add: it creates, but it is not the
              action the page is about (that is still Add Student). */}
          <button
            className="btn btn-secondary"
            onClick={() => setCreatingClass(true)}
          >
            <Plus size={16} /> Create Class
          </button>
          <button className="btn btn-primary" onClick={openCreate}>
            <Plus size={16} /> Add Student
          </button>
        </div>
      </div>

      {classes.length === 0 ? (
        <div className="empty-state">
          <GraduationCap size={40} />
          {q ? `No students match “${q}”.` : 'No students yet. Add your first admission.'}
        </div>
      ) : (
        <div className="class-grid">
          {classes.map((c) => (
            <div
              key={c.key}
              className="class-card"
              onClick={() => openRoster(c)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRoster(c); } }}
              role="button"
              tabIndex={0}
              aria-haspopup="dialog"
              ref={(el) => { if (el) rowRefs.set(c.key, el); else rowRefs.delete(c.key); }}
            >
              <div className="class-card-top">
                <div className="class-card-icon">
                  <GraduationCap size={18} />
                </div>
                <ChevronRight size={18} className="class-card-chevron" aria-hidden="true" />
              </div>
              <div className="class-card-name">{c.class}</div>
              <div className="class-card-count">
                {c.totalStudents} {c.totalStudents === 1 ? 'student' : 'students'}
              </div>
              <div className="class-card-dues">
                <span className="class-card-dues-label">Fee dues</span>
                {c.feeDues > 0
                  ? <span className="badge badge-danger">{money(c.feeDues)}</span>
                  : <span className="badge badge-success">No dues</span>}
              </div>
              {c.previousDues > 0 && (
                <div className="text-sm text-muted">
                  includes {money(c.previousDues)} carried from earlier years
                </div>
              )}
              {c.avgMarks != null ? (
                <div className="class-card-stats">
                  <div className="class-card-stats-row">
                    <div className="class-card-stat">
                      <div className="class-card-stat-value">{c.avgMarks}%</div>
                      <div className="class-card-stat-label">Avg Score</div>
                    </div>
                    <div className="class-card-stat">
                      <div className="class-card-stat-value">{c.topScore}%</div>
                      <div className="class-card-stat-label">Top Score</div>
                    </div>
                  </div>
                  <div
                    className="progress-track"
                    role="img"
                    aria-label={`Average score ${c.avgMarks}%`}
                  >
                    <div
                      className="progress-fill"
                      style={{ width: `${Math.max(0, Math.min(100, c.avgMarks))}%` }}
                    />
                  </div>
                </div>
              ) : (
                <div className="class-card-no-marks">No marks recorded yet</div>
              )}
            </div>
          ))}
        </div>
      )}

      {modal?.mode === 'roster' && (() => {
        const c = modal.cls;
        const members = membersFor(c);
        const sep = c.key.indexOf('-');
        const preset = sep === -1
          ? { class: c.key, section: '' }
          : { class: c.key.slice(0, sep), section: c.key.slice(sep + 1) };
        return (
          <Modal
            wide
            title={c.class}
            returnFocusRef={modal.returnRef}
            onClose={() => setModal(null)}
            footer={(
              <>
                {/* Delete class, offered only for a class that holds nothing. A
                    class with any record cannot be deleted (the route refuses and
                    names what is in the way), so offering it would be a promise the
                    server will not keep. */}
                {c.totalStudents === 0 && (
                  <button
                    className="btn btn-secondary"
                    onClick={() => setDeleteClass(c)}
                    disabled={saving}
                    title="This class has no students and no records"
                  >
                    <Trash size={16} /> Delete class
                  </button>
                )}
                <button
                  className="btn btn-primary"
                  onClick={() => openCreate(preset)}
                  disabled={saving}
                >
                  <Plus size={16} /> Add Student to this Class
                </button>
              </>
            )}
          >
            <div className="modal-meta">
              <div>
                <div className="modal-meta-label">Students</div>
                <div className="modal-meta-value">{c.totalStudents}</div>
              </div>
              <div>
                <div className="modal-meta-label">Fee Dues</div>
                <div className="modal-meta-value">{money(c.feeDues)}</div>
              </div>
              <div>
                <div className="modal-meta-label">Avg Marks</div>
                <div className="modal-meta-value">{c.avgMarks != null ? `${c.avgMarks}%` : '—'}</div>
              </div>
              <div>
                <div className="modal-meta-label">Top Score</div>
                <div className="modal-meta-value">{c.topScore != null ? `${c.topScore}%` : '—'}</div>
              </div>
            </div>
            {members.length === 0 ? (
              <div className="empty-state" style={{ padding: 'var(--sp-xl)' }}>
                No students in this class yet.
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Roll No</th><th>Name</th><th>Parent</th><th>Contact</th><th>Fee Dues</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((s) => (
                    <tr key={s.id}>
                      <td>{s.rollNumber || '—'}</td>
                      <td><b>{s.name}</b></td>
                      <td>{s.parentName || '—'}</td>
                      <td>{s.guardianContact || '—'}</td>
                      <td>{s.feeDues ? money(s.feeDues) : '—'}</td>
                      <td>
                        <div className="flex gap-sm" style={{ alignItems: 'center' }}>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => setViewing(s)}
                            aria-label={`View profile of ${s.name}`}
                            title="View full profile"
                          >
                            <Eye size={14} />
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => openEdit(s)}
                            aria-label={`Edit ${s.name}`}
                          >
                            <Pencil size={14} />
                          </button>
                          {s.userId && (
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => setResettingUser({ id: s.userId, name: s.name })}
                              aria-label={`Reset password for ${s.name}`}
                              title={s.userId ? undefined : 'No user account for this student'}
                            >
                              <KeyRound size={14} />
                            </button>
                          )}
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => handleDelete(s)}
                            aria-label={`Delete ${s.name}`}
                          >
                            <Trash size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Modal>
        );
      })()}

      {(modal?.mode === 'create' || modal?.mode === 'edit') && (
        <Modal
          title={modal.mode === 'create' ? 'Add Student' : `Edit — ${modal.student.name}`}
          onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save Student'}
              </button>
            </>
          }
        >
          {error && <div className="login-error" style={{ marginBottom: 'var(--sp-md)' }}>{error}</div>}
          {studentForm(form, setForm, options)}
        </Modal>
      )}

      {modal?.mode === 'bulk' && (
        <BulkAddModal
          classes={classes}
          onClose={() => setModal(null)}
          // Refetch so the class card count and the shared list both update.
          onAdded={async () => { await load(); }}
        />
      )}


      {creatingClass && (
        <CreateClassModal
          levels={levels}
          onClose={() => setCreatingClass(false)}
          // The class card must appear immediately: refresh the page data and
          // the shared options list the dropdowns read.
          onCreated={async () => { await load(); }}
          onLevelAdded={async () => { await load(); }}
        />
      )}

      {viewing && (
        <StudentProfileModal
          student={viewing}
          onClose={() => setViewing(null)}
        />
      )}

      {resettingUser && (
        <ResetPasswordModal
          user={resettingUser}
          onClose={() => setResettingUser(null)}
        />
      )}

      {deleteClass && (
        <ConfirmModal
          title={`Delete ${deleteClass.class}?`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          tone="danger"
          onClose={() => setDeleteClass(null)}
          onConfirm={async () => {
            const target = deleteClass;
            setDeleteClass(null);
            try {
              const res = await api.delete(`/admin/classes/${target.id}`);
              toast.success(res.data.message);
              // Refresh so the card disappears and every dropdown loses it.
              await load();
              setModal((m) => {
                if (m?.mode !== 'roster') return m;
                return m.cls.id === target.id ? null : m;
              });
            } catch (err) {
              // The server refuses anything with data and says what is in the way,
              // so its message is the useful half of the answer.
              toast.error(err.response?.data?.message || 'Could not delete the class.');
            }
          }}
        >
          <p>
            This class has no students and no records. Deleting it removes it from
            every class list. This cannot be undone.
          </p>
        </ConfirmModal>
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
