import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import Modal from './Modal';
import api from '../services/api';

/**
 * Promote ONE student — the popup behind the roster's "Promote" button.
 *
 * ## Why this is a screen and not just a button
 *
 * Until now a single move was two fixed buttons: "Promote to 6A" and "Keep in
 * 5A". Both were computed by the server and neither could be argued with — the
 * admin could not send a child anywhere the level chain did not go. This popup
 * asks the two questions the buttons were answering silently (which year, which
 * class) and shows the answer in a sentence before anything happens.
 *
 * ## Where every value comes from
 *
 * NOTHING here is typed in. The current year and class, the suggested next year
 * and class, the list of years that may be chosen and the list of real classes
 * all arrive from `GET .../students/:id/promotion-options`, which derives them
 * from the `AcademicYear` and `Class` tables. A school with a gap in its calendar,
 * or a level the code has never heard of, needs no change here.
 *
 * ## The year is shown, not chosen
 *
 * The year line is READ-ONLY on purpose. The move is sent with no year at all, so
 * the server applies its own default (the next year in the calendar) — the same
 * default it applied before this popup existed. The line exists so the admin can
 * see where the child is going; it is not a control. That is also why there is no
 * "next year does not exist" case to handle here: the options endpoint reports no
 * suggested year, and the popup refuses to confirm and says so.
 *
 * ## Two actions, one button
 *
 * Choosing the student's own class means "repeat the year", which is a different
 * server action (`keep`) from moving up (`promote`). The popup picks the right one
 * from the choice, so the admin never has to know the two names.
 */
export default function PromoteStudentModal({ student, onClose, onDone }) {
  const [options, setOptions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [selectedClassId, setSelectedClassId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await api.get(
          `/admin/class-management/students/${student.studentId}/promotion-options`,
        );
        if (!alive) return;
        const data = res.data.data;
        setOptions(data);
        // Default to the class the server suggests — for a top class that is the
        // student's own class, which correctly reads as "stay back".
        setSelectedClassId(data.suggestedClass?.id ?? data.currentClass?.id ?? null);
      } catch (err) {
        if (!alive) return;
        setLoadError(err.response?.data?.message || 'Could not load the promotion options');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [student.studentId]);

  /* The classes the admin may choose: the student's own class, plus every class at
     a HIGHER level. Anything below is filtered out because the server refuses it
     on a move — offering it would only produce an error. Order comes from the
     level (`order`), so a named pre-primary level sorts where it belongs. */
  const choices = useMemo(() => {
    if (!options?.currentClass) return [];
    const here = options.currentClass;
    return (options.classes || [])
      .filter((c) => c.id === here.id || c.order > here.order)
      .sort((a, b) => (a.order - b.order) || a.section.localeCompare(b.section));
  }, [options]);

  const currentClass = options?.currentClass ?? null;
  const suggestedYear = options?.suggestedYear ?? null;
  const chosen = choices.find((c) => c.id === selectedClassId) || null;
  const staying = Boolean(chosen && currentClass && chosen.id === currentClass.id);
  const nextYearLabel = suggestedYear?.label ?? null;

  /* One sentence, in the two shapes the office reads out loud. */
  const summary = (() => {
    if (!chosen || !currentClass || !nextYearLabel) return null;
    const from = `${currentClass.label} (${options.currentYear.label})`;
    if (staying) {
      return `${student.name} will stay in ${currentClass.label} for ${nextYearLabel}.`;
    }
    return `${student.name} will move from ${from} to ${chosen.label} (${nextYearLabel}).`;
  })();

  const confirm = async () => {
    if (!chosen || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      /* The year is deliberately NOT sent: the server's own default is what the
         read-only line above displays. Only the class is sent, and only when the
         admin moved the child somewhere else — repeating the year is the `keep`
         action, which takes no class and keeps them where they are. */
      const body = staying
        ? { action: 'keep' }
        : { action: 'promote', toClassId: chosen.id };
      const res = await api.post(
        `/admin/class-management/students/${student.studentId}/move`,
        body,
      );
      onDone?.(res.data.message || `${student.name} has been moved.`);
    } catch (err) {
      setSaveError(err.response?.data?.message || 'Could not move the student');
    } finally {
      setSaving(false);
    }
  };

  const noNextYear = !loading && !loadError && options && !nextYearLabel;
  const confirmDisabled = loading || saving || noNextYear || !chosen || Boolean(loadError);

  return (
    <Modal
      stacked
      title={`Promote ${student.name}`}
      onClose={() => { if (!saving) onClose(); }}
      footer={(
        <>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={confirm}
            disabled={confirmDisabled}
          >
            {saving ? 'Saving…' : 'Confirm'}
          </button>
        </>
      )}
    >
      {loading ? (
        <div className="loading-center"><div className="spinner" /></div>
      ) : loadError ? (
        <div className="att-note locked">
          <TriangleAlert size={14} /> {loadError}
        </div>
      ) : (
        <>
          {/* Who this is. The roll number is this year's; it is cleared by the
              move, which is why it is shown as context rather than a field. */}
          <div className="form-group">
            <div className="text-sm text-muted">
              {student.name}
              {student.rollNumber ? ` · Roll ${student.rollNumber}` : ''}
              {currentClass ? ` · ${currentClass.label}` : ''}
              {options?.currentYear ? ` (${options.currentYear.label})` : ''}
            </div>
          </div>

          {/* The year. Read-only by design — see the note at the top of the file. */}
          <div className="form-group">
            <label className="form-label">Academic year</label>
            <div className="form-input" style={{ opacity: 0.85 }}>
              {nextYearLabel || 'No following academic year on file'}
              <span className="text-sm text-muted">{nextYearLabel ? ' (set automatically)' : ''}</span>
            </div>
          </div>

          {/* The class. The student's own class is labelled as "stay", because
              picking it is not a promotion — it is a repeat. */}
          <div className="form-group">
            <label className="form-label" htmlFor="promote-student-class">Promote to class</label>
            <select
              id="promote-student-class"
              className="form-input"
              value={selectedClassId ?? ''}
              onChange={(e) => setSelectedClassId(e.target.value)}
              disabled={saving}
            >
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id === currentClass?.id ? `${c.label} (stay in the same class)` : c.label}
                </option>
              ))}
            </select>
          </div>

          {summary && (
            <div className="att-note" style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-sm)' }}>
              <ArrowRight size={14} />
              <span>{summary}</span>
            </div>
          )}

          {noNextYear && (
            <div className="att-note locked" style={{ marginTop: 'var(--sp-md)' }}>
              <TriangleAlert size={14} /> The next academic year has not been created yet.
            </div>
          )}

          {saveError && (
            <div className="att-note locked" style={{ marginTop: 'var(--sp-md)' }}>
              <TriangleAlert size={14} /> {saveError}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
