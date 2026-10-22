import { useState } from 'react';
import Modal from '../../components/Modal';
import {
  EMPLOYMENT_DESCRIPTION_MAX,
  employmentReasonLabel,
  normalizeDescription,
} from '../../utils/employment';

/**
 * End Employment — the confirmation dialog for taking someone off the staff list.
 *
 * This is the replacement for the row's old delete button. The distinction it
 * exists to make is the whole point of the feature: ending an employment keeps
 * every record the employee owns (payroll, attendance, marks they entered, leave,
 * documents, timetable periods), so it is offered for ANY active employee and is
 * the normal way someone leaves. Deleting the record outright is not offered here
 * at all — see `EmployeeDetailsModal`, which only exposes it when the employee has
 * no dependent rows, as a rare duplicate-cleanup path.
 *
 * The dialog says what will be kept, before the button is pressed, because the
 * counts are the reason this is safe: an admin choosing between "delete" and
 * "terminate" needs to see that their history survives. They come from the
 * employee's real dependent-record census, never from a constant.
 *
 * Field rules, all enforced again on the server:
 *   - Reason — required, from the `EmploymentEndReason` enum via /school/options,
 *     so the dropdown cannot offer something the API would reject.
 *   - Last working day — required, and deliberately NOT defaulted to today. It is
 *     the payroll cutoff, so it is a fact about the employee that the admin types,
 *     not a consequence of when the office happens to process the paperwork.
 *   - Description — optional free text with the same 500-character normalised
 *     counter the Leave Reason field uses (see utils/employment.js).
 *
 * @param {object}   props.employee      the active employee being ended
 * @param {object[]} props.reasons       EmploymentEndReason values from /school/options
 * @param {Array}    [props.records]     the employee's dependent-record census
 * @param {function} props.onSubmit      async ({reason,lastWorkingDay,description}) => void
 * @param {function} props.onClose
 */
export default function EndEmploymentModal({ employee, reasons, records, onSubmit, onClose }) {
  /* No default reason, unlike the other selects on this screen. The first enum
     value would be "resigned", and a termination filed with the wrong reason is a
     wrong record that payroll, reports and the timeline all inherit — so this one
     has to be a deliberate choice rather than whatever happened to sort first. */
  const [reason, setReason] = useState('');
  const [lastWorkingDay, setLastWorkingDay] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /* Count the NORMALISED length, not the raw textarea value, so the number on
     screen is the number the server measures — see normalizeDescription. Amber as
     the limit approaches, red past it, so the cap is visible before the textarea
     silently stops accepting keystrokes. */
  const descriptionLength = normalizeDescription(description).length;
  const near = descriptionLength >= EMPLOYMENT_DESCRIPTION_MAX * 0.9;
  const over = descriptionLength > EMPLOYMENT_DESCRIPTION_MAX;

  // What this action will preserve — real counts from the census, so the promise
  // in the dialog is the same promise the server keeps.
  const kept = (records || []).filter((r) => r.blocking && r.count > 0);

  const submit = async () => {
    setError('');
    if (!reason) { setError('Choose a reason.'); return; }
    if (!lastWorkingDay) { setError('Enter the last working day.'); return; }
    if (over) { setError(`Description must be at most ${EMPLOYMENT_DESCRIPTION_MAX} characters.`); return; }

    setBusy(true);
    try {
      await onSubmit({ reason, lastWorkingDay, description });
    } catch (err) {
      // Left open on failure so the admin keeps what they typed and can fix one
      // field, rather than retyping a termination note into a fresh dialog.
      setError(err.response?.data?.message || 'Could not end this employment.');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`End Employment — ${employee.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-danger" onClick={submit} disabled={busy}>
            {busy ? 'Ending...' : 'End Employment'}
          </button>
        </>
      }
    >
      {error && <div className="login-error" style={{ marginBottom: 'var(--sp-md)' }}>{error}</div>}

      <p style={{ marginTop: 0 }}>
        This takes <b>{employee.name}</b> off the active staff list and disables their
        portal login. It does <b>not</b> delete anything.
      </p>

      {kept.length > 0 && (
        <div className="info-note">
          These records stay, attributed to them as before:
          <ul>
            {kept.map((r) => <li key={r.key}>{r.label} — {r.count}</li>)}
          </ul>
        </div>
      )}

      <div className="form-group">
        <label className="form-label" htmlFor="end-reason">Reason *</label>
        <select
          id="end-reason"
          className="form-input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
        >
          <option value="" disabled>Select a reason…</option>
          {reasons.map((r) => <option key={r} value={r}>{employmentReasonLabel(r)}</option>)}
        </select>
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="end-last-day">Last Working Day *</label>
        {/* Deliberately no default: this is the employee's own last day, used as
            the payroll cutoff, and it is frequently in the past when the
            paperwork is filed late. Prefilling "today" would quietly move the
            cutoff to whenever the admin happened to open this dialog. */}
        <input
          id="end-last-day"
          className="form-input"
          type="date"
          value={lastWorkingDay}
          onChange={(e) => setLastWorkingDay(e.target.value)}
          disabled={busy}
        />
        <small className="form-help">Used as the payroll cutoff for this employee.</small>
      </div>

      <div className="form-group">
        <div className="label-row">
          <label className="form-label" htmlFor="end-description">Description</label>
          <span className={`field-counter${over ? ' over' : near ? ' near' : ''}`} aria-live="polite">
            {descriptionLength} / {EMPLOYMENT_DESCRIPTION_MAX}
          </span>
        </div>
        <textarea
          id="end-description"
          className="form-input"
          rows={4}
          maxLength={EMPLOYMENT_DESCRIPTION_MAX}
          placeholder={'Optional detail — notice period, reason, reference number.\n\nUse separate lines for separate points.'}
          style={{ whiteSpace: 'pre-wrap' }}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={busy}
        />
      </div>

      <p className="form-help" style={{ marginBottom: 0 }}>
        You can reactivate {employee.name} later — the earlier ending is kept as history.
      </p>
    </Modal>
  );
}
