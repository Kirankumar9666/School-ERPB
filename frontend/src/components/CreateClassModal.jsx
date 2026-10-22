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
import { Plus } from 'lucide-react';
import Modal from './Modal';
import api from '../services/api';
import toast from '../services/toast';

const LABEL = (levelName, section) =>
  (/^\d+$/.test(String(levelName)) ? `Class ${levelName}${section}` : `${levelName} ${section}`);

export default function CreateClassModal({ levels, onClose, onCreated, onLevelAdded }) {
  const [levelId, setLevelId] = useState(levels[0]?.id || '');
  const [section, setSection] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [addingLevel, setAddingLevel] = useState(false);

  /* Derived as it is typed, so the confirm button can say the real name.

     `safeLevelId` is the selection with a stale id repaired: if the level list
     changes underneath the open modal (an "add level" that renumbers it), the
     id that was selected may no longer exist, and rendering a select whose value
     matches nothing would show the first option while holding a dead one. */
  const safeLevelId = levels.some((l) => l.id === levelId) ? levelId : (levels[0]?.id || '');
  const chosenLevel = useMemo(() => levels.find((l) => l.id === safeLevelId) || null, [levels, safeLevelId]);
  const upper = section.trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
  const preview = chosenLevel && upper ? LABEL(chosenLevel.name, upper) : '';

  const submit = async () => {
    setError('');
    if (!safeLevelId) { setError('Choose a level.'); return; }
    if (!upper) { setError('Enter a section (letters only, e.g. A).'); return; }
    setSaving(true);
    try {
      const res = await api.post('/admin/classes', { levelId: safeLevelId, section: upper });
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
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
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
          onChange={(e) => setLevelId(e.target.value)}
          disabled={saving}
          aria-label="Level"
        >
          {levels.map((l) => (
            // The level NAME only. The order is internal and never shown here.
            <option key={l.id} value={l.id}>
              {l.name}
              {l.classCount > 0 ? ` (${l.classCount} class${l.classCount === 1 ? '' : 'es'})` : ''}
            </option>
          ))}
        </select>
      </div>

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
          <Plus size={14} /> Add a level
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
 */
function AddLevelModal({ levels, onClose, onSaved }) {
  const sorted = useMemo(() => [...levels].sort((a, b) => a.order - b.order), [levels]);
  const [name, setName] = useState('');
  const [afterId, setAfterId] = useState(sorted.length ? sorted[sorted.length - 1].id : '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError('');
    const trimmed = name.trim().replace(/\s+/g, ' ');
    if (!trimmed) { setError('Name the level.'); return; }
    setSaving(true);
    try {
      const res = await api.post('/admin/class-levels', { name: trimmed, afterId: afterId || null });
      toast.success(res.data.message);
      await onSaved(res.data.data);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not add the level.');
    } finally {
      setSaving(false);
    }
  };

  const afterName = sorted.find((l) => l.id === afterId);

  return (
    <Modal
      title="Add Level"
      onClose={() => { if (!saving) onClose(); }}
      footer={(
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
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
          onChange={(e) => setAfterId(e.target.value)}
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

      {error && <div className="field-error" style={{ marginTop: 4 }}>{error}</div>}
    </Modal>
  );
}
