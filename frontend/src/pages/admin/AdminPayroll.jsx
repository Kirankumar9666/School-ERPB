import { useEffect, useState } from 'react';
import {
  DollarSign, Pencil, Download, Check, Plus, Trash2, Wallet, AlertTriangle,
  History, ChevronDown,
} from 'lucide-react';
import Modal from '../../components/Modal';
import api from '../../services/api';
import toast from '../../services/toast';
import { downloadTextFile } from '../../utils/download';
import {
  SALARY_EARNINGS,
  SALARY_DEDUCTIONS,
  formatINR,
  PAYROLL_STATUS_BADGE,
  PAYROLL_STATUS_LABEL,
} from '../../constants/payroll';
import LoadErrorState from '../../components/LoadErrorState';
import { useLoadState } from '../../utils/useLoadState';
import { apiErrorMessage } from '../../utils/apiError';

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

/** A payment row, formatted for the slip text and the on-screen list. */
const payDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

/**
 * Salary slip text — same format the employee portal downloads, with the
 * employee identity filled from the staff record the admin is looking at.
 *
 * Carries the payment breakdown, not just a "Paid on" line, because a month paid
 * in instalments has no single meaningful date and printing only the completion
 * date would hide the transfers that actually happened.
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
  '--------------------------------------------------',
  `PAID SO FAR    : ${formatINR(p.paidTotal)}`,
  `REMAINING      : ${p.remaining < 0 ? `-${formatINR(p.overpaidBy)}` : formatINR(p.remaining)}`,
  `STATUS         : ${PAYROLL_STATUS_LABEL[p.status] || p.status}`,
  ...(p.paidOn ? [`SETTLED ON   : ${payDate(p.paidOn)}`] : []),
  ...(p.payments?.length
    ? [
      '--------------------------------------------------',
      'PAYMENTS',
      ...[...p.payments].reverse().map((x, i) => (
        `${String(i + 1).padStart(2, ' ')}. ${payDate(x.paidOn)}  ${formatINR(x.amount).padStart(12)}${x.note ? `  — ${x.note}` : ''}`
      )),
    ]
    : []),
  '==================================================',
  'This is a system-generated payslip (demo).',
].join('\n');

/**
 * Admin Payroll — every employee with their salary breakdown and payment
 * history (from GET /admin/payroll).
 *
 * Three things a month can be in, and all three come from the payment rows
 * rather than a stored flag:
 *
 *   Pending        nothing transferred yet
 *   Partially paid some money in, a balance still outstanding
 *   Paid           the payments have reached the net salary
 *
 * Per month the admin can edit the salary components for THAT month only,
 * record a payment of any amount, delete a payment entered in error, settle the
 * balance in one action, and download the slip. Net payable is recomputed by the
 * API — the client only collects components.
 *
 * A fully-paid month is locked: the API refuses a salary edit with 409, so the
 * buttons are not offered either. A partially-paid month stays editable, which
 * is the ordinary case — pay part of a month, then fix the structure.
 *
 * Each month row carries a "History (N)" disclosure. The payment list is
 * collapsed when the modal opens and is revealed by that button, one month at a
 * time; the month summary (net / paid so far / remaining) stays visible either
 * way, because those are the figures an admin reads at a glance.
 *
 * Modal views: 'history' → per-month table · 'edit' → salary components form ·
 * 'payment' → add-payment form · 'paid' → settle-the-balance form.
 */
