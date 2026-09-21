import { useEffect, useState } from 'react';
import { BookOpen, Check } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';

/**
 * Derived completion: (done topics / total topics) × 100, rounded — computed
 * from the stored per-topic done flags, never entered or stored as a number.
 */
const percentOf = (topics) =>
  topics.length === 0
    ? 0
    : Math.round((topics.filter((t) => t.done).length / topics.length) * 100);

/**
 * Student Syllabus — per-subject topic chips (green = done, outline = not
 * done) with a live-derived completion percentage.
 */
export default function StudentSyllabus() {
  const { user } = useAuth();
  const [syllabus, setSyllabus] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.linkedEntityId) return;
    api.get(`/students/${user.linkedEntityId}/syllabus`)
      .then((r) => setSyllabus(r.data.data || []))
      .finally(() => setLoading(false));
  }, [user]);

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Syllabus</div>
        <div className="page-subtitle">Chapter-wise curriculum progress</div>
      </div>

      {syllabus.length === 0 ? (
        <div className="empty-state">
          <BookOpen size={40} />
          Syllabus has not been uploaded yet.
        </div>
      ) : (
        syllabus.map((sub) => {
          const pct = percentOf(sub.topics);
          return (
            <div key={sub.subject} className="card" style={{ marginBottom: 'var(--sp-lg)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sp-md)' }}>
                <div style={{ fontSize: 16, fontWeight: 700 }}>{sub.subject}</div>
                <span className={`badge ${pct === 100 ? 'badge-success' : 'badge-info'}`}>
                  {pct === 100 ? 'Finished' : `${pct}% completed`}
                </span>
              </div>

              {/* Progress bar — derived from the topic chips below */}
              <div style={{ height: 6, borderRadius: 'var(--r-full)', background: 'var(--clr-bg-2)', overflow: 'hidden', marginBottom: 'var(--sp-md)' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: 'linear-gradient(90deg, var(--clr-primary), var(--clr-accent))' }} />
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-sm)' }}>
                {sub.topics.map((t) => (
                  <span key={t.topic} className={`topic-chip${t.done ? ' topic-chip--done' : ''}`}>
                    {t.done && <Check size={11} />}
                    {t.topic}
                  </span>
                ))}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}