import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Banknote, Eye, Search, Settings2, Wallet } from 'lucide-react';
import api from '../../services/api';
import toast from '../../services/toast';
import Modal from '../../components/Modal';
import FeeLedgerTable from '../../components/FeeLedgerTable';
import { openYearOption } from '../../utils/feeFormat';
import StudentProfileModal from '../../components/StudentProfileModal';
import LoadErrorState from '../../components/LoadErrorState';
import { useSubmitGuard } from '../../utils/useSubmitGuard';

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);
const todayISO = () => new Date().toISOString().slice(0, 10);

/** The three questions the office actually asks of this page. */
const FILTERS = [
  { id: 'dues', label: 'Has dues' },
  { id: 'not_set', label: 'Fee not set' },
  { id: '', label: 'All students' },
];

/**
 * Fee Dues — what every student owes, across every year.
 *
 * ## Two figures, not one
 *
 * The page reads `GET /fees/dues`, which returns each student's CURRENT-year
 * fee and every EARLIER year still carrying a balance. A carried-forward amount
 * is a real debt — that is exactly what a promotion leaves behind — so the
 * "Amount due" column is previous + current, and the breakdown is one click
 * away. Reading the old `Student.feeDues` column instead would have silently
 * dropped everything a student owed from before this year.
 *
 * ## Setting and taking money
 *
 * Both are separate, explicit actions on a row: set (or clear) this year's fee,
 * and record a payment. Payments are applied OLDEST-FIRST by the server, so a
 * family settling an old year before a new one just works. Access is LIMITED to
 * admin and accountant by the endpoint itself — this page merely offers the
 * controls.
 */
