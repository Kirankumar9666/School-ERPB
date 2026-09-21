/**
 * Non-negative whole-rupee amount input (₹): blocks negatives and junk as
 * typed — it only ever yields '' or a plain digit string, so no invalid value
 * ever reaches state. The backend re-validates/clamps every write anyway.
 * Used by the salary fields on the employee Add/Edit form.
 *
 * @param {string|number} value    current value
 * @param {function} onChange      receives '' or a digit string
 * @param {string} label           accessible name
 */
export default function AmountInput({ value, onChange, label }) {
  return (
    <input
      className="form-input"
      type="number"
      inputMode="numeric"
      min="0"
      step="1"
      placeholder="0"
      aria-label={label}
      value={value ?? ''}
      onChange={(e) => {
        const n = Number(e.target.value);
        onChange(e.target.value === '' || !Number.isFinite(n) ? '' : String(Math.max(0, Math.trunc(n))));
      }}
    />
  );
}
