import { useEffect, useRef, useState } from 'react';
import { ChevronRight, GraduationCap, Plus, Pencil, Trash, Upload, KeyRound, Eye } from 'lucide-react';
import Modal from '../../components/Modal';
import ConfirmModal from '../../components/ConfirmModal';
import ResetPasswordModal from '../../components/ResetPasswordModal';
import StudentProfileModal from '../../components/StudentProfileModal';
import { contactToField, fieldToContact, isValidContact } from '../../utils/phone';
import api from '../../services/api';
import { loadOptions } from '../../services/options';
import toast from 'react-hot-toast';
import studentForm from './studentForm';

/**
 * Blank form. Class/section start empty and are seeded from the classes that
 * exist in the database when the modal opens — no hardcoded grade/section.
 */
const EMPTY_FORM = {
  name: '', class: '', section: '', rollNumber: '', parentName: '', guardianContact: '',
  admissionYear: '', bloodGroup: '', dob: '', feeTotal: '', feeDues: '', address: '',
};

/** CSV columns — header row required, in this exact order (RollNumber optional) */
const BULK_COLUMNS = ['Name', 'Class', 'Section', 'RollNumber', 'ParentGuardian', 'Contact', 'FeeDues'];

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

/** Download a CSV template containing just the required header row */
const downloadTemplate = () => {
  const blob = new Blob([`\uFEFF${BULK_COLUMNS.join(',')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'students-template.csv';
  a.click();
  URL.revokeObjectURL(url);
};

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
  const [q, setQ] = useState('');
  const [modal, setModal] = useState(null); // { mode: 'create' | 'edit' | 'bulk' | 'roster', ... }
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [rowRefs] = useState(() => new Map()); // class key → row element, for focus return
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Bulk-upload error lives in its own state so it can never leak into the
  // Bulk Add modal on open — it is only ever set by handleBulk (a real,
  // failed submit attempt) and cleared when the modal opens or a file is chosen.
  const [bulkError, setBulkError] = useState('');
  // Reset-password modal: the user account of the student being reset.
  // Null when the student has no account (the button only renders when userId exists).
  const [resettingUser, setResettingUser] = useState(null);
  // Full profile view: the student whose profile is open from the class roster.
  const [viewing, setViewing] = useState(null);

  const load = (query = q) =>
    Promise.all([
      api.get('/admin/students/by-class', { params: query ? { q: query } : undefined }),
      api.get('/admin/students'),
      loadOptions(), // classes are re-read because this page can create them
    ]).then(([c, s, o]) => {
      const classRows = c.data.data;
      setClasses(classRows);
      setStudents(s.data.data);
      setOptions(o);
      return { classes: classRows }; // so callers can sync an open roster modal
    });

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

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
    // Default to a class that exists (first by grade), never a fixed grade/section
    const first = options.classes[0];
    setForm({
      ...EMPTY_FORM,
      class: preset.class ?? first?.grade ?? '',
      section: preset.section ?? first?.section ?? '',
    });
    setError('');
    setModal({ mode: 'create' });
  };

  const openEdit = (s) => {
    setForm({
      name: s.name || '', class: s.class || '', section: s.section || '', rollNumber: s.rollNumber || '',
      parentName: s.parentName || '', guardianContact: contactToField(s.guardianContact),
      admissionYear: s.admissionYear || '', bloodGroup: s.bloodGroup || '', dob: s.dob || '',
      feeTotal: s.feeTotal ?? '', feeDues: s.feeDues ?? '', address: s.address || '',
    });
    setError('');
    setModal({ mode: 'edit', student: s });
  };

  // Destructive-action confirmation (ConfirmModal replaces window.confirm)
  const [confirm, setConfirm] = useState(null);

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
    if (!form.name.trim() || !String(form.class).trim() || !String(form.section).trim()) {
      setError('Name, Class and Section are required.');
      return;
    }
    if (!isValidContact(form.guardianContact)) {
      setError('Enter a valid 10-digit contact number.');
      return;
    }
    setSaving(true);
    try {
      const payload = toPayload(form);
      if (modal.mode === 'create') {
        const res = await api.post('/admin/students', payload);
        // The server auto-provisions the login (username from the name, initial
        // password = guardian contact) — surface it so the admin can hand it out.
        const acc = res.data.data?.account;
        toast.success(acc?.username
          ? `Student added — login ${acc.username} · initial password = guardian contact`
          : 'Student added!');
      } else {
        await api.put(`/admin/students/${modal.student.id}`, payload);
        toast.success('Student updated.');
      }
      setModal(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save the student.');
    } finally {
      setSaving(false);
    }
  };

  const handleBulk = async (file) => {
    setBulkError(''); // choosing a file always clears any previous error
    if (!file) {
      setBulkError('Choose a .csv or .xlsx file first.');
      return;
    }
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.post('/admin/students/bulk', fd);
      toast.success(res.data.message || 'Students added.');
      setModal(null);
      await load();
    } catch (err) {
      // Only place the bulk banner is ever populated — a real failed attempt.
      setBulkError(err.response?.data?.message || 'Bulk upload failed.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Student Management</div>
        <div className="page-subtitle">
          {students.length} students across {classes.length} {classes.length === 1 ? 'class' : 'classes'}
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
            onClick={() => { setBulkError(''); setModal({ mode: 'bulk' }); }}
          >
            <Upload size={16} /> Bulk Add
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
              <button
                className="btn btn-primary"
                onClick={() => openCreate(preset)}
                disabled={saving}
              >
                <Plus size={16} /> Add Student to this Class
              </button>
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
        <Modal
          title="Bulk Add Students"
          onClose={() => setModal(null)}
          footer={
            <button className="btn btn-secondary" onClick={() => setModal(null)}>Cancel</button>
          }
        >
          {bulkError && <div className="login-error" style={{ marginBottom: 'var(--sp-md)' }}>{bulkError}</div>}
          <div className="form-group">
            <label className="form-label">Upload a spreadsheet (.csv or .xlsx)</label>
            <input
              type="file"
              className="form-input"
              accept=".csv,.xlsx"
              disabled={saving}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = ''; // allow re-choosing the same file after a failed attempt
                if (file) handleBulk(file);
              }}
              aria-label="Bulk upload file"
            />
          </div>
          <div className="text-sm" style={{ marginTop: 'var(--sp-sm)' }}>
            <a href="#" onClick={(e) => { e.preventDefault(); downloadTemplate(); }}>
              Download template
            </a>
          </div>
          <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-sm)' }}>
            Header row required, in this order: {BULK_COLUMNS.join(', ')}. RollNumber is optional —
            blank cells get the next available roll number for that class/section. Up to 200 students
            per file. Added atomically — if any row is invalid, nothing is saved.
          </div>
        </Modal>
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
