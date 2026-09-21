import { useCallback } from 'react';
import { CalendarCheck, XCircle, CalendarDays } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import AttendanceCalendarWithReminders from '../../components/AttendanceCalendarWithReminders';

/** What this portal's calendar can show — one pill per status it can render. */
const LEGEND = [
  { label: 'Present', tone: 'active' },
  { label: 'Absent', tone: 'absent' },
  { label: 'Holiday', tone: 'holiday' },
];

/**
 * Student Attendance — the shared attendance/calendar + reminder layout
 * (AttendanceCalendarWithReminders) fed with THIS student's live data:
 * `/students/:id/attendance?month=…` for the day statuses and
 * `/school/holidays?month=…` for the holiday days. Every number, colour and
 * marker is derived from those rows for the month on screen — nothing is
 * hardcoded, and the reminders panel is scoped server-side to this user.
 */
export default function StudentAttendance() {
  const { user } = useAuth();
  const studentId = user?.linkedEntityId;

  const loadMonth = useCallback(async (m) => {
    if (!studentId) return null;
    const [att, hol] = await Promise.all([
      api.get(`/students/${studentId}/attendance?month=${m.key}`),
      api.get(`/school/holidays?month=${m.key}`),
    ]);
    const records = att.data.data.records || {};
    const holidays = hol.data.data || [];
    const holidayOn = Object.fromEntries(holidays.map((h) => [h.date, h]));

    const classes = {};
    const titles = {};
    Object.entries(holidayOn).forEach(([iso, h]) => {
      classes[iso] = 'holiday';
      titles[iso] = `Holiday: ${h.name}`;
    });

    const counts = { present: 0, absent: 0 };
    Object.entries(records).forEach(([iso, status]) => {
      if (holidayOn[iso]) return; // that day is shown as a holiday, not a class day
      if (!status) return;
      classes[iso] = status;
      if (counts[status] !== undefined) counts[status] += 1;
    });

    return {
      classes,
      titles,
      stats: [
        { icon: CalendarCheck, tone: 'info', value: counts.present, label: 'Days Present' },
        { icon: XCircle, tone: 'danger', value: counts.absent, label: 'Days Absent' },
        { icon: CalendarDays, tone: 'success', value: holidays.length, label: 'Holidays' },
      ],
    };
  }, [studentId]);

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Attendance Overview</div>
        <div className="page-subtitle">Month-wise attendance record</div>
      </div>

      <AttendanceCalendarWithReminders loadMonth={loadMonth} legend={LEGEND} />
    </div>
  );
}