export default function AdminPayroll() {
  const [employees, setEmployees] = useState([]);
  const { loading, setLoading, error: loadError, reloadKey, retry, fail } = useLoadState();
  const [q, setQ] = useState('');

  const [selectedId, setSelectedId] = useState(null);
  const [view, setView] = useState('history'); // 'history' | 'edit' | 'payment' | 'paid'
  const [month, setMonth] = useState(currentMonth());
  const [form, setForm] = useState(formFrom());
  const [amount, setAmount] = useState('');
  const [payDateValue, setPayDateValue] = useState(todayISO());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  /**
   * Which month has its payment list expanded, as its `month` key, or null for
   * none. A single key rather than a set, because only one may be open at a
   * time — storing "the one that is open" makes that structural, instead of
   * something every toggle has to remember to undo in its sibling.
   */
  const [openMonth, setOpenMonth] = useState(null);

  const load = () => api.get('/admin/payroll').then((r) => setEmployees(r.data.data || []));

  useEffect(() => {
    load().catch(fail).finally(() => setLoading(false));
  }, [reloadKey, fail, setLoading]);

  /** Live search, same substring semantics as the Employees screen */
  const term = q.trim().toLowerCase();
  const filtered = term
    ? employees.filter((e) => [e.name, e.employeeId, e.department, e.designation, e.role]
      .some((v) => String(v ?? '').toLowerCase().includes(term)))
    : employees;

  // Always derived from the latest list, so a save re-renders the open modal
  const selected = employees.find((e) => e.id === selectedId) || null;
  const record = selected?.payroll.find((p) => p.month === month) || null;

  /**
   * The month the bottom detail block is describing.
   *
   * While a history is open that is unambiguously the open month. With none
   * open it falls back to the currently selected `month`, which is what this
   * block showed before the toggle existed — so the Net / Paid so far /
   * Overpaid summary is still there on open, and the summary and the payment
   * list can never end up describing two different months.
   */
  const detailRecord = (openMonth
    ? selected?.payroll.find((p) => p.month === openMonth)
    : null) || record;
  const detailOpen = Boolean(openMonth) && detailRecord?.month === openMonth;

  /**
   * What the payment form should offer, computed from the live record. A month
   * with no record yet cannot take a payment (there is no net to pay against), so
   * the form says so rather than posting an amount into nothing.
   */
  const remaining = record ? record.remaining : null;
  const settled = record?.status === 'paid';

  const openHistory = (e) => {
    setSelectedId(e.id);
    setView('history');
    setError('');
    // Every payment list starts collapsed, including when the same employee is
    // reopened — a modal that remembered an expanded month from last time would
    // contradict "hidden by default" depending on how you got here.
    setOpenMonth(null);
  };

  /**
   * Expand or collapse one month's payment list.
   *
   * Clicking the open month again closes it, and opening a different month
   * replaces the key rather than adding to it, so exactly one is ever open.
   * Expanding also points the bottom detail block at this month (via `month`),
   * which is what keeps the summary and the list describing the same row.
   */
  const toggleMonthDetail = (p) => {
    if (openMonth === p.month) {
      setOpenMonth(null);
    } else {
      setOpenMonth(p.month);
      setMonth(p.month);
    }
    setError('');
  };

  /**
   * Start editing `p`; for a brand-new month prefill from the latest existing
   * month so the admin edits from current reality, not zeros — or, for an
   * employee with no payroll history yet, from the default salary structure
   * saved on their employee record.
   *
   * Prefilling from a previous month is deliberate and is also why editing a
   * month can never quietly change another one: this writes a single
   * (employee, month) record and never touches the employee's default
   * structure, which only ever prefills months that do not exist yet.
   */
  const openEdit = (e, p) => {
    setMonth(p?.month || e.payroll.at(-1)?.month || currentMonth());
    setForm(formFrom(p || e.payroll.at(-1) || e.defaultSalary));
    setError('');
    setView('edit');
  };

  const openPayment = (p) => {
    setMonth(p.month);
    // Prefill with the balance: the common case is "pay the rest", and a
    // prefilled amount the admin can shrink is faster than an empty box. Left
    // blank for a brand-new month, where there is no balance to suggest.
    setAmount(p.remaining > 0 ? String(p.remaining) : '');
    setPayDateValue(todayISO());
    setNote('');
    setError('');
    setView('payment');
  };

  const openMarkPaid = (p) => {
    setMonth(p.month);
    setPayDateValue(todayISO());
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
      toast.success(`Salary structure saved for ${month}.`);
      await load();
      setView('history');
    } catch (err) {
      setError(apiErrorMessage(err, {}, 'Save failed.'));
    } finally {
      setSaving(false);
    }
  };

  /**
   * Record ONE payment. A new row every time — never an edit of an earlier
   * payment — so a month paid in instalments keeps every transfer and its own
   * date. The amount is not capped at the balance: an overpayment really did
   * happen, and the API records it and reports the excess rather than hiding it.
   */
  const addPayment = async () => {
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      await api.post(`/admin/payroll/${selected.id}/${month}/payments`, {
        amount: Number(amount),
        paidOn: payDateValue,
        note: note.trim() || undefined,
      });
      toast.success('Payment recorded.');
      await load();
      setView('history');
    } catch (err) {
      setError(apiErrorMessage(err, {}, 'Could not record the payment.'));
    } finally {
      setSaving(false);
    }
  };

  const removePayment = async (payment) => {
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      await api.delete(`/admin/payroll/${selected.id}/${month}/payments/${payment.id}`);
      toast.success('Payment removed.');
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not remove the payment.');
    } finally {
      setSaving(false);
    }
  };

  const markPaid = async () => {
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      await api.post(`/admin/payroll/${selected.id}/${month}/mark-paid`, { paidDate: payDateValue });
      toast.success('Payroll marked as paid.');
      await load();
      setView('history');
    } catch (err) {
      setError(apiErrorMessage(err, {}, 'Update failed.'));
    } finally {
      setSaving(false);
    }
  };

  const downloadSlip = (p) => {
    if (!selected) return;
    downloadTextFile(`salary_slip_${p.month}.txt`, buildSlip(selected, p));
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  // A failed request is not "no employees on payroll" — the two are told apart
  // before the empty state below can ever be reached.
  if (loadError) {
    return (
      <LoadErrorState
        title="Payroll"
        subtitle="Employees on payroll"
        detail={loadError}
        onRetry={retry}
        icon={DollarSign}
      />
    );
  }

  /**
   * The month summary strip — net, paid, remaining — and, when `expanded`, that
   * month's payment list.
   *
   * The summary is always shown, for whichever month the detail block is
   * pointed at. The payment LIST is not: it is revealed only by that month's
   * History button, so opening the modal shows figures without a wall of rows
   * the admin did not ask for. `expanded` is derived from the same `openMonth`
   * key the button writes, so the two can never disagree.
   */
  const monthDetail = (p, expanded) => {
    if (!p) return null;
    return (
      <>
        <div className="card" style={{ padding: 'var(--sp-md)', marginBottom: 'var(--sp-md)' }}>
          <div className="payroll-row">
            <span>Net salary</span>
            <span>{formatINR(p.netSalary)}</span>
          </div>
          <div className="payroll-row">
            <span>Paid so far</span>
            <span>{formatINR(p.paidTotal)}</span>
          </div>
          <div className="payroll-row total">
            <span>{p.remaining < 0 ? 'Overpaid by' : 'Remaining'}</span>
            <span className={p.remaining < 0 ? 'payroll-deduction' : ''}>
              {p.remaining < 0 ? `− ${formatINR(p.overpaidBy)}` : formatINR(p.remaining)}
            </span>
          </div>
        </div>

        {p.overpaid && (
          <div className="login-error" style={{ marginBottom: 'var(--sp-md)' }}>
            <AlertTriangle size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />
            More has been paid than this month&apos;s net salary, by {formatINR(p.overpaidBy)}.
            Remove a payment if one of them was recorded in error.
          </div>
        )}

        {expanded && (
          <div id={`payroll-payments-${p.month}`}>
            <div className="section-title" style={{ fontSize: 13 }}>
              <Wallet size={13} /> Payments
              <span className="mk-count">{p.paymentCount} recorded</span>
            </div>
            {p.payments.length === 0 ? (
              <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-sm)' }}>
                No payments recorded against this month yet.
              </div>
            ) : (
              <div className="table-wrapper" style={{ marginTop: 'var(--sp-sm)' }}>
                <table>
                  <thead>
                    <tr><th>Date</th><th>Amount</th><th>Note</th><th /></tr>
                  </thead>
                  <tbody>
                    {p.payments.map((x) => (
                      <tr key={x.id}>
                        <td>{payDate(x.paidOn)}</td>
                        <td>{formatINR(x.amount)}</td>
                        <td>{x.note || '—'}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => removePayment(x)}
                            disabled={saving}
                            aria-label={`Remove payment of ${formatINR(x.amount)} on ${payDate(x.paidOn)}`}
                            title="Remove this payment"
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </>
    );
  };

  /** The action buttons for one month, driven by its live status. */
  const monthActions = (p) => {
    const open = openMonth === p.month;
    const count = p.paymentCount ?? 0;
    return (
      <div className="flex gap-sm" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        {/* Expands this month's payment list. `aria-expanded` carries the open
            state (and flips the pressed styling from CSS), `aria-controls` points
            at the region it reveals, and the chevron rotates 180° when open. A
            real <button> already gives Enter/Space activation and a focus ring. */}
        <button
          className="btn btn-secondary btn-sm btn-toggle"
          onClick={() => toggleMonthDetail(p)}
          aria-expanded={open}
          aria-controls={`payroll-payments-${p.month}`}
          aria-label={`${open ? 'Hide' : 'Show'} payment history for ${p.monthLabel}, ${count} recorded`}
          title={count === 0
            ? `No payments recorded against ${p.monthLabel}`
            : `${open ? 'Hide' : 'Show'} the ${count} payment${count === 1 ? '' : 's'} recorded against ${p.monthLabel}`}
        >
          <History size={14} /> History ({count})
          <ChevronDown className="toggle-caret" size={13} style={{ transform: open ? 'rotate(180deg)' : 'none' }} />
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => downloadSlip(p)} aria-label={`Download slip for ${p.monthLabel}`} title="Download slip">
          <Download size={14} />
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => openPayment(p)} aria-label={`Add payment for ${p.monthLabel}`} title="Add a payment">
          <Plus size={14} /> Payment
        </button>
        {p.status === 'paid' ? (
          // A settled month is locked by the API; offering Edit/Mark Paid here
          // would only produce a 409. The lock is stated rather than hidden.
          <span className="badge badge-active" title="Fully paid — the salary for this month is locked">Locked</span>
        ) : (
          <>
            <button className="btn btn-secondary btn-sm" onClick={() => openEdit(selected, p)} aria-label={`Edit salary for ${p.monthLabel}`} title="Edit this month's salary">
              <Pencil size={14} /> Edit salary
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => openMarkPaid(p)} title="Pay the remaining balance in one go">
              <Check size={14} /> Mark Paid
            </button>
          </>
        )}
      </div>
    );
  };

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
    payment: (
      <>
        <button className="btn btn-secondary" onClick={() => setView('history')} disabled={saving}>Back</button>
        <button
          className="btn btn-primary"
          onClick={addPayment}
          disabled={saving || !Number(amount) || Number(amount) < 1}
        >
          {saving ? 'Saving...' : <><Plus size={15} /> Record Payment</>}
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

  const modalTitle = {
    history: `Payroll — ${selected?.name || ''}`,
    edit: `Edit Salary — ${month}`,
    payment: `Add Payment — ${month}`,
    paid: `Mark Paid — ${month}`,
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
                const count = (s) => e.payroll.filter((p) => p.status === s).length;
                const paid = count('paid');
                const partial = count('partial');
                const pending = count('pending');
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
                            {partial > 0 && <span className="badge badge-pending">{partial} partial</span>}{' '}
                            {pending > 0 && <span className="badge badge-pending">{pending} pending</span>}
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
          title={modalTitle}
          wide={view === 'history' || view === 'payment'}
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
              <>
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>Month</th><th>Net Salary</th><th>Paid</th><th>Status</th><th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.payroll.map((p) => (
                        <tr key={p.month}>
                          <td>
                            <b>{p.monthLabel}</b>
                            {p.paymentCount > 0 && (
                              <div className="text-sm text-muted">
                                {p.paymentCount} payment{p.paymentCount === 1 ? '' : 's'}
                                {p.paidOn ? ` · settled ${payDate(p.paidOn)}` : ''}
                              </div>
                            )}
                          </td>
                          <td>{formatINR(p.netSalary)}</td>
                          <td>
                            {formatINR(p.paidTotal)}
                            {p.remaining > 0 && (
                              <div className="text-sm text-muted">{formatINR(p.remaining)} left</div>
                            )}
                          </td>
                          <td>
                            <span className={`badge ${PAYROLL_STATUS_BADGE[p.status] || 'badge-pending'}`}>
                              {PAYROLL_STATUS_LABEL[p.status] || p.status}
                            </span>
                          </td>
                          <td>{monthActions(p)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {monthDetail(detailRecord, detailOpen)}
              </>
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
              {/* The distinction that matters here, stated where the admin is
                  about to type: this is the month, not the person. */}
              <div className="text-sm text-muted" style={{ marginBottom: 'var(--sp-md)' }}>
                These figures apply to {month} only. They do not change
                {` ${selected.name}'s`} default salary, so no other month is affected.
                {record && record.paidTotal > 0 && (
                  <> {formatINR(record.paidTotal)} has already been paid against this month.</>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-lg)', marginTop: 'var(--sp-md)' }}>
                <div>
                  <div className="section-title" style={{ fontSize: 13 }}>Earnings (₹)</div>
                  {SALARY_EARNINGS.map(({ key, label, required }) => (
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
                  {SALARY_DEDUCTIONS.map(({ key, label }) => (
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

          {view === 'payment' && (
            <>
              {monthDetail(record)}

              <div className="form-group" style={{ marginTop: 'var(--sp-lg)' }}>
                <label className="form-label" htmlFor="payroll-amount">Amount paid (₹) *</label>
                <input
                  id="payroll-amount"
                  className="form-input"
                  type="number"
                  min="1"
                  step="1"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  autoFocus
                />
                {remaining !== null && (
                  <div className="text-sm text-muted" style={{ marginTop: 4 }}>
                    {settled
                      ? <>This month is already fully paid. Adding a payment here would overpay it by {formatINR(Number(amount) || 0)} — remove an existing payment instead if this was a mistake.</>
                      : <>Outstanding: {formatINR(remaining)}. Record another payment as often as you need to; each one is kept with its own date.</>}
                  </div>
                )}
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="payroll-payment-date">Paid on</label>
                <input
                  id="payroll-payment-date"
                  className="form-input"
                  type="date"
                  value={payDateValue}
                  onChange={(e) => setPayDateValue(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="payroll-note">Note (optional)</label>
                <input
                  id="payroll-note"
                  className="form-input"
                  type="text"
                  maxLength={200}
                  placeholder="Advance, salary on hold, UTR…"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            </>
          )}

          {view === 'paid' && (
            <>
              <div style={{ marginBottom: 'var(--sp-md)' }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{selected.name}</div>
                <div className="text-sm text-muted">
                  {record?.monthLabel || month} ·{' '}
                  {record
                    ? `${formatINR(record.paidTotal)} of ${formatINR(record.netSalary)} already paid`
                    : `Net salary ${formatINR(netFrom(form))}`}
                </div>
              </div>

              {record && record.remaining > 0 && (
                <div className="card" style={{ padding: 'var(--sp-md)', marginBottom: 'var(--sp-md)' }}>
                  <div className="payroll-row">
                    <span>Net salary</span>
                    <span>{formatINR(record.netSalary)}</span>
                  </div>
                  <div className="payroll-row">
                    <span>Already paid ({record.paymentCount})</span>
                    <span>− {formatINR(record.paidTotal)}</span>
                  </div>
                  <div className="payroll-row total">
                    <span>This will settle</span>
                    <span>{formatINR(record.remaining)}</span>
                  </div>
                </div>
              )}

              <div className="form-group">
                <label className="form-label" htmlFor="payroll-paid-date">Paid on</label>
                <input
                  id="payroll-paid-date"
                  className="form-input"
                  type="date"
                  value={payDateValue}
                  onChange={(e) => setPayDateValue(e.target.value)}
                />
              </div>
              <div className="text-sm text-muted">
                Records one payment for the outstanding balance, dated here. The salary for a
                fully-paid month is then locked and cannot be edited.
                {record && record.overpaid && (
                  <> This month is already overpaid, so it cannot be settled further &mdash; remove a payment if one was recorded in error.</>
                )}
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
