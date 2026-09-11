import { useEffect, useState } from 'react';
import { DollarSign, Download, Info } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import { downloadTextFile } from '../../utils/download';

const formatINR = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

/**
 * Employee Payroll — monthly salary details (read-only) + downloadable slip.
 */
export default function EmployeePayroll() {
  const { user } = useAuth();
  const [payroll, setPayroll] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.linkedEntityId) return;
    api.get(`/employees/${user.linkedEntityId}/payroll`)
      .then((r) => setPayroll(r.data.data || []))
      .finally(() => setLoading(false));
  }, [user]);

  const downloadSlip = (p) => {
    const lines = [
      '==================================================',
      '          STUDENT SCHOOL ERP — SALARY SLIP',
      '==================================================',
      `Employee ID   : ${user.linkedEntityId}`,
      `Employee      : ${user.name}`,
      `Pay Month     : ${p.monthLabel}`,
      '--------------------------------------------------',
      `Basic Pay     : ${formatINR(p.basicPay)}`,
      ...Object.entries(p.allowances).map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').trim()} (Allowance): ${formatINR(v)}`),
      '--------------------------------------------------',
      ...Object.entries(p.deductions).map(([k, v]) => `${k.toUpperCase()} (Deduction)  : ${formatINR(v)}`),
      '--------------------------------------------------',
      `NET SALARY    : ${formatINR(p.netSalary)}`,
      `Paid On       : ${p.paidOn || 'Pending'}`,
      '==================================================',
      'This is a system-generated payslip (demo).',
    ];
    downloadTextFile(`salary_slip_${p.month}.txt`, lines.join('\n'));
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

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
                  {p.paidOn
                    ? `Paid on ${new Date(`${p.paidOn}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`
                    : 'Payment pending'}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-md)' }}>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--clr-success)' }}>{formatINR(p.netSalary)}</div>
                  <div className="text-sm text-muted">Net Salary</div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => downloadSlip(p)} aria-label="Download salary slip">
                  <Download size={16} /> Slip
                </button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-lg)', marginTop: 'var(--sp-lg)' }}>
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
          </div>
        ))
      )}

      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--sp-sm)',
        background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)',
        borderRadius: 'var(--r-sm)', padding: '10px var(--sp-md)', fontSize: 13,
        color: 'var(--clr-text-muted)',
      }}>
        <Info size={14} style={{ color: 'var(--clr-warning)', flexShrink: 0 }} />
        Salary data is read-only. Contact HR / Admin for corrections.
      </div>
    </div>
  );
}