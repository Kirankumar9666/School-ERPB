/**
 * CreateClassModal — a class on an existing level, plus "add a level" inline.
 *
 * ## Why the level is a dropdown of records, not a typed grade
 *
 * A school's level list is data (GradeLevel rows), so a named level — Nursery,
 * LKG, UKG — is offered exactly like a numbered one, and a school that runs
 * Playgroup or goes to Class 12 needs no code change here. The order number is
 * deliberately never shown: it is internal, and "after 3" would mean nothing to
 * an office that thinks in "Class 4".
 *
 * The section is typed because a section is a naming decision (A, B, C), not a
 * lookup — but it is letters only and always upper-cased, because the class id is
 * built from it and a lowercase 'b' would create a second class.
 */
import { useMemo, useState } from 'react';
import { Plus, TriangleAlert } from 'lucide-react';
import Modal from './Modal';
import api from '../services/api';
import toast from '../services/toast';

const LABEL = (levelName, section) =>
  (/^\d+$/.test(String(levelName)) ? `Class ${levelName}${section}` : `${levelName} ${section}`);

export default function CreateClassModal({ levels, onClose, onCreated, onLevelAdded }) {
  /* Levels are ALL offered, including any above the school's final class. A school
     legitimately plans Class 11 in April while Class 10 is still the final year
     until term ends, so hiding the level would make that impossible. Instead,
     choosing a level above the final class shows a warning and asks for an explicit
     confirmation, which is sent as `allowAboveFinal`.

     With no final class set, `finalLevel` is null and nothing is above anything —
     no warning, no flag, exactly today's behaviour. */
  const ordered = useMemo(() => [...levels].sort((a, b) => a.order - b.order), [levels]);
  const finalLevel = useMemo(() => ordered.find((l) => l.isFinal) || null, [ordered]);

  const [levelId, setLevelId] = useState(ordered[0]?.id || '');
  const [section, setSection] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [addingLevel, setAddingLevel] = useState(false);
  const [allowAboveFinal, setAllowAboveFinal] = useState(false);

  /* Derived as it is typed, so the confirm button can say the real name.

     `safeLevelId` is the selection with a stale id repaired: if the level list
     changes underneath the open modal (an "add level" that renumbers it), the
     id that was selected may no longer exist, and rendering a select whose value
     matches nothing would show the first option while holding a dead one. */
  const safeLevelId = ordered.some((l) => l.id === levelId) ? levelId : (ordered[0]?.id || '');
  const chosenLevel = useMemo(() => ordered.find((l) => l.id === safeLevelId) || null, [ordered, safeLevelId]);
  const upper = section.trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  const preview = chosenLevel && upper ? LABEL(chosenLevel.name, upper) : '';
  // Strictly above the final year. The final class itself is not "above" it.
  const isAboveFinal = Boolean(finalLevel && chosenLevel && chosenLevel.order > finalLevel.order);

  const submit = async () => {
    setError('');
    if (!safeLevelId) { setError('Choose a level.'); return; }
    if (!upper) { setError('Enter a section (letters only, e.g. A).'); return; }
    if (isAboveFinal && !allowAboveFinal) { setError('Tick the box to confirm this class is above the final year.'); return; }
    setSaving(true);
    try {
      const res = await api.post('/admin/classes', {
        levelId: safeLevelId,
        section: upper,
        allowAboveFinal: isAboveFinal ? allowAboveFinal : undefined,
      });
      toast.success(res.data.message);
      await onCreated(res.data.data);
      onClose();
    } catch (err) {
      // A 409 duplicate is the one answer the office can act on directly, so it
      // goes inline beside the field rather than into a toast they may miss.
      const code = err.response?.data?.code;
      if (code === 'DUPLICATE') {
        setError(err.response?.data?.message || `${preview} already exists.`);
      } else {
        setError(err.response?.data?.message || 'Could not create the class.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Create Class"
      onClose={() => { if (!saving) onClose(); }}
      footer={(
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={saving || (isAboveFinal && !allowAboveFinal)}
          >
            {saving ? 'Creating…' : `Create${preview ? ` ${preview}` : ''}`}
          </button>
        </>
      )}
    >
      <div className="form-group">
        <label className="form-label" htmlFor="cc-level">Level</label>
        <select
          id="cc-level"
          className="form-input"
          value={safeLevelId}
          onChange={(e) => { setLevelId(e.target.value); setAllowAboveFinal(false); }}
          disabled={saving}
          aria-label="Level"
        >
          {ordered.map((l) => (
            // The level NAME only. The order is internal and never shown here.
            // A level above the final class is marked, not removed.
            <option key={l.id} value={l.id}>
              {l.name}
              {l.classCount > 0 ? ` (${l.classCount} class${l.classCount === 1 ? '' : 'es'})` : ''}
              {finalLevel && l.order > finalLevel.order ? ' — above the final class' : ''}
            </option>
          ))}
        </select>
      </div>

      {isAboveFinal && (
        <div className="att-note locked" style={{ marginTop: 'var(--sp-sm)' }}>
          <TriangleAlert size={14} />
          <div>
            <strong>{chosenLevel.name}</strong> is above your final class{' '}
            <strong>{finalLevel.name}</strong> — students in {finalLevel.name} graduate
            instead of moving up. Only tick this if you are opening the level ahead of
            time; nothing else is changed.
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
              <input
                type="checkbox"
                checked={allowAboveFinal}
                onChange={(e) => setAllowAboveFinal(e.target.checked)}
                disabled={saving}
              />
              Yes, create it above the final year
            </label>
          </div>
        </div>
      )}

      <div className="form-group">
        <label className="form-label" htmlFor="cc-section">Section</label>
        <input
          id="cc-section"
          className="form-input"
          value={section}
          onChange={(e) => setSection(e.target.value)}
          placeholder="e.g. A"
          maxLength={3}
          autoFocus
          disabled={saving}
          aria-label="Section"
        />
        <div className="text-sm text-muted" style={{ marginTop: 4 }}>
          Letters only, up to three. It is stored upper-cased, so “b” becomes “B”.
        </div>
      </div>

      {error && <div className="field-error" style={{ marginTop: 4 }}>{error}</div>}

      {preview && !error && (
        <div className="info-note" style={{ marginTop: 'var(--sp-md)' }}>
          This will create <strong>{preview}</strong>. It appears in every class list
          straight away, with 0 students, no fee dues and no marks.
        </div>
      )}

      <div style={{ marginTop: 'var(--sp-md)' }}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setAddingLevel(true)}
          disabled={saving}
        >
          <Plus size={14} /> Add a class level
        </button>
      </div>

      {addingLevel && (
        <AddLevelModal
          levels={levels}
          onClose={() => setAddingLevel(false)}
          onSaved={async (level) => {
            setAddingLevel(false);
            await onLevelAdded(level);
          }}
        />
      )}
    </Modal>
  );
}

/**
 * AddLevelModal — a new level, placed after an existing one.
 *
 * The position is chosen from the levels that exist, because "after UKG" is the
 * only way an office thinks about where a level sits. `afterId` is what the route
 * takes; the route renumbers everything below it in one transaction.
 *
 * The final-class question is asked EXPLICITLY and defaults to No, never guessed
 * from the position: adding a level is usually not the final class, but a small
 * school's next level may genuinely be (a school whose last year is Class 10 and
 * who adds Class 11 usually means 11 to be final, while one inserting Playgroup
 * below certainly does not). Guessing either way would be wrong often enough to
 * matter, so the office answers it.
 *
 * ## Above the final class
 *
 * Adding a level that lands ABOVE the final class (positioned after it) is
 * allowed — a school plans Class 11 before Class 10 graduates — but it is a
 * deliberate act: a visible warning appears and the `allowAboveFinal` checkbox
 * must be ticked, which is what the API is sent. The level is offered, not
 * hidden; nothing is deleted, and clearing the final class removes the warning.
 */
function AddLevelModal({ levels, onClose, onSaved }) {
  const sorted = useMemo(() => [...levels].sort((a, b) => a.order - b.order), [levels]);
  const finalLevel = useMemo(() => sorted.find((l) => l.isFinal) || null, [sorted]);
  const [name, setName] = useState('');
  const [afterId, setAfterId] = useState(sorted.length ? sorted[sorted.length - 1].id : '');
  const [isFinal, setIsFinal] = useState(false); // No pre-selected
  const [allowAboveFinal, setAllowAboveFinal] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const afterName = sorted.find((l) => l.id === afterId);
  /* The new level takes the order immediately AFTER the chosen one, so it is above
     the final class when the anchor is at or beyond the final level. */
  const isAboveFinal = Boolean(finalLevel && afterName && afterName.order >= finalLevel.order);

  const submit = async () => {
    setError('');
    const trimmed = name.trim().replace(/\s+/g, ' ');
    if (!trimmed) { setError('Name the level.'); return; }
    if (isAboveFinal && !allowAboveFinal) {
      setError('Tick the box to confirm this level sits above the final class.');
      return;
    }
    setSaving(true);
    try {
      const res = await api.post('/admin/class-levels', {
        name: trimmed,
        afterId: afterId || null,
        isFinal,
        allowAboveFinal: isAboveFinal ? allowAboveFinal : undefined,
      });
      toast.success(res.data.message);
      await onSaved(res.data.data);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not add the level.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Add Level"
      onClose={() => { if (!saving) onClose(); }}
      footer={(
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={saving || (isAboveFinal && !allowAboveFinal)}
          >
            {saving ? 'Adding…' : 'Add Level'}
          </button>
        </>
      )}
    >
      <div className="form-group">
        <label className="form-label" htmlFor="al-name">Level name</label>
        <input
          id="al-name"
          className="form-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Playgroup"
          maxLength={20}
          autoFocus
          disabled={saving}
          aria-label="Level name"
        />
        <div className="text-sm text-muted" style={{ marginTop: 4 }}>
          Shown everywhere a class is named, e.g. “Playgroup A”.
        </div>
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="al-after">Position</label>
        <select
          id="al-after"
          className="form-input"
          value={afterId}
          onChange={(e) => { setAfterId(e.target.value); setAllowAboveFinal(false); }}
          disabled={saving}
          aria-label="Position"
        >
          {sorted.map((l) => (
            <option key={l.id} value={l.id}>After {l.name}</option>
          ))}
        </select>
        <div className="text-sm text-muted" style={{ marginTop: 4 }}>
          Levels below it move down one place to make room. Classes follow their
          level automatically.
        </div>
      </div>

      {afterName && name.trim() && (
        <div className="info-note">
          <strong>{name.trim()}</strong> will sit between{' '}
          <strong>{afterName.name}</strong> and the next level after it.
        </div>
      )}

      {isAboveFinal && (
        <div className="att-note locked" style={{ marginTop: 'var(--sp-sm)' }}>
          <TriangleAlert size={14} />
          <div>
            This level will sit above your final class <strong>{finalLevel.name}</strong> —
            students in {finalLevel.name} graduate instead of moving up. Only tick this if
            you are opening the level ahead of time; the final class is unchanged.
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
              <input
                type="checkbox"
                checked={allowAboveFinal}
                onChange={(e) => setAllowAboveFinal(e.target.checked)}
                disabled={saving}
              />
              Yes, add it above the final year
            </label>
          </div>
        </div>
      )}

      <fieldset className="form-group" style={{ border: 'none', padding: 0, margin: 0 }}>
        <legend className="form-label">Is this the school&apos;s final class?</legend>
        <div className="weekly-off-days">
          <button
            type="button"
            className={`weekly-off-day${isFinal ? ' active' : ''}`}
            aria-pressed={isFinal}
            onClick={() => setIsFinal(true)}
            disabled={saving}
          >
            Yes — students in it graduate
          </button>
          <button
            type="button"
            className={`weekly-off-day${!isFinal ? ' active' : ''}`}
            aria-pressed={!isFinal}
            onClick={() => setIsFinal(false)}
            disabled={saving}
          >
            No
          </button>
        </div>
        <div className="text-sm text-muted" style={{ marginTop: 4 }}>
          {isFinal
            ? 'This becomes the final class — any level previously marked final stops being it.'
            : 'The final class stays as it is. You can change it later in Class Management.'}
        </div>
      </fieldset>

      {error && <div className="field-error" style={{ marginTop: 4 }}>{error}</div>}
    </Modal>
  );
}
