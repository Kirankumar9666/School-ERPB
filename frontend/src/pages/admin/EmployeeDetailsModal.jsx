import { useState } from 'react';
import { User, RotateCcw, Trash2, ShieldAlert } from 'lucide-react';
import Modal from '../../components/Modal';
import ConfirmModal from '../../components/ConfirmModal';
import { shortDate, shortStamp } from '../../utils/date';
import {
  dependentRecordLabel,
  employmentReasonLabel,
  employmentStatusBadge,
} from '../../utils/employment';

/**
 * Employee details — the read view for one employee, and the only place the
 * permanent delete lives.
 *
 * Two things justify this being a modal rather than more columns:
 *
 *   1. The EMPLOYMENT TIMELINE. One row per ending, each carrying its own reason,
 *      last working day, description and who processed it — and, if they were
 *      rehired, who reopened it. A rehire does not overwrite the first ending, so
 *      a table column could only ever show the latest event and would silently
 *      misrepresent anyone who left, came back and left again.
 *
 *   2. The DEPENDENT-RECORD CENSUS, which decides whether the permanent delete is
 *      available at all. The old row-level trash button asked "are you sure?" and
 *      then failed with a foreign-key error for anyone who had actually worked
 *      here. Now the button is only offered when the server has counted zero
 *      blocking records, so the destructive path cannot be walked into.
 *
 * Everything on screen comes from `GET /admin/employees/:id` — the counts are
 * queried per employee at open time, so they describe this employee now.
 *
 * @param {object}   props.employee  the mapped employee detail (salaryStructure
 *   may be absent — this view does not use it)
 * @param {function} props.onReactivate async () => void
 * @param {function} props.onDelete     async () => void
 * @param {function} props.onClose
 */
