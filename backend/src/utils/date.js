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

module.exports = { parseDateOnly, dateOnly };
