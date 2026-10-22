const { sendError } = require('../utils/response');

/**
 * Blocks every business endpoint while an account is still using a password
 * the SCHOOL chose for it rather than one the user chose (User.mustChangePassword,
 * set by services/studentAccounts.js when the password is derived from the
 * guardian contact).
 *
 * Why this is a server-side gate and not just a portal redirect: hiding the UI
 * would leave the predictable default password fully usable against the API,
 * which is exactly the exposure this exists to close. The flag travels in the
 * JWT payload (no extra query per request), so authMiddleware has already
 * populated req.user by the time this runs.
 *
 * The user CAN still reach /auth/* — in particular POST /auth/change-password,
 * which is the only way to clear the flag, and GET /auth/me. Those routers
 * deliberately do not mount this middleware; the four business routers do.
 *
 * Mount immediately after authMiddleware:
 *   router.use(authMiddleware);
 *   router.use(requirePasswordChange);
 */
const requirePasswordChange = (req, res, next) => {
  if (req.user && req.user.mustChangePassword === true) {
    return sendError(
      res,
      'Set a new password before continuing — your account is still using its initial password',
      403,
      'PASSWORD_CHANGE_REQUIRED',
    );
  }
  return next();
};

module.exports = requirePasswordChange;
