import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, PartyPopper } from 'lucide-react';
import api from '../../services/api';
import Modal from '../../components/Modal';
import { monthShift, monthLabel, buildCalendar, todayISO } from '../../utils/date';

const fmtLong = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
});

/**
 * Holiday Calendar — a compact month grid (small cells, centered card) where
 * only the days that actually have a holiday are marked: gold date + a dot
 * under it, and clicking one opens a popup with the holiday's details (name +
 * date, from the same GET /school/holidays data the admin panel manages).
 * Days without a holiday are plain cells — clicking them does nothing. All
 * details live on the server; nothing here is a local list.
 */
export default function StudentHolidays() {
  const [offset, setOffset] = useState(0);
  const [holidays, setHolidays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null); // the holiday whose popup is open

  const m = monthShift(offset);

  useEffect(() => {
    let alive = true;
    api.get(`/school/holidays?month=${m.key}`)
      .then((r) => { if (alive) setHolidays(r.data.data || []); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [m.key]);

  const cells = buildCalendar(m.year, m.month);
  const today = todayISO();
  const byDate = Object.fromEntries(holidays.map((h) => [h.date, h]));

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Holiday Calendar</div>
        <div className="page-subtitle">School holidays & vacations</div>
      </div>

      {loading ? (
        <div className="loading-center"><div className="spinner" /></div>
      ) : (
        <div className="card" style={{ maxWidth: 420, margin: '0 auto' }}>
          <div className="month-nav">
            <button className="btn btn-secondary btn-sm" onClick={() => setOffset(offset - 1)} aria-label="Previous month">
              <ChevronLeft size={16} /> Prev
            </button>
            <div className="month-label">{monthLabel(m.year, m.month)}</div>
            <button className="btn btn-secondary btn-sm" onClick={() => setOffset(offset + 1)} aria-label="Next month">
              Next <ChevronRight size={16} />
            </button>
          </div>

          {/* Horizontal-scroll fallback — see the shared calendar component */}
          <div className="cal-scroll">
            <div className="calendar-grid compact">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                <div key={d} className="cal-day-header">{d}</div>
              ))}
              {cells.map((cell, idx) => {
                if (!cell.inMonth) {
                  /* Leading/trailing blanks keep their grid cell so the days line
                     up with the right weekday columns. */
                  return <div key={`e-${idx}`} className="cal-day empty compact">{''}</div>;
                }
                const holiday = byDate[cell.iso];
                if (!holiday) {
                  /* No holiday → not clickable, no marker */
                  return (
                    <div key={cell.iso} className={`cal-day compact ${cell.iso === today ? 'today' : ''}`}>
                      {cell.day}
                    </div>
                  );
                }
                return (
                  <button
                    key={cell.iso}
                    type="button"
                    className={`cal-day compact holiday ${cell.iso === today ? 'today' : ''}`}
                    onClick={() => setSelected(holiday)}
                    aria-label={`Holiday: ${holiday.name}, ${fmtLong(cell.iso)}`}
                  >
                    {cell.day}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-md)', textAlign: 'center' }}>
            Dotted dates are holidays — click one for details.
          </div>
        </div>
      )}

      {selected && (
        <Modal title={selected.name} onClose={() => setSelected(null)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-md)' }}>
            <div className="overview-card-icon" style={{ background: 'var(--tint-gold)', color: 'var(--clr-warning)' }}>
              <PartyPopper size={22} />
            </div>
            <div>
              <div style={{ fontWeight: 600 }}>{selected.name}</div>
              <div className="text-sm text-muted">{fmtLong(selected.date)}</div>
            </div>
          </div>
          <div style={{ marginTop: 'var(--sp-md)' }}>
            <span className="badge badge-holiday">Holiday</span>
          </div>
        </Modal>
      )}
    </div>
  );
}