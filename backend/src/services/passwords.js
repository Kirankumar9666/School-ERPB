/**
 * The one password-complexity rule for the whole API.
 *
 * It lives here, not in a route, because three surfaces enforce it and they must
 * agree exactly: the admin's own reset (POST /auth/reset-password), the admin
 * panel's reset (PUT /admin/users/:id/reset-password) and the first-admin CLI
 * (`npm run create-admin`). A second copy is how a password one screen accepts
 * comes to be rejected by another.
 *
 * Both shapes are exported from the same rule:
 *   - {@link passwordProblems} returns the list of human-readable problems, for
 *     callers that want to show every failure at once (the CLI, and the
 *     change-password route, which collects problems rather than failing on the
 *     first zod check so the message is the useful one).
 *   - {@link passwordSchema} is the zod string built from the same list, for the
 *     reset routes that validate a request body in one `safeParse`.
 *
 * @module services/passwords
 */
const { z } = require('zod');

/** Minimum length, stated once. */
const MIN_LENGTH = 8;

/**
 * Every way a candidate password fails the rule, in a stable order.
 *
 * @param {string} pw
 * @returns {string[]} one message per unmet requirement; empty when the password
 *   is acceptable
 */
const passwordProblems = (pw) => {
  const value = String(pw ?? '');
  const problems = [];
  if (value.length < MIN_LENGTH) problems.push(`Password must be at least ${MIN_LENGTH} characters`);
  if (!/[a-z]/.test(value)) problems.push('Password must include a lowercase letter');
  if (!/[A-Z]/.test(value)) problems.push('Password must include an uppercase letter');
  if (!/[0-9]/.test(value)) problems.push('Password must include a digit');
  return problems;
};

/**
 * The same rule as a zod string schema, for request-body validation. Kept in
 * lockstep with {@link passwordProblems} by construction: every requirement is
 * expressed once here as a `.min`/`.regex` pair.
 */
const passwordSchema = z.string()
  .min(MIN_LENGTH, `Password must be at least ${MIN_LENGTH} characters`)
  .regex(/[a-z]/, 'Password must include a lowercase letter')
  .regex(/[A-Z]/, 'Password must include an uppercase letter')
  .regex(/[0-9]/, 'Password must include a digit');

module.exports = { MIN_LENGTH, passwordProblems, passwordSchema };
