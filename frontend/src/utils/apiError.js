/**
 * Turn an axios error from the API into ONE human message.
 *
 * The API answers a rejected form two ways:
 *   { message: 'Validation failed', code: 'VALIDATION_ERROR',
 *     errors: { feeTotal: ['Too small: expected number to be >=0'], ... } }
 *   { message: 'Class not found', code: 'NOT_FOUND' }
 *
 * Forms used to read `message` alone, so any per-field problem arrived as the
 * bare "Validation failed" and the user could not tell WHICH field was wrong
 * (QA-A1-010). This helper keeps the plain message for ordinary errors, and for
 * a validation error appends the field messages so the reason is visible. It is
 * the shared place every form should call, so a new form cannot reintroduce the
 * "generic message only" bug by copying the old one-liner.
 *
 * The field label is title-cased from the API key (`feeTotal` -> `Fee Total`)
 * and, when the caller passes the form's own label map, its nicer wording wins
 * (`guardianContact` -> `Guardian Contact`).
 *
 * @param {unknown} err the thrown axios error
 * @param {Record<string, string>} [labels] optional key -> label overrides
 * @param {string} [fallback] message when the error carries nothing readable
 * @returns {string}
 */
export const apiErrorMessage = (err, labels = {}, fallback = 'Something went wrong.') => {
  const data = err?.response?.data;
  if (!data) return err?.message || fallback;

  const message = typeof data.message === 'string' && data.message ? data.message : fallback;

  const errors = data.errors;
  if (!errors || typeof errors !== 'object') return message;

  const parts = [];
  for (const [key, value] of Object.entries(errors)) {
    const messages = Array.isArray(value) ? value : [value];
    const text = messages.filter((m) => typeof m === 'string' && m).join(', ');
    if (!text) continue;
    const fallbackLabel = key
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/^./, (c) => c.toUpperCase());
    parts.push(`${labels[key] || fallbackLabel}: ${text}`);
  }
  if (parts.length === 0) return message;

  // "Validation failed — Fee Total: Too small..." reads better than two lines,
  // and the toast/InlineError that consumes it is single-line.
  return `${message} — ${parts.join('; ')}`;
};

export default apiErrorMessage;
