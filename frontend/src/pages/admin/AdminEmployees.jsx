import { useEffect, useState } from 'react';
import { User, Plus, Pencil, Trash, KeyRound } from 'lucide-react';
import Modal from '../../components/Modal';
import ResetPasswordModal from '../../components/ResetPasswordModal';
import ConfirmModal from '../../components/ConfirmModal';
import api from '../../services/api';
import { loadOptions } from '../../services/options';
import { EMPLOYEE_ROLES } from '../../constants/roles';
import toast from 'react-hot-toast';
import employeeForm from './employeeForm';
import { contactToField, fieldToContact, isValidContact } from '../../utils/phone';
import { SALARY_EARNINGS, SALARY_DEDUCTIONS } from '../../constants/payroll';

/**
 * Blank employee form. Every default is the first option the server offers for
 * that field (Prisma enums via /school/options, EMPLOYEE_ROLES for the job
 * role), so no default is a literal written here. Salary components default to
 * 0 — a new employee has no salary structure until the admin enters one.
 * @param {object} enums option lists from GET /school/options
 */
const blankForm = (enums = {}) => ({
  name: '', employeeId: '',
  gender: enums.genders?.[0] || '',
  department: '', designation: '',
  role: EMPLOYEE_ROLES[0],
  employmentType: enums.employmentTypes?.[0] || '',
  dateOfJoining: '', mobile: '', email: '', qualification: '',
  experience: '', dob: '', bloodGroup: '', emergencyContact: '',
  status: enums.accountStatuses?.[0] || '',
  address: '',
  basicPay: 0, hra: 0, transportAllowance: 0, medicalAllowance: 0,
  providentFund: 0, professionalTax: 0, tds: 0,
});

/**
 * Admin Employees — list, add, edit and delete employee records, with a live
 * search bar filtering the table by name, ID, department, designation, role,
 * mobile, email or status (case-insensitive substring, no request per
 * keystroke — the whole staff list is already loaded).
 */
