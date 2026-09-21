import { useEffect, useState } from 'react';
import api from '../services/api';
import { buildCalendar, monthLabel, monthShift } from '../utils/date';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * AttendanceMonthCalendar — the compact month calendar from "Check student"
 * on the Mark Attendance flow, extracted so any student-centric view can show
 * it. Marks present (green) / absent (red) / half-day (gold) from the REAL
 * saved records for the student, weekend cells shaded, with ‹ › month
 * navigation.
 *
 * The profile view also wants the month's Present/Absent/% summary, so the
 * server's own month summary is handed up through `onSummary` whenever a new
 * month is loaded — one fetch, and the numbers always match the grid on
 * screen (nothing recomputed differently elsewhere).
 *
 * @param {string} studentId - whose attendance to draw (fetched per month).
 * @param {function} [onSummary] - called with the server's month summary
 *   ({ present, absent, halfDay, workingDays, percent, ... }) after each load.
 */
export default function AttendanceMonthCalendar({ studentId, onSummary }) {
  const [monthOffset, setMonthOffset] = useState(0);
  const [monthRecords, setMonthRecords] = useState({}); // 'YYYY-MM-DD' → status

  /** Real saved records for that student + month (server-computed summary). */
  useEffect(() => {
    if (!studentId) return undefined;
    const { key } = monthShift(monthOffset);
    let alive = true;
    api.get(`/students/${studentId}/attendance`, { params: { month: key } })
      .then((res) => {
        if (!alive) return;
        setMonthRecords(res.data.data.records || {});
        if (onSummary) onSummary(res.data.data.summary || null);
      })
      .catch(() => { if (alive) { setMonthRecords({}); if (onSummary) onSummary(null); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId, monthOffset]);

  const view = monthShift(monthOffset);
  const calCells = buildCalendar(view.year, view.month);
  const isWeekend = (iso) => {
    const d = new Date(`${iso}T00:00:00`);
    return d.getDay() === 0 || d.getDay() === 6;
  };
  const dayClass = (iso) => {
    const rec = monthRecords[iso];
    if (rec === 'present') return 'present';
    if (rec === 'absent') return 'absent';
    if (rec === 'half-day') return 'halfday';
    return isWeekend(iso) ? 'holiday' : ''; // weekends with no record = no school
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
    </div>
  );
}
