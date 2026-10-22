import { useEffect, useState } from 'react';
import { User, Plus, Pencil, KeyRound, Eye, RotateCcw, UserMinus, UserCheck } from 'lucide-react';
import Modal from '../../components/Modal';
import ResetPasswordModal from '../../components/ResetPasswordModal';
import EndEmploymentModal from './EndEmploymentModal';
import EmployeeDetailsModal from './EmployeeDetailsModal';
import api from '../../services/api';
import { loadOptions } from '../../services/options';
import { EMPLOYEE_ROLES } from '../../constants/roles';
import toast from '../../services/toast';
import employeeForm from './employeeForm';
import { contactToField, fieldToContact, isValidContact } from '../../utils/phone';
import { apiErrorMessage } from '../../utils/apiError';
import { dependentRecordLabel, employmentReasonLabel, employmentStatusBadge } from '../../utils/employment';
import { shortDate } from '../../utils/date';
import { SALARY_EARNINGS, SALARY_DEDUCTIONS } from '../../constants/payroll';
import LoadErrorState from '../../components/LoadErrorState';
import { useLoadState } from '../../utils/useLoadState';

/**
 * Blank employee form. Every default is the first option the server offers for
 * that field (Prisma enums via /school/options, EMPLOYEE_ROLES for the job
 * role), so no default is a literal written here. Salary components default to
 * 0 — a new employee has no salary structure until the admin enters one.
 *
 * There is deliberately NO `status` field: employment status is owned by
 * End Employment / Reactivate, and the API rejects an attempt to set it here.
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
  address: '',
  basicPay: 0, hra: 0, transportAllowance: 0, medicalAllowance: 0,
  providentFund: 0, professionalTax: 0, tds: 0,
});

/**
 * Admin Employees — the staff list, with employment status as a first-class part
 * of a row rather than something you discover by trying to delete someone.
 *
 * The trash button used to attempt a hard DELETE and fail with a foreign-key
 * error for anyone who had actually taught, been paid, or taken leave. It now
 * opens End Employment, which takes a person off the staff list and keeps every
 * record they own. The permanent delete still exists, but only for a record
 * nothing depends on, and only from the details view — see EmployeeDetailsModal.
 *
 * The list shows ACTIVE employees by default, because that is what an admin
 * working the staff roster needs; "Show all" adds the ones who have left, each
 * with the reason and last working day their timeline recorded. The header count
 * stays active-only for the same reason (see `activeCount`).
 *
 * Search filters the visible set by any column shown, including the employment
 * reason, so typing "retired" finds the retired staff.
 */
