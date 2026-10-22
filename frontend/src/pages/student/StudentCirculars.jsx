import { useEffect, useState } from 'react';
import { Bell, Download, Megaphone, User } from 'lucide-react';
import api from '../../services/api';
import { downloadBlob, filenameFromDisposition } from '../../utils/download';
import toast from '../../services/toast';
import LoadErrorState from '../../components/LoadErrorState';
import { useLoadState } from '../../utils/useLoadState';

/**
 * Student Announcements — announcement cards, tap to expand full details.
 *
 * The feed is the recipient's own: the server applies the show window AND the
 * audience (broad role send, a targeted send to this student's class, or the
 * all-employees send) before anything is returned, so this page never has to
 * decide who may see what. A circular a teacher pushed shows "From: <name>".
 */
export default function StudentCirculars() {
  const [announcements, setAnnouncements] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const { loading, setLoading, error, reloadKey, retry, fail } = useLoadState();

  useEffect(() => {
    api.get('/school/announcements')
      .then((r) => setAnnouncements(r.data.data || []))
      .catch(fail)
      .finally(() => setLoading(false));
  }, [reloadKey, fail, setLoading]);

  /** Download the circular's PDF — same audience check as reading the body. */
  const downloadAttachment = async (a) => {
    try {
      const res = await api.get(`/school/announcements/${a.id}/pdf`, { responseType: 'blob' });
      const filename = filenameFromDisposition(res.headers?.['content-disposition'])
        || `${a.title.replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '')}.pdf`;
      downloadBlob(new Blob([res.data], { type: 'application/pdf' }), filename);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not download the attachment.');
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  if (error) {
    return (
      <LoadErrorState
        title="Announcements"
        subtitle="School announcements & notices — tap to expand"
        detail={error}
        onRetry={retry}
        icon={Bell}
      />
    );
  }

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
                    {a.fromTeacher && a.authorName && (
                      <div className="text-sm" style={{ marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <User size={12} /> From: {a.authorName}
                      </div>
                    )}
                    {a.hasAttachment && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        style={{ marginTop: 'var(--sp-sm)' }}
                        onClick={(e) => { e.stopPropagation(); downloadAttachment(a); }}
                      >
                        <Download size={14} /> {a.attachmentName || 'Download attachment'}
                      </button>
                    )}
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