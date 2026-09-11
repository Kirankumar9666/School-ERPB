import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, PartyPopper } from 'lucide-react';
import api from '../../services/api';
import { monthShift, monthLabel, buildCalendar, todayISO } from '../../utils/date';

/**
 * Holiday Calendar — month calendar highlighting school holidays.
 */
export default function StudentHolidays() {
  const [offset, setOffset] = useState(0);
  const [holidays, setHolidays] = useState([]);
  const [loading, setLoading] = useState(true);

  const m = monthShift(offset);

  useEffect(() => {
    api.get(`/school/holidays?month=${m.key}`)
      .then((r) => setHolidays(r.data.data || []))
      .finally(() => setLoading(false));
  }, [m.key]);

  const cells = buildCalendar(m.year, m.month);
  const today = todayISO();
  const holidayMap = {};
  holidays.forEach((h) => { holidayMap[h.date] = h.name; });

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Holiday Calendar</div>
        <div className="page-subtitle">School holidays & vacations</div>
      </div>

      {loading ? (
        <div className="loading-center"><div className="spinner" /></div>
      ) : (
        <>
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
                {cells.map((cell) => cell === null ? (
                  <div key={`e-${cells.indexOf(cell)}`} className="cal-day empty">{''}</div>
                ) : (
                  <div
                    key={cell.iso}
                    className={`cal-day ${cell.iso === today ? 'today ' : ''}${holidayMap[cell.iso] ? 'holiday' : ''}${!cell.inMonth && !holidayMap[cell.iso] ? ' other' : ''}`}
                    title={holidayMap[cell.iso] || ''}
                  >
                    {cell.day || ''}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="section">
            <div className="section-title"><PartyPopper size={14} /> Holidays in {monthLabel(m.year, m.month)}</div>
            {holidays.length === 0 ? (
              <div className="empty-state">
                <PartyPopper size={40} />
                No holidays this month.
              </div>
            ) : (
              holidays.map((h) => (
                <div key={h.id} className="card" style={{ marginBottom: 'var(--sp-md)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>{h.name}</div>
                    <div className="text-sm text-muted">
                      {new Date(`${h.date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
                    </div>
                  </div>
                  <span className="badge badge-holiday">Holiday</span>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}