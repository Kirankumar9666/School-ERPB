import { useEffect, useState } from 'react';
import { Clock, Plus, Trash } from 'lucide-react';
import api from '../../services/api';
import { loadOptions } from '../../services/options';
import { classChoices } from '../../utils/classes';
import Modal from '../../components/Modal';
import toast from 'react-hot-toast';

/** 'HH:MM' → minutes since midnight (null when malformed) */
const toMinutes = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
};

/** Minutes since midnight → 'HH:MM' */
const toTime = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/** Half-open interval overlap — touching endpoints (08:00–08:45, 08:45–09:30) don't clash */
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

/** Order rows by period number, breaking ties by start time (never by row position) */
const byPeriodThenTime = (a, b) => {
  const pa = Number(a.period);
  const pb = Number(b.period);
  if (Number.isFinite(pa) && Number.isFinite(pb) && pa !== pb) return pa - pb;
  return (toMinutes(a.timeStart) ?? 0) - (toMinutes(b.timeStart) ?? 0);
};

const EMPTY_FORM = { period: '', timeStart: '', timeEnd: '', subject: '', teacher: '', room: '' };

/**
 * Admin Timetable — manage class schedules (add / delete periods).
 * The class selector lists the classes that exist in the database
 * (GET /school/options) plus any class the payload already references; the
 * teacher dropdown is the real staff list (GET /admin/employees) — nothing is
 * hardcoded locally. "+ Add Period" opens the same modal pattern the other
 * admin screens use and warns (window.confirm) before saving a period whose
 * time overlaps another period of the class, or that double-books a teacher
 * who is scheduled in a different class at the same time.
 */
