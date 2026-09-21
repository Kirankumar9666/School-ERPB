import { useState } from 'react';
import { digitsOnly, isValidContact } from '../utils/phone';

/**
 * PhoneInput — the shared contact/phone field (Guardian Contact, Employee
 * Mobile, Emergency Contact). Numbers are collected as EXACTLY 10 digits:
 *
 *  - every keystroke is stripped to digits (letters, symbols and spaces can
 *    never enter the field) and input is capped at 10 characters, so an 11th
 *    digit simply cannot be typed;
 *  - inputMode="numeric" + type="tel" give mobile users a numeric keypad;
 *  - blur/submit show "Enter a valid 10-digit contact number." when fewer
 *    than 10 digits are present (empty is allowed — the contact fields are
 *    optional in the data model).
 *
 * Country-code convention (matches how contacts are already displayed in the
 * Student Management Contact column, the employee table and the profile
 * screens — always '+91-9876543210'): the field edits ONLY the 10-digit
 * national number, with the '+91-' prefix shown as static text. The prefix is
 * added on save (utils/phone.fieldToContact) and stripped on prefill
 * (utils/phone.contactToField), so stored values keep their uniform
 * '+91-XXXXXXXXXX' shape.
 */

export default function PhoneInput({ id, value, onChange, ariaLabel }) {
  const [touched, setTouched] = useState(false);
  const invalid = touched && !isValidContact(value);
  return (
    <>
      <div className="phone-field">
        <span className="phone-prefix" aria-hidden="true">+91-</span>
        <input
          id={id}
          type="tel"
          inputMode="numeric"
          autoComplete="off"
          className="form-input"
          placeholder="9876543210"
          maxLength={10}
          value={value}
          onChange={(e) => onChange(digitsOnly(e.target.value))}
          onBlur={() => setTouched(true)}
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
        />
      </div>
      {invalid && <div className="field-error">Enter a valid 10-digit contact number.</div>}
    </>
  );
}
