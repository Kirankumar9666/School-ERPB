import { useEffect, useState } from 'react';
import { FileUp, Plus, Trash, FileText } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';

/**
 * Admin Documents — upload document records to employee files.
 * (Mock: records are metadata only; real file storage is a future swap-in.)
 */
export default function AdminDocuments() {
  const [documents, setDocuments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ employeeId: '', type: '', fileName: '' });
  const [saving, setSaving] = useState(false);

  const load = () =>
    Promise.all([api.get('/admin/documents'), api.get('/admin/employees')]).then(([d, e]) => {
      setDocuments(d.data.data);
      setEmployees(e.data.data);
      setForm((f) => ({ ...f, employeeId: f.employeeId || e.data.data[0]?.id || '' }));
    });

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!form.employeeId || form.type.trim().length < 2 || form.fileName.trim().length < 2) {
      toast.error('Select an employee and enter document type + file name.');
      return;
    }
    setSaving(true);
    try {
      await api.post(`/admin/employees/${form.employeeId}/documents`, {
        type: form.type.trim(),
        fileName: form.fileName.trim(),
      });
      toast.success('Document uploaded!');
      setForm({ employeeId: form.employeeId, type: '', fileName: '' });
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not upload document.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (doc) => {
    try {
      await api.delete(`/admin/documents/${doc.id}`);
      toast.success('Document record removed.');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not remove document.');
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Document Management</div>
        <div className="page-subtitle">{documents.length} documents on file</div>
      </div>

      <div className="section">
        <div className="section-title"><FileUp size={14} /> Upload Document Record</div>
        <div className="card">
          <form onSubmit={handleAdd} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr auto', gap: 'var(--sp-md)', alignItems: 'end' }}>
            <div className="form-group">
              <label className="form-label">Employee *</label>
              <select className="form-input" value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
                <option value="" disabled>Select employee</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>{emp.name}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Document Type *</label>
              <input
                className="form-input"
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
                placeholder="e.g. Contract, ID Proof"
              />
            </div>
            <div className="form-group">
              <label className="form-label">File Name *</label>
              <input
                className="form-input"
                value={form.fileName}
                onChange={(e) => setForm({ ...form, fileName: e.target.value })}
                placeholder="e.g. contract-2026.pdf"
              />
            </div>
            <button className="btn btn-primary" disabled={saving}>
              <Plus size={16} /> {saving ? 'Uploading...' : 'Upload'}
            </button>
          </form>
        </div>
      </div>

      <div className="section">
        <div className="section-title"><FileText size={14} /> All Documents</div>
        {documents.length === 0 ? (
          <div className="empty-state"><FileText size={40} />No documents on file.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}>
            {documents.map((d) => (
              <div key={d.id} className="doc-item">
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-md)' }}>
                  <div className="doc-icon"><FileText size={20} /></div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{d.fileName}</div>
                    <div className="text-sm text-muted">
                      {d.employeeName} • {d.type} • uploaded {new Date(d.uploadedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </div>
                  </div>
                </div>
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(d)} aria-label="Delete document">
                  <Trash size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
