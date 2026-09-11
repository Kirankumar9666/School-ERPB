import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';

/**
 * Employee Timetable — teaching periods assigned to this teacher.
 */
export default function EmployeeTimetable() {
  const { user } = useAuth();
  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.linkedEntityId) return;
    api.get(`/employees/${user.linkedEntityId}/timetable`)
      .then((r) => setPeriods(r.data.data || []))
      .finally(() => setLoading(false));
  }, [user]);

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">My Timetable</div>
        <div className="page-subtitle">Your teaching schedule</div>
      </div>

      {periods.length === 0 ? (
        <div className="empty-state">
          <Clock size={40} />
          No teaching periods assigned yet.
        </div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr><th>Period</th><th>Time</th><th>Subject</th><th>Class</th><th>Subject Code</th><th>Room</th></tr>
            </thead>
            <tbody>
              {periods.map((p, i) => (
                <tr key={`${p.classKey}-${i}`}>
                  <td><b>{p.period}</b></td>
                  <td>{p.timeStart} – {p.timeEnd}</td>
                  <td>{p.subject}</td>
                  <td>{p.classKey.replace('cls-', '').replace('A', ' A')}</td>
                  <td><span className="badge" style={{ background: 'rgba(34,211,238,0.15)', color: 'var(--clr-accent)' }}>{p.subject.slice(0, 3).toUpperCase()}</span></td>
                  <td>{p.room}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}