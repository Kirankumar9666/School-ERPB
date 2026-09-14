/**
 * Shared student form fields used by the admin student modal.
 *
 * Class and section are suggested from the classes that exist in the database
 * (GET /school/options) via a `datalist`, so the options are live data rather
 * than a fixed range — and because a school can open a new class at any time the
 * fields stay free-entry: the API creates the class row on save.
 *
 * @param {object} form   - current form values
 * @param {function} setForm - state setter
 * @param {object} options - reference options ({ classes: [...] })
 */
export default function studentForm(form, setForm, options = {}) {
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  /* Distinct grades/sections actually in use — derived, never a fixed list */
  const classes = options.classes || [];
  const grades = [...new Set(classes.map((c) => c.grade))];
  const sections = [...new Set(classes.map((c) => c.section))];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-md)' }}>
      <div className="form-group">
        <label className="form-label">Full Name *</label>
        <input className="form-input" value={form.name} onChange={set('name')} placeholder="e.g. Arjun Kumar" />
      </div>
      <div className="form-group">
        <label className="form-label">Class *</label>
        <input
          className="form-input"
          list="student-class-options"
          value={form.class}
          onChange={set('class')}
          placeholder="e.g. 10"
          aria-label="Class"
        />
        <datalist id="student-class-options">
          {grades.map((g) => <option key={g} value={g} />)}
        </datalist>
      </div>
      <div className="form-group">
        <label className="form-label">Section *</label>
        <input
          className="form-input"
          list="student-section-options"
          value={form.section}
          onChange={set('section')}
          placeholder="e.g. A"
          aria-label="Section"
        />
        <datalist id="student-section-options">
          {sections.map((s) => <option key={s} value={s} />)}
        </datalist>
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