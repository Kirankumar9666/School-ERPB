/**
 * Shared student form fields used by the admin student modal.
 * @param {object} form   - current form values
 * @param {function} setForm - state setter
 */
export default function studentForm(form, setForm) {
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-md)' }}>
      <div className="form-group">
        <label className="form-label">Full Name *</label>
        <input className="form-input" value={form.name} onChange={set('name')} placeholder="e.g. Arjun Kumar" />
      </div>
      <div className="form-group">
        <label className="form-label">Class *</label>
        <select className="form-input" value={form.class} onChange={set('class')}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
      <div className="form-group">
        <label className="form-label">Section *</label>
        <select className="form-input" value={form.section} onChange={set('section')}>
          {['A', 'B', 'C', 'D'].map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
      <div className="form-group">
        <label className="form-label">Roll Number</label>
        <input className="form-input" value={form.rollNumber} onChange={set('rollNumber')} placeholder="e.g. STU-2022-004" />
      </div>
      <div className="form-group">
        <label className="form-label">Parent / Guardian</label>
        <input className="form-input" value={form.parentName} onChange={set('parentName')} placeholder="e.g. Rajesh Kumar" />
      </div>
      <div className="form-group">
        <label className="form-label">Guardian Contact</label>
        <input className="form-input" value={form.guardianContact} onChange={set('guardianContact')} placeholder="+91-XXXXXXXXXX" />
      </div>
      <div className="form-group">
        <label className="form-label">Admission Year</label>
        <input className="form-input" type="number" value={form.admissionYear} onChange={set('admissionYear')} placeholder="e.g. 2022" />
      </div>
      <div className="form-group">
        <label className="form-label">Blood Group</label>
        <input className="form-input" value={form.bloodGroup} onChange={set('bloodGroup')} placeholder="e.g. O+" />
      </div>
      <div className="form-group">
        <label className="form-label">Date of Birth</label>
        <input className="form-input" type="date" value={form.dob} onChange={set('dob')} />
      </div>
      <div className="form-group">
        <label className="form-label">Fee Total (₹)</label>
        <input className="form-input" type="number" min="0" value={form.feeTotal} onChange={set('feeTotal')} placeholder="e.g. 45000" />
      </div>
      <div className="form-group">
        <label className="form-label">Fee Dues (₹)</label>
        <input className="form-input" type="number" min="0" value={form.feeDues} onChange={set('feeDues')} placeholder="e.g. 5000" />
      </div>
      <div className="form-group" style={{ gridColumn: '1 / -1' }}>
        <label className="form-label">Address</label>
        <textarea className="form-input" rows={2} value={form.address} onChange={set('address')} placeholder="Residential address" />
      </div>
    </div>
  );
}