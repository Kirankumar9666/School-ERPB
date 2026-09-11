/**
 * Shared employee form fields used by the admin employee modal.
 * @param {object} form   - current form values
 * @param {function} setForm - state setter
 */
export default function employeeForm(form, setForm) {
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const o = (label, opts, k, extra) => (
    <div className="form-group">
      <label className="form-label">{label}*</label>
      <select className="form-input" value={form[k]} onChange={set(k)} disabled={extra?.disabled}>
        {opts.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    </div>
  );
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-md)' }}>
      <div className="form-group">
        <label className="form-label">Full Name *</label>
        <input className="form-input" value={form.name} onChange={set('name')} placeholder="e.g. Priya Sharma" />
      </div>
      <div className="form-group">
        <label className="form-label">Employee ID</label>
        <input className="form-input" value={form.employeeId} onChange={set('employeeId')} placeholder="e.g. EMP-2026-003" />
      </div>
      <div className="form-group">
        <label className="form-label">Gender *</label>
        <select className="form-input" value={form.gender} onChange={set('gender')}>
          {['Female', 'Male', 'Other'].map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
      <div className="form-group">
        <label className="form-label">Department *</label>
        <input className="form-input" value={form.department} onChange={set('department')} placeholder="e.g. Mathematics" />
      </div>
      <div className="form-group">
        <label className="form-label">Designation *</label>
        <input className="form-input" value={form.designation} onChange={set('designation')} placeholder="e.g. Senior Teacher" />
      </div>
      <div className="form-group">
        <label className="form-label">Job Role *</label>
        <select className="form-input" value={form.role} onChange={set('role')}>
          {['teacher', 'accountant', 'librarian'].map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
      {o('Employment Type', ['Permanent', 'Contract', 'Probation', 'Temporary'], 'employmentType')}
      <div className="form-group">
        <label className="form-label">Date of Joining</label>
        <input className="form-input" type="date" value={form.dateOfJoining} onChange={set('dateOfJoining')} />
      </div>
      <div className="form-group">
        <label className="form-label">Mobile</label>
        <input className="form-input" value={form.mobile} onChange={set('mobile')} placeholder="+91-XXXXXXXXXX" />
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
        <input className="form-input" value={form.emergencyContact} onChange={set('emergencyContact')} placeholder="+91-XXXXXXXXXX" />
      </div>
      {o('Status', ['active', 'inactive'], 'status')}
      <div className="form-group" style={{ gridColumn: '1 / -1' }}>
        <label className="form-label">Address</label>
        <textarea className="form-input" rows={2} value={form.address} onChange={set('address')} placeholder="Residential address" />
      </div>
    </div>
  );
}