import { useEffect, useState } from 'react';
import { DollarSign, Pencil, Download, Check } from 'lucide-react';
import Modal from '../../components/Modal';
import api from '../../services/api';
import toast from 'react-hot-toast';
import { downloadTextFile } from '../../utils/download';

const formatINR = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

/**
 * Salary components — grouped exactly like the employee portal renders them
 * (earnings vs deductions); the labels are display strings, the keys are the
 * PayrollRecord columns the API accepts.
 */
const EARNINGS = [
  { key: 'basicPay', label: 'Basic Pay', required: true },
  { key: 'hra', label: 'HRA' },
  { key: 'transportAllowance', label: 'Transport Allowance' },
  { key: 'medicalAllowance', label: 'Medical Allowance' },
];
const DEDUCTIONS = [
  { key: 'providentFund', label: 'Provident Fund (PF)' },
  { key: 'professionalTax', label: 'Professional Tax' },
  { key: 'tds', label: 'TDS' },
];
const STATUS_BADGE = { paid: 'badge-active', pending: 'badge-pending' };

/** Mapped payroll record → flat edit form (defaults from the record, or zeros) */
const formFrom = (p) => ({
  basicPay: p?.basicPay ?? 0,
  hra: p?.allowances?.hra ?? 0,
  transportAllowance: p?.allowances?.transportAllowance ?? 0,
  medicalAllowance: p?.allowances?.medicalAllowance ?? 0,
  providentFund: p?.deductions?.providentFund ?? 0,
  professionalTax: p?.deductions?.professionalTax ?? 0,
  tds: p?.deductions?.tds ?? 0,
});

/** Live net preview in the edit form (the API recomputes it on save anyway) */
const netFrom = (f) =>
  Number(f.basicPay) + Number(f.hra) + Number(f.transportAllowance) + Number(f.medicalAllowance) -
  Number(f.providentFund) - Number(f.professionalTax) - Number(f.tds);

const todayISO = () => new Date().toISOString().slice(0, 10);
const currentMonth = () => new Date().toISOString().slice(0, 7);

/**
 * Salary slip text — same format the employee portal downloads, with the
 * employee identity filled from the staff record the admin is looking at.
 */
const buildSlip = (emp, p) => [
  '==================================================',
  '          SCHOOL ERP — SALARY SLIP',
  '==================================================',
  `Employee ID   : ${emp.employeeId || emp.id}`,
  `Employee      : ${emp.name}`,
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
].join('\n');

/**
 * Admin Payroll — every employee with their salary breakdown and payment
 * history (from GET /admin/payroll). Per month the admin can edit the salary
 * components (pending months only), mark the month paid with a paid date, and
 * download the slip. Net payable is recomputed by the API — the client only
 * collects components.
 *
 * Modal views: 'history' → per-month table · 'edit' → salary components form ·
 * 'paid' → confirm-payment form.
 */
