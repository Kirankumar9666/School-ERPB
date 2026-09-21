import { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import api from '../services/api';
import Modal from './Modal';
import { todayISO } from '../utils/date';

const DISMISS_KEY = 'reminder-dismissed'; // sessionStorage — dies with the browser session, i.e. at most "for the rest of the day"

/** Read the set of reminder keys dismissed today: '${date}:${id}' entries. */
const readDismissed = () => {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(DISMISS_KEY) || '[]'));
  } catch {
    return new Set();
  }
};

/**
 * ReminderPopup — mounted once in ProtectedLayout, so every portal (student,
 * employee, admin) checks for due reminders on load. A reminder is "due"
 * when its stored date equals the real current date (computed at render/request
 * time — never a hardcoded date). Dismissed reminders are remembered per day
 * (sessionStorage), so the same popup doesn't re-appear after "Got it" until
 * the next day; the reminder still shows in the Upcoming list.
 *
 * Reminders are private per user: the endpoint only ever returns the signed-in
 * user's own rows, so this can never show someone else's reminder.
 */
export default function ReminderPopup() {
  const [reminders, setReminders] = useState([]);
  const [dismissed, setDismissed] = useState(() => readDismissed());

  useEffect(() => {
    let alive = true;
    api.get('/school/reminders')
      .then((r) => { if (alive) setReminders(r.data.data || []); })
      .catch(() => { /* a failed read must not block the app — just no popup */ });
    return () => { alive = false; };
  }, []);

  const today = todayISO();
  const due = reminders.find((r) => r.date === today && !dismissed.has(`${r.date}:${r.id}`));

  const handleDismiss = () => {
    const next = new Set(dismissed);
    next.add(`${due.date}:${due.id}`);
    sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...next]));
    setDismissed(next); // re-renders: if another reminder is also due today, it shows next
  };

  if (!due) return null;

  return (
    <Modal title="Reminder" onClose={handleDismiss}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--sp-md)', textAlign: 'center' }}>
        <div
          className="overview-card-icon"
          style={{ background: 'var(--tint-gold)', color: 'var(--clr-warning)', width: 56, height: 56, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <BellRing size={26} />
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 17 }}>{due.title}</div>
          <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-xs)' }}>
            {new Date(`${due.date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </div>
        </div>
        <button type="button" className="btn btn-primary" onClick={handleDismiss}>
          Got it
        </button>
      </div>
    </Modal>
  );
}
