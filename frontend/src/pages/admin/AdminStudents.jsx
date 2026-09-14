import { useEffect, useState } from 'react';
import { GraduationCap, Plus, Pencil, Trash, ChevronDown, Search, Upload } from 'lucide-react';
import Modal from '../../components/Modal';
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
  const [open, setOpen] = useState(null); // class key currently expanded
  const [modal, setModal] = useState(null); // { mode: 'create' | 'edit' | 'bulk' }
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = (query = q) =>
    Promise.all([
      api.get('/admin/students/by-class', { params: query ? { q: query } : undefined }),
      api.get('/admin/students'),
      loadOptions(), // classes are re-read because this page can create them
    ]).then(([c, s, o]) => {
      setClasses(c.data.data);
      setStudents(s.data.data);
      setOptions(o);
    });

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  const membersFor = (c) => {
    const byId = new Map(students.map((s) => [s.id, s]));
    return (c.studentIds || []).map((id) => byId.get(id)).filter(Boolean);
  };

  const openCreate = () => {
    // Default to a class that exists (first by grade), never a fixed grade/section
    const first = options.classes[0];
    setForm({ ...EMPTY_FORM, class: first?.grade || '', section: first?.section || '' });
    setError('');
    setModal({ mode: 'create' });
  };

  const openEdit = (s) => {
    setForm({
      name: s.name || '', class: s.class || '', section: s.section || '', rollNumber: s.rollNumber || '',
      parentName: s.parentName || '', guardianContact: s.guardianContact || '',
      admissionYear: s.admissionYear || '', bloodGroup: s.bloodGroup || '', dob: s.dob || '',
      feeTotal: s.feeTotal ?? '', feeDues: s.feeDues ?? '', address: s.address || '',
    });
    setError('');
    setModal({ mode: 'edit', student: s });
  };

  const handleSearch = (e) => {
    e.preventDefault();
    load();
  };

  const handleDelete = async (s) => {
    if (!window.confirm(`Delete student "${s.name}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/admin/students/${s.id}`);
      toast.success('Student deleted.');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed.');
    }
  };

  const toPayload = (f) => ({
    name: f.name.trim(),
    class: String(f.class).trim(),
    section: String(f.section).trim().toUpperCase(),
    rollNumber: f.rollNumber.trim() || undefined,
    parentName: f.parentName.trim() || undefined,
    guardianContact: f.guardianContact.trim() || undefined,
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
    setSaving(true);
    try {
      const payload = toPayload(form);
      if (modal.mode === 'create') await api.post('/admin/students', payload);
      else await api.put(`/admin/students/${modal.student.id}`, payload);
      toast.success(modal.mode === 'create' ? 'Student added!' : 'Student updated.');
      setModal(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save the student.');
    } finally {
      setSaving(false);
    }
  };

  const handleBulk = async (file) => {
    setError('');
    if (!file) {
      setError('Choose a .csv or .xlsx file first.');
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
      setError(err.response?.data?.message || 'Bulk upload failed.');
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
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: 'var(--sp-sm)', flex: 1, maxWidth: 380 }}>
          <input
            className="form-input"
            placeholder="Search name, roll no, class…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search students"
          />
          <button className="btn btn-secondary" type="submit" aria-label="Search">
            <Search size={15} />
          </button>
        </form>
        <div style={{ display: 'flex', gap: 'var(--sp-sm)' }}>
          <button
            className="btn btn-secondary"
            onClick={() => { setError(''); setModal({ mode: 'bulk' }); }}
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}>
          {classes.map((c) => {
            const isOpen = open === c.key;
            const members = membersFor(c);
            return (
              <div key={c.key}>
                <div
                  className="doc-item"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setOpen(isOpen ? null : c.key)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(isOpen ? null : c.key); } }}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                >
                  <div className="doc-icon">
                    <GraduationCap size={20} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>{c.class}</div>
                    <div className="text-sm text-muted">
                      {c.totalStudents} students · fee dues {money(c.feeDues)}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="text-sm">{c.avgMarks != null ? `Avg ${c.avgMarks}%` : 'No marks yet'}</div>
                    <div className="text-sm text-muted">{c.topScore != null ? `Top ${c.topScore}%` : '—'}</div>
                  </div>
                  <ChevronDown
                    size={18}
                    style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
                  />
                </div>
                {isOpen && (members.length === 0 ? (
                  <div className="empty-state" style={{ padding: 'var(--sp-lg)' }}>
                    No students in this class yet.
                  </div>
                ) : (
                  <div className="table-wrapper" style={{ marginTop: 'var(--sp-sm)' }}>
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
                                  onClick={(e) => { e.stopPropagation(); openEdit(s); }}
                                  aria-label={`Edit ${s.name}`}
                                >
                                  <Pencil size={14} />
                                </button>
                                <button
                                  className="btn btn-danger btn-sm"
                                  onClick={(e) => { e.stopPropagation(); handleDelete(s); }}
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
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

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
          {error && <div className="login-error" style={{ marginBottom: 'var(--sp-md)' }}>{error}</div>}
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
    </div>
  );
}
