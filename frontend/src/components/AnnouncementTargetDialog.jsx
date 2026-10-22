import { useMemo, useState } from 'react';
import { Building2, Check, Send, Users } from 'lucide-react';
import Modal from './Modal';

/**
 * "Send To…" — the targeted-announcement popup shared by the admin Announcements
 * page and the Employee Portal's push dialog.
 *
 * Three steps, in the order the flow requires:
 *   1. pick a target type — a single class, or all employees;
 *   2. pick WHICH class from the live class list (never a hardcoded list);
 *   3. confirm, with the real recipient count the server returned.
 *
 * The class list is loaded by the caller from the API and passed in, because
 * the two portals legitimately have different lists: an admin gets every class
 * in the school, a teacher only the classes they actually teach. Nothing here
 * is a fallback list, and the server re-checks the target either way.
 *
 * `allowEmployees` is false for teachers — the option is not rendered, and the
 * server's schema rejects the scope too, so the blast radius can't be widened
 * by hand.
 */
export default function AnnouncementTargetDialog(props) {
  // The body is a separate component so its state lives and dies with the
  // popup: reopening always starts from a clean slate, with no reset effect and
  // no way a previous send's target is still selected.
  if (!props.open) return null;
  return <TargetDialogBody {...props} />;
}

function TargetDialogBody({
  title, // the announcement being sent — used in the confirm copy
  classOptions = [],
  classesLoading = false,
  allowEmployees = true,
  onClose,
  onConfirm, // ({ scope, targetClassId }) => Promise<void>
  sending = false,
}) {
  const [step, setStep] = useState('choose'); // choose | class | confirm
  const [scope, setScope] = useState(null);
  const [picked, setPicked] = useState(null);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return classOptions;
    return classOptions.filter((c) => `${c.label} ${c.grade} ${c.section}`.toLowerCase().includes(q));
  }, [classOptions, query]);

  const chooseClass = () => { setScope('CLASS'); setStep('class'); };
  const chooseEmployees = () => { setScope('EMPLOYEES'); setStep('confirm'); };
  const pickClass = (c) => { setPicked(c); setStep('confirm'); };

  const classLabel = picked ? (picked.label || 'the selected class') : 'the selected class';
  const studentCount = picked ? picked.studentCount : null;

  const confirmText =
    scope === 'EMPLOYEES'
      ? `Send this announcement to ALL employees?`
      : `Send to ${studentCount ?? '—'} students in ${classLabel}?`;

  return (
    <Modal
      title="Send To…"
      onClose={onClose}
      stacked
      footer={
        step === 'confirm' ? (
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setStep(scope === 'CLASS' ? 'class' : 'choose')} disabled={sending}>
              Back
            </button>
            <button type="button" className="btn btn-primary" onClick={() => onConfirm({ scope, targetClassId: scope === 'CLASS' ? picked?.id : undefined })} disabled={sending}>
              <Send size={16} /> {sending ? 'Sending…' : 'Send announcement'}
            </button>
          </>
        ) : null
      }
    >
      {step === 'choose' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}>
          <p className="text-sm text-muted" style={{ margin: 0 }}>
            Choose exactly who should receive this announcement. The audience tags on the
            form are not used for a targeted send — the target picked here is the only audience.
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ justifyContent: 'flex-start', padding: 'var(--sp-md)' }}
            onClick={chooseClass}
            disabled={classesLoading || classOptions.length === 0}
          >
            <Building2 size={18} />
            <span style={{ textAlign: 'left' }}>
              <b style={{ display: 'block' }}>Select Class</b>
              <span className="text-sm text-muted">
                {classesLoading
                  ? 'Loading classes…'
                  : classOptions.length === 0
                    ? 'No classes available to you'
                    : `Send to the students of one class (${classOptions.length} available)`}
              </span>
            </span>
          </button>
          {allowEmployees && (
            <button
              type="button"
              className="btn btn-secondary"
              style={{ justifyContent: 'flex-start', padding: 'var(--sp-md)' }}
              onClick={chooseEmployees}
            >
              <Users size={18} />
              <span style={{ textAlign: 'left' }}>
                <b style={{ display: 'block' }}>Employees</b>
                <span className="text-sm text-muted">Send to every employee in the school</span>
              </span>
            </button>
          )}
        </div>
      )}

      {step === 'class' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Search classes</label>
            <input
              className="form-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. 10A"
            />
          </div>
          {classesLoading ? (
            <div className="text-sm text-muted">Loading classes…</div>
          ) : filtered.length === 0 ? (
            <div className="text-sm text-muted">No classes match that search.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-xs)', maxHeight: 280, overflowY: 'auto' }}>
              {filtered.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="btn btn-secondary"
                  style={{ justifyContent: 'space-between' }}
                  onClick={() => pickClass(c)}
                >
                  <span>{c.label || c.id}</span>
                  <span className="text-sm text-muted">
                    {c.studentCount} {c.studentCount === 1 ? 'student' : 'students'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {step === 'confirm' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-md)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-sm)' }}>
            <Check size={18} />
            <b>{title || 'This announcement'}</b>
          </div>
          <p style={{ margin: 0 }}>{confirmText}</p>
          <p className="text-sm text-muted" style={{ margin: 0 }}>
            {scope === 'EMPLOYEES'
              ? 'Every employee will see this on their Announcements page.'
              : `Only the students of ${classLabel} will see this — other classes and staff will not.`}
          </p>
        </div>
      )}
    </Modal>
  );
}
