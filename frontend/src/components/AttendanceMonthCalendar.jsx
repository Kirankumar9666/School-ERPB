import { useEffect, useState } from 'react';
import api from '../services/api';
import LoadErrorState from './LoadErrorState';
import { describeLoadError } from '../utils/useLoadState';
import { buildCalendar, monthLabel, monthShift } from '../utils/date';
import { useWeeklyOffDays, weekdayOfISO } from '../utils/useWeeklyOffDays';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * AttendanceMonthCalendar — the compact month calendar from "Check record"
 * on the Mark Attendance flow, extracted so any student- or employee-centric
 * view can show it. Marks present (green) / absent (red) / half-day (gold) from
 * the REAL saved records for that person, weekly-off cells shaded, with ‹ › month
 * navigation.
 *
 * The profile view also wants the month's Present/Absent/% summary, so the
 * server's own month summary is handed up through `onSummary` whenever a new
 * month is loaded — one fetch, and the numbers always match the grid on
 * screen (nothing recomputed differently elsewhere).
 *
 * `kind` picks which live endpoint answers the month: a student's attendance
 * lives at `/students/:id/attendance`, an employee's at
 * `/employees/:id/attendance`. Both return the same `{ records, summary }`
 * shape, so only the path differs. It defaults to 'student', leaving every
 * existing caller unchanged.
 *
 * @param {string} personId - whose attendance to draw (fetched per month).
 * @param {'student'|'employee'} [kind]
 * @param {function} [onSummary] - called with the server's month summary
 *   ({ present, absent, halfDay, workingDays, percent, ... }) after each load.
 */
export default function AttendanceMonthCalendar({ personId, kind = 'student', onSummary }) {
  const [monthOffset, setMonthOffset] = useState(0);
  const [monthRecords, setMonthRecords] = useState({}); // 'YYYY-MM-DD' → status
  // The school's one weekly-off setting — read live, never a hardcoded weekend.
  const weeklyOffDays = useWeeklyOffDays();
  // Set only when the fetch itself failed. Empty records and a failed fetch
  // used to produce the same blank grid and the same "0 present · 0 absent",
  // which reads as "this month was never marked" when in fact we were never
  // told whether it was.
  const [error, setError] = useState('');
  const [rev, setRev] = useState(0); // bumped by "Try again" to re-run the load

  /** Real saved records for that person + month (server-computed summary). */
  useEffect(() => {
    if (!personId) return undefined;
    const { key } = monthShift(monthOffset);
    const path = kind === 'employee' ? 'employees' : 'students';
    let alive = true;
    api.get(`/${path}/${personId}/attendance`, { params: { month: key } })
      .then((res) => {
        if (!alive) return;
        setMonthRecords(res.data.data.records || {});
        setError('');
        if (onSummary) onSummary(res.data.data.summary || null);
      })
      .catch((err) => {
        if (!alive) return;
        setMonthRecords({});
        setError(describeLoadError(err));
        if (onSummary) onSummary(null);
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId, kind, monthOffset, rev]);

  const view = monthShift(monthOffset);
  const calCells = buildCalendar(view.year, view.month);
  /**
   * Which class a day gets. Saved present/absent/half-day win; anything else
   * falls back to the school's weekly-off setting — a Saturday is plain (it is
   * a working day) while a Sunday is shaded as an off day, exactly as stored in
   * the setting. Saved 'holiday' rows on a non-off day are not re-shaded: the
   * weekly-off style is separate from real holidays, which live on /school/holidays.
   */
  const dayClass = (iso) => {
    const rec = monthRecords[iso];
    if (rec === 'present') return 'present';
    if (rec === 'absent') return 'absent';
    if (rec === 'half-day') return 'halfday';
    return weeklyOffDays.includes(weekdayOfISO(iso)) ? 'weekly-off' : '';
  };
  const monthCounts = Object.values(monthRecords).reduce(
    (acc, s) => {
      if (s === 'present') acc.present += 1;
      else if (s === 'absent') acc.absent += 1;
      else if (s === 'half-day') acc.halfDay += 1;
      return acc;
    },
    { present: 0, absent: 0, halfDay: 0 },
  );

  return (
    <div className="att-calendar">
      <div className="att-cal-head">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMonthOffset((o) => o - 1)} aria-label="Previous month">‹</button>
        <strong>{monthLabel(view.year, view.month)}</strong>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMonthOffset((o) => o + 1)} aria-label="Next month">›</button>
      </div>
      {error ? (
        <LoadErrorState compact detail={error} onRetry={() => setRev((n) => n + 1)} />
      ) : (
        <>
          <div className="att-cal-grid">
            {WEEKDAYS.map((d) => <div key={d} className="att-cal-dow">{d}</div>)}
            {calCells.map((cell, idx) => cell.inMonth ? (
              <div
                key={cell.iso}
                className={`att-cal-day ${dayClass(cell.iso)}`.trim()}
                title={monthRecords[cell.iso] || undefined}
              >
                {cell.day}
              </div>
            ) : (
              /* Leading/trailing blanks must still occupy a grid cell —
                 dropping one shifts every day into the wrong weekday column. */
              <div key={`e-${idx}`} className="att-cal-day empty" aria-hidden="true" />
            ))}
          </div>
          <div className="text-sm text-muted">
            {monthCounts.present} present · {monthCounts.absent} absent{monthCounts.halfDay ? ` · ${monthCounts.halfDay} half-day` : ''}
          </div>
        </>
      )}
    </div>
  );
}
