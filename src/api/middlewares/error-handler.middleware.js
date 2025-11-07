/**
 * ============================================
 * ERROR HANDLER MIDDLEWARE
 * ============================================
 * Middleware para manejar errores
 */

const logger = require('../../utils/logger');
const ResponseUtil = require('../../utils/response');

function errorHandler(err, req, res, next) {
  logger.error('Error:', err);

  // Error de validación
  if (err.name === 'ValidationError') {
    return ResponseUtil.badRequest(res, err.message);
  }

  // Error de autenticación
  if (err.name === 'UnauthorizedError') {
    return ResponseUtil.unauthorized(res, 'Unauthorized');
  }

  // Error genérico
  return ResponseUtil.serverError(res, err.message || 'Internal Server Error');
}

module.exports = errorHandler;

