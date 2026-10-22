const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const config = require('../../config/env');
const prisma = require('../../services/prisma');
const { mapUserPublic } = require('../../services/mappers');
const { loginRateLimiter, loginAccountLimiter, refreshLimiter, changePasswordLimiter } = require('../../middleware/rateLimiter.middleware');
const authMiddleware = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { ROLES } = require('../../constants/roles');
const { sendSuccess, sendError, sendValidationError } = require('../../utils/response');
const { wrapAsync } = require('../../utils/asyncRoute');
const { passwordProblems, passwordSchema } = require('../../services/passwords');

const router = wrapAsync(express.Router());

/** Input schema for login */
const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

/**
 * POST /api/v1/auth/login
 * Authenticates a user and returns JWT tokens.
 *
 * Rate limited twice, independently: per-IP (loginRateLimiter) for anonymous
 * probing, and per-ACCOUNT (loginAccountLimiter) so grinding one username is
 * throttled without locking out everyone else who shares the school's IP.
 */
router.post('/login', loginRateLimiter, loginAccountLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendValidationError(res, parsed.error.flatten().fieldErrors);
  }

  const { username, password } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { username },
    include: { student: true, employee: true },
  });
  if (!user || user.status !== 'active') {
    return sendError(res, 'Invalid username or password', 401, 'INVALID_CREDENTIALS');
  }

  /* The linked student or employee must still exist. An account whose row was
     left behind when its student was deleted (a bug, or data removed outside the
     app) must not produce a working login for a person who is no longer on roll.
     The delete route now removes the account too; this is the belt to that pair
     of braces. */
  const orphanedAccount = (user.role === ROLES.STUDENT && !user.student)
    || (user.role === ROLES.TEACHER && !user.employee)
    || (user.role === ROLES.ACCOUNTANT && !user.employee)
    || (user.role === ROLES.LIBRARIAN && !user.employee);
  if (orphanedAccount) {
    return sendError(res, 'This account is no longer linked to a record. Ask the office to recreate it.', 403, 'ACCOUNT_ORPHANED');
  }

  const passwordMatch = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatch) {
    return sendError(res, 'Invalid username or password', 401, 'INVALID_CREDENTIALS');
  }

  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    linkedEntityId: user.student?.id || user.employee?.id || null,
    // Carried in the token so the password gate can refuse business endpoints
    // without a database lookup on every request. Refreshed from the DB below,
    // so it clears as soon as the password is changed.
    mustChangePassword: user.mustChangePassword === true,
  };

  const accessToken = jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
  const refreshToken = jwt.sign({ id: user.id }, config.jwt.refreshSecret, { expiresIn: config.jwt.refreshExpiresIn });

  return sendSuccess(res, {
    accessToken,
    refreshToken,
    user: mapUserPublic(user),
  }, 'Login successful');
});

/**
 * POST /api/v1/auth/refresh
 * Issues a new access token using a valid refresh token.
 * Rate limited (failed attempts only) and zod-validated.
 */
const refreshSchema = z.object({
  refreshToken: z.string().min(10, 'Refresh token required'),
});

router.post('/refresh', refreshLimiter, async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendValidationError(res, parsed.error.flatten().fieldErrors);
  }

  try {
    const decoded = jwt.verify(parsed.data.refreshToken, config.jwt.refreshSecret);
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      include: { student: true, employee: true },
    });
    if (!user) return sendError(res, 'User not found', 404, 'NOT_FOUND');
    if (user.status !== 'active') {
      return sendError(res, 'Account is no longer active', 403, 'ACCOUNT_INACTIVE');
    }

    /* Rebuilt from the database on every refresh, so an account whose linked
       record has been deleted stops working HERE too, not only at the next
       login. Otherwise a token issued before the delete would keep renewing
       itself into a working session. */
    if ((user.role === ROLES.STUDENT && !user.student)
      || ((user.role === ROLES.TEACHER || user.role === ROLES.ACCOUNTANT || user.role === ROLES.LIBRARIAN) && !user.employee)) {
      return sendError(res, 'This account is no longer linked to a record.', 403, 'ACCOUNT_ORPHANED');
    }

    const payload = {
      id: user.id,
      username: user.username,
      role: user.role,
      linkedEntityId: user.student?.id || user.employee?.id || null,
      // Rebuilt from the database on every refresh, so this clears as soon as
      // the user has set their own password.
      mustChangePassword: user.mustChangePassword === true,
    };
    const newAccessToken = jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn });

    return sendSuccess(res, { accessToken: newAccessToken }, 'Token refreshed');
  } catch {
    return sendError(res, 'Invalid or expired refresh token', 401, 'INVALID_REFRESH_TOKEN');
  }
});

