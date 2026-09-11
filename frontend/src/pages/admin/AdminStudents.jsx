import { useEffect, useState } from 'react';
import { Users, Plus, Pencil, Trash } from 'lucide-react';
import Modal from '../../components/Modal';
import api from '../../services/api';
import toast from 'react-hot-toast';
import studentForm from './studentForm';

const EMPTY_FORM = {
  name: '', class: '', section: 'A', rollNumber: '', parentName: '', guardianContact: '',
  address: '', admissionYear: '', bloodGroup: '', dob: '', feeTotal: '', feeDues: '',
};

/**
 * Admin Students — list, add, edit and delete student records.
 */
export default function AdminStudents() {
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // null | { mode: 'create' } | { mode: 'edit', student }
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get('/admin/students').then((r) => setStudents(r.data.data));

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  const openCreate = () => {
    setForm({ ...EMPTY_FORM });
    setError('');
    setModal({ mode: 'create' });
  };

  const openEdit = (s) => {
    setForm({
      name: s.name, class: s.class, section: s.section, rollNumber: s.rollNumber || '',
      parentName: s.parentName || '', guardianContact: s.guardianContact || '',
      address: s.address || '', admissionYear: s.admissionYear ? String(s.admissionYear) : '',
      bloodGroup: s.bloodGroup || '', dob: s.dob || '',
      feeTotal: s.feeTotal ? String(s.feeTotal) : '', feeDues: s.feeDues ? String(s.feeDues) : '',
    });
    setError('');
    setModal({ mode: 'edit', student: s });
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

  const handleSave = async () => {
    setError('');
    if (!form.name.trim() || !form.class.trim() || !form.section.trim()) {
      setError('Name, Class and Section are required.');
      return;
    }
    const payload = {
      name: form.name.trim(),
      class: form.class.trim(),
      section: form.section.toUpperCase(),
      rollNumber: form.rollNumber.trim() || undefined,
      parentName: form.parentName.trim() || undefined,
      guardianContact: form.guardianContact.trim() || undefined,
      address: form.address.trim() || undefined,
      admissionYear: form.admissionYear ? Number(form.admissionYear) : undefined,
      bloodGroup: form.bloodGroup.trim() || undefined,
      dob: form.dob || undefined,
      feeTotal: form.feeTotal ? Number(form.feeTotal) : 0,
      feeDues: form.feeDues ? Number(form.feeDues) : 0,
    };
    setSaving(true);
    try {
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

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Student Management</div>
        <div className="page-subtitle">{students.length} students enrolled</div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--sp-lg)' }}>
        <button className="btn btn-primary" onClick={openCreate}>
          <Plus size={16} /> Add Student
        </button>
      </div>

      {students.length === 0 ? (
        <div className="empty-state">
          <Users size={40} />
          No students yet. Add your first student.
        </div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Class</th><th>Roll No</th><th>Parent / Guardian</th><th>Contact</th><th>Fee Dues</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {students.map((s) => (
                <tr key={s.id}>
                  <td><b>{s.name}</b></td>
                  <td>{s.class}-{s.section}</td>
                  <td>{s.rollNumber}</td>
                  <td>{s.parentName}</td>
                  <td>{s.guardianContact}</td>
                  <td style={{ color: (s.feeDues || 0) > 0 ? 'var(--clr-warning)' : 'var(--clr-success)' }}>
                    {s.feeDues > 0 ? `₹${Number(s.feeDues).toLocaleString('en-IN')}` : 'No dues'}
                  </td>
                  <td>
                    <div className="flex gap-sm" style={{ alignItems: 'center' }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => openEdit(s)} aria-label="Edit student">
                        <Pencil size={14} />
                      </button>
                      <button className="btn btn-danger btn-sm" onClick={() => handleDelete(s)} aria-label="Delete student">
                        <Trash size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
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
          {studentForm(form, setForm)}
        </Modal>
      )}
    </div>
  );
}