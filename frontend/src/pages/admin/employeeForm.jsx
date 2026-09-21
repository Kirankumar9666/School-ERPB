import { IndianRupee } from 'lucide-react';
import { EMPLOYEE_ROLES } from '../../constants/roles';
import { SALARY_EARNINGS, SALARY_DEDUCTIONS, formatINR } from '../../constants/payroll';
import PhoneInput from '../../components/PhoneInput';
import AmountInput from '../../components/AmountInput';

/**
 * Shared employee form fields used by the admin employee modal.
 *
 * Every select is fed from a single source: gender / employment type / account
 * status are the Prisma schema enums served by GET /school/options, and the job
 * role list is the shared EMPLOYEE_ROLES constant — no inline value lists.
 * Mobile and Emergency Contact use the shared PhoneInput (digits-only,
 * exactly 10; the '+91-' prefix is static text added on save).
 * The Salary / Compensation section edits the employee's default monthly
 * salary structure (same 7 components as PayrollRecord) and shows the
 * earnings/deductions/net totals computed live from what the admin typed.
 *
 * @param {object} form   - current form values
 * @param {function} setForm - state setter
 * @param {object} options - reference options ({ enums: {...} })
 */
export default function employeeForm(form, setForm, options = {}) {
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const { genders = [], employmentTypes = [], accountStatuses = [] } = options.enums || {};
  const amount = (v) => Number(v) || 0;
  const totalEarnings = SALARY_EARNINGS.reduce((n, c) => n + amount(form[c.key]), 0);
  const totalDeductions = SALARY_DEDUCTIONS.reduce((n, c) => n + amount(form[c.key]), 0);
  const netPayable = totalEarnings - totalDeductions;
  const o = (label, opts, k, extra) => (
    <div className="form-group">
      <label className="form-label">{label}*</label>
      <select className="form-input" value={form[k]} onChange={set(k)} disabled={extra?.disabled}>
        {opts.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    </div>
  );
  return (
    <div className="form-grid-2">
      <div className="form-group">
        <label className="form-label">Full Name *</label>
        <input className="form-input" value={form.name} onChange={set('name')} placeholder="e.g. Priya Sharma" />
      </div>
      <div className="form-group">
        <label className="form-label">Employee ID</label>
        <input className="form-input" value={form.employeeId} onChange={set('employeeId')} placeholder="e.g. EMP-2026-003" />
      </div>
      {o('Gender', genders, 'gender')}
      <div className="form-group">
        <label className="form-label">Department *</label>
        <input className="form-input" value={form.department} onChange={set('department')} placeholder="e.g. Science" />
      </div>
      <div className="form-group">
        <label className="form-label">Designation *</label>
        <input className="form-input" value={form.designation} onChange={set('designation')} placeholder="e.g. Senior Teacher" />
      </div>
      {o('Job Role', EMPLOYEE_ROLES, 'role')}
      {o('Employment Type', employmentTypes, 'employmentType')}
      <div className="form-group">
        <label className="form-label">Date of Joining</label>
        <input className="form-input" type="date" value={form.dateOfJoining} onChange={set('dateOfJoining')} />
      </div>
      <div className="form-group">
        <label className="form-label">Mobile</label>
        <PhoneInput
          value={form.mobile}
          onChange={(v) => setForm({ ...form, mobile: v })}
          ariaLabel="Mobile number"
        />
      </div>
      <div className="form-group">
        <label className="form-label">Email</label>
        <input className="form-input" type="email" value={form.email} onChange={set('email')} placeholder="name@schoolerp.in" />
      </div>
      <div className="form-group">
        <label className="form-label">Qualification</label>
        <input className="form-input" value={form.qualification} onChange={set('qualification')} placeholder="e.g. M.Sc, B.Ed" />
      </div>
      <div className="form-group">
        <label className="form-label">Experience</label>
        <input className="form-input" value={form.experience} onChange={set('experience')} placeholder="e.g. 6 years" />
      </div>
      <div className="form-group">
        <label className="form-label">Date of Birth</label>
        <input className="form-input" type="date" value={form.dob} onChange={set('dob')} />
      </div>
      <div className="form-group">
        <label className="form-label">Blood Group</label>
        <input className="form-input" value={form.bloodGroup} onChange={set('bloodGroup')} placeholder="e.g. O+" />
      </div>
      <div className="form-group">
        <label className="form-label">Emergency Contact</label>
        <PhoneInput
          value={form.emergencyContact}
          onChange={(v) => setForm({ ...form, emergencyContact: v })}
          ariaLabel="Emergency contact number"
        />
      </div>
      {o('Status', accountStatuses, 'status')}
      <div className="form-group" style={{ gridColumn: '1 / -1' }}>
        <label className="form-label">Address</label>
        <textarea className="form-input" rows={2} value={form.address} onChange={set('address')} placeholder="Residential address" />
      </div>

      {/* Salary / Compensation — the employee's default monthly salary
          structure, fed to every new payroll month (which stays editable
          per month on the Payroll page). Totals are computed live. */}
      <div style={{ gridColumn: '1 / -1' }}>
        <div className="section-title"><IndianRupee size={14} /> Salary / Compensation</div>
        <div className="form-grid-2">
          <div>
            <div className="section-title" style={{ fontSize: 13 }}>Earnings (₹)</div>
            {SALARY_EARNINGS.map(({ key, label, required }) => (
              <div className="form-group" key={key}>
                <label className="form-label">{label}{required ? ' *' : ''}</label>
                <AmountInput
                  value={form[key]}
                  label={label}
                  onChange={(v) => setForm({ ...form, [key]: v })}
                />
              </div>
            ))}
          </div>
          <div>
            <div className="section-title" style={{ fontSize: 13 }}>Deductions (₹)</div>
            {SALARY_DEDUCTIONS.map(({ key, label }) => (
              <div className="form-group" key={key}>
                <label className="form-label">{label}</label>
                <AmountInput
                  value={form[key]}
                  label={label}
                  onChange={(v) => setForm({ ...form, [key]: v })}
                />
              </div>
            ))}
            <div className="card" style={{ padding: 'var(--sp-md)', marginTop: 'var(--sp-md)' }}>
              <div className="payroll-row"><span>Total Earnings</span><span>{formatINR(totalEarnings)}</span></div>
              <div className="payroll-row"><span>Total Deductions</span><span className="payroll-deduction">− {formatINR(totalDeductions)}</span></div>
              <div className="payroll-row total"><span>Net Payable</span><span>{formatINR(netPayable)}</span></div>
            </div>
          </div>
        </div>
        <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-sm)' }}>
          Saved as this employee's default monthly salary structure. Each new payroll month on the
          Payroll page starts from these values and can still be adjusted per month; already-paid
          months are never changed.
        </div>
      </div>
    </div>
  );
}