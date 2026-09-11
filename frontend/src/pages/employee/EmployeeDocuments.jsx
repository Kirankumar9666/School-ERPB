import { useEffect, useState } from 'react';
import { FileText, Download, Info } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import { downloadTextFile } from '../../utils/download';

/**
 * Employee Documents — secure file records (downloads via signed URLs in production).
 */
export default function EmployeeDocuments() {
  const { user } = useAuth();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.linkedEntityId) return;
    api.get(`/employees/${user.linkedEntityId}/documents`)
      .then((r) => setDocs(r.data.data || []))
      .finally(() => setLoading(false));
  }, [user]);

  const downloadDoc = (doc) => {
    const content = [
      'School ERP — Employee Document',
      '==================================================',
      `Type       : ${doc.type}`,
      `File       : ${doc.fileName}`,
      `Uploaded   : ${new Date(doc.uploadedAt).toLocaleString('en-IN')}`,
      '--------------------------------------------------',
      'Demo placeholder — production files are served',
      'as private, time-limited signed URLs (S3/Firebase).',
    ].join('\n');
    downloadTextFile(doc.fileName.replace(/\.pdf$/, '.txt'), content);
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">My Documents</div>
        <div className="page-subtitle">Appointment, ID, salary slips & certificates</div>
      </div>

      {docs.length === 0 ? (
        <div className="empty-state">
          <FileText size={40} />
          No documents uploaded yet.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}>
            {docs.map((doc) => (
              <div key={doc.id} className="doc-item">
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-md)', flex: 1 }}>
                  <div className="doc-icon"><FileText size={20} /></div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{doc.type}</div>
                    <div className="text-sm text-muted">
                      {doc.fileName} · {new Date(doc.uploadedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </div>
                  </div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => downloadDoc(doc)}>
                  <Download size={15} /> Download
                </button>
              </div>
            ))}
          </div>

          <div style={{
            display: 'flex', alignItems: 'center', gap: 'var(--sp-sm)', marginTop: 'var(--sp-xl)',
            background: 'var(--tint-oxblood)', border: '1px solid var(--tint-oxblood)',
            borderRadius: 'var(--r-sm)', padding: '10px var(--sp-md)', fontSize: 13,
            color: 'var(--clr-text-muted)',
          }}>
            <Info size={14} style={{ color: 'var(--clr-primary-h)', flexShrink: 0 }} />
            Files are private. In production they are served as time-limited signed URLs.
          </div>
        </>
      )}
    </div>
  );
}