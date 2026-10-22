import { money, fmtDate, feeRowLabel, dash } from '../utils/feeFormat';

/**
 * FeeLedgerTable — the one rendering of a student's fee ledger, used by the
 * Record-payment modal, the Fee Dues row detail, the Student Profile fee section,
 * Class History's year view and the student's own portal.
 *
 * ## Why one component and not five copies
 *
 * "Which year did this money pay" is the question every one of those screens has
 * to answer, and they must all answer it the same way. The ROWS come from the
 * server's single `feeLedgerFor` read, and every payment already carries the year
 * and class it settled — because that is a fact about the fee row it hangs off,
 * not about the day it was paid. A payment made today toward last year's dues
 * therefore appears under last year, which is exactly what Class History needs.
 *
 * Money is never shown for a year whose amount has not been set: "Not set" is a
 * badge, not ₹0, because those are two different facts and only one of them was
 * recorded.
 *
 * @param {object} props
 * @param {Array} props.rows every fee year, oldest first, from the fee ledger
 * @param {string} [props.currentAcademicYearId] marks which row is the current one
 * @param {boolean} [props.showPayments] list each year's payments (default true)
 * @param {string} [props.title] optional heading above the table
 */
export default function FeeLedgerTable({
  rows = [],
  currentAcademicYearId = null,
  showPayments = true,
  title = null,
}) {
  if (!rows.length) {
    return (
      <div className="text-sm text-muted" style={{ marginTop: 'var(--sp-sm)' }}>
        No fee has been recorded for this student yet.
      </div>
    );
  }

  return (
    <div>
      {title && <div className="text-sm text-muted" style={{ marginBottom: 6 }}>{title}</div>}
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Academic year</th>
              <th>Class</th>
              <th>Fee</th>
              <th>Paid</th>
              <th>Balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const key = row.id || `missing-${row.academicYearId}`;
              const isCurrent = row.isCurrent || row.academicYearId === currentAcademicYearId;
              return (
                <tr key={key}>
                  <td>
                    {row.academicYearLabel}
                    {isCurrent && <span className="badge badge-primary" style={{ marginLeft: 6 }}>Current</span>}
                  </td>
                  <td>{dash(row.classLabel)}</td>
                  <td>
                    {row.isSet
                      ? money(row.total)
                      : <span className="badge badge-muted">Not set</span>}
                  </td>
                  <td>{row.paid ? money(row.paid) : '—'}</td>
                  <td>
                    {row.balance != null && row.balance > 0
                      ? <span className="badge badge-danger">{money(row.balance)}</span>
                      : row.isSet ? <span className="badge badge-success">Clear</span> : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showPayments && (
        <div style={{ marginTop: 'var(--sp-sm)' }}>
          {rows.map((row) => {
            const payments = row.payments || [];
            if (!payments.length) return null;
            const key = row.id || `pay-${row.academicYearId}`;
            return (
              <div key={key} style={{ marginBottom: 'var(--sp-sm)' }}>
                <div className="text-sm text-muted" style={{ marginBottom: 4 }}>
                  Payments for {feeRowLabel(row)}
                </div>
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Amount</th>
                        <th>Class &amp; year paid</th>
                        <th>Note</th>
                        <th>Recorded by</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map((p) => (
                        <tr key={p.id || `${p.paidOn}-${p.amount}`}>
                          <td>{fmtDate(p.paidOn)}</td>
                          <td>{money(p.amount)}</td>
                          <td>
                            {p.classLabel ? `${p.classLabel} · ${p.academicYearLabel}` : p.academicYearLabel}
                            {p.chosenYear && (
                              <span className="badge badge-muted" style={{ marginLeft: 6 }} title="This year was chosen by hand, not by the oldest-first rule">
                                year chosen
                              </span>
                            )}
                          </td>
                          <td>{p.note || '—'}</td>
                          <td>{p.recordedBy || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
