import { useCallback, useState } from 'react';
import { Bell, BellRing, CalendarDays, Check, Save } from 'lucide-react';
import api from '../../services/api';
import toast from '../../services/toast';
import AttendanceCalendarWithReminders from '../../components/AttendanceCalendarWithReminders';
import { useWeeklyOffDays, setWeeklyOffDays } from '../../utils/useWeeklyOffDays';
import { todayISO } from '../../utils/date';
import { getReminders } from '../../utils/remindersCache';

/** What the admin's calendar can mark — one pill per category it can render. */
const LEGEND = [
  { label: 'Holiday', tone: 'holiday' },
  { label: 'Your Reminder', tone: 'primary' },
];

const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Weekly Off Days — the school-level setting behind every attendance calendar.
 * Changing it here updates the database and, immediately, the calendars already
 * on screen (the shared `useWeeklyOffDays` cache is notified). Sundays are off
 * by default; Saturdays are ordinary working days.
 */
function WeeklyOffEditor() {
  const current = useWeeklyOffDays();
  // `null` = showing the stored setting; a non-null draft is the admin's edit.
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const selected = draft ?? current;

  const toggle = (day) => setDraft((base) => {
    const from = base ?? current;
    return from.includes(day) ? from.filter((d) => d !== day) : [...from, day].sort((a, b) => a - b);
  });

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.put('/admin/settings', { weeklyOffDays: selected });
      setWeeklyOffDays(res.data.data.weeklyOffDays);
      setDraft(null);
      toast.success('Weekly off days saved.');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save weekly off days.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="section">
      <div className="section-title"><CalendarDays size={14} /> Weekly Off Days</div>
      <div className="card">
        <p className="text-sm text-muted" style={{ marginBottom: 'var(--sp-md)' }}>
          The school&apos;s weekly working week. These days are shaded in every attendance
          calendar and left out of working-day counts; real holidays are managed separately.
        </p>
        <div className="weekly-off-days">
          {WEEKDAY_LABELS.map((label, day) => {
            const active = selected.includes(day);
            return (
              <button
                key={label}
                type="button"
                className={`weekly-off-day${active ? ' active' : ''}`}
                aria-pressed={active}
                onClick={() => toggle(day)}
              >
                {active && <Check size={12} />} {label.slice(0, 3)}
              </button>
            );
          })}
        </div>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save} style={{ marginTop: 'var(--sp-md)' }}>
          <Save size={16} /> {saving ? 'Saving…' : 'Save Weekly Off Days'}
        </button>
      </div>
    </div>
  );
}

/**
 * Admin Calendar — the shared attendance/calendar + reminder layout
 * (AttendanceCalendarWithReminders) fed with the school holidays for the month
 * on screen and the admin's OWN reminders for the calendar markers and the
 * stat row. Both come from live reads: `/school/holidays?month=…` and
 * `/school/reminders`, which the server scopes to `req.user.id` — so the
 * markers, counts and list below are always this admin's real stored rows.
 *
 * There is no attendance calendar for an admin, so the stat row counts what
 * this page actually holds (monthly holidays, this month's reminders, and how
 * many reminders are still upcoming) instead of inventing figures — and the
 * Holidays stat counts only REAL holidays, never a weekly off day.
 */
export default function AdminCalendar() {
  const loadMonth = useCallback(async (m) => {
    const [hol, reminders] = await Promise.all([
      api.get(`/school/holidays?month=${m.key}`),
      // Through the shared cache so the admin calendar and the reminder popup
      // do not each fetch the same list.
      getReminders(),
    ]);
    const holidays = hol.data.data || [];
    const today = todayISO();

    const classes = {};
    const titles = {};
    reminders.forEach((r) => {
      classes[r.date] = 'reminder';
      titles[r.date] = `Reminder: ${r.title}`;
    });
    holidays.forEach((h) => {
      classes[h.date] = 'holiday'; // a holiday outranks a reminder on the same day
      titles[h.date] = `Holiday: ${h.name}`;
    });

    return {
      classes,
      titles,
      stats: [
        { icon: CalendarDays, tone: 'warning', value: holidays.length, label: 'Holidays' },
        {
          icon: Bell, tone: 'accent', label: 'Your Reminders',
          value: reminders.filter((r) => r.date.startsWith(m.key)).length,
        },
        {
          icon: BellRing, tone: 'info', label: 'Upcoming',
          value: reminders.filter((r) => r.date >= today).length,
        },
      ],
    };
  }, []);

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Calendar</div>
        <div className="page-subtitle">Holidays & your personal reminders</div>
      </div>

      <WeeklyOffEditor />

      <AttendanceCalendarWithReminders loadMonth={loadMonth} legend={LEGEND} />
    </div>
  );
}
