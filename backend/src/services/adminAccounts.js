/**
 * Provisioning the FIRST admin account.
 *
 * A fresh production database has no users at all, and every other way an
 * account comes into existence is closed to it: the student auto-login service
 * creates students only, and the demo seed refuses production outright (it would
 * insert well-known passwords). So without this module a real deploy ends with
 * nobody able to log in.
 *
 * The account is created HERE, through Prisma, in one place — the CLI
 * (`scripts/create-admin.js`) is a thin wrapper over {@link createFirstAdmin}.
 * The password never touches the command line, an env var, a file or a log: the
 * CLI reads it with a hidden prompt and passes it straight in.
 *
 * @module services/adminAccounts
 */
const bcrypt = require('bcrypt');
const prisma = require('./prisma');
const { ROLES } = require('../constants/roles');
const { passwordProblems } = require('./passwords');

/** bcrypt cost, matching every other write in the app. */
const BCRYPT_ROUNDS = 10;

/** Thrown when the request cannot be honoured; `code` distinguishes the cases. */
class AdminAccountError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AdminAccountError';
    this.code = code;
  }
}

/** How many accounts already hold the admin role. */
const countAdmins = () => prisma.user.count({ where: { role: ROLES.ADMIN } });

/**
 * Create the first admin user.
 *
 * Refuses when an admin already exists unless `force` is set — a second,
 * accidental run must not quietly add another all-powerful account. The password
 * is validated with the SAME complexity rule every reset route enforces, so the
 * CLI cannot mint a credential the app itself would reject.
 *
 * @param {object} opts
 * @param {string} opts.username  login name (stored verbatim; must be unique)
 * @param {string} opts.password  the password to hash — never logged
 * @param {string} [opts.name]    display name; defaults to the username
 * @param {boolean} [opts.force]  create even when an admin already exists
 * @returns {Promise<{id: string, username: string, name: string, role: string}>}
 *   the sanitized account (never the hash)
 */
async function createFirstAdmin({ username, password, name, force = false }) {
  const login = String(username ?? '').trim();
  if (!login) throw new AdminAccountError('A username is required.', 'USERNAME_REQUIRED');

  const existing = await countAdmins();
  if (existing > 0 && !force) {
    throw new AdminAccountError(
      `An admin account already exists (${existing}). Pass --force to create another one anyway.`,
      'ADMIN_EXISTS',
    );
  }

  const problems = passwordProblems(password);
  if (problems.length > 0) {
    throw new AdminAccountError(
      ['The password does not meet the required complexity:', ...problems.map((p) => `  - ${p}`)].join('\n'),
      'WEAK_PASSWORD',
    );
  }

  const taken = await prisma.user.findUnique({ where: { username: login }, select: { id: true } });
  if (taken) throw new AdminAccountError(`The username "${login}" is already taken.`, 'USERNAME_TAKEN');

  const user = await prisma.user.create({
    data: {
      username: login,
      passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
      role: ROLES.ADMIN,
      name: String(name ?? '').trim() || login,
      status: 'active',
      // The operator chose this password deliberately, so the recipient is not
      // forced to change it — the same reasoning as an admin reset.
      mustChangePassword: false,
    },
    select: { id: true, username: true, name: true, role: true },
  });
  return user;
}

module.exports = { createFirstAdmin, countAdmins, AdminAccountError, BCRYPT_ROUNDS };
