import { useEffect, useState } from 'react';
import { Trophy, GraduationCap, Medal } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';

/** Icon + color per achievement type */
const TYPE_META = {
  academic:   { icon: <GraduationCap size={22} />, color: 'var(--clr-primary-h)' },
  sports:     { icon: <Medal size={22} />,         color: 'var(--clr-success)' },
  cultural:   { icon: <Trophy size={22} />,        color: 'var(--clr-warning)' },
  other:      { icon: <Trophy size={22} />,        color: 'var(--clr-accent)' },
};

/**
 * Achievements — awards, certificates and accomplishments entered by admin.
 */
export default function StudentAchievements() {
  const { user } = useAuth();
  const [achievements, setAchievements] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.linkedEntityId) return;
    api.get(`/students/${user.linkedEntityId}/achievements`)
      .then((r) => setAchievements(r.data.data || []))
      .finally(() => setLoading(false));
  }, [user]);

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Achievements</div>
        <div className="page-subtitle">Awards, certificates & accomplishments</div>
      </div>

      {achievements.length === 0 ? (
        <div className="empty-state">
          <Trophy size={40} />
          No achievements recorded yet. Keep shining! ✨
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}>
          {achievements.map((a) => {
            const meta = TYPE_META[a.type] || TYPE_META.other;
            return (
              <div key={a.id} className="achievement-item">
                <div className="achievement-icon" style={{ color: meta.color }}>{meta.icon}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{a.title}</div>
                  <div style={{ color: 'var(--clr-text-muted)', fontSize: 13, marginTop: 4 }}>{a.description}</div>
                  <div className="text-sm text-muted" style={{ marginTop: 6 }}>
                    {new Date(`${a.date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
                  </div>
                </div>
                <span className="badge" style={{ background: 'rgba(99,102,241,0.15)', color: 'var(--clr-primary-h)', textTransform: 'capitalize' }}>
                  {a.type}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}