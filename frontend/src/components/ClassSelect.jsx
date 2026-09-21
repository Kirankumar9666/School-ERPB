/**
 * Shared "Select Class" dropdown for admin screens.
 *
 * The options are passed in by the page — built by `classChoices()` from the
 * classes returned by GET /school/options (`services/options.loadOptions`) —
 * so every screen shows the same real, current class list and no page keeps a
 * local copy that can drift or silently go stale.
 *
 * Empty-state handling lives here so a class list can never render as a
 * silently empty select: with zero classes the dropdown is disabled and shows
 * a clear hint instead of offering nothing.
 *
 * @param {string}   [id]        input id (label htmlFor + a11y)
 * @param {string}   [label]     field label
 * @param {string}   [placeholder] hint shown before a class is chosen
 * @param {string}   value       currently selected class id ('' = none)
 * @param {function} onChange    receives the newly selected class id
 * @param {Array<{id: string, label: string}>} choices class options
 * @param {boolean}  [disabled]  extra disable (e.g. while saving)
 * @param {object}   [style]     wrapper style (layout tweaks per page)
 * @param {string}   [emptyHint] text shown when there are no classes at all
 */
export default function ClassSelect({
  id,
  label = 'Select Class',
  placeholder = 'Select class',
  value,
  onChange,
  choices,
  disabled = false,
  style,
  emptyHint = 'No classes found — add students first',
}) {
  const hasClasses = choices.length > 0;
  return (
    <div className="form-group" style={style}>
      <label className="form-label" htmlFor={id}>{label}</label>
      <select
        id={id}
        className="form-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || !hasClasses}
        aria-label={label}
      >
        {!hasClasses ? (
          <option value="">{emptyHint}</option>
        ) : (
          <>
            <option value="" disabled>{placeholder}</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </>
        )}
      </select>
    </div>
  );
}
