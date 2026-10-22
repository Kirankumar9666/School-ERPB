import { useEffect, useState } from 'react';
import { DollarSign, Download, Info, Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import LoadErrorState from '../../components/LoadErrorState';
import { useLoadState } from '../../utils/useLoadState';
import toast from '../../services/toast';
import { downloadBlob, filenameFromDisposition, payslipFilename } from '../../utils/download';

const formatINR = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

const payDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

/**
 * Employee Payroll — monthly salary details (read-only) + downloadable slip.
 * The Slip button fetches a server-generated PDF payslip (composed from the
 * employee's profile + that month's payroll record) and saves it under the
 * filename the backend chose.
 *
 * A month is paid in instalments, so the payment state is shown as the same
 * three states the Admin Panel and the PDF use — pending / partially paid /
 * paid — with the running total and the balance. Those figures are derived
 * server-side by the same service the office's screen uses, so what an employee
 * reads here cannot contradict what the admin recorded.
 */
export default function EmployeePayroll() {
  const { user } = useAuth();
  const [payroll, setPayroll] = useState([]);
  const { loading, setLoading, error, reloadKey, retry, fail } = useLoadState();
  const [downloading, setDownloading] = useState(null); // month currently generating

  useEffect(() => {
    if (!user?.linkedEntityId) return;
    api.get(`/employees/${user.linkedEntityId}/payroll`)
      .then((r) => setPayroll(r.data.data || []))
      .catch(fail)
      .finally(() => setLoading(false));
  }, [user, reloadKey, fail, setLoading]);

  const downloadSlip = async (p) => {
    setDownloading(p.month);
    try {
      const res = await api.get(
        `/employees/${user.linkedEntityId}/payroll/${p.month}/slip`,
        { responseType: 'blob' },
      );
      const filename = filenameFromDisposition(res.headers?.['content-disposition'])
        || payslipFilename(user.name, p.month);
      downloadBlob(new Blob([res.data], { type: 'application/pdf' }), filename);
      toast.success('Salary slip downloaded.');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not download the slip.');
    } finally {
      setDownloading(null);
    }
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  if (error) {
    return (
      <LoadErrorState
        title="Payroll"
        subtitle="Monthly salary details — read only"
        detail={error}
        onRetry={retry}
        icon={DollarSign}
      />
    );
  }

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Payroll</div>
        <div className="page-subtitle">Monthly salary details — read only</div>
      </div>

      {payroll.length === 0 ? (
        <div className="empty-state">
          <DollarSign size={40} />
          No salary records yet.
        </div>
      ) : (
        payroll.map((p) => (
          <div key={p.month} className="card" style={{ marginBottom: 'var(--sp-xl)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 17, fontWeight: 700 }}>{p.monthLabel}</div>
                <div className="text-sm text-muted">
                  {p.status === 'paid'
                    ? `Paid in full on ${payDate(p.paidOn)}`
                    : p.status === 'partial'
                      ? `${formatINR(p.paidTotal)} paid · ${formatINR(p.remaining)} outstanding`
                      : 'Payment pending'}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-md)' }}>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--clr-success)' }}>{formatINR(p.netSalary)}</div>
                  <div className="text-sm text-muted">Net Salary</div>
                </div>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => downloadSlip(p)}
                  disabled={downloading === p.month}
                  aria-label="Download salary slip"
                >
                  {downloading === p.month ? <Loader2 size={16} className="spin" /> : <Download size={16} />} Slip
                </button>
              </div>
            </div>

            <div className="form-grid-2" style={{ gap: 'var(--sp-lg)', marginTop: 'var(--sp-lg)' }}>
              <div>
                <div className="section-title" style={{ fontSize: 13 }}>Earnings</div>
                <div className="card" style={{ padding: 'var(--sp-md)' }}>
                  <div className="payroll-row"><span>Basic Pay</span><span>{formatINR(p.basicPay)}</span></div>
                  {Object.entries(p.allowances).map(([k, v]) => (
                    <div key={k} className="payroll-row">
                      <span>{k.replace(/([A-Z])/g, ' $1').trim()}</span>
                      <span>{formatINR(v)}</span>
                    </div>
                  ))}
                  <div className="payroll-row total">
                    <span>Total Earnings</span>
                    <span>{formatINR(p.basicPay + Object.values(p.allowances).reduce((a, b) => a + b, 0))}</span>
                  </div>
                </div>
              </div>
              <div>
                <div className="section-title" style={{ fontSize: 13 }}>Deductions</div>
                <div className="card" style={{ padding: 'var(--sp-md)' }}>
                  {Object.entries(p.deductions).map(([k, v]) => (
                    <div key={k} className="payroll-row">
                      <span>{k.replace(/([A-Z])/g, ' $1').trim()}</span>
                      <span className="payroll-deduction">− {formatINR(v)}</span>
                    </div>
                  ))}
                  <div className="payroll-row total">
                    <span>Net Payable</span>
                    <span>{formatINR(p.netSalary)}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* The payment history for the month. Present even when nothing has
                been paid, so the shape of the section does not change month to
                month as the office records instalments. */}
            <div style={{ marginTop: 'var(--sp-lg)' }}>
              <div className="section-title" style={{ fontSize: 13 }}>Payments</div>
              <div className="card" style={{ padding: 'var(--sp-md)' }}>
                <div className="payroll-row">
                  <span>Paid so far</span>
                  <span>{formatINR(p.paidTotal)}</span>
                </div>
                {p.remaining < 0 ? (
                  <div className="payroll-row total">
                    <span>Overpaid by</span>
                    <span className="payroll-deduction">− {formatINR(p.overpaidBy)}</span>
                  </div>
                ) : (
                  <div className="payroll-row total">
                    <span>Balance remaining</span>
                    <span>{formatINR(p.remaining)}</span>
                  </div>
                )}
              </div>

              {p.payments.length > 0 && (
                <div className="table-wrapper" style={{ marginTop: 'var(--sp-sm)' }}>
                  <table>
                    <thead>
                      <tr><th>Date</th><th>Amount</th><th>Note</th></tr>
                    </thead>
                    <tbody>
                      {p.payments.map((x) => (
                        <tr key={x.id}>
                          <td>{payDate(x.paidOn)}</td>
                          <td>{formatINR(x.amount)}</td>
                          <td>{x.note || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        ))
      )}

      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--sp-sm)',
        background: 'var(--tint-gold)', border: '1px solid var(--tint-gold)',
        borderRadius: 'var(--r-sm)', padding: '10px var(--sp-md)', fontSize: 13,
        color: 'var(--clr-text-muted)',
      }}>
        <Info size={14} style={{ color: 'var(--clr-warning)', flexShrink: 0 }} />
        Salary data is read-only. Contact HR / Admin for corrections.
      </div>
    </div>
  );
}