/**
 * POST /api/v1/auth/reset-password
 * Admin-only endpoint to reset any user's password.
 */
const resetPasswordSchema = z.object({
  userId: z.string().min(1),
  newPassword: passwordSchema,
});

router.post('/reset-password', authMiddleware, requireRole([ROLES.ADMIN]), async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendValidationError(res, parsed.error.flatten().fieldErrors);
  }

  const { userId, newPassword } = parsed.data;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return sendError(res, 'User not found', 404, 'NOT_FOUND');

  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: await bcrypt.hash(newPassword, 10),
      // An admin deliberately set this password, so it is not a school-chosen
      // derived default — the recipient is not forced to change it.
      mustChangePassword: false,
    },
  });

  return sendSuccess(res, null, 'Password reset successfully');
});

/**
 * POST /api/v1/auth/change-password
 *
 * A user changing their OWN password — the counterpart to the admin's
 * PUT /admin/users/:id/reset-password, and the only way out of the forced
 * change state (User.mustChangePassword) that student accounts are created in.
 *
 * Deliberately NOT mounted with requirePasswordChange: a blocked account must
 * be able to call exactly this route. It is the one /auth route an admin or
 * student can use while flagged; everything under the four business routers is
 * refused until this succeeds.
 *
 * Neither password ever leaves the server: the reply carries a freshly signed
 * access token (forced-change flag already cleared) and the same sanitized
 * user shape mapUserPublic always returns.
 *
 * Rate limited (changePasswordLimiter, failed attempts only) so a stolen access
 * token cannot be used to brute-force the current password.
 */
/**
 * Shape only — the complexity rule and the derived-default guard are applied
 * explicitly below, in that order, so the message is the useful one: a user
 * who types the guardian contact as their new password is told what is wrong
 * with that choice rather than a generic "must include a capital letter".
 */
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(1, 'New password is required'),
});

/** The admin reset's complexity rule, collected so every problem shows at once. */
const newPasswordProblems = passwordProblems;

router.post('/change-password', changePasswordLimiter, authMiddleware, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendValidationError(res, parsed.error.flatten().fieldErrors);
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { student: true, employee: true },
  });
  if (!user) return sendError(res, 'User not found', 404, 'NOT_FOUND');
  if (user.status !== 'active') return sendError(res, 'Account is not active', 403, 'ACCOUNT_INACTIVE');

  // 400 (not 401) on purpose: 401 is the interceptor's signal to attempt a
  // token refresh, and a wrong current password is a bad request body, not an
  // expired session.
  const currentMatches = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
  if (!currentMatches) {
    return sendError(res, 'Current password is incorrect', 400, 'CURRENT_PASSWORD_INVALID');
  }

  /*
   * The forced change exists precisely because the initial password is
   * predictable, so accepting that same value as the replacement would clear
   * the flag while leaving the credential unchanged. Compared against the
   * student's own guardian contact (a real column read from this account's
   * record — never a hardcoded sample) and only when one exists; staff
   * accounts have none and skip the check.
   */
  const derivedDefault = String(user.student?.guardianContact ?? '').trim();
  if (derivedDefault && parsed.data.newPassword === derivedDefault) {
    return sendError(res, 'Choose a password that is not the guardian contact number', 400, 'PASSWORD_REUSE_DEFAULT');
  }

  const problems = newPasswordProblems(parsed.data.newPassword);
  if (problems.length > 0) {
    return sendValidationError(res, { newPassword: problems });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await bcrypt.hash(parsed.data.newPassword, 10),
      mustChangePassword: false,
    },
  });

  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    linkedEntityId: user.student?.id || user.employee?.id || null,
    mustChangePassword: false,
  };
  const accessToken = jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn });

  return sendSuccess(
    res,
    { accessToken, user: mapUserPublic({ ...user, mustChangePassword: false }) },
    'Password changed',
  );
});

/**
 * GET /api/v1/auth/me
 * Returns the currently authenticated user's info.
 */
router.get('/me', authMiddleware, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { student: true, employee: true },
  });
  if (!user) return sendError(res, 'User not found', 404, 'NOT_FOUND');

  return sendSuccess(res, mapUserPublic(user));
});

module.exports = router;
