import { useCallback } from 'react';
import { Bell, BellRing, CalendarDays } from 'lucide-react';
import api from '../../services/api';
import AttendanceCalendarWithReminders from '../../components/AttendanceCalendarWithReminders';
import { todayISO } from '../../utils/date';

/** What the admin's calendar can mark — one pill per category it can render. */
const LEGEND = [
  { label: 'Holiday', tone: 'holiday' },
  { label: 'Your Reminder', tone: 'primary' },
];

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
 * many reminders are still upcoming) instead of inventing figures.
 */
export default function AdminCalendar() {
  const loadMonth = useCallback(async (m) => {
    const [hol, rem] = await Promise.all([
      api.get(`/school/holidays?month=${m.key}`),
      api.get('/school/reminders'),
    ]);
    const holidays = hol.data.data || [];
    const reminders = rem.data.data || [];
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

      <AttendanceCalendarWithReminders loadMonth={loadMonth} legend={LEGEND} />
    </div>
  );
}