export default function AdminEmployees() {
  const [employees, setEmployees] = useState([]);
  const [options, setOptions] = useState({ enums: {}, classes: [] });
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(blankForm());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  // Reset-password modal: the user account of the employee being reset.
  // Null when the employee has no account (the button only renders when userId exists).
  const [resettingUser, setResettingUser] = useState(null);

  /**
   * Live search over the staff list. `GET /admin/employees` already returns
   * every employee (no pagination), so the filter runs in the browser —
   * instant, no request per keystroke. Same substring semantics the students
   * screen applies server-side: case-insensitive match on any column shown
   * (plus email, which the table itself omits).
   */
  const term = q.trim().toLowerCase();
  const filtered = term
    ? employees.filter((e) => [
      e.name, e.employeeId, e.department, e.designation, e.role, e.mobile, e.email, e.status,
    ].some((v) => String(v ?? '').toLowerCase().includes(term)))
    : employees;

  const load = () =>
    Promise.all([api.get('/admin/employees'), loadOptions()])
      .then(([e, o]) => { setEmployees(e.data.data); setOptions(o); });

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  const openCreate = () => {
    setForm(blankForm(options.enums));
    setError('');
    setModal({ mode: 'create' });
  };

  const openEdit = (e) => {
    const blank = blankForm(options.enums);
    setForm({
      name: e.name, employeeId: e.employeeId || '', gender: e.gender || blank.gender,
      department: e.department || '', designation: e.designation || '', role: e.role || blank.role,
      employmentType: e.employmentType || blank.employmentType, dateOfJoining: e.dateOfJoining || '',
      mobile: contactToField(e.mobile), email: e.email || '', qualification: e.qualification || '',
      experience: e.experience || '', dob: e.dob || '', bloodGroup: e.bloodGroup || '',
      emergencyContact: contactToField(e.emergencyContact), status: e.status || blank.status, address: e.address || '',
      basicPay: e.basicPay ?? 0, hra: e.hra ?? 0, transportAllowance: e.transportAllowance ?? 0,
      medicalAllowance: e.medicalAllowance ?? 0, providentFund: e.providentFund ?? 0,
      professionalTax: e.professionalTax ?? 0, tds: e.tds ?? 0,
    });
    setError('');
    setModal({ mode: 'edit', employee: e });
  };

  // Destructive-action confirmation (ConfirmModal replaces window.confirm)
  const [confirm, setConfirm] = useState(null);

  const handleDelete = (e) => {
    setConfirm({
      title: 'Delete Employee',
      message: `Delete employee “${e.name}”? This cannot be undone.`,
      onConfirm: async () => {
        try {
          await api.delete(`/admin/employees/${e.id}`);
          toast.success('Employee deleted.');
          await load();
        } catch (err) {
          toast.error(err.response?.data?.message || 'Delete failed.');
        }
        setConfirm(null);
      },
    });
  };

  const handleSave = async () => {
    setError('');
    if (!form.name.trim() || !form.department.trim() || !form.designation.trim()) {
      setError('Name, Department and Designation are required.');
      return;
    }
    if (!isValidContact(form.mobile) || !isValidContact(form.emergencyContact)) {
      setError('Enter a valid 10-digit contact number.');
      return;
    }
    // Same rule the payroll month editor enforces server-side: deductions can
    // never exceed total earnings in the default salary structure either.
    const amount = (v) => Number(v) || 0;
    const earnings = SALARY_EARNINGS.reduce((n, c) => n + amount(form[c.key]), 0);
    const deductions = SALARY_DEDUCTIONS.reduce((n, c) => n + amount(form[c.key]), 0);
    if (earnings - deductions < 0) {
      setError('Deductions cannot exceed total earnings.');
      return;
    }
    const whole = (v) => Math.max(0, Math.trunc(amount(v)));
    const payload = {
      name: form.name.trim(), employeeId: form.employeeId.trim() || undefined,
      gender: form.gender, department: form.department.trim(), designation: form.designation.trim(),
      role: form.role, employmentType: form.employmentType,
      dateOfJoining: form.dateOfJoining || undefined, mobile: fieldToContact(form.mobile) || undefined,
      email: form.email.trim() || undefined, qualification: form.qualification.trim() || undefined,
      experience: form.experience.trim() || undefined, dob: form.dob || undefined,
      bloodGroup: form.bloodGroup.trim() || undefined, emergencyContact: fieldToContact(form.emergencyContact) || undefined,
      status: form.status, address: form.address.trim() || undefined,
      // Default salary structure — whole, non-negative rupees (the server
      // validates and stores these on the employee record).
      basicPay: whole(form.basicPay), hra: whole(form.hra),
      transportAllowance: whole(form.transportAllowance), medicalAllowance: whole(form.medicalAllowance),
      providentFund: whole(form.providentFund), professionalTax: whole(form.professionalTax),
      tds: whole(form.tds),
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
        <div className="page-subtitle">
          {term
            ? `${filtered.length} of ${employees.length} employees match “${q.trim()}”`
            : `${employees.length} employees on staff`}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 'var(--sp-md)', flexWrap: 'wrap', marginBottom: 'var(--sp-lg)' }}>
        <div className="form-group" style={{ flex: 1, minWidth: 240, maxWidth: 420, marginBottom: 0 }}>
          <label className="form-label" htmlFor="employee-search">Search employees</label>
          <input
            id="employee-search"
            className="form-input"
            type="search"
            placeholder="Search name, ID, department, designation…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
          />
        </div>
        <button className="btn btn-primary" onClick={openCreate}>
          <Plus size={16} /> Add Employee
        </button>
      </div>

      {employees.length === 0 ? (
        <div className="empty-state">
          <User size={40} />
          No employees yet. Add your first staff member.
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <User size={40} />
          No employees match “{q.trim()}”.
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
              {filtered.map((e) => (
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
                      {e.userId && (
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => setResettingUser({ id: e.userId, name: e.name })}
                          aria-label={`Reset password for ${e.name}`}
                        >
                          <KeyRound size={14} />
                        </button>
                      )}
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
          {employeeForm(form, setForm, options)}
        </Modal>
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