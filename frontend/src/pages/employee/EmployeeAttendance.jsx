import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, CalendarCheck, XCircle, AlarmClock, Hourglass } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import { monthShift, monthLabel, buildCalendar, todayISO } from '../../utils/date';

/**
 * Employee Attendance — today's status + month calendar + summary stats.
 */
export default function EmployeeAttendance() {
  const { user } = useAuth();
  const [offset, setOffset] = useState(0);
  const [records, setRecords] = useState({});
  const [holidays, setHolidays] = useState([]);
  const [loading, setLoading] = useState(true);

  const m = monthShift(offset);

  useEffect(() => {
    if (!user?.linkedEntityId) return;
    Promise.all([
      api.get(`/employees/${user.linkedEntityId}/attendance?month=${m.key}`),
      api.get(`/school/holidays?month=${m.key}`),
    ])
      .then(([att, hol]) => {
        setRecords(att.data.data.records || {});
        setHolidays(hol.data.data || []);
      })
      .finally(() => setLoading(false));
  }, [user, m.key]);

  const statusFor = (iso) => {
    if (holidays.some((h) => h.date === iso)) return 'holiday';
    const r = records[iso];
    return r ? r.status : null;
  };

  const summary = { present: 0, absent: 0, late: 0, halfDay: 0, hours: 0 };
  Object.values(records).forEach((r) => {
    if (r.status === 'present') summary.present += 1;
    else if (r.status === 'absent') summary.absent += 1;
    else if (r.status === 'late') summary.late += 1;
    else if (r.status === 'half-day') summary.halfDay += 1;
    summary.hours += r.workingHours || 0;
  });

  const cells = buildCalendar(m.year, m.month);
  const today = todayISO();
  const todayStatus = statusFor(today);

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">My Attendance</div>
        <div className="page-subtitle">Monthly record & working hours</div>
      </div>

      {loading ? (
        <div className="loading-center"><div className="spinner" /></div>
      ) : (
        <>
          {/* Today's status */}
          <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-md)', marginBottom: 'var(--sp-xl)' }}>
            <span className="text-muted text-sm">Today:&nbsp;</span>
            <span className={`badge badge-${todayStatus || 'pending'}`}>{todayStatus || 'Not marked'}</span>
            {todayStatus === 'present' && records[today]?.workingHours && (
              <span className="text-sm text-muted">· {records[today].workingHours} hrs</span>
            )}
          </div>

          {/* Summary */}
          <div className="stat-grid" style={{ marginBottom: 'var(--sp-xl)' }}>
            <div className="stat-card">
              <div className="stat-icon stat-icon-info"><CalendarCheck size={22} /></div>
              <div><div className="stat-value">{summary.present}</div><div className="stat-label">Present</div></div>
            </div>
            <div className="stat-card">
              <div className="stat-icon stat-icon-danger"><XCircle size={22} /></div>
              <div><div className="stat-value">{summary.absent}</div><div className="stat-label">Absent</div></div>
            </div>
            <div className="stat-card">
              <div className="stat-icon stat-icon-warning"><AlarmClock size={22} /></div>
              <div><div className="stat-value">{summary.late}</div><div className="stat-label">Late</div></div>
            </div>
            <div className="stat-card">
              <div className="stat-icon stat-icon-warning"><Hourglass size={22} /></div>
              <div><div className="stat-value">{summary.hours}</div><div className="stat-label">Working Hours</div></div>
            </div>
          </div>

          {/* Calendar */}
          <div className="section">
            <div className="month-nav">
              <button className="btn btn-secondary btn-sm" onClick={() => setOffset(offset - 1)} aria-label="Previous month">
                <ChevronLeft size={16} /> Prev
              </button>
              <div className="month-label">{monthLabel(m.year, m.month)}</div>
              <button className="btn btn-secondary btn-sm" onClick={() => setOffset(offset + 1)} aria-label="Next month">
                Next <ChevronRight size={16} />
              </button>
            </div>

            <div className="card">
              <div className="calendar-grid">
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                  <div key={d} className="cal-day-header">{d}</div>
                ))}
                {cells.map((cell, idx) => cell === null ? (
                  <div key={`e-${idx}`} className="cal-day empty">{''}</div>
                ) : (
                  <div key={cell.iso} className={`cal-day ${cell.iso === today ? 'today ' : ''}${statusFor(cell.iso) || (cell.inMonth ? '' : ' other')}`}>
                    {cell.day || ''}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Legend */}
          <div className="card" style={{ display: 'flex', gap: 'var(--sp-md)', alignItems: 'center' }}>
            <span className="text-muted text-sm">Legend:</span>
            <span className="badge badge-active">Present</span>
            <span className="badge badge-absent">Absent</span>
            <span className="badge badge-late">Late</span>
            <span className="badge badge-holiday">Holiday</span>
          </div>
        </>
      )}
    </div>
  );
}