export default function AdminPayroll() {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');

  const [selectedId, setSelectedId] = useState(null);
  const [view, setView] = useState('history'); // 'history' | 'edit' | 'paid'
  const [month, setMonth] = useState(currentMonth());
  const [form, setForm] = useState(formFrom());
  const [paidDate, setPaidDate] = useState(todayISO());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get('/admin/payroll').then((r) => setEmployees(r.data.data || []));

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  /** Live search, same substring semantics as the Employees screen */
  const term = q.trim().toLowerCase();
  const filtered = term
    ? employees.filter((e) => [e.name, e.employeeId, e.department, e.designation, e.role]
      .some((v) => String(v ?? '').toLowerCase().includes(term)))
    : employees;

  // Always derived from the latest list, so a save re-renders the open modal
  const selected = employees.find((e) => e.id === selectedId) || null;
  const editRecord = selected?.payroll.find((p) => p.month === month) || null;

  const openHistory = (e) => {
    setSelectedId(e.id);
    setView('history');
    setError('');
  };

  /** Start editing `record`; for a brand-new month prefill from the latest
      existing month so the admin edits from current reality, not zeros. */
  const openEdit = (e, record) => {
    setMonth(record?.month || e.payroll.at(-1)?.month || currentMonth());
    setForm(formFrom(record || e.payroll.at(-1)));
    setError('');
    setView('edit');
  };

  const openMarkPaid = (record) => {
    setMonth(record.month);
    setPaidDate(todayISO());
    setError('');
    setView('paid');
  };

  const savePayroll = async () => {
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      const payload = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, Number(v) || 0]));
      await api.put(`/admin/payroll/${selected.id}/${month}`, payload);
      toast.success('Salary structure saved.');
      await load();
      setView('history');
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const markPaid = async () => {
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      await api.post(`/admin/payroll/${selected.id}/${month}/mark-paid`, { paidDate });
      toast.success('Payroll marked as paid.');
      await load();
      setView('history');
    } catch (err) {
      setError(err.response?.data?.message || 'Update failed.');
    } finally {
      setSaving(false);
    }
  };

  const downloadSlip = (p) => {
    if (!selected) return;
    downloadTextFile(`salary_slip_${p.month}.txt`, buildSlip(selected, p));
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  const modalFooter = {
    history: <button className="btn btn-secondary" onClick={() => setSelectedId(null)}>Close</button>,
    edit: (
      <>
        <button className="btn btn-secondary" onClick={() => setView('history')} disabled={saving}>Back</button>
        <button className="btn btn-primary" onClick={savePayroll} disabled={saving}>
          {saving ? 'Saving...' : 'Save Salary'}
        </button>
      </>
    ),
    paid: (
      <>
        <button className="btn btn-secondary" onClick={() => setView('history')} disabled={saving}>Back</button>
        <button className="btn btn-primary" onClick={markPaid} disabled={saving}>
          {saving ? 'Saving...' : <><Check size={15} /> Mark as Paid</>}
        </button>
      </>
    ),
  }[view];

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Payroll</div>
        <div className="page-subtitle">
          {term && filtered.length !== employees.length
            ? `${filtered.length} of ${employees.length} employees match “${q.trim()}”`
            : `${employees.length} employees on payroll`}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--sp-lg)' }}>
        <div className="form-group" style={{ flex: 1, maxWidth: 420, marginBottom: 0 }}>
          <label className="form-label" htmlFor="payroll-search">Search employees</label>
          <input
            id="payroll-search"
            className="form-input"
            type="search"
            placeholder="Search name, ID, department, designation…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
          />
        </div>
      </div>

      {employees.length === 0 ? (
        <div className="empty-state">
          <DollarSign size={40} />
          No employees on staff yet. Add employees first.
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <DollarSign size={40} />
          No employees match “{q.trim()}”.
        </div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Employee ID</th><th>Department</th><th>Designation</th><th>Payroll</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => {
                const paid = e.payroll.filter((p) => p.status === 'paid').length;
                const pending = e.payroll.length - paid;
                return (
                  <tr key={e.id}>
                    <td><b>{e.name}</b></td>
                    <td>{e.employeeId}</td>
                    <td>{e.department}</td>
                    <td>{e.designation}</td>
                    <td>
                      {e.payroll.length === 0
                        ? <span className="text-sm text-muted">Not set up</span>
                        : (
                          <span className="text-sm">
                            <span className="badge badge-active">{paid} paid</span>{' '}
                            <span className="badge badge-pending">{pending} pending</span>
                          </span>
                        )}
                    </td>
                    <td>
                      <button className="btn btn-secondary btn-sm" onClick={() => openHistory(e)} aria-label={`Manage payroll for ${e.name}`}>
                        <Pencil size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <Modal
          title={view === 'edit' ? `Edit Salary — ${month}` : view === 'paid' ? `Mark Paid — ${month}` : `Payroll — ${selected.name}`}
          wide={view === 'history'}
          onClose={() => setSelectedId(null)}
          footer={modalFooter}
        >
          {error && <div className="login-error" style={{ marginBottom: 'var(--sp-md)' }}>{error}</div>}

          {view === 'history' && (
            selected.payroll.length === 0 ? (
              <div className="empty-state" style={{ padding: 'var(--sp-xl)' }}>
                <DollarSign size={32} />
                No payroll records yet for this employee.
                <button className="btn btn-primary btn-sm" style={{ marginTop: 'var(--sp-md)' }} onClick={() => openEdit(selected, null)}>
                  Set up salary
                </button>
              </div>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Month</th><th>Net Salary</th><th>Status</th><th>Paid On</th><th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.payroll.map((p) => (
                      <tr key={p.month}>
                        <td><b>{p.monthLabel}</b></td>
                        <td>{formatINR(p.netSalary)}</td>
                        <td><span className={`badge ${STATUS_BADGE[p.status] || 'badge-pending'}`}>{p.status}</span></td>
                        <td>{p.paidOn || '—'}</td>
                        <td>
                          <div className="flex gap-sm" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                            <button className="btn btn-secondary btn-sm" onClick={() => downloadSlip(p)} aria-label={`Download slip for ${p.monthLabel}`}>
                              <Download size={14} />
                            </button>
                            {p.status === 'pending' && (
                              <>
                                <button className="btn btn-secondary btn-sm" onClick={() => openEdit(selected, p)} aria-label={`Edit salary for ${p.monthLabel}`}>
                                  <Pencil size={14} />
                                </button>
                                <button className="btn btn-primary btn-sm" onClick={() => openMarkPaid(p)}>
                                  Mark Paid
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}

          {view === 'edit' && (
            <>
              <div className="form-group">
                <label className="form-label" htmlFor="payroll-month">Pay month</label>
                <input
                  id="payroll-month"
                  className="form-input"
                  type="month"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-lg)', marginTop: 'var(--sp-md)' }}>
                <div>
                  <div className="section-title" style={{ fontSize: 13 }}>Earnings (₹)</div>
                  {EARNINGS.map(({ key, label, required }) => (
                    <div className="form-group" key={key}>
                      <label className="form-label" htmlFor={`payroll-${key}`}>{label}{required ? ' *' : ''}</label>
                      <input
                        id={`payroll-${key}`}
                        className="form-input"
                        type="number"
                        min="0"
                        step="1"
                        value={form[key]}
                        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>
                <div>
                  <div className="section-title" style={{ fontSize: 13 }}>Deductions (₹)</div>
                  {DEDUCTIONS.map(({ key, label }) => (
                    <div className="form-group" key={key}>
                      <label className="form-label" htmlFor={`payroll-${key}`}>{label}</label>
                      <input
                        id={`payroll-${key}`}
                        className="form-input"
                        type="number"
                        min="0"
                        step="1"
                        value={form[key]}
                        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                      />
                    </div>
                  ))}
                  <div className="card" style={{ padding: 'var(--sp-md)', marginTop: 'var(--sp-md)' }}>
                    <div className="payroll-row"><span>Total Earnings</span><span>{formatINR(Number(form.basicPay) + Number(form.hra) + Number(form.transportAllowance) + Number(form.medicalAllowance))}</span></div>
                    <div className="payroll-row"><span>Total Deductions</span><span className="payroll-deduction">− {formatINR(Number(form.providentFund) + Number(form.professionalTax) + Number(form.tds))}</span></div>
                    <div className="payroll-row total"><span>Net Payable</span><span>{formatINR(netFrom(form))}</span></div>
                  </div>
                </div>
              </div>
            </>
          )}

          {view === 'paid' && (
            <>
              <div style={{ marginBottom: 'var(--sp-md)' }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{selected.name}</div>
                <div className="text-sm text-muted">
                  {month} · Net salary {formatINR(editRecord?.netSalary ?? netFrom(form))}
                </div>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="payroll-paid-date">Paid on</label>
                <input
                  id="payroll-paid-date"
                  className="form-input"
                  type="date"
                  value={paidDate}
                  onChange={(e) => setPaidDate(e.target.value)}
                />
              </div>
              <div className="text-sm text-muted">
                Marks {month} as paid with this date. The slip for a paid month can no longer be edited.
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

