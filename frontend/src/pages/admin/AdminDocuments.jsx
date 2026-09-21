import { useEffect, useState, useRef } from 'react';
import { FileUp, Plus, Trash, FileText, Upload } from 'lucide-react';
import api from '../../services/api';
import { loadOptions } from '../../services/options';
import ClassSelect from '../../components/ClassSelect';
import ConfirmModal from '../../components/ConfirmModal';
import toast from 'react-hot-toast';

/** '10' + 'A' → 'cls-10A' (same id format the class list uses) */
const classIdOf = (grade, section) => `cls-${String(grade)}${String(section).toUpperCase()}`;

const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

const EMPTY_FORM = { type: '', file: null };

/** Quick-select categories for the upload form — replaces the old free-text
 *  "Document Type" input. Generic labels only (no per-person data); the value
 *  is stored in the same `type` column the lists already display. */
const DOC_CATEGORIES = [
  'Birth Certificate',
  'ID Proof',
  'Transfer Certificate',
  'Report Card',
  'Marksheet',
  'Migration Certificate',
  'Other',
];

/** Client-side PDF check — the server re-validates extension + MIME + magic
 *  bytes, so a renamed non-PDF can never be stored even if this is bypassed. */
const isPdfFile = (file) => !!file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name));

/**
 * Admin Documents — per-person document records behind Students / Employees
 * top-level tabs (same tab pattern as the Attendance page).
 *
 * Students tab: pick a class (shared ClassSelect, sourced from
 * GET /school/options like every other screen) → live roster (roll no, name)
 * → click a student to see THEIR documents and upload into their file.
 * Employees tab: live name search over the real staff list → click an
 * employee to see THEIR documents and upload into their file.
 *
 * Every list is fetched from the API at request time — no class, name, type
 * or count is ever local. Selecting a different class/person (or switching
 * tabs) clears the document view first, so stale records from a previous
 * selection are never visible.
 */
