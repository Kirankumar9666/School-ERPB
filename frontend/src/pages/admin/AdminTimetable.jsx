import { useEffect, useState } from 'react';
import { Clock, Plus, Trash } from 'lucide-react';
import api from '../../services/api';
import { loadOptions } from '../../services/options';
import { classChoices } from '../../utils/classes';
import ClassSelect from '../../components/ClassSelect';
import Modal from '../../components/Modal';
import ConfirmModal from '../../components/ConfirmModal';
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
 * admin screens use and warns with a styled stacked confirmation dialog
 * (ConfirmModal) before saving a period whose
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
  // Schedule Conflict dialog: the detected conflicts (strings) while it is
  // open — the Add-Period form stays mounted behind it with its values intact.
  const [conflictItems, setConflictItems] = useState(null);
  // Generic confirmation dialog state (period deletion): { title, message, onConfirm }
  const [confirm, setConfirm] = useState(null);
  // Load failure must never look like "no classes" — an empty dropdown should
  // only ever mean the school really has no classes yet.
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

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
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, [reloadKey]);

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

  const savePeriod = async () => {
    setSaving(true);
    try {
      await api.post('/admin/timetable', {
        classKey,
        period: Number(form.period),
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
    // Real conflicts (teacher + class + slot details from the live timetable)
    // are listed in the stacked Schedule Conflict dialog. The Add-Period form
    // stays open behind it; "Add Anyway" re-enters here with the dialog state
    // set, so this time it proceeds straight to saving.
    const conflicts = findConflicts(start, end);
    if (conflicts.length > 0 && !conflictItems) {
      setConflictItems(conflicts);
      return;
    }
    setConflictItems(null);
    await savePeriod();
  };

  const handleDelete = (ck, period) => {
    const label = choices.find((c) => c.id === ck)?.label || ck;
    setConfirm({
      title: 'Delete Period',
      message: `Delete period ${period} of ${label}? This cannot be undone.`,
      onConfirm: async () => {
        try {
          await api.delete(`/admin/timetable/${ck}/${period}`);
          toast.success('Period removed.');
          const r = await api.get('/admin/timetable');
          setTimetables(r.data.data);
        } catch (err) {
          toast.error(err.response?.data?.message || 'Could not remove period.');
        }
        setConfirm(null);
      },
    });
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  if (loadError) {
    return (
      <div className="page fade-in">
        <div className="page-header">
          <div className="page-title">Timetable Editor</div>
          <div className="page-subtitle">Add and manage class schedules</div>
        </div>
        <div className="empty-state">
          <Clock size={40} />
          Could not load the class list or timetable. Check that the API is running.
          <button
            className="btn btn-primary btn-sm"
            style={{ marginTop: 'var(--sp-md)' }}
            onClick={() => { setLoadError(false); setLoading(true); setReloadKey((k) => k + 1); }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Timetable Editor</div>
        <div className="page-subtitle">Add and manage class schedules</div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 'var(--sp-md)', flexWrap: 'wrap', marginBottom: 'var(--sp-lg)' }}>
        <ClassSelect
          id="timetable-class"
          value={classKey}
          onChange={setClassKey}
          choices={choices}
          style={{ flex: 1, minWidth: 240, maxWidth: 420, marginBottom: 0 }}
        />
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
        {!classKey ? (
          <div className="empty-state">
            <Clock size={40} />
            Select a class to view its periods.
          </div>
        ) : periods.length === 0 ? (
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

      {/* Stacked Schedule Conflict dialog — the Add-Period form stays mounted
          behind it, so Cancel returns to the in-progress form untouched. */}
      {conflictItems && (
        <ConfirmModal
          title="Schedule Conflict"
          confirmLabel="Add Anyway"
          cancelLabel="Cancel"
          tone="primary"
          busy={saving}
          onClose={() => setConflictItems(null)}
          onConfirm={handleSave}
        >
          <ul className="confirm-list">
            {conflictItems.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
          <p className="confirm-note">
            Adding this period anyway will create an overlapping schedule.
          </p>
        </ConfirmModal>
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