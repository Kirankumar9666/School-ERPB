const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const config = require('../../config/env');
const prisma = require('../../services/prisma');
const { mapUserPublic } = require('../../services/mappers');
const { loginRateLimiter, refreshLimiter } = require('../../middleware/rateLimiter.middleware');
const authMiddleware = require('../../middleware/auth.middleware');
const { requireRole } = require('../../middleware/role.middleware');
const { ROLES } = require('../../constants/roles');
const { sendSuccess, sendError, sendValidationError } = require('../../utils/response');

const router = express.Router();

/** Input schema for login */
const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

/**
 * POST /api/v1/auth/login
 * Authenticates a user and returns JWT tokens.
 */
router.post('/login', loginRateLimiter, async (req, res) => {
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

  const passwordMatch = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatch) {
    return sendError(res, 'Invalid username or password', 401, 'INVALID_CREDENTIALS');
  }

  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    linkedEntityId: user.student?.id || user.employee?.id || null,
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

    const payload = {
      id: user.id,
      username: user.username,
      role: user.role,
      linkedEntityId: user.student?.id || user.employee?.id || null,
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
  newPassword: z.string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[a-z]/, 'Password must include a lowercase letter')
    .regex(/[A-Z]/, 'Password must include an uppercase letter')
    .regex(/[0-9]/, 'Password must include a digit'),
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
    data: { passwordHash: await bcrypt.hash(newPassword, 10) },
  });

  return sendSuccess(res, null, 'Password reset successfully');
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
