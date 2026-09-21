/**
 * Phone/contact helpers — shared by PhoneInput and the admin forms.
 *
 * Numbers are collected as EXACTLY 10 digits. Country-code convention (matches
 * how contacts are already displayed in the Student Management Contact column,
 * the employee table and the profile screens — always '+91-9876543210'): the
 * field edits ONLY the 10-digit national number, with the '+91-' prefix shown
 * as static text. The prefix is added on save (fieldToContact) and stripped on
 * prefill (contactToField), so stored values keep their uniform
 * '+91-XXXXXXXXXX' shape.
 */

/** Keep digits only, capped at 10 — everything else is stripped as typed */
export const digitsOnly = (value) => String(value ?? '').replace(/\D/g, '').slice(0, 10);

/** Stored '+91-9876543210' (or legacy junk) → what the 10-digit field shows */
export const contactToField = (stored) => {
  let d = String(stored ?? '').replace(/\D/g, '');
  if (d.length > 10 && d.startsWith('91')) d = d.slice(2); // drop the country code
  return d.slice(0, 10);
};

/** Field value → stored format ('+91-9876543210'); '' stays '' (optional) */
export const fieldToContact = (value) => (value ? `+91-${value}` : '');

/** Saveable state: empty (optional field) or exactly 10 digits */
export const isValidContact = (value) => value === '' || value.length === 10;
