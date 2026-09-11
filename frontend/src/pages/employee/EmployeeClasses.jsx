import { useEffect, useState } from 'react';
import { BookMarked, Star, Users, DoorOpen } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';

/**
 * Employee Classes — class-teacher / subject assignments.
 */
export default function EmployeeClasses() {
  const { user } = useAuth();
  const [classes, setClasses] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.linkedEntityId) return;
    api.get(`/employees/${user.linkedEntityId}/assigned-classes`)
      .then((r) => setClasses(r.data.data || []))
      .finally(() => setLoading(false));
  }, [user]);

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Assigned Classes</div>
        <div className="page-subtitle">Classes & subjects under your responsibility</div>
      </div>

      {classes.length === 0 ? (
        <div className="empty-state">
          <BookMarked size={40} />
          No classes assigned yet.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 'var(--sp-lg)' }}>
          {classes.map((c) => (
            <div key={`${c.classId}`} className="card card--glow">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 18, fontWeight: 800 }}>
                  Class {c.class}-{c.section}
                </div>
                {c.isClassTeacher && (
                  <span className="badge" style={{ background: 'rgba(245,158,11,0.15)', color: 'var(--clr-warning)' }}>
                    <Star size={11} style={{ marginRight: 4 }} />Class Teacher
                  </span>
                )}
              </div>
              <div style={{ marginTop: 8, fontSize: 14, color: 'var(--clr-text-muted)' }}>
                Subject: <b>{c.subject}</b>
              </div>
              <div style={{ display: 'flex', gap: 'var(--sp-md)', marginTop: 'var(--sp-md)', alignItems: 'center' }}>
                <span className="badge" style={{ background: 'rgba(59,130,246,0.15)', color: 'var(--clr-info)' }}>
                  <Users size={11} style={{ marginRight: 4 }} />{c.studentCount} students
                </span>
                <span className="badge" style={{ background: 'rgba(34,211,238,0.15)', color: 'var(--clr-accent)' }}>
                  <DoorOpen size={11} style={{ marginRight: 4 }} />Room {c.room}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}