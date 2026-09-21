import { useEffect, useState } from 'react';
import { Umbrella, Send, Info } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import { loadOptions, optionLabel } from '../../services/options';
import toast from 'react-hot-toast';

/** Leave requests are "pending" until an admin decides (LeaveStatus enum) */
const LEAVE_STATUS_BADGE = { pending: 'badge-pending', approved: 'badge-approved', rejected: 'badge-rejected' };

/**
 * Employee Leave — apply + history + balance tracker.
 * The leave-type list is the LeaveType enum served by /school/options, so the
 * form can never offer a type the API would reject.
 */
export default function EmployeeLeave() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [form, setForm] = useState({ type: '', fromDate: '', toDate: '', reason: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const empId = user?.linkedEntityId;

  useEffect(() => {
    if (!empId) return;
    Promise.all([api.get(`/employees/${empId}/leaves`), loadOptions()])
      .then(([r, o]) => {
        setData(r.data.data);
        setLeaveTypes(o.enums.leaveTypes);
        setForm((f) => ({ ...f, type: f.type || o.enums.leaveTypes[0] || '' }));
      })
      .finally(() => setLoading(false));
  }, [empId]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.fromDate || !form.toDate || form.reason.trim().length < 5) {
      setError('Fill in the dates and a reason (at least 5 characters).');
      return;
    }
    if (form.toDate < form.fromDate) {
      setError('End date cannot be before the start date.');
      return;
    }
    setSubmitting(true);
    try {
      await api.post(`/employees/${empId}/leaves/apply`, {
        type: form.type, fromDate: form.fromDate, toDate: form.toDate, reason: form.reason.trim(),
      });
      toast.success('Leave application submitted!');
      setForm((f) => ({ ...f, type: leaveTypes[0] || '', fromDate: '', toDate: '', reason: '' }));
      const r = await api.get(`/employees/${empId}/leaves`);
      setData(r.data.data);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit your leave application.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || !data) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Leave Management</div>
        <div className="page-subtitle">Apply, track and manage your leave</div>
      </div>

      {/* Balance */}
      <div className="section">
        <div className="section-title"><Umbrella size={14} /> Leave Balance</div>
        <div className="leave-balance-grid">
          {Object.entries(data.balance || {}).map(([type, count]) => (
            <div key={type} className="leave-balance-card">
              <div className="leave-balance-count">{count}</div>
              <div className="leave-balance-type">{type.charAt(0).toUpperCase() + type.slice(1)} Leave</div>
            </div>
          ))}
        </div>
      </div>

      {/* Apply form */}
      <div className="section">
        <div className="section-title"><Send size={14} /> Apply for Leave</div>
        <div className="card">
          {error && (
            <div className="login-error" style={{ marginBottom: 'var(--sp-md)' }}>
              <Info size={14} />&nbsp;{error}
            </div>
          )}
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}>
            <div className="form-group">
              <label className="form-label" htmlFor="leave-type">Leave Type</label>
              <select
                id="leave-type"
                className="form-input"
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
              >
                {leaveTypes.map((t) => <option key={t} value={t}>{optionLabel(t)}</option>)}
              </select>
            </div>

            <div className="form-grid-2">
              <div className="form-group">
                <label className="form-label" htmlFor="from-date">From Date</label>
                <input id="from-date" type="date" className="form-input" value={form.fromDate} onChange={(e) => setForm({ ...form, fromDate: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="to-date">To Date</label>
                <input id="to-date" type="date" className="form-input" value={form.toDate} onChange={(e) => setForm({ ...form, toDate: e.target.value })} />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="leave-reason">Reason</label>
              <textarea
                id="leave-reason"
                className="form-input"
                rows={3}
                maxLength={500}
                placeholder="Write a brief reason for your leave..."
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
              />
            </div>

            <button className="btn btn-primary btn-full" disabled={submitting}>
              {submitting ? 'Submitting...' : 'Submit Leave Application'}
            </button>
          </form>
        </div>
      </div>

      {/* History */}
      <div className="section">
        <div className="section-title"><Umbrella size={14} /> Leave History</div>
        {data.history.length === 0 ? (
          <div className="empty-state">
            <Umbrella size={40} />
            No leave applications yet.
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr><th>Type</th><th>From</th><th>To</th><th>Reason</th><th>Status</th><th>Applied On</th></tr>
              </thead>
              <tbody>
                {data.history.map((l) => (
                  <tr key={l.id}>
                    <td style={{ textTransform: 'capitalize' }}>{l.type}</td>
                    <td>{l.fromDate}</td>
                    <td>{l.toDate}</td>
                    <td>{l.reason}</td>
                    <td><span className={`badge ${LEAVE_STATUS_BADGE[l.status] || 'badge-pending'}`}>{l.status}</span></td>
                    <td>{new Date(l.appliedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}