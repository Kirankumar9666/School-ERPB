import { useCallback, useEffect, useState } from 'react';
import { Bell, Plus, X } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../services/api';
import { todayISO } from '../utils/date';

/** 'YYYY-MM-DD' → '8 Sep 2026' (en-IN) */
const fmtDay = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', {
  day: 'numeric', month: 'short', year: 'numeric',
});

/** Date-chip parts from a stored 'YYYY-MM-DD', e.g. { day: '8', mon: 'SEP' } */
const chipFor = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  return {
    day: String(d.getDate()),
    mon: d.toLocaleDateString('en-IN', { month: 'short' }).toUpperCase(),
  };
};

/**
 * ReminderSection — the shared "Set a Reminder" panel used by all three portals
 * (Student Attendance, Employee "My Attendance", Admin Calendar), rendered by
 * AttendanceCalendarWithReminders. A reminder is a date + title the signed-in
 * user sets for themselves: the server stores it against their userId, the list
 * below shows only their own reminders (soonest first) with per-item remove.
 * No reminder content or dates are ever hardcoded — everything comes from the
 * user's own stored rows.
 *
 * `onChange` (optional) fires after a reminder is added or removed so the host
 * can refresh whatever it derives from them (e.g. the calendar's day markers).
 */
export default function ReminderSection({ onChange }) {
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ date: '', title: '' });

  const load = useCallback(() =>
    api.get('/school/reminders').then((r) => setReminders(r.data.data || [])), []);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  /* Upcoming = today onwards (inclusive), in the server's soonest-first order. */
  const today = todayISO();
  const upcoming = reminders.filter((r) => r.date >= today);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!form.date) {
      toast.error('Pick a date for the reminder.');
      return;
    }
    if (!form.title.trim()) {
      toast.error('Give the reminder a title.');
      return;
    }
    setSaving(true);
    try {
      await api.post('/school/reminders', { date: form.date, title: form.title.trim() });
      toast.success('Reminder set!');
      setForm({ date: '', title: '' });
      await load();
      onChange?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not set the reminder.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (r) => {
    try {
      await api.delete(`/school/reminders/${r.id}`);
      toast.success('Reminder deleted.');
      await load();
      onChange?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed.');
    }
  };

  return (
    <div className="card">
      <form onSubmit={handleAdd} className="rm-form">
        <div className="section-title" style={{ marginBottom: 0 }}><Bell size={14} /> Set a Reminder</div>

        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label" htmlFor="rm-date">Date *</label>
          <input
            id="rm-date" type="date" className="form-input" value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
          />
        </div>

        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label" htmlFor="rm-title">Title *</label>
          <input
            id="rm-title" className="form-input" maxLength={120} value={form.title} placeholder="e.g. Submit lab record"
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </div>

        <button type="submit" className="btn btn-primary btn-full" disabled={saving}>
          <Plus size={16} /> {saving ? 'Adding…' : 'Add Reminder'}
        </button>
      </form>

      <div className="section-title" style={{ marginTop: 'var(--sp-xl)', marginBottom: 'var(--sp-md)' }}>
        Upcoming ({upcoming.length})
      </div>

      {loading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : upcoming.length === 0 ? (
        <div className="text-sm text-muted">No upcoming reminders — add one above</div>
      ) : (
        <div className="rm-list">
          {upcoming.map((r) => {
            const chip = chipFor(r.date);
            return (
              <div key={r.id} className="reminder-item">
                <div className={`rm-chip${r.date === today ? ' is-today' : ''}`}>
                  <span className="rm-chip-day">{chip.day}</span>
                  <span className="rm-chip-mon">{chip.mon}</span>
                </div>
                <div className="rm-body">
                  <div className="rm-title">{r.title}</div>
                  <div className="text-sm text-muted">{fmtDay(r.date)}{r.date === today ? ' · today' : ''}</div>
                </div>
                <button
                  type="button" className="rm-remove" aria-label={`Remove reminder: ${r.title}`}
                  onClick={() => handleDelete(r)}
                >
                  <X size={15} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
