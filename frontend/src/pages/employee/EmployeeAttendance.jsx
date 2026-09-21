import { useCallback, useEffect, useState } from 'react';
import { CalendarCheck, XCircle, AlarmClock, Hourglass, Clock, BookMarked } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { TEACHER_ROLES } from '../../constants/roles';
import api from '../../services/api';
import MarkAttendance from '../../components/MarkAttendance';
import AttendanceCalendarWithReminders from '../../components/AttendanceCalendarWithReminders';
import { todayISO } from '../../utils/date';

/** What this portal's calendar can show — one pill per status it can render. */
const LEGEND = [
  { label: 'Present', tone: 'active' },
  { label: 'Absent', tone: 'absent' },
  { label: 'Late', tone: 'late' },
  { label: 'Half Day', tone: 'half-day' },
  { label: 'Holiday', tone: 'holiday' },
];

/** API status → label (the API sends 'half-day' with a hyphen). */
const STATUS_LABELS = {
  present: 'Present', absent: 'Absent', late: 'Late', 'half-day': 'Half day', holiday: 'Holiday',
};

/**
 * My Attendance — the shared attendance/calendar + reminder layout
 * (AttendanceCalendarWithReminders), fed with THIS employee's live data:
 * `/employees/:id/attendance?month=…` (a status + working hours per day,
 * accompanied by the server's own month summary) and
 * `/school/holidays?month=…` for the holiday days. Every number, colour and
 * marker comes from those rows — nothing is hardcoded, and the reminders panel
 * is scoped server-side to this signed-in user.
 */
function MyAttendance() {
  const { user } = useAuth();
  const employeeId = user?.linkedEntityId;

  const loadMonth = useCallback(async (m) => {
    if (!employeeId) return null;
    const [att, hol] = await Promise.all([
      api.get(`/employees/${employeeId}/attendance?month=${m.key}`),
      api.get(`/school/holidays?month=${m.key}`),
    ]);
    const records = att.data.data.records || {};
    const summary = att.data.data.summary || {};
    const holidays = hol.data.data || [];
    const today = todayISO();

    const holidayOn = Object.fromEntries(holidays.map((h) => [h.date, h]));
    const classes = {};
    const titles = {};
    holidays.forEach((h) => {
      classes[h.date] = 'holiday';
      titles[h.date] = `Holiday: ${h.name}`;
    });

    Object.entries(records).forEach(([iso, r]) => {
      if (holidayOn[iso]) return; // that day is shown as a holiday, not a working day
      if (!r?.status) return;
      const hours = r.workingHours || 0;
      classes[iso] = r.status;
      titles[iso] = `${STATUS_LABELS[r.status] || r.status}${hours ? ` · ${hours} hrs` : ''}`;
    });

    const todayStatus = classes[today];

    return {
      classes,
      titles,
      // The month summary is the server's own figures for exactly these rows.
      stats: [
        { icon: CalendarCheck, tone: 'info', value: summary.present || 0, label: 'Present' },
        { icon: XCircle, tone: 'danger', value: summary.absent || 0, label: 'Absent' },
        { icon: AlarmClock, tone: 'warning', value: summary.late || 0, label: 'Late' },
        { icon: Hourglass, tone: 'warning', value: summary.halfDay || 0, label: 'Half Day' },
        { icon: Clock, tone: 'primary', value: summary.hours || 0, label: 'Working Hours' },
      ],
      header: (
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-md)', marginBottom: 'var(--sp-xl)' }}>
          <span className="text-muted text-sm">Today:&nbsp;</span>
          <span className={`badge badge-${todayStatus || 'pending'}`}>{STATUS_LABELS[todayStatus] || 'Not marked'}</span>
          {todayStatus === 'present' && records[today]?.workingHours ? (
            <span className="text-sm text-muted">· {records[today].workingHours} hrs</span>
          ) : null}
        </div>
      ),
    };
  }, [employeeId]);

  return <AttendanceCalendarWithReminders loadMonth={loadMonth} legend={LEGEND} />;
}
/**
 * Mark Attendance — the class-based flow the admin panel uses, rendered inside
 * the employee portal and scoped to the classes THIS teacher is assigned to
 * teach. The list comes from `/employees/:id/attendance/classes`, which is
 * derived live from the teacher's TeachingAssignment rows — never a local list.
 *
 * The scoping is also enforced server-side on every group read and save, so a
 * class the teacher doesn't teach is rejected even if requested directly; this
 * screen only reflects what the server already allows.
 */
function TeacherMarkAttendance() {
  const { user } = useAuth();
  const employeeId = user?.linkedEntityId;
  const [classes, setClasses] = useState([]);
  const [loading, setLoading] = useState(Boolean(employeeId));
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // No linked employee → nothing to fetch; `loading` already starts false.
    if (!employeeId) return undefined;
    let alive = true;
    api.get(`/employees/${employeeId}/attendance/classes`)
      .then((r) => { if (alive) { setClasses(r.data.data || []); setFailed(false); } })
      .catch(() => { if (alive) { setClasses([]); setFailed(true); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [employeeId, attempt]);

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  // A failed read is not the same as "no classes" — say which it is.
  if (failed) {
    return (
      <div className="empty-state">
        <BookMarked size={40} />
        <p>Could not load your classes.</p>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => { setLoading(true); setFailed(false); setAttempt((n) => n + 1); }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (classes.length === 0) {
    return (
      <div className="empty-state">
        <BookMarked size={40} />
        <p>No classes are assigned to you yet, so there is no attendance to mark.</p>
      </div>
    );
  }

  return (
    /* key: remount with clean state if the signed-in teacher changes */
    <MarkAttendance
      key={employeeId}
      kind="student"
      groups={classes}
      apiBase={`/employees/${employeeId}`}
      nouns={{ group: 'class', groups: 'classes', members: 'students' }}
      searchPlaceholder="Search class, e.g. 10 - A"
    />
  );
}

/**
 * Employee Attendance — the employee's own monthly record, plus (for teaching
 * staff) the class-based "Mark Attendance" flow. Only the active tab is
 * rendered, and the teacher section remounts on a tab switch so no roster from
 * the other view can linger.
 *
 * "My Attendance" is unchanged: the same calendar, summary and today's status
 * as before. The Mark Attendance tab is the shared admin flow, scoped to this
 * teacher's assigned classes.
 */
export default function EmployeeAttendance() {
  const { user } = useAuth();
  const [tab, setTab] = useState('mine'); // 'mine' | 'mark'

  // Only teaching staff have a roster to mark (mirrors the server's guard).
  const canMarkAttendance = TEACHER_ROLES.includes(user?.role);

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Attendance</div>
        <div className="page-subtitle">
          {canMarkAttendance ? 'Your record and the classes you teach' : 'Monthly record & working hours'}
        </div>
      </div>

      {canMarkAttendance && (
        <div className="tabs">
          <button
            type="button"
            className={`tab-btn${tab === 'mine' ? ' active' : ''}`}
            onClick={() => setTab('mine')}
          >
            My Attendance
          </button>
          <button
            type="button"
            className={`tab-btn${tab === 'mark' ? ' active' : ''}`}
            onClick={() => setTab('mark')}
          >
            Mark Attendance
          </button>
        </div>
      )}

      {canMarkAttendance && tab === 'mark'
        ? <TeacherMarkAttendance />
        : <MyAttendance />}
    </div>
  );
}