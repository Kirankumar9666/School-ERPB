import { useEffect, useState } from 'react';
import { Umbrella, Send, Info } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import LoadErrorState from '../../components/LoadErrorState';
import { useLoadState } from '../../utils/useLoadState';
import { loadOptions, optionLabel } from '../../services/options';
import toast from '../../services/toast';
import LeaveReasonCell from '../../components/LeaveReason';
import { LEAVE_REASON_MAX, LEAVE_STATUS_BADGE, normalizeReason } from '../../utils/leave';
import { shortDate } from '../../utils/date';

/**
 * Employee Leave — apply + history + balance tracker.
 *
 * The leave-type list is the LeaveType enum served by /school/options, so the
 * form can never offer a type the API would reject.
 *
 * The reason is multi-line free text and is treated as such end to end: the
 * textarea submits line breaks, the server normalises them without flattening
 * them (`normalizeReason` in `utils/leave.js` mirrors the server exactly), and
 * the history's Reason column is the shared `LeaveReasonCell`, which renders those
 * breaks under `white-space: pre-line` and clamps to 2 lines.
 */
export default function EmployeeLeave() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [form, setForm] = useState({ type: '', fromDate: '', toDate: '', reason: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // `error` above is this form's own validation/submit message, so the load
  // failure from the hook is aliased — the page-level error state and the
  // inline form error must be able to coexist.
  const { loading, setLoading, error: loadError, reloadKey, retry, fail } = useLoadState();
  const empId = user?.linkedEntityId;

  useEffect(() => {
    if (!empId) return;
    Promise.all([api.get(`/employees/${empId}/leaves`), loadOptions()])
      .then(([r, o]) => {
        setData(r.data.data);
        setLeaveTypes(o.enums.leaveTypes);
        setForm((f) => ({ ...f, type: f.type || o.enums.leaveTypes[0] || '' }));
      })
      .catch(fail)
      .finally(() => setLoading(false));
  }, [empId, reloadKey, fail, setLoading]);

  /**
   * The length the SERVER will measure: the same normalisation the apply route
   * applies before validating. Counting the raw textarea value instead would
   * count a CRLF as 2 characters where the server stores 1, so the counter would
   * drift away from the 500 limit on exactly the multi-line reasons this field
   * exists for. The textarea's own `maxLength` still guards the raw input, which
   * is the stricter of the two and can only ever keep the user inside the limit.
   */
  const reasonLength = normalizeReason(form.reason).length;
  const reasonTooLong = reasonLength > LEAVE_REASON_MAX;
  const reasonNearLimit = !reasonTooLong && reasonLength > LEAVE_REASON_MAX * 0.9;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    // Normalised here too, so what is counted, what is validated and what is
    // sent are all the same string.
    const reason = normalizeReason(form.reason);
    if (!form.fromDate || !form.toDate || reason.length < 5) {
      setError('Fill in the dates and a reason (at least 5 characters).');
      return;
    }
    if (form.toDate < form.fromDate) {
      setError('End date cannot be before the start date.');
      return;
    }
    setSubmitting(true);
    try {
      // Sent exactly as typed (newlines and blank lines intact) — NOT reflowed
      // into one line. The server trims the ends and stores the rest verbatim.
      await api.post(`/employees/${empId}/leaves/apply`, {
        type: form.type, fromDate: form.fromDate, toDate: form.toDate, reason,
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

  // Before the `loading || !data` guard, not after: on a failed load `data`
  // stays null forever, so a guard of `loading || !data` would spin forever.
  if (loadError) {
    return (
      <LoadErrorState
        title="Leave Management"
        subtitle="Apply, track and manage your leave"
        detail={loadError}
        onRetry={retry}
        icon={Umbrella}
      />
    );
  }

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
              <div className="label-row">
                <label className="form-label" htmlFor="leave-reason">Reason</label>
                {/* Live counter on the NORMALISED length, so it always agrees with
                    the server's 500-character limit. Amber as the limit is
                    approached, red past it, so the cap is visible before the
                    textarea silently stops accepting keystrokes. */}
                <span
                  className={`field-counter${reasonTooLong ? ' over' : reasonNearLimit ? ' near' : ''}`}
                  aria-live="polite"
                >
                  {reasonLength} / {LEAVE_REASON_MAX}
                </span>
              </div>
              <textarea
                id="leave-reason"
                className="form-input"
                rows={4}
                maxLength={LEAVE_REASON_MAX}
                placeholder={'Write a brief reason for your leave...\n\nUse separate lines for separate points.'}
                /* The input side needs pre-wrap too, or a newline typed here would
                   be invisible until the text was submitted and read back. */
                style={{ whiteSpace: 'pre-wrap' }}
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

      {/* History — the Reason cell is the shared clamped one. `pre-line` keeps the
          line breaks the employee typed, the 2-line clamp keeps every row a
          consistent height, and "View more" appears only when the text is
          genuinely cut off. */}
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
                    <td className="reason-cell"><LeaveReasonCell leave={l} /></td>
                    <td><span className={`badge ${LEAVE_STATUS_BADGE[l.status] || 'badge-pending'}`}>{l.status}</span></td>
                    <td>{shortDate(l.appliedAt)}</td>
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