export default function AdminTimetable() {
  const [timetables, setTimetables] = useState({});
  const [classes, setClasses] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [classKey, setClassKey] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    Promise.all([api.get('/admin/timetable'), loadOptions(), api.get('/admin/employees')])
      .then(([t, o, e]) => {
        const data = t.data.data || {};
        setTimetables(data);
        setClasses(o.classes);
        setEmployees([...(e.data.data || [])].sort((a, b) => a.name.localeCompare(b.name)));
        // Prefer a class that already has periods, else the first real class
        setClassKey((current) => current || Object.keys(data)[0] || o.classes[0]?.id || '');
      })
      .finally(() => setLoading(false));
  }, []);

  /* Class options: database classes ∪ classes already in the payload, sorted */
  const choices = classChoices(Object.keys(timetables), classes);
  const periods = [...(timetables[classKey] || [])].sort(byPeriodThenTime);
  const activeLabel = choices.find((c) => c.id === classKey)?.label || '';
  const classLabel = (id) => choices.find((c) => c.id === id)?.label || id;

  /** Conflicts the new period would create: class-slot overlaps + teacher double-booking */
  const findConflicts = (start, end) => {
    const out = [];
    periods.forEach((p) => {
      const ps = toMinutes(p.timeStart);
      const pe = toMinutes(p.timeEnd);
      if (ps !== null && pe !== null && overlaps(start, end, ps, pe)) {
        out.push(`Period ${p.period} of ${activeLabel} already runs ${p.timeStart} – ${p.timeEnd} (${p.subject}).`);
      }
    });
    const teacher = form.teacher.trim().toLowerCase();
    Object.entries(timetables).forEach(([ck, list]) => {
      if (ck === classKey) return;
      list.forEach((p) => {
        if (String(p.teacher || '').trim().toLowerCase() !== teacher) return;
        const ps = toMinutes(p.timeStart);
        const pe = toMinutes(p.timeEnd);
        if (ps !== null && pe !== null && overlaps(start, end, ps, pe)) {
          out.push(`${form.teacher.trim()} is already scheduled in ${classLabel(ck)} at ${p.timeStart} – ${p.timeEnd} (period ${p.period}, ${p.subject}).`);
        }
      });
    });
    return out;
  };

  /** Pre-fill: next free period number + times continuing after the last saved period */
  const openAdd = () => {
    const nums = periods.map((p) => Number(p.period)).filter(Number.isFinite);
    const lastEnd = toMinutes(periods[periods.length - 1]?.timeEnd);
    setForm({
      ...EMPTY_FORM,
      period: String(nums.length ? Math.max(...nums) + 1 : 1),
      // 45-minute slot continuing after the last saved period, clamped to 23:59
      timeStart: lastEnd !== null ? toTime(lastEnd) : '08:00',
      timeEnd: lastEnd !== null ? toTime(Math.min(lastEnd + 45, 23 * 60 + 59)) : '08:45',
    });
    setAddOpen(true);
  };

  const handleSave = async () => {
    const period = Number(form.period);
    if (!Number.isInteger(period) || period < 1) {
      toast.error('Period must be a positive number.');
      return;
    }
    if (periods.some((p) => Number(p.period) === period)) {
      toast.error(`Period ${period} already exists for ${activeLabel}.`);
      return;
    }
    const start = toMinutes(form.timeStart);
    const end = toMinutes(form.timeEnd);
    if (start === null || end === null) {
      toast.error('Pick a valid start and end time.');
      return;
    }
    if (end <= start) {
      toast.error('End time must be after start time.');
      return;
    }
    if (!form.subject.trim() || !form.teacher.trim() || !form.room.trim()) {
      toast.error('Fill subject, teacher and room.');
      return;
    }
    const conflicts = findConflicts(start, end);
    if (conflicts.length > 0 && !window.confirm(`Schedule conflict:\n\n- ${conflicts.join('\n- ')}\n\nAdd the period anyway?`)) return;

    setSaving(true);
    try {
      await api.post('/admin/timetable', {
        classKey,
        period,
        timeStart: form.timeStart,
        timeEnd: form.timeEnd,
        subject: form.subject.trim(),
        teacher: form.teacher.trim(),
        room: form.room.trim(),
      });
      toast.success('Period added!');
      setAddOpen(false);
      const r = await api.get('/admin/timetable');
      setTimetables(r.data.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not add period.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (ck, period) => {
    const label = choices.find((c) => c.id === ck)?.label || ck;
    if (!window.confirm(`Delete period ${period} of ${label}? This cannot be undone.`)) return;
    try {
      await api.delete(`/admin/timetable/${ck}/${period}`);
      toast.success('Period removed.');
      const r = await api.get('/admin/timetable');
      setTimetables(r.data.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not remove period.');
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Timetable Editor</div>
        <div className="page-subtitle">Add and manage class schedules</div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 'var(--sp-md)', flexWrap: 'wrap', marginBottom: 'var(--sp-lg)' }}>
        <div className="form-group" style={{ flex: 1, minWidth: 240, maxWidth: 420, marginBottom: 0 }}>
          <label className="form-label">Select Class</label>
          <select className="form-input" value={classKey} onChange={(e) => setClassKey(e.target.value)}>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>
        <button
          className="btn btn-primary"
          onClick={openAdd}
          disabled={!classKey}
          title={classKey ? 'Add a period to this class' : 'Select a class first'}
        >
          <Plus size={16} /> Add Period
        </button>
      </div>

      <div className="section">
        <div className="section-title"><Clock size={14} /> Periods — {activeLabel}</div>
        {periods.length === 0 ? (
          <div className="empty-state">
            <Clock size={40} />
            No periods scheduled yet.
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr><th>Period</th><th>Time</th><th>Subject</th><th>Teacher</th><th>Room</th><th>{''}</th></tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={`${p.period}`}>
                    <td><b>{p.period}</b></td>
                    <td>{p.timeStart} – {p.timeEnd}</td>
                    <td>{p.subject}</td>
                    <td>{p.teacher}</td>
                    <td>{p.room}</td>
                    <td>
                      <button className="btn btn-danger btn-sm" onClick={() => handleDelete(classKey, p.period)} aria-label="Delete period">
                        <Trash size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {addOpen && (
        <Modal
          title={`Add Period — ${activeLabel}`}
          onClose={() => setAddOpen(false)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setAddOpen(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Adding...' : 'Add Period'}
              </button>
            </>
          }
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-md)' }}>
            <div className="form-group">
              <label className="form-label">Period *</label>
              <input
                className="form-input"
                type="number"
                min="1"
                value={form.period}
                onChange={(e) => setForm({ ...form, period: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Room *</label>
              <input
                className="form-input"
                value={form.room}
                onChange={(e) => setForm({ ...form, room: e.target.value })}
                placeholder="e.g. 101"
              />
            </div>
            <div className="form-group">
              <label className="form-label">Time Start *</label>
              <input
                className="form-input"
                type="time"
                value={form.timeStart}
                onChange={(e) => setForm({ ...form, timeStart: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Time End *</label>
              <input
                className="form-input"
                type="time"
                value={form.timeEnd}
                onChange={(e) => setForm({ ...form, timeEnd: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Subject *</label>
              <input
                className="form-input"
                value={form.subject}
                onChange={(e) => setForm({ ...form, subject: e.target.value })}
                placeholder="e.g. Mathematics"
              />
            </div>
            <div className="form-group">
              <label className="form-label">Teacher *</label>
              <select
                className="form-input"
                value={form.teacher}
                onChange={(e) => setForm({ ...form, teacher: e.target.value })}
              >
                <option value="" disabled>Select teacher</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.name}>
                    {emp.name} — {emp.designation}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}