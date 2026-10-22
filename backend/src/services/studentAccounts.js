const bcrypt = require('bcrypt');
const prisma = require('./prisma');
const { ROLES } = require('../constants/roles');

/**
 * Auto-provisioned student logins.
 *
 * Every student created through the admin surface — the single "Add Student"
 * form and Bulk Add/Bulk Upload alike — gets a STUDENT login automatically:
 *
 *   username  the student's full name, lowercased with separator dots
 *             ('Sneha Reddy' → 'sneha.reddy'; non-alphanumeric runs collapse
 *             to a dot, so 'Excel Kid, Jr.' → 'excel.kid.jr'). Collisions
 *             with ANY existing username are resolved by appending a numeric
 *             suffix ('kavya.nair', 'kavya.nair.2', 'kavya.nair.3' …) — the
 *             add/upload never fails over a username clash and never
 *             overwrites an existing account (User.username is @unique and
 *             the insert is retried with the next suffix on P2002).
 *   password  the student's guardian contact number, EXACTLY as stored
 *             (including the '+91-' prefix), bcrypt-hashed like any other.
 *
 * PASSWORD TRADE-OFF (deliberate, not an oversight): the initial password is
 * the guardian contact — a value several people may know and that siblings
 * can share. Keeping it as the default is a usability choice: it is the one
 * credential the school can state without inventing or printing a secret.
 *
 * What is NOT accepted is that it stays usable. Every account created here is
 * flagged `mustChangePassword`, which blocks the user from every business
 * endpoint (middleware/passwordGate.middleware.js) until they set their own
 * password through POST /auth/change-password — which also refuses to accept
 * the guardian contact as the replacement. So the predictable default is valid
 * only for the window between admission and the student's first login.
 *
 * The password itself is never sent to any client: the profile/list responses
 * carry `username` and `guardianContact` (a contact field), never a password
 * field. The derivation rule is stated exactly once, in the response of the
 * create request that produced the account — the one moment an admin needs it
 * to hand the login over. After that it cannot be retrieved; a forgotten
 * password is reset from User Accounts, not read back.
 */

/** 'Sneha Reddy' → 'sneha.reddy' — lowercase, non-alphanumeric runs → dots */
const baseUsernameFrom = (name) => {
  const base = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
  return base || 'student'; // a name of pure symbols still yields a valid base
};

/** First free username: base, base.2, base.3 … (never reuses a taken one) */
const freeUsername = (base, taken) => {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}.${n}`)) n += 1;
  return `${base}.${n}`;
};

/** Every username already in the users table (the collision universe) */
const loadTakenUsernames = async () => {
  const rows = await prisma.user.findMany({ select: { username: true } });
  return new Set(rows.map((r) => r.username));
};

/**
 * Create the STUDENT login for one freshly created student and link it.
 * Skips silently (returns null) when the student has no guardian contact —
 * there is nothing to derive the initial password from.
 *
 * @param {{id: string, name: string, guardianContact: string|null}} student
 * @param {{taken?: Set<string>}} [opts] shared taken-usernames set; generated
 *   usernames are added to it so a bulk batch can never collide with itself
 * @returns {Promise<{userId: string, username: string, name: string}|null>}
 */
const createStudentAccount = async (student, { taken = new Set() } = {}) => {
  const contact = String(student.guardianContact ?? '').trim();
  if (!contact) return null;

  const base = baseUsernameFrom(student.name);
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const username = freeUsername(base, taken);
    try {
      const user = await prisma.user.create({
        data: {
          username,
          passwordHash: bcrypt.hashSync(contact, 10),
          role: ROLES.STUDENT,
          name: student.name,
          status: 'active',
          // The password here is a value the school chose (the guardian
          // contact), not one the user chose — so the account may log in but
          // cannot reach any business endpoint until they set their own.
          mustChangePassword: true,
        },
      });
      await prisma.student.update({
        where: { id: student.id },
        data: { userId: user.id },
      });
      taken.add(username); // later rows in the same batch must not reuse it
      return { userId: user.id, username, name: student.name };
    } catch (err) {
      if (err?.code === 'P2002') {
        // Lost a race on the unique username — try the next suffix.
        taken.add(username);
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError;
};

module.exports = { baseUsernameFrom, freeUsername, loadTakenUsernames, createStudentAccount };
