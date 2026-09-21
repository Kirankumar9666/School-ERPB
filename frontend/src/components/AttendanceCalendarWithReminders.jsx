import { useEffect, useRef, useState } from 'react';
import { Bell, ChevronLeft, ChevronRight } from 'lucide-react';
import ReminderSection from './ReminderSection';
import { monthShift, monthLabel, buildCalendar, todayISO } from '../utils/date';

/** Column headers — Sunday first, matching `getDay()` (0 = Sunday), which is
 *  what `buildCalendar` uses to place day 1. Not a month offset: the grid
 *  layout itself always comes from real date math. */
const DAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const EMPTY = { classes: {}, titles: {}, stats: [], header: null };

/**
 * AttendanceCalendarWithReminders — THE shared attendance/calendar + reminder
 * layout, used by all three portals (Student Attendance, Employee
 * "My Attendance", Admin Calendar). One component, one place to change the
 * look: a stat row on top, then the calendar on the left and the reminder
 * panel on the right (stacked on narrow screens).
 *
 * It is parameterized only by:
 *   - `loadMonth(month)` — where THAT portal's data comes from. `month` is
 *     `{ year, month, key }` from `monthShift(offset)`, so every fetch is
 *     month-scoped and re-runs on Prev/Next. Resolve to
 *     `{ classes, titles, stats, header }`:
 *       classes : { 'YYYY-MM-DD': 'present' | 'absent' | 'late' | 'half-day'
 *                                    | 'holiday' | 'reminder' }
 *       titles  : { 'YYYY-MM-DD': 'tooltip text' }
 *       stats   : [{ icon, tone, value, label }]   — real numbers only
 *       header  : optional node above the stat row (e.g. today's status)
 *   - `legend` — the pills under the grid ([{ label, tone }]); a portal passes
 *     only the categories its own calendar can produce.
 *
 * Nothing here is hardcoded: the grid comes from `buildCalendar(year, month)`
 * (real weekday offset + real day count), today's cell from `todayISO()`, and
 * every stat/colour/marker from the stored rows the loader returns. Reminders
 * are the signed-in user's own — the server scopes `/school/reminders` to
 * `req.user.id`, so one user's reminders can never reach another's screen.
 */
export default function AttendanceCalendarWithReminders({ loadMonth, legend = [] }) {
  const [offset, setOffset] = useState(0);
  const [rev, setRev] = useState(0); // bumped when a reminder is added/removed
  // Last *settled* load: the request key it belongs to + its data. `loading`
  // below is derived from that key, so the effect never has to setState()
  // synchronously to flip the spinner on.
  const [settled, setSettled] = useState({ key: null, data: EMPTY });

  // Keep the newest loader in a ref instead of the effect's deps: pages define
  // it inline, so depending on its identity would refetch on every render.
  const loader = useRef(loadMonth);
  useEffect(() => { loader.current = loadMonth; });

  const m = monthShift(offset);
  const requestKey = `${offset}:${rev}`;
  const loading = settled.key !== requestKey;

  useEffect(() => {
    let alive = true;
    loader.current(monthShift(offset))
      .then((d) => { if (alive) setSettled({ key: requestKey, data: { ...EMPTY, ...d } }); })
      .catch(() => { if (alive) setSettled({ key: requestKey, data: EMPTY }); });
    return () => { alive = false; };
  }, [offset, requestKey]);

  const cells = buildCalendar(m.year, m.month);
  const today = todayISO();
  const { classes, titles, stats, header } = settled.data;


  return (
    <>
      {loading ? (
        <div className="loading-center"><div className="spinner" /></div>
      ) : (
        <>
          {header}

          {stats.length > 0 && (
            <div className="stat-grid" style={{ marginBottom: 'var(--sp-xl)' }}>
              {stats.map((s) => {
                const Icon = s.icon;
                return (
                  <div className="stat-card" key={s.label}>
                    <div className={`stat-icon stat-icon-${s.tone || 'primary'}`}>
                      {Icon ? <Icon size={22} /> : null}
                    </div>
                    <div>
                      <div className="stat-value">{s.value}</div>
                      <div className="stat-label">{s.label}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      <div className="att-layout">
        {/* Calendar — compact month grid derived from the real date math. */}
        <div className="card att-cal-card">
          {loading ? (
            <div className="loading-center"><div className="spinner" /></div>
          ) : (
            <>
              <div className="month-nav">
                <button
                  type="button" className="btn btn-secondary btn-sm" aria-label="Previous month"
                  onClick={() => setOffset((o) => o - 1)}
                >
                  <ChevronLeft size={16} /> Prev
                </button>
                <div className="month-label">{monthLabel(m.year, m.month)}</div>
                <button
                  type="button" className="btn btn-secondary btn-sm" aria-label="Next month"
                  onClick={() => setOffset((o) => o + 1)}
                >
                  Next <ChevronRight size={16} />
                </button>
              </div>

              {/* Horizontal-scroll fallback: the compact grid fits 7 columns at
                  every width we measured, so this wrapper never scrolls in
                  practice — it exists so a day can never become unreachable on
                  an unusually narrow screen. */}
              <div className="cal-scroll">
                <div className="calendar-grid compact">
                  {DAY_HEADERS.map((d) => <div key={d} className="cal-day-header">{d}</div>)}
                  {cells.map((cell, idx) => !cell.inMonth ? (
                    <div key={`e-${idx}`} className="cal-day empty compact" />
                  ) : (
                    <div
                      key={cell.iso}
                      className={`cal-day compact ${cell.iso === today ? 'today ' : ''}${classes[cell.iso] || ''}`}
                      title={titles[cell.iso]}
                    >
                      {cell.day}
                    </div>
                  ))}
                </div>
              </div>

              {legend.length > 0 && (
                <div className="att-legend">
                  <span className="text-muted text-sm">Legend:</span>
                  {legend.map((l) => (
                    <span key={l.label} className={`badge badge-${l.tone || 'muted'}`}>{l.label}</span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Reminder panel — the signed-in user's own date+title list. */}
        <div className="att-rm-col">
          <ReminderSection onChange={() => setRev((n) => n + 1)} />
        </div>
      </div>

      <div className="att-note text-sm text-muted">
        <Bell size={12} /> A reminder pops up on its date when you load the app — dismissed ones stay quiet for the rest of the day.
      </div>
    </>
  );
}