export default function EmployeeDetailsModal({ employee, onReactivate, onDelete, onClose }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const history = employee.employmentHistory || [];
  const records = employee.dependentRecords || [];
  const blockers = records.filter((r) => r.blocking && r.count > 0);
  const preserved = records.filter((r) => !r.blocking && r.count > 0);
  const offStaff = employee.status !== 'active';
  const badge = employmentStatusBadge(employee);

  /* Run an action. `busy` is cleared on BOTH outcomes: on failure the dialog
     stays open so the admin can retry or back out with everything they were
     looking at still in place, and on success the acting button is about to
     disappear (Reactivate vanishes once they are active) — leaving `busy` set
     would strand the Close button disabled on a dialog that is still open. */
  const run = async (fn, fallback) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err.response?.data?.message || fallback);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={employee.name}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Close</button>
          {offStaff && (
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => run(onReactivate, 'Could not reactivate this employee.')}
            >
              <RotateCcw size={15} /> {busy ? 'Working...' : 'Reactivate'}
            </button>
          )}
        </>
      }
    >
      {error && <div className="login-error" style={{ marginBottom: 'var(--sp-md)' }}>{error}</div>}

      {/* Who they are — the identity fields, not the whole profile. */}
      <div className="form-grid-2" style={{ marginBottom: 'var(--sp-md)' }}>
        <div><span className="form-help">Employee ID</span><div>{employee.employeeId || '-'}</div></div>
        <div><span className="form-help">Department</span><div>{employee.department || '-'}</div></div>
        <div><span className="form-help">Designation</span><div>{employee.designation || '-'}</div></div>
        <div><span className="form-help">Mobile</span><div>{employee.mobile || '-'}</div></div>
        <div><span className="form-help">Date of joining</span><div>{shortDate(employee.dateOfJoining)}</div></div>
        <div>
          <span className="form-help">Status</span>
          <div><span className={`badge ${badge.className}`}>{badge.text}</span></div>
        </div>
      </div>

      {offStaff && employee.employment && (
        /* `employment` is by definition the OPEN ending, so a reactivation date can
           never appear here — a closed one lives in the timeline below. */
        <div className="info-note">
          {employee.name} is not on the active staff list and cannot sign in.
          {employee.employment.lastWorkingDay
            ? ` Payroll cutoff: ${shortDate(employee.employment.lastWorkingDay)}.`
            : ''}
        </div>
      )}

      {/* ---- Employment timeline ---- */}
      <div className="section-title"><User size={14} /> Employment History</div>
      {history.length === 0 ? (
        <p className="form-help" style={{ marginTop: 0 }}>
          No endings recorded — {employee.name} has been on the staff list throughout.
        </p>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Reason</th><th>Last working day</th><th>Ended by</th>
                <th>Processed</th><th>Description</th><th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => {
                const reopenedAt = shortStamp(h.reactivatedAt);
                return (
                  <tr key={h.id}>
                    <td><b>{employmentReasonLabel(h.reason)}</b></td>
                    <td>{shortDate(h.lastWorkingDay)}</td>
                    <td>{h.endedBy}</td>
                    <td>{shortStamp(h.endedAt) || '-'}</td>
                    {/* pre-line, because the server normalises a typed note's CRLF to
                        LF and the line breaks are part of what the admin wrote. */}
                    <td style={{ whiteSpace: 'pre-line' }}>{h.description || '-'}</td>
                    <td>
                      {h.open ? (
                        <span className="badge badge-inactive">Current</span>
                      ) : (
                        <span className="form-help">
                          Reactivated{reopenedAt ? ` ${reopenedAt}` : ''}
                          {h.reactivatedBy ? ` by ${h.reactivatedBy}` : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Dependent records ----
          Split because the two kinds behave differently and conflating them would
          mislead: the first group is why a permanent delete is refused, the second
          survives one anyway and is worth saying so plainly. Blocking types are
          listed even at zero, so the refusal below can be seen to be about the
          ones that actually have rows. */}
      <div className="section-title" style={{ marginTop: 'var(--sp-lg)' }}>
        <ShieldAlert size={14} /> Linked Records
      </div>
      <p className="form-help" style={{ marginTop: 0 }}>
        {employee.canDeletePermanently
          ? 'Nothing depends on this employee record.'
          : 'These records belong to this employee and are why the record cannot be deleted outright.'}
      </p>
      <div className="table-wrapper">
        <table>
          <thead>
            <tr><th>Record</th><th>Count</th><th>If deleted outright</th></tr>
          </thead>
          <tbody>
            {records.filter((r) => r.count > 0 || r.blocking).map((r) => (
              <tr key={r.key}>
                <td>{dependentRecordLabel(r.key)}</td>
                <td>{r.count}</td>
                <td>
                  {r.count === 0
                    ? <span className="form-help">-</span>
                    : r.blocking
                      ? <span className="badge badge-danger">Would be destroyed</span>
                      : <span className="badge badge-info">Kept (stored by name)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {preserved.length > 0 && (
        <p className="form-help">
          {preserved.map((r) => dependentRecordLabel(r.key)).join(', ')} are recorded
          against the author's login name rather than a foreign key, so they outlive the
          employee record — but they would then name someone who no longer exists.
        </p>
      )}

      {/* ---- The rare permanent delete ----
          Reachable only from here, and only when the server counted zero blocking
          records. Kept visually quiet and labelled differently from End Employment
          so the two can never be confused for each other. */}
      <div style={{ marginTop: 'var(--sp-lg)', paddingTop: 'var(--sp-md)', borderTop: '1px solid var(--line)' }}>
        {employee.canDeletePermanently ? (
          <>
            <div className="form-help" style={{ marginTop: 0, marginBottom: 'var(--sp-sm)' }}>
              No records depend on this employee, so the record itself can be removed.
              This is only meant for a duplicate or a placeholder for someone who never
              started.
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => setConfirmingDelete(true)}>
              <Trash2 size={14} /> Delete permanently
            </button>
          </>
        ) : (
          <p className="form-help" style={{ margin: 0 }}>
            Permanent delete is unavailable while {blockers.length} linked{' '}
            {blockers.length === 1 ? 'record type exists' : 'record types exist'} above.
            Use End Employment instead — it keeps all of them.
          </p>
        )}
      </div>

      {confirmingDelete && (
        /* Stacked on top of this modal, so the details stay visible but dimmed
           behind the stronger warning — ConfirmModal handles the z-index and the
           key handling for exactly this (it listens in the capture phase on
           document, so this dialog's Tab trap and Esc handling take precedence
           over the Modal underneath). */
        <ConfirmModal
          title="Delete permanently — cannot be undone"
          confirmLabel="Delete permanently"
          cancelLabel="Keep the record"
          tone="danger"
          busy={busy}
          onClose={() => setConfirmingDelete(false)}
          onConfirm={async () => {
            await run(onDelete, 'Could not delete this employee.');
            setConfirmingDelete(false);
          }}
        >
          <p>
            This <b>permanently removes the employee record itself</b>. There is no
            undo, and no End Employment afterwards.
          </p>
          <p>
            It is only offered because every linked-record count above is zero. If
            that is wrong — or if this person was real after all — cancel and keep
            the record.
          </p>
        </ConfirmModal>
      )}
    </Modal>
  );
}