export default function AdminFeeDues() {
  const [rows, setRows] = useState([]);
  const [totals, setTotals] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('dues');
  const [q, setQ] = useState('');

  const [viewing, setViewing] = useState(null);
  const [feeTarget, setFeeTarget] = useState(null); // student whose fee is being set
  const [payTarget, setPayTarget] = useState(null); // student receiving a payment
  // The expanded row's ledger — fetched on demand, so the list itself stays light.
  const [detail, setDetail] = useState(null); // { studentId, ledger }
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filter) params.set('filter', filter);
      const res = await api.get(`/fees/dues?${params.toString()}`);
      setRows(res.data.data.students || []);
      setTotals(res.data.data.totals || null);
      setError('');
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not reach the server.');
    }
  }, [filter]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  // The server filter narrows to a set; the free-text search is applied to the
  // rows already in hand, so typing never fires a request per keystroke.
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => [r.name, r.rollNumber, r.classLabel, r.parentName, r.guardianContact]
      .some((v) => String(v ?? '').toLowerCase().includes(needle)));
  }, [rows, q]);

  const retry = () => { setLoading(true); load().finally(() => setLoading(false)); };

  const refresh = async () => {
    await load();
    // An open row detail is showing the student's ledger; keep it current too.
    if (detail) {
      try {
        const res = await api.get(`/fees/students/${detail.studentId}`);
        setDetail({ studentId: detail.studentId, ledger: res.data.data });
      } catch { /* the row detail keeps its last good read */ }
    }
  };

  /** Open (or close) a row's year-and-class breakdown, read live on first open. */
  const toggleDetail = (studentId) => {
    if (detail && detail.studentId === studentId) {
      setDetail(null);
      return;
    }
    setDetail({ studentId, ledger: null });
    setDetailLoading(true);
    api.get(`/fees/students/${studentId}`)
      .then((res) => {
        setDetail({ studentId, ledger: res.data.data });
        setDetailLoading(false);
      })
      .catch(() => {
        setDetail({ studentId, ledger: null });
        setDetailLoading(false);
      });
  };

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  if (error) {
    return (
      <LoadErrorState
        title="Fee Dues"
        detail={error}
        onRetry={retry}
        icon={Banknote}
      />
    );
  }

  return (
    <div className="page fade-in">
      <div className="page-header">
        <div className="page-title">Fee Dues</div>
        <div className="page-subtitle">
          {totals?.notSetCount ? `${totals.notSetCount} student${totals.notSetCount === 1 ? '' : 's'} without a fee set · ` : ''}
          {money(totals?.totalDue || 0)} outstanding
        </div>
      </div>

      <div className="stat-grid" style={{ marginBottom: 'var(--sp-xl)' }}>
        <div className="stat-card">
          <div className="stat-icon stat-icon-warning"><Wallet size={22} /></div>
          <div>
            <div className="stat-value">{money(totals?.currentDues || 0)}</div>
            <div className="stat-label">Current year unpaid</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-danger"><Banknote size={22} /></div>
          <div>
            <div className="stat-value">{money(totals?.previousDues || 0)}</div>
            <div className="stat-label">Previous dues</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-primary"><Banknote size={22} /></div>
          <div>
            <div className="stat-value">{money(totals?.totalDue || 0)}</div>
            <div className="stat-label">Total outstanding</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon stat-icon-info"><Settings2 size={22} /></div>
          <div>
            <div className="stat-value">{totals?.notSetCount ?? 0}</div>
            <div className="stat-label">Fee not set</div>
          </div>
        </div>
      </div>

      <div className="section">
        <div
          className="section-title"
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-md)', flexWrap: 'wrap' }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Banknote size={14} /> Fees &amp; payments
          </span>
        </div>

        <div className="mk-actions" style={{ marginBottom: 'var(--sp-md)', alignItems: 'center' }}>
          {FILTERS.map((f) => (
            <button
              key={f.id || 'all'}
              type="button"
              className={`btn btn-sm ${filter === f.id ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
          <div style={{ marginLeft: 'auto', position: 'relative' }}>
            <Search
              size={14}
              style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', opacity: 0.6 }}
            />
            <input
              className="form-input"
              style={{ paddingLeft: 30, minWidth: 220 }}
              placeholder="Search name, roll, guardian"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search students"
            />
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="empty-state">
            <Banknote size={40} />
            {filter === 'not_set'
              ? 'Every student in this view has a fee set.'
              : filter === 'dues'
                ? 'No student has pending fees.'
                : 'No students match.'}
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Class</th>
                  <th>Roll No</th>
                  <th>Parent / Guardian</th>
                  <th>Current year</th>
                  <th>Previous dues</th>
                  <th>Amount due</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const cur = r.current;
                  const hasPrev = r.previous?.length > 0;
                  const isExpanded = detail?.studentId === r.studentId;
                  return (
                    <Fragment key={r.studentId}>
                      <tr>
                        <td>
                          <b>{r.name}</b>
                          {r.guardianContact && (
                            <div className="text-sm text-muted">{r.guardianContact}</div>
                          )}
                        </td>
                        <td>{r.classLabel || '—'}</td>
                        <td>{r.rollNumber || '—'}</td>
                        <td>{dash(r.parentName)}</td>
                        <td>
                          {cur?.isSet ? (
                            <>
                              {money(cur.total)}
                              <div className="text-sm text-muted">
                                paid {money(cur.paid)} · bal {money(cur.balance)}
                              </div>
                            </>
                          ) : (
                            <span className="badge badge-muted">Not set</span>
                          )}
                        </td>
                        <td>
                          {hasPrev ? (
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => toggleDetail(r.studentId)}
                              aria-expanded={isExpanded}
                              title="Show the years this is carried from"
                            >
                              {money(r.previousDues)}
                            </button>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          {r.totalDue > 0
                            ? <span className="badge badge-danger">{money(r.totalDue)}</span>
                            : <span className="badge badge-success">Clear</span>}
                        </td>
                        <td>
                          <div className="flex gap-sm" style={{ alignItems: 'center' }}>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => setFeeTarget(r)}
                              title="Set or clear this year's fee"
                              aria-label={`Set fee for ${r.name}`}
                            >
                              <Settings2 size={14} />
                            </button>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              onClick={() => setPayTarget(r)}
                              disabled={r.totalDue <= 0}
                              title={r.totalDue <= 0 ? 'Nothing outstanding to pay' : 'Record a payment'}
                              aria-label={`Record a payment for ${r.name}`}
                            >
                              <Banknote size={14} />
                            </button>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => setViewing({ id: r.studentId, name: r.name })}
                              aria-label={`View profile of ${r.name}`}
                              title="View full profile"
                            >
                              <Eye size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr key={`${r.studentId}-prev`}>
                          <td colSpan={8} style={{ background: 'var(--tint-slate)' }}>
                            {detail.ledger ? (
                              <FeeLedgerTable
                                rows={detail.ledger.rows}
                                currentAcademicYearId={detail.ledger.currentAcademicYearId}
                                showPayments
                                title="What is owed year by year, and what each year has already taken"
                              />
                            ) : detailLoading ? (
                              <div className="loading-center"><div className="spinner" /></div>
                            ) : (
                              <div className="text-sm text-muted">Could not read the fee ledger.</div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {viewing && (
        <StudentProfileModal student={viewing} onClose={() => setViewing(null)} />
      )}

      {feeTarget && (
        <FeeAmountModal
          row={feeTarget}
          onClose={() => setFeeTarget(null)}
          onSaved={async () => { setFeeTarget(null); await refresh(); }}
        />
      )}

      {payTarget && (
        <PaymentModal
          row={payTarget}
          onClose={() => setPayTarget(null)}
          onSaved={async () => { setPayTarget(null); await refresh(); }}
        />
      )}
    </div>
  );
}

/* ── Set / clear this year's fee ─────────────────────────────────────────── */
function FeeAmountModal({ row, onClose, onSaved }) {
  const [amount, setAmount] = useState(row.current?.isSet ? String(row.current.total) : '');
  const [saving, setSaving] = useState(false);
  const [guard, cooling] = useSubmitGuard(600);

  const submit = async (value) => {
    setSaving(true);
    try {
      const res = await api.put(`/fees/students/${row.studentId}/amount`, { amount: value });
      toast.success(res.data.message);
      await onSaved();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not set the fee');
    } finally {
      setSaving(false);
    }
  };

  const saveNumber = () => {
    const trimmed = String(amount).trim();
    if (trimmed === '' || Number(trimmed) < 0 || Number.isNaN(Number(trimmed))) {
      toast.error('Enter a non-negative amount, or use “Clear”.');
      return;
    }
    submit(Number(trimmed));
  };

  return (
    <Modal
      title={`Set fee — ${row.name}`}
      onClose={() => { if (!saving) onClose(); }}
      footer={(
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={guard(() => submit(null))}
            disabled={saving || cooling}
            title="Clear this year's amount back to “not set”"
          >
            Clear (not set)
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={guard(saveNumber)}
            disabled={saving || cooling}
          >
            {saving ? 'Saving…' : 'Save fee'}
          </button>
        </>
      )}
    >
      <p className="text-sm text-muted" style={{ marginTop: 0 }}>
        This sets the <strong>current year&apos;s</strong> fee for {row.name}. Previous
        years are their own records and are never overwritten from here. Leaving the
        amount blank and using “Clear” makes the fee “not set” again.
      </p>
      <div className="form-group">
        <label className="form-label" htmlFor="fee-amount">Amount (₹)</label>
        <input
          id="fee-amount"
          className="form-input"
          type="number"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="e.g. 45000"
          autoFocus
        />
      </div>
      {row.previousDues > 0 && (
        <div className="info-note">
          {row.name} also owes {money(row.previousDues)} from earlier years. That balance
          is not changed by this amount.
        </div>
      )}
    </Modal>
  );
}

/* ── Record a payment ──────────────────────────────────────────────────────
   Everything the admin needs to see is here: what is owed, year by year with the
   class the child was in then; the total that must match the Fee Dues list; and a
   live preview of where the money will go, which comes from the same
   `allocatePayment` call that writes the payment. */
function PaymentModal({ row, onClose, onSaved }) {
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(todayISO());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [guard, cooling] = useSubmitGuard(600);

  // The ledger, read once when the modal opens. Every figure below comes from it.
  const [ledger, setLedger] = useState(null);
  const [ledgerError, setLedgerError] = useState('');

  // Live preview state, and the year to target when a year is picked by hand.
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [targetFeeId, setTargetFeeId] = useState(null);

  const rows = ledger?.rows || [];
  const outstanding = Number(ledger?.outstanding ?? row.totalDue ?? 0);
  // Only years that can actually take money are offered as a manual target.
  const openYears = rows.filter((r) => r.balance != null && r.balance > 0);

  useEffect(() => {
    let alive = true;
    api.get(`/fees/students/${row.studentId}`)
      .then((res) => {
        if (!alive) return;
        setLedger(res.data.data || null);
        setLedgerError('');
      })
      .catch((err) => {
        if (!alive) return;
        setLedgerError(err.response?.data?.message || 'Could not read this student’s fee ledger.');
      });
    return () => { alive = false; };
  }, [row.studentId]);

  /**
   * Ask the server where this amount would go. Debounced so typing does not fire a
   * request per keystroke, and skipped for anything that is not a usable amount —
   * only a real number is worth a round trip. An empty or partial amount just
   * clears the preview rather than reporting a problem.
   */
  useEffect(() => {
    const raw = String(amount).trim();
    const value = Number(raw);
    if (raw === '' || !Number.isFinite(value) || value <= 0) {
      setPreview(null);
      setPreviewError('');
      return undefined;
    }
    let alive = true;
    const timer = setTimeout(() => {
      api.post(`/fees/students/${row.studentId}/allocate`, {
        amount: value,
        ...(targetFeeId ? { feeId: targetFeeId } : {}),
      })
        .then((res) => {
          if (!alive) return;
          setPreview(res.data.data);
          setPreviewError('');
        })
        .catch((err) => {
          if (!alive) return;
          setPreview(null);
          setPreviewError(err.response?.data?.message || 'Could not work out this payment.');
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [amount, targetFeeId, row.studentId]);

  const submit = async () => {
    const value = Number(amount);
    if (!amount || Number.isNaN(value) || value <= 0) {
      setPreviewError('Enter a payment amount greater than zero.');
      return;
    }
    setSaving(true);
    try {
      const res = await api.post(`/fees/students/${row.studentId}/payments`, {
        amount: value, paidOn, note: note.trim() || undefined,
        ...(targetFeeId ? { feeId: targetFeeId } : {}),
      });
      // The message already names the year and class, because the server built it
      // from the allocation it actually wrote.
      toast.success(res.data.message);
      await onSaved();
    } catch (err) {
      setPreviewError(err.response?.data?.message || 'Could not record the payment');
    } finally {
      setSaving(false);
    }
  };

  const retarget = (feeId) => {
    setTargetFeeId(feeId || null);
    setPreview(null);
    setPreviewError('');
  };

  return (
    <Modal
      title={`Record payment — ${row.name}`}
      onClose={() => { if (!saving) onClose(); }}
      footer={(
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={guard(submit)} disabled={saving || cooling}>
            {saving ? 'Recording…' : 'Record payment'}
          </button>
        </>
      )}
    >
      {/* ── What is owed, year by year ────────────────────────────────────── */}
      {ledgerError && (
        <div className="info-note" style={{ marginBottom: 'var(--sp-md)' }}>{ledgerError}</div>
      )}
      {ledger && (
        <>
          <FeeLedgerTable
            rows={rows}
            currentAcademicYearId={ledger.currentAcademicYearId}
            showPayments={false}
            title={`Everything ${row.name} currently owes, oldest first`}
          />
          <div className="mk-actions" style={{ marginTop: 'var(--sp-sm)', marginBottom: 0 }}>
            <span className="text-sm text-muted">Total outstanding</span>
            <b>{money(outstanding)}</b>
            <span className="text-sm text-muted">
              — the same figure as the Amount Due in the Fee Dues list
            </span>
          </div>
        </>
      )}

      {/* ── Where the money goes ───────────────────────────────────────────── */}
      <div className="form-grid-2">
        <div className="form-group">
          <label className="form-label" htmlFor="pay-amount">Amount (₹)</label>
          <input
            id="pay-amount"
            className="form-input"
            type="number"
            min="1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="e.g. 5000"
            autoFocus
          />
          {previewError && <div className="field-error">{previewError}</div>}
          {/* The preview sentence is built by the same function that writes the
              payment, so what is read here is what will be saved. */}
          {!previewError && preview?.message && (
            <div className="field-ok" style={{ marginTop: 4 }}>{preview.message}</div>
          )}
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="pay-date">Paid on</label>
          <input
            id="pay-date"
            className="form-input"
            type="date"
            value={paidOn}
            onChange={(e) => setPaidOn(e.target.value)}
          />
        </div>
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="pay-note">Note (optional)</label>
        <input
          id="pay-note"
          className="form-input"
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. cash receipt"
        />
      </div>

      {/* ── Naming one year instead of oldest-first ─────────────────────────
          Only offered when there is a real choice to make. Picking a year is
          recorded as a manual choice, so the history can show that the oldest
          of two years was deliberately left alone. */}
      {openYears.length > 1 && (
        <div className="form-group" style={{ marginTop: 'var(--sp-sm)', marginBottom: 0 }}>
          <label className="form-label" htmlFor="pay-target">
            {targetFeeId ? 'Year this payment is for' : 'Payment applies to'}
          </label>
          {targetFeeId ? (
            <>
              <select
                id="pay-target"
                className="form-input"
                value={targetFeeId}
                onChange={(e) => retarget(e.target.value)}
                disabled={saving}
              >
                {openYears.map((y) => (
                  <option key={y.id} value={y.id}>
                    {openYearOption(y)}
                  </option>
                ))}
              </select>
              <div className="field-ok" style={{ marginTop: 4 }}>
                Other years are left untouched, and the history records that this year was
                picked by hand.{' '}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => retarget(null)}
                  disabled={saving}
                >
                  Use oldest-first instead
                </button>
              </div>
            </>
          ) : (
            <div className="mk-actions" style={{ margin: 0 }}>
              <span className="text-sm text-muted">The oldest outstanding year first</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => retarget(openYears[0].id)}
                disabled={saving}
              >
                Apply to a specific year instead
              </button>
            </div>
          )}
        </div>
      )}

      <div className="info-note" style={{ marginBottom: 0 }}>
        By default a payment settles the <strong>oldest outstanding year first</strong>.
        It cannot exceed the total outstanding — there is no credit balance in the fee
        ledger, and a year whose fee has not been set cannot be paid until it is.
      </div>
    </Modal>
  );
}

