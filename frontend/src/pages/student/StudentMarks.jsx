import { useEffect, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';

/** Circular progress indicator (SVG) */
const circular = (percent, color = 'var(--clr-primary)') => {
  const r = 34;
  const c = 2 * Math.PI * r;
  const filled = (c * Math.min(100, Math.max(0, percent))) / 100;
  return (
    <div className="circular-progress">
      <svg width="80" height="80">
        <circle cx="40" cy="40" r={r} stroke="var(--clr-border-2)" strokeWidth="6" fill="none" />
        <circle cx="40" cy="40" r={r} stroke={color} strokeWidth="6" fill="none"
          strokeDasharray={`${filled} ${c}`} strokeLinecap="round" />
      </svg>
      <div className="circular-progress-text">
        <div style={{ fontWeight: 800 }}>{Math.round(percent)}%</div>
      </div>
    </div>
  );
};

/**
 * Marks / Progress Card — list of exams with per-subject marks and overall percentage.
 */
export default function StudentMarks() {
  const { user } = useAuth();
  const [marks, setMarks] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.linkedEntityId) return;
    api.get(`/students/${user.linkedEntityId}/marks`)
      .then((r) => setMarks(r.data.data || []))
      .finally(() => setLoading(false));
  }, [user]);

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Marks / Progress Card</div>
        <div className="page-subtitle">Academic performance across exams</div>
      </div>

      {marks.length === 0 ? (
        <div className="empty-state">
          <ClipboardList size={40} />
          No exam results published yet.
        </div>
      ) : (
        marks.map((exam) => {
          const totalMax = exam.subjects.reduce((s, x) => s + x.maxMarks, 0);
          const totalObtained = exam.subjects.reduce((s, x) => s + x.obtained, 0);
          const percent = totalMax ? (totalObtained / totalMax) * 100 : 0;
          const grade = percent >= 90 ? 'A+' : percent >= 75 ? 'A' : percent >= 60 ? 'B' : percent >= 40 ? 'C' : 'D';
          const color = percent >= 75 ? 'var(--clr-success)' : percent >= 40 ? 'var(--clr-warning)' : 'var(--clr-danger)';

          return (
            <div key={exam.examId} className="card progress-card">
              <div className="progress-card-header">
                <div>
                  <div className="school-badge">🏫 School Progress Card</div>
                  <div style={{ marginTop: 8, fontSize: 16, fontWeight: 700 }}>{exam.examName}</div>
                  <div className="text-sm text-muted">Conducted on {exam.date}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-md)' }}>
                  <div>
                    <div style={{ fontSize: 22, fontWeight: 800, color }}>
                      {totalObtained}/{totalMax}
                    </div>
                    <div className="text-sm text-muted">Total Marks</div>
                    <div className="badge" style={{ background: 'var(--tint-oxblood)', color: 'var(--clr-primary-h)' }}>
                      Grade {grade}
                    </div>
                  </div>
                  {circular(percent, color)}
                </div>
              </div>

              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr><th>Subject</th><th>Max Marks</th><th>Obtained</th><th>Percentage</th></tr>
                  </thead>
                  <tbody>
                    {exam.subjects.map((sub) => {
                      const p = sub.maxMarks ? (sub.obtained / sub.maxMarks) * 100 : 0;
                      return (
                        <tr key={sub.subject}>
                          <td>{sub.subject}</td>
                          <td>{sub.maxMarks}</td>
                          <td>{sub.obtained}</td>
                          <td>
                            <span style={{ color: p >= 75 ? 'var(--clr-success)' : p >= 40 ? 'var(--clr-warning)' : 'var(--clr-danger)' }}>
                              {p.toFixed(1)}%
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}