export default function AdminEmployees() {
  const [employees, setEmployees] = useState([]);
  const [options, setOptions] = useState({ enums: {}, classes: [] });
  const { loading, setLoading, error: loadError, reloadKey, retry, fail } = useLoadState();
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(blankForm());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);
  // Reset-password modal: the user account of the employee being reset.
  // Null when the employee has no account (the button only renders when userId exists).
  const [resettingUser, setResettingUser] = useState(null);
  // The employee being ended, and the details view's own state.
  const [ending, setEnding] = useState(null);
  const [endingLoading, setEndingLoading] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  /**
   * How many people are actually on staff.
   *
   * Counted over `status`, not over the rows currently displayed, so the headline
   * number is the active headcount whether or not a search or the "show all"
   * toggle is narrowing the table. An inactive employee is a historical record,
   * and every other count in the app means "right now".
   */
  const activeCount = employees.filter((e) => e.status === 'active').length;

  /**
   * Live search over the staff list. `GET /admin/employees` already returns every
   * employee (no pagination), so this runs in the browser — instant, no request
   * per keystroke. Same substring semantics the students screen applies
   * server-side, widened to the employment reason and last working day so the
   * people who have left are findable by how they left.
   */
  const term = q.trim().toLowerCase();
  const visible = showAll ? employees : employees.filter((e) => e.status === 'active');
  const filtered = term
    ? visible.filter((e) => [
      e.name, e.employeeId, e.department, e.designation, e.role, e.mobile, e.email,
      e.status, e.employment?.reason, e.employment?.lastWorkingDay,
    ].some((v) => String(v ?? '').toLowerCase().includes(term)))
    : visible;

  const load = () =>
    Promise.all([api.get('/admin/employees'), loadOptions()])
      .then(([e, o]) => { setEmployees(e.data.data); setOptions(o); });

  useEffect(() => {
    load().catch(fail).finally(() => setLoading(false));
  }, [reloadKey, fail, setLoading]);

  const openCreate = () => {
    setForm(blankForm(options.enums));
    setError('');
    setModal({ mode: 'create' });
  };

  const openEdit = async (e) => {
    // The list row carries the employee's stored default salary columns — which
    // can be zeros when a wage was worked out on the Payroll screen (that page
    // writes per-month PayrollRecord rows, not the default columns). Fetch the
    // single-employee detail so the form prefills the same figures Payroll
    // shows: salaryStructure = the latest saved payroll month, else the stored
    // default. The list row is used as-is if the detail fetch fails.
    let src = e;
    try {
      src = (await api.get(`/admin/employees/${e.id}`)).data.data;
    } catch { /* the list row already carries every editable field */ }
    const sal = src.salaryStructure || src;
    const blank = blankForm(options.enums);
    setForm({
      name: src.name, employeeId: src.employeeId || '', gender: src.gender || blank.gender,
      department: src.department || '', designation: src.designation || '', role: src.role || blank.role,
      employmentType: src.employmentType || blank.employmentType, dateOfJoining: src.dateOfJoining || '',
      mobile: contactToField(src.mobile), email: src.email || '', qualification: src.qualification || '',
      experience: src.experience || '', dob: src.dob || '', bloodGroup: src.bloodGroup || '',
      emergencyContact: contactToField(src.emergencyContact), address: src.address || '',
      basicPay: sal.basicPay ?? 0, hra: sal.hra ?? 0, transportAllowance: sal.transportAllowance ?? 0,
      medicalAllowance: sal.medicalAllowance ?? 0, providentFund: sal.providentFund ?? 0,
      professionalTax: sal.professionalTax ?? 0, tds: sal.tds ?? 0,
    });
    setError('');
    setModal({ mode: 'edit', employee: src });
  };

  /* ── Details view ──
     Re-read from the detail endpoint rather than reusing the list row: the
     timeline and the linked-record census only exist there, and both must be
     current at the moment they are shown (the census decides whether the
     permanent delete is offered at all). */
  const openDetails = async (e) => {
    setDetailLoading(true);
    try {
      setDetail((await api.get(`/admin/employees/${e.id}`)).data.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load the employee.');
    } finally {
      setDetailLoading(false);
    }
  };

  /**
   * Open End Employment.
   *
   * Fetches the detail rather than using the row, because the dialog lists the
   * records this action will PRESERVE and that list has to be the real census for
   * this employee — it is the whole reason the button is safe to press instead of
   * "Delete". The counts are labelled here so the dialog stays a plain list of
   * `{key, label, count, blocking}`.
   */
  const openEndEmployment = async (e) => {
    setEndingLoading(true);
    try {
      const full = (await api.get(`/admin/employees/${e.id}`)).data.data;
      setEnding({
        employee: full,
        records: (full.dependentRecords || []).map((r) => ({ ...r, label: dependentRecordLabel(r.key) })),
      });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not open the employee record.');
    } finally {
      setEndingLoading(false);
    }
  };

  /**
   * Apply one lifecycle action, then refresh the list and any open detail view.
   *
   * The two are separate reads, so refreshing only one would leave a badge in
   * the dialog contradicting the row underneath it. `keepDetail` is false for
   * the permanent delete, where the employee no longer exists and re-reading them
   * would only earn a 404.
   */
  const afterLifecycle = async (message, keepDetail = true) => {
    await load();
    if (keepDetail && detail) {
      try {
        setDetail((await api.get(`/admin/employees/${detail.id}`)).data.data);
      } catch { /* the list refresh already succeeded; leave the detail as it was */ }
    }
    if (message) toast.success(message);
  };

  const handleEndEmployment = async (payload) => {
    const res = await api.post(`/admin/employees/${ending.employee.id}/end-employment`, {
      reason: payload.reason,
      lastWorkingDay: payload.lastWorkingDay,
      // Trimmed here as well as on the server, so an all-whitespace description
      // is stored as absent rather than as an empty string.
      description: payload.description?.trim() || undefined,
    });
    setEnding(null);
    await afterLifecycle(res.data.message);
  };

  const handleReactivate = async () => {
    const res = await api.post(`/admin/employees/${detail.id}/reactivate`);
    await afterLifecycle(res.data.message);
  };

  const handleHardDelete = async () => {
    await api.delete(`/admin/employees/${detail.id}`);
    setDetail(null);
    await afterLifecycle('Employee record deleted permanently.', false);
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
      address: form.address.trim() || undefined,
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
      setError(apiErrorMessage(err, {}, 'Could not save the employee.'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  // A failed request is not "no employees yet" — the two are told apart before
  // the empty state below can ever be reached.
  if (loadError) {
    return (
      <LoadErrorState
        title="Employee Management"
        subtitle="Employees on staff"
        detail={loadError}
        onRetry={retry}
        icon={User}
      />
    );
  }

  const offStaffCount = employees.length - activeCount;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Employee Management</div>
        <div className="page-subtitle">
          {term
            ? `${filtered.length} of ${visible.length} shown match “${q.trim()}”`
            : `${activeCount} ${activeCount === 1 ? 'employee' : 'employees'} on staff`}
          {/* Say how many are hidden rather than letting the list quietly shrink:
              an admin who ends someone's employment and never sees them again has
              no way to know they still exist. */}
          {!showAll && offStaffCount > 0 && (
            <> · {offStaffCount} no longer on staff</>
          )}
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

        <div style={{ display: 'flex', gap: 'var(--sp-sm)', alignItems: 'center', flexWrap: 'wrap' }}>
          {/* A switch rather than a checkbox: it states which list is on screen
              ("Active only" / "All") instead of asking the admin to interpret an
              unticked box, and `aria-pressed` is what a toggle button should
              announce. */}
          <button
            type="button"
            className={`btn btn-sm ${showAll ? 'btn-secondary' : 'btn-toggle'}`}
            aria-pressed={showAll}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? <User size={15} /> : <UserCheck size={15} />}
            {showAll ? 'Showing all' : 'Active only'}
          </button>
          <button className="btn btn-primary" onClick={openCreate}>
            <Plus size={16} /> Add Employee
          </button>
        </div>
      </div>

      {employees.length === 0 ? (
        <div className="empty-state">
          <User size={40} />
          No employees yet. Add your first staff member.
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <User size={40} />
          {term
            ? `No employees match “${q.trim()}”.`
            : 'Nobody is on the active staff list. Use the toggle above to include everyone.'}
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
              {filtered.map((e) => {
                const active = e.status === 'active';
                const badge = employmentStatusBadge(e);
                return (
                  <tr key={e.id}>
                    <td>
                      <b>{e.name}</b>
                      {/* The last working day belongs with the reason, not in a
                          column of its own: it is only meaningful for someone who
                          has left, and it is the date payroll was cut off on. */}
                      {!active && e.employment?.lastWorkingDay && (
                        <div className="form-help">Last working day {shortDate(e.employment.lastWorkingDay)}</div>
                      )}
                    </td>
                    <td>{e.employeeId}</td>
                    <td>{e.department}</td>
                    <td>{e.designation}</td>
                    <td><span className={`badge badge-${e.role}`}>{e.role}</span></td>
                    <td>{e.mobile}</td>
                    <td>
                      <span className={`badge ${badge.className}`}>{badge.text}</span>
                    </td>
                    <td>
                      <div className="flex gap-sm" style={{ alignItems: 'center' }}>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => openDetails(e)}
                          aria-label={`View details for ${e.name}`}
                          disabled={detailLoading}
                        >
                          <Eye size={14} />
                        </button>
                        <button className="btn btn-secondary btn-sm" onClick={() => openEdit(e)} aria-label={`Edit ${e.name}`}>
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
                        {/* Off staff → Reactivate. On staff → End Employment. Never
                            both, and never neither: the common action is always
                            present, which is what makes the trash icon safe to put
                            where the delete button used to be. */}
                        {active ? (
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => openEndEmployment(e)}
                            aria-label={`End employment for ${e.name}`}
                            disabled={endingLoading}
                          >
                            <UserMinus size={14} />
                          </button>
                        ) : (
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={async () => {
                              try {
                                const res = await api.post(`/admin/employees/${e.id}/reactivate`);
                                toast.success(res.data.message);
                                await load();
                              } catch (err) {
                                toast.error(err.response?.data?.message || 'Could not reactivate.');
                              }
                            }}
                            aria-label={`Reactivate ${e.name}`}
                          >
                            <RotateCcw size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
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
          {/* A terminated employee can still have their contact details corrected —
              just not their status, which is the lifecycle's to set. Say so here
              rather than letting the admin wonder where the Status field went. */}
          {modal.mode === 'edit' && modal.employee.status !== 'active' && (
            <div className="info-note">
              This employee is not on the active staff list
              {modal.employee.employment
                ? ` — ${employmentReasonLabel(modal.employee.employment.reason)}`
                : ''}
              . Use the details view to see their history or to reactivate them.
            </div>
          )}
          {employeeForm(form, setForm, options)}
        </Modal>
      )}

      {ending && (
        <EndEmploymentModal
          employee={ending.employee}
          records={ending.records}
          reasons={options.enums.employmentEndReasons || []}
          onSubmit={handleEndEmployment}
          onClose={() => setEnding(null)}
        />
      )}

      {detail && (
        <EmployeeDetailsModal
          employee={detail}
          onReactivate={handleReactivate}
          onDelete={handleHardDelete}
          onClose={() => setDetail(null)}
        />
      )}

      {resettingUser && (
        <ResetPasswordModal
          user={resettingUser}
          onClose={() => setResettingUser(null)}
        />
      )}
    </div>
  );
}
