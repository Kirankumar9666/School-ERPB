import { useEffect, useState } from 'react';
import { BookOpen, Check } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';

/**
 * Student Syllabus — per-subject topics with completion progress.
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
          const pct = Math.min(100, Math.max(0, sub.completedPercent || 0));
          return (
            <div key={sub.subject} className="card" style={{ marginBottom: 'var(--sp-lg)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sp-md)' }}>
                <div style={{ fontSize: 16, fontWeight: 700 }}>{sub.subject}</div>
                <span className="badge" style={{ background: 'rgba(34,211,238,0.15)', color: 'var(--clr-accent)' }}>
                  {pct}% completed
                </span>
              </div>

              {/* Progress bar */}
              <div style={{ height: 6, borderRadius: 'var(--r-full)', background: 'var(--clr-bg-2)', overflow: 'hidden', marginBottom: 'var(--sp-md)' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: 'linear-gradient(90deg, var(--clr-primary), var(--clr-accent))' }} />
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-sm)' }}>
                {sub.topics.map((t) => (
                  <span key={t} className="badge" style={{ background: 'rgba(16,185,129,0.12)', color: 'var(--clr-success)' }}>
                    <Check size={11} style={{ marginRight: 4 }} />{t}
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