export default function AdminDocuments() {
  const [tab, setTab] = useState('students'); // top-level Students / Employees tabs
  const [classes, setClasses] = useState([]); // live class list (options API)
  const [students, setStudents] = useState([]); // live student list
  const [employees, setEmployees] = useState([]); // live employee list
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Students tab selection
  const [classKey, setClassKey] = useState('');
  const [selectedStudentId, setSelectedStudentId] = useState('');
  const [studentQuery, setStudentQuery] = useState(''); // name/roll-no search within the class
  // Employees tab selection
  const [query, setQuery] = useState('');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');

  // Document view for the currently selected person (either tab)
  const [docs, setDocs] = useState(null); // null = nothing fetched yet
  const [docsLoading, setDocsLoading] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const fileInputRef = useRef(null);

  useEffect(() => {
    Promise.all([loadOptions(), api.get('/admin/students'), api.get('/admin/employees')])
      .then(([o, s, e]) => {
        setClasses(o.classes);
        setStudents(s.data.data || []);
        setEmployees(e.data.data || []);
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, [reloadKey]);

  /** Roster of the selected class, narrowed live by the name/roll-no search */
  const roster = students.filter((s) => classIdOf(s.class, s.section) === classKey);
  const studentTerm = studentQuery.trim().toLowerCase();
  const classStudents = roster.filter((s) => !studentTerm
    || [s.name, s.rollNumber].some((v) => String(v ?? '').toLowerCase().includes(studentTerm)));
  const selectedStudent = students.find((s) => s.id === selectedStudentId) || null;
  const selectedEmployee = employees.find((e) => e.id === selectedEmployeeId) || null;
  const selected = tab === 'students' ? selectedStudent : selectedEmployee;

  /** Live name search for the Employees tab (same interaction as Attendance) */
  const term = query.trim().toLowerCase();
  const employeeResults = term
    ? employees.filter((e) => [e.name, e.employeeId, e.designation, e.role, e.department]
      .some((v) => String(v ?? '').toLowerCase().includes(term)))
    : employees;

  /** Fetch ONE person's documents — the URL itself is scoped to that person */
  const loadDocs = async (kind, personId) => {
    setDocsLoading(true);
    try {
      const res = await api.get(kind === 'student'
        ? `/admin/students/${personId}/documents`
        : `/employees/${personId}/documents`);
      setDocs(res.data.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load documents.');
      setDocs(null);
    } finally {
      setDocsLoading(false);
    }
  };

  /** Reset the upload form: clears the category, the picked file, any inline
   *  error and the native input's value (so the same file can be re-picked). */
  const resetForm = () => {
    setDocs(null);
    setForm(EMPTY_FORM);
    setFormError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const clearSelection = () => resetForm();

  /** Native file picker change — store the File, surface its real name, and
   *  immediately flag a non-PDF pick inline (the browser filter is advisory). */
  const handleFileChosen = (e) => {
    const file = e.target.files?.[0] || null;
    setFormError('');
    setForm((prev) => ({ ...prev, file }));
    if (file && !isPdfFile(file)) setFormError('Only PDF files are allowed');
    e.target.value = ''; // allow re-choosing the same file after a failed attempt
  };


  const changeClass = (id) => {
    setClassKey(id);
    setSelectedStudentId('');
    setStudentQuery(''); // the search is class-scoped — a new class starts clean
    clearSelection(); // never leave the previous student's list on screen
  };

  const changeTab = (next) => {
    setTab(next);
    if (next === 'employees') setQuery('');
    clearSelection();
  };

  const selectStudent = (s) => {
    if (s.id === selectedStudentId) return;
    setSelectedStudentId(s.id);
    clearSelection();
    loadDocs('student', s.id);
  };

  /** Back to the full table (search results kept) so another student can be picked */
  const deselectStudent = () => {
    setSelectedStudentId('');
    clearSelection();
  };

  const selectEmployee = (e) => {
    if (e.id === selectedEmployeeId) return;
    setSelectedEmployeeId(e.id);
    clearSelection();
    loadDocs('employee', e.id);
  };

  /** Upload into the selected person's file — the endpoint itself is scoped.
   *  The stored name is derived server-side from the actual file; the only
   *  manual choice is the category. A non-PDF is blocked client-side with an
   *  inline error and re-checked server-side (extension + MIME + magic bytes). */
  const handleUpload = async (ev) => {
    ev.preventDefault();
    const person = tab === 'students' ? selectedStudent : selectedEmployee;
    if (!person) return;
    if (form.type.trim().length < 2) {
      setFormError('Select a document category.');
      return;
    }
    if (!form.file) {
      setFormError('Choose a PDF file to upload.');
      return;
    }
    if (!isPdfFile(form.file)) {
      setFormError('Only PDF files are allowed');
      return;
    }
    setSaving(true);
    try {
      const url = tab === 'students'
        ? `/admin/students/${person.id}/documents`
        : `/admin/employees/${person.id}/documents`;
      const fd = new FormData();
      fd.append('file', form.file);
      fd.append('type', form.type.trim());
      await api.post(url, fd);
      toast.success('Document uploaded!');
      setForm(EMPTY_FORM);
      setFormError('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      await loadDocs(tab === 'students' ? 'student' : 'employee', person.id);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not upload document.');
    } finally {
      setSaving(false);
    }
  };

  // Destructive-action confirmation (ConfirmModal replaces window.confirm)
  const [confirm, setConfirm] = useState(null);

  /** Ask, then delete exactly the confirmed record and re-read the same person's list */
  const handleDelete = (doc) => {
    setConfirm({
      title: 'Delete Document Record',
      message: `Delete document record “${doc.fileName}”? This cannot be undone.`,
      onConfirm: async () => {
        try {
          await api.delete(tab === 'students' ? `/admin/student-documents/${doc.id}` : `/admin/documents/${doc.id}`);
          toast.success('Document record removed.');
          await loadDocs(tab === 'students' ? 'student' : 'employee', selected.id);
        } catch (err) {
          toast.error(err.response?.data?.message || 'Could not remove document.');
        }
        setConfirm(null);
      },
    });
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  if (loadError) {
    return (
      <div className="page fade-in">
        <div className="page-header">
          <div className="page-title">Document Management</div>
          <div className="page-subtitle">Student and employee document records</div>
        </div>
        <div className="empty-state">
          <FileText size={40} />
          Could not load the class, student or employee lists. Check that the API is running.
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
        <div className="page-title">Document Management</div>
        <div className="page-subtitle">Student and employee document records</div>
      </div>

      {/* Top-level tabs — same pattern as the Attendance page */}
      <div className="tabs">
        <button className={`tab-btn${tab === 'students' ? ' active' : ''}`} onClick={() => changeTab('students')}>Students</button>
        <button className={`tab-btn${tab === 'employees' ? ' active' : ''}`} onClick={() => changeTab('employees')}>Employees</button>
      </div>

      {tab === 'students' ? (
        <div className="card">
          <div style={{ display: 'flex', gap: 'var(--sp-md)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <ClassSelect
              id="documents-class"
              placeholder="Choose a class…"
              value={classKey}
              onChange={changeClass}
              choices={classes}
              style={{ flex: 1, minWidth: 220, maxWidth: 320, marginBottom: 0 }}
            />
            <div className="form-group" style={{ flex: 1, minWidth: 220, marginBottom: 0 }}>
              <label className="form-label" htmlFor="student-search">Search student</label>
              <input
                id="student-search"
                className="form-input"
                placeholder={classKey ? 'Search by name or roll no…' : 'Choose a class first…'}
                value={classKey ? studentQuery : ''}
                disabled={!classKey}
                onChange={(e) => setStudentQuery(e.target.value)}
                autoComplete="off"
              />
            </div>
          </div>
          {classKey && (
            selectedStudent ? (
              /* Collapsed: only the selected student remains, with a way back */
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 'var(--sp-md)',
                  flexWrap: 'wrap',
                  padding: 'var(--sp-md)',
                  border: '1px solid var(--line-2)',
                  borderRadius: 6,
                  background: 'var(--green-soft)',
                }}
              >
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{selectedStudent.name}</div>
                  <div className="text-sm text-muted">Roll No: {selectedStudent.rollNumber || '—'}</div>
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={deselectStudent}>
                  Change student
                </button>
              </div>
            ) : (
              <>
                {roster.length === 0 ? (
                  <div className="empty-state text-sm text-muted">
                    No students in this class yet — add students first.
                  </div>
                ) : classStudents.length === 0 ? (
                  <div className="empty-state text-sm text-muted">
                    No students match &ldquo;{studentQuery.trim()}&rdquo;.
                  </div>
                ) : (
                  <div className="table-wrapper">
                    <table>
                      <thead>
                        <tr><th>Roll No</th><th>Name</th></tr>
                      </thead>
                      <tbody>
                        {classStudents.map((s) => (
                          <tr
                            key={s.id}
                            onClick={() => selectStudent(s)}
                            onKeyDown={(e) => { if (e.key === 'Enter') selectStudent(s); }}
                            tabIndex={0}
                            role="button"
                            style={{ cursor: 'pointer' }}
                          >
                            <td>{s.rollNumber || '—'}</td>
                            <td><b>{s.name}</b></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )
          )}
        </div>
      ) : (
        <div className="card">
          <div className="form-group">
            <label className="form-label" htmlFor="employee-search">Search employee</label>
            <input
              id="employee-search"
              className="form-input"
              placeholder="Search employee by name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
          </div>
          {employeeResults.length === 0 ? (
            <div className="empty-state text-sm text-muted">
              {term ? `No employees match "${query.trim()}".` : 'No employees on staff yet.'}
            </div>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr><th>Name</th><th>Role</th></tr>
                </thead>
                <tbody>
                  {employeeResults.map((e) => (
                    <tr
                      key={e.id}
                      onClick={() => selectEmployee(e)}
                      onKeyDown={(ev) => { if (ev.key === 'Enter') selectEmployee(e); }}
                      tabIndex={0}
                      role="button"
                      aria-pressed={e.id === selectedEmployeeId}
                      style={{
                        cursor: 'pointer',
                        background: e.id === selectedEmployeeId ? 'var(--green-soft)' : undefined,
                      }}
                    >
                      <td><b>{e.name}</b></td>
                      <td>{e.role}{e.designation ? ` · ${e.designation}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {selected && (
        <>
          <div className="section">
            <div className="section-title">
              <FileText size={14} /> Documents — {selected.name}
            </div>
            {docsLoading ? (
              <div className="loading-center"><div className="spinner" /></div>
            ) : docs === null ? null : docs.length === 0 ? (
              <div className="empty-state">
                <FileText size={40} />
                No documents uploaded yet for {selected.name}.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}>
                {docs.map((d) => (
                  <div key={d.id} className="doc-item">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-md)' }}>
                      <div className="doc-icon"><FileText size={20} /></div>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600 }}>{d.fileName}</div>
                        <div className="text-sm text-muted">
                          {d.type} • uploaded {fmtDate(d.uploadedAt)}
                        </div>
                      </div>
                    </div>
                    <button className="btn btn-danger btn-sm" onClick={() => handleDelete(d)} aria-label={`Delete ${d.fileName}`}>
                      <Trash size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="section">
            <div className="section-title"><FileUp size={14} /> Upload Document Record</div>
            <div className="card">
              <form onSubmit={handleUpload} className="doc-upload-grid">
                <div className="form-group">
                  <label className="form-label" htmlFor="doc-category">Category *</label>
                  <select
                    id="doc-category"
                    className="form-input"
                    value={form.type}
                    onChange={(e) => setForm({ ...form, type: e.target.value })}
                  >
                    <option value="">Select a category…</option>
                    {DOC_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">File (PDF only) *</label>
                  <div className="doc-file-row">
                    <input
                      ref={fileInputRef}
                      id="doc-file-input"
                      type="file"
                      accept="application/pdf"
                      className="doc-file-input"
                      onChange={handleFileChosen}
                    />
                    <label className="btn btn-secondary" htmlFor="doc-file-input">
                      <Upload size={16} /> Choose File
                    </label>
                    <span className="doc-file-name" title={form.file?.name || ''}>
                      {form.file ? form.file.name : 'No file chosen'}
                    </span>
                  </div>
                </div>
                <button className="btn btn-primary" disabled={saving}>
                  <Plus size={16} /> {saving ? 'Uploading...' : 'Confirm'}
                </button>
              </form>
              {formError && (
                <div className="login-error" style={{ marginTop: 'var(--sp-md)' }}>{formError}</div>
              )}
            </div>
          </div>
        </>
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

