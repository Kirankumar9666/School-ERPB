import { useEffect, useState } from 'react';
import { Umbrella, Check, X } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';

/**
 * Admin Leaves — approve or reject pending leave applications.
 */
export default function AdminLeaves() {
  const [leaves, setLeaves] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () => api.get('/admin/leaves/pending').then((r) => setLeaves(r.data.data));

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  const decide = async (leave, status) => {
    try {
      await api.put(`/admin/leaves/${leave.id}/status`, { status });
      toast.success(`Leave ${status}.`);
      setLeaves((prev) => prev.filter((l) => l.id !== leave.id));
    } catch (err) {
      toast.error(err.response?.data?.message || 'Update failed.');
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Leave Approval</div>
        <div className="page-subtitle">{leaves.length} pending applications</div>
      </div>

      {leaves.length === 0 ? (
        <div className="empty-state">
          <Umbrella size={40} />
          No pending leave applications. 🎉
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}>
          {leaves.map((l) => (
            <div key={l.id} className="doc-item">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-md)', flex: 1 }}>
                <div className="doc-icon" style={{ background: 'rgba(245,158,11,0.15)', color: 'var(--clr-warning)' }}>
                  <Umbrella size={20} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{l.employeeName}</div>
                  <div className="text-sm text-muted">
                    {l.type.charAt(0).toUpperCase() + l.type.slice(1)} Leave · {l.fromDate} → {l.toDate}
                  </div>
                  <div className="text-sm" style={{ color: 'var(--clr-text-muted)', marginTop: 2 }}>“{l.reason}”</div>
                </div>
                <div style={{ display: 'flex', gap: 'var(--sp-sm)' }}>
                  <button className="btn btn-primary btn-sm" onClick={() => decide(l, 'approved')}>
                    <Check size={15} /> Approve
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => decide(l, 'rejected')}>
                    <X size={15} /> Reject
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}