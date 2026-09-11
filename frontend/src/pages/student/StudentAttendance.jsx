import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, CalendarCheck, XCircle, CalendarDays } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import { monthShift, monthLabel, buildCalendar, todayISO } from '../../utils/date';

/**
 * Student Attendance — month calendar with color coding.
 * Blue → Present | Red → Absent | Green → Holiday
 */
export default function StudentAttendance() {
  const { user } = useAuth();
  const [offset, setOffset] = useState(0);
  const [records, setRecords] = useState({});
  const [holidays, setHolidays] = useState([]);
  const [loading, setLoading] = useState(true);

  const m = monthShift(offset);

  useEffect(() => {
    if (!user?.linkedEntityId) return;
    Promise.all([
      api.get(`/students/${user.linkedEntityId}/attendance?month=${m.key}`),
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
    return records[iso] || null;
  };

  const summary = { present: 0, absent: 0, holiday: 0 };
  Object.values(records).forEach((s) => {
    if (s === 'present') summary.present += 1;
    else if (s === 'absent') summary.absent += 1;
  });
  Object.keys(records).forEach((k) => {
    if (statusFor(k) === 'holiday') summary.holiday += 1;
  });

  const cells = buildCalendar(m.year, m.month);
  const today = todayISO();

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Attendance Overview</div>
        <div className="page-subtitle">Month-wise attendance record</div>
      </div>

      {loading ? (
        <div className="loading-center"><div className="spinner" /></div>
      ) : (
        <>
          {/* Summary */}
          <div className="stat-grid" style={{ marginBottom: 'var(--sp-xl)' }}>
            <div className="stat-card">
              <div className="stat-icon stat-icon-info"><CalendarCheck size={22} /></div>
              <div>
                <div className="stat-value">{summary.present}</div>
                <div className="stat-label">Days Present</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon stat-icon-danger"><XCircle size={22} /></div>
              <div>
                <div className="stat-value">{summary.absent}</div>
                <div className="stat-label">Days Absent</div>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon stat-icon-success"><CalendarDays size={22} /></div>
              <div>
                <div className="stat-value">{summary.holiday}</div>
                <div className="stat-label">Holidays</div>
              </div>
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
                  <div
                    key={cell.iso || `${cell.day}`}
                    className={`cal-day ${cell.iso === today ? 'today ' : ''}${statusFor(cell.iso) || (cell.inMonth ? '' : ' other')}`}
                  >
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
            <span className="badge badge-holiday">Holiday</span>
          </div>
        </>
      )}
    </div>
  );
}