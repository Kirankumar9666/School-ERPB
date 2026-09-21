/**
 * Contact / phone-number rule — one shared implementation for every write path
 * that stores a phone number: the student guardian contact, the employee mobile
 * and emergency contact, and the student bulk-upload 'Contact' column.
 *
 * The rule is digits only, EXACTLY 10 of them. Letters, symbols and spaces can
 * never be stored, and a short number is rejected with a per-field error
 * instead of being written.
 *
 * Country-code convention: the app stores contacts uniformly as '+91-' + the
 * 10-digit national number — matching how they are already displayed in the
 * Student Management Contact column, the employee table and every profile
 * screen. This schema accepts the stored shape ('+91-9876543210'), the bare 10
 * digits a hand-written bulk file usually contains ('9876543210') and the
 * country code with no separator ('+919876543210'), and NORMALIZES all three to
 * '+91-XXXXXXXXXX'. Normalizing (rather than rejecting) matters for the bulk
 * paths: an admin uploading a spreadsheet is not expected to type a prefix, but
 * the value that lands in the database — and therefore the auto-created login
 * password derived from it — is always in the one canonical shape.
 *
 * @example
 *   contactSchema.parse('+91-9876543210') // → '+91-9876543210'
 *   contactSchema.parse('9876543210')     // → '+91-9876543210'
 *   contactSchema.parse('f3g4g45g')       // → ZodError: Enter a valid 10-digit contact number
 */
const { z } = require('zod');

/** Number of national digits every contact must have */
const CONTACT_DIGITS = 10;

/** Message shown for every rejected contact (client mirrors this wording) */
const CONTACT_MESSAGE = `Enter a valid ${CONTACT_DIGITS}-digit contact number`;

/** Static prefix of the stored shape */
const CONTACT_PREFIX = '+91-';

/**
 * The national digits inside a contact value, with any country code, dash,
 * space or other separator removed. Anything non-numeric is dropped, so a value
 * with letters simply yields fewer digits and fails the length check below.
 *
 * @param {unknown} value
 * @returns {string} 0–N digits (never null, so callers can compare lengths)
 */
const contactDigits = (value) => {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length > CONTACT_DIGITS && digits.startsWith('91')) digits = digits.slice(2);
  return digits;
};

/**
 * zod schema for a stored contact field: validates AND normalizes.
 *
 * Chain `.optional()` for the optional fields (all contact fields are optional
 * in the data model — an empty value is accepted as-is, never turned into
 * '+91-').
 */
const contactSchema = z
  .string()
  .refine((value) => contactDigits(value).length === CONTACT_DIGITS, { message: CONTACT_MESSAGE })
  .transform((value) => `${CONTACT_PREFIX}${contactDigits(value)}`);

module.exports = {
  CONTACT_DIGITS,
  CONTACT_MESSAGE,
  CONTACT_PREFIX,
  contactDigits,
  contactSchema,
};
