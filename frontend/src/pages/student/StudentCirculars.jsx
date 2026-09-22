import { useEffect, useState } from 'react';
import { Bell, Megaphone } from 'lucide-react';
import api from '../../services/api';

/**
 * Student Announcements — announcement cards, tap to expand full details.
 */
export default function StudentCirculars() {
  const [announcements, setAnnouncements] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/school/announcements')
      .then((r) => setAnnouncements(r.data.data || []))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Announcements</div>
        <div className="page-subtitle">School announcements & notices — tap to expand</div>
      </div>

      {announcements.length === 0 ? (
        <div className="empty-state">
          <Bell size={40} />
          No announcements for your role right now.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}>
          {announcements.map((a) => {
            const isOpen = expanded === a.id;
            return (
              <div
                key={a.id}
                className={`announcement-card${isOpen ? ' expanded' : ''}`}
                onClick={() => setExpanded(isOpen ? null : a.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && setExpanded(isOpen ? null : a.id)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-md)' }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: 'var(--r-md)', flexShrink: 0,
                    background: 'var(--tint-oxblood)', color: 'var(--clr-primary-h)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Megaphone size={20} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>{a.title}</div>
                    <div className="text-sm text-muted">
                      {a.category} · {new Date(a.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </div>
                  </div>
                </div>
                {isOpen && (
                  <div className="slide-up" style={{ marginTop: 'var(--sp-md)', color: 'var(--clr-text-muted)', fontSize: 14, lineHeight: 1.7 }}>
                    {a.body}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}