const { sendError } = require('../utils/response');

/**
 * RBAC middleware factory.
 * Usage: requireRole([ROLES.ADMIN, ROLES.TEACHER])
 * Must be used AFTER authMiddleware.
 *
 * @param {string[]} allowedRoles - Array of role strings permitted to access the route
 */
const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return sendError(res, 'Not authenticated', 401, 'UNAUTHORIZED');
    }
    if (!allowedRoles.includes(req.user.role)) {
      return sendError(res, 'Access denied — insufficient permissions', 403, 'FORBIDDEN');
    }
    next();
  };
};

module.exports = { requireRole };
