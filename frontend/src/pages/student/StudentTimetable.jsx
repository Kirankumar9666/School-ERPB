import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import LoadErrorState from '../../components/LoadErrorState';
import { useLoadState } from '../../utils/useLoadState';
/**
 * Fallback when the API has not sent a label (an older cached response):
 * rebuild it the same way the server's shared function does.
 */
const displayClassName = (t) => {
  if (t.classLabel) return t.classLabel;
  if (t.levelName) return /^\d+$/.test(t.levelName) ? `Class ${t.levelName}${t.section}` : `${t.levelName} ${t.section}`;
  if (t.class === null || t.class === undefined) return '—';
  return `Class ${t.class}-${t.section}`;
};

/**
 * Student Timetable — daily/weekly teaching schedule in tabular format.
 */
export default function StudentTimetable() {
  const { user } = useAuth();
  const [timetable, setTimetable] = useState(null);
  const { loading, setLoading, error, reloadKey, retry, fail } = useLoadState();

  useEffect(() => {
    if (!user?.linkedEntityId) return;
    api.get(`/students/${user.linkedEntityId}/timetable`)
      .then((r) => setTimetable(r.data.data))
      .catch(fail)
      .finally(() => setLoading(false));
  }, [user, reloadKey, fail, setLoading]);

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  if (error) {
    return (
      <LoadErrorState
        title="Time Table"
        detail={error}
        onRetry={retry}
        icon={Clock}
      />
    );
  }

  if (!timetable) return null;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Time Table</div>
        <div className="page-subtitle">
          {timetable.classLabel || displayClassName(timetable)} · Regular schedule
        </div>
      </div>

      {timetable.periods.length === 0 ? (
        <div className="empty-state">
          <Clock size={40} />
          Timetable not published yet. Check back soon.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-sm)', marginBottom: 'var(--sp-lg)' }}>
            {timetable.periods.map((p) => (
              <span key={`${p.period}`} className="badge" style={{ background: 'var(--tint-gold)', color: 'var(--clr-warning)' }}>
                Period {p.period}
              </span>
            ))}
          </div>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Period</th><th>Time</th><th>Subject</th><th>Teacher</th><th>Room</th>
                </tr>
              </thead>
              <tbody>
                {timetable.periods.map((p) => (
                  <tr key={`${p.period}`}>
                    <td><b>{p.period}</b></td>
                    <td>{p.timeStart} – {p.timeEnd}</td>
                    <td>{p.subject}</td>
                    <td>{p.teacher}</td>
                    <td><span className="badge" style={{ background: 'var(--tint-slate)', color: 'var(--clr-accent)' }}>{p.room}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}