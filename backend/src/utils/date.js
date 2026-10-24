const { z } = require('zod');

/**
 * Date-only helpers for API fields that are calendar dates.
 *
 * Parsing with `new Date('YYYY-MM-DDT00:00:00.000Z')` is not a validity check:
 * an impossible value such as `2026-13-40` or `2026-02-30` produces an Invalid
 * Date, which then reaches Prisma and becomes a 500. `parseDateOnly` parses the
 * three components, lets Date.UTC normalize them, and requires the normalized
 * date to round-trip to the exact input. That rejects impossible dates,
 * non-zero-padded parts and trailing text without a list of known-bad values.
 */
const parseDateOnly = (value) => {
  if (typeof value !== 'string') return null;
  const parts = value.split('-');
  if (parts.length !== 3 || parts.some((part) => part === '')) return null;
  const [year, month, day] = parts.map(Number);
  if (![year, month, day].every(Number.isInteger)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === value ? date : null;
};

/** A required, real calendar date in the API's date-only form. */
const dateOnly = z
  .string({ error: 'Date is required' })
  .trim()
  .min(1, 'Date is required')
  .refine((value) => parseDateOnly(value) !== null, 'Enter a valid calendar date');

/**
 * Parse a present date-only value, throwing a 400 instead of returning null.
 *
 * This is the safe conversion for route/service code: a present but impossible
 * value must never become a null (or an Invalid Date) passed to Prisma. Callers
 * that allow an absent date check for undefined/null before calling this.
 */
const parseDateOnlyOrThrow = (value) => {
  const parsed = parseDateOnly(value);
  if (!parsed) {
    const err = new Error('Enter a valid calendar date');
    err.status = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  return parsed;
};

/** An optional date: omitted is allowed, exactly like the old `.optional()`. */
const optionalDateOnly = dateOnly.optional();

/** A nullable date: omitted or null is allowed, exactly like `.nullish()`. */
const nullableDateOnly = dateOnly.nullish();

module.exports = {
  parseDateOnly,
  parseDateOnlyOrThrow,
  dateOnly,
  optionalDateOnly,
  nullableDateOnly,
};
