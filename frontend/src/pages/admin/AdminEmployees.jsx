import { useEffect, useState } from 'react';
import { User, Plus, Pencil, Trash } from 'lucide-react';
import Modal from '../../components/Modal';
import api from '../../services/api';
import toast from 'react-hot-toast';
import employeeForm from './employeeForm';

const EMPTY_FORM = {
  name: '', employeeId: '', gender: 'Female', department: '', designation: '', role: 'teacher',
  employmentType: 'Permanent', dateOfJoining: '', mobile: '', email: '', qualification: '',
  experience: '', dob: '', bloodGroup: '', emergencyContact: '', status: 'active', address: '',
};

/**
 * Admin Employees — list, add, edit and delete employee records.
 */
export default function AdminEmployees() {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get('/admin/employees').then((r) => setEmployees(r.data.data));

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  const openCreate = () => {
    setForm({ ...EMPTY_FORM });
    setError('');
    setModal({ mode: 'create' });
  };

  const openEdit = (e) => {
    setForm({
      name: e.name, employeeId: e.employeeId || '', gender: e.gender || 'Female',
      department: e.department || '', designation: e.designation || '', role: e.role || 'teacher',
      employmentType: e.employmentType || 'Permanent', dateOfJoining: e.dateOfJoining || '',
      mobile: e.mobile || '', email: e.email || '', qualification: e.qualification || '',
      experience: e.experience || '', dob: e.dob || '', bloodGroup: e.bloodGroup || '',
      emergencyContact: e.emergencyContact || '', status: e.status || 'active', address: e.address || '',
    });
    setError('');
    setModal({ mode: 'edit', employee: e });
  };

  const handleDelete = async (e) => {
    if (!window.confirm(`Delete employee "${e.name}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/admin/employees/${e.id}`);
      toast.success('Employee deleted.');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed.');
    }
  };

  const handleSave = async () => {
    setError('');
    if (!form.name.trim() || !form.department.trim() || !form.designation.trim()) {
      setError('Name, Department and Designation are required.');
      return;
    }
    const payload = {
      name: form.name.trim(), employeeId: form.employeeId.trim() || undefined,
      gender: form.gender, department: form.department.trim(), designation: form.designation.trim(),
      role: form.role, employmentType: form.employmentType,
      dateOfJoining: form.dateOfJoining || undefined, mobile: form.mobile.trim() || undefined,
      email: form.email.trim() || undefined, qualification: form.qualification.trim() || undefined,
      experience: form.experience.trim() || undefined, dob: form.dob || undefined,
      bloodGroup: form.bloodGroup.trim() || undefined, emergencyContact: form.emergencyContact.trim() || undefined,
      status: form.status, address: form.address.trim() || undefined,
    };
    setSaving(true);
    try {
      if (modal.mode === 'create') await api.post('/admin/employees', payload);
      else await api.put(`/admin/employees/${modal.employee.id}`, payload);
      toast.success(modal.mode === 'create' ? 'Employee added!' : 'Employee updated.');
      setModal(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save the employee.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Employee Management</div>
        <div className="page-subtitle">{employees.length} employees on staff</div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--sp-lg)' }}>
        <button className="btn btn-primary" onClick={openCreate}>
          <Plus size={16} /> Add Employee
        </button>
      </div>

      {employees.length === 0 ? (
        <div className="empty-state">
          <User size={40} />
          No employees yet. Add your first staff member.
        </div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Employee ID</th><th>Department</th><th>Designation</th><th>Role</th><th>Mobile</th><th>Status</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.id}>
                  <td><b>{e.name}</b></td>
                  <td>{e.employeeId}</td>
                  <td>{e.department}</td>
                  <td>{e.designation}</td>
                  <td><span className={`badge badge-${e.role}`}>{e.role}</span></td>
                  <td>{e.mobile}</td>
                  <td><span className={`badge ${e.status === 'active' ? 'badge-active' : 'badge-pending'}`}>{e.status}</span></td>
                  <td>
                    <div className="flex gap-sm" style={{ alignItems: 'center' }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => openEdit(e)} aria-label="Edit employee">
                        <Pencil size={14} />
                      </button>
                      <button className="btn btn-danger btn-sm" onClick={() => handleDelete(e)} aria-label="Delete employee">
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
          title={modal.mode === 'create' ? 'Add Employee' : `Edit — ${modal.employee.name}`}
          onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save Employee'}
              </button>
            </>
          }
        >
          {error && <div className="login-error" style={{ marginBottom: 'var(--sp-md)' }}>{error}</div>}
          {employeeForm(form, setForm)}
        </Modal>
      )}
    </div>
  );
}