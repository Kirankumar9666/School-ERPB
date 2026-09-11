/**
 * Standard API response helpers.
 * Ensures every response has a consistent shape:
 *   { success, message, data } or { success, message, code }
 */

const sendSuccess = (res, data, message = 'Success', statusCode = 200) => {
  return res.status(statusCode).json({ success: true, message, data });
};

const sendError = (res, message = 'An error occurred', statusCode = 500, code = 'SERVER_ERROR') => {
  return res.status(statusCode).json({ success: false, message, code });
};

const sendValidationError = (res, errors) => {
  return res.status(400).json({
    success: false,
    message: 'Validation failed',
    code: 'VALIDATION_ERROR',
    errors,
  });
};

module.exports = { sendSuccess, sendError, sendValidationError };
