/**
 * Shared student form fields used by the admin student modal.
 *
 * Class is a SELECTION from the shared class list (GET /school/options), never a
 * typed value. The choices are that endpoint's `classes` array, so a named level
 * (Nursery, LKG, UKG) is offered and selectable exactly as a numbered one, and the
 * boundaries of a school — how high it goes, whether it runs pre-primary — come
 * from its data rather than from a hardcoded list here.
 *
 * Guardian Contact uses the shared PhoneInput (digits-only, exactly 10; the
 * '+91-' prefix is static text added on save).
 *
 * Parent / Guardian and Guardian Contact are REQUIRED (marked *): together with
 * the name they are the identity a duplicate student is recognised by, and the
 * contact is what the student's initial login password is derived from. The
 * server enforces the same rule; the client-side check only saves the round trip.
 *
 * @param {object} form   - current form values
 * @param {function} setForm - state setter
 * @param {object} options - reference options ({ classes: [...] })
 */
import PhoneInput from '../../components/PhoneInput';

export default function studentForm(form, setForm, options = {}) {
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  /* The SHARED class list, already in teaching order (the server sorts it by level
     order). Nothing is derived locally, so a level the admin added a moment ago is
     here on the next render. */
  const classes = options.classes || [];

  /* Choosing a class sets both the id (what the API stores) and the section (what
     the schema still requires), so the two can never disagree. */
  const pickClass = (e) => {
    const id = e.target.value;
    const chosen = classes.find((c) => c.id === id);
    setForm({
      ...form,
      classId: id,
      // The legacy typed form travels too, so a caller that reads `class` still
      // sees the right value — but the id is what the API writes.
      class: chosen ? String(chosen.grade) : '',
      section: chosen ? chosen.section : '',
    });
  };

  const sectionsForLevel = (() => {
    const chosen = classes.find((c) => c.id === form.classId);
    if (!chosen) return [];
    return classes.filter((c) => c.levelId ? c.levelId === chosen.levelId : c.grade === chosen.grade);
  })();

  const setSection = (e) => {
    const id = e.target.value;
    const chosen = classes.find((c) => c.id === id);
    setForm({
      ...form,
      classId: id,
      class: chosen ? String(chosen.grade) : '',
      section: chosen ? chosen.section : '',
    });
  };

  return (
    <div className="form-grid-2">
      <div className="form-group">
        <label className="form-label">Full Name *</label>
        <input className="form-input" value={form.name} onChange={set('name')} placeholder="e.g. Arjun Kumar" />
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="student-class-id">Class *</label>
        {classes.length === 0 ? (
          <div className="text-sm text-muted" style={{ paddingTop: 8 }}>
            No classes yet — create one with “Create Class” first.
          </div>
        ) : (
          <select
            id="student-class-id"
            className="form-input"
            value={form.classId || ''}
            onChange={pickClass}
            aria-label="Class"
          >
            <option value="" disabled>Select class</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        )}
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="student-section-id">Section</label>
        {sectionsForLevel.length > 1 ? (
          <select
            id="student-section-id"
            className="form-input"
            value={form.classId || ''}
            onChange={setSection}
            aria-label="Section"
          >
            {sectionsForLevel.map((c) => (
              <option key={c.id} value={c.id}>{c.section}</option>
            ))}
          </select>
        ) : (
          <>
            <input
              className="form-input"
              value={form.section || ''}
              readOnly
              aria-label="Section"
            />
            <div className="text-sm text-muted" style={{ marginTop: 4 }}>
              Comes from the class chosen above.
            </div>
          </>
        )}
      </div>
      <div className="form-group">
        <label className="form-label">Roll Number</label>
        <input className="form-input" value={form.rollNumber} onChange={set('rollNumber')} placeholder="e.g. STU-2022-004" />
      </div>
      <div className="form-group">
        <label className="form-label">Parent / Guardian *</label>
        <input className="form-input" value={form.parentName} onChange={set('parentName')} placeholder="e.g. Rajesh Kumar" />
      </div>
      <div className="form-group">
        <label className="form-label">Guardian Contact *</label>
        <PhoneInput
          value={form.guardianContact}
          onChange={(v) => setForm({ ...form, guardianContact: v })}
          ariaLabel="Guardian contact number"
        />
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
        {/* max = today: a date of birth in the future is refused by the server
            too, but stopping it at the picker saves the round trip. */}
        <input className="form-input" type="date" max={new Date().toISOString().slice(0, 10)} value={form.dob} onChange={set('dob')} />
      </div>
      <div className="form-group">
        <label className="form-label">Fee Total (₹)</label>
        <input className="form-input" type="number" min="0" step="1" value={form.feeTotal} onChange={set('feeTotal')} placeholder="e.g. 45000" />
      </div>
      <div className="form-group">
        <label className="form-label">Fee Dues (₹)</label>
        <input className="form-input" type="number" min="0" step="1" value={form.feeDues} onChange={set('feeDues')} placeholder="e.g. 5000" />
      </div>
      <div className="form-group" style={{ gridColumn: '1 / -1' }}>
        <label className="form-label">Address</label>
        <textarea className="form-input" rows={2} value={form.address} onChange={set('address')} placeholder="Residential address" />
      </div>
    </div>
  );
}
