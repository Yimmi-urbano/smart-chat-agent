/**
 * ============================================
 * AUTHENTICATION MIDDLEWARE
 * ============================================
 * Middleware para validar tokens JWT
 */

const jwt = require('jsonwebtoken');
const config = require('../../config/env.config');
const logger = require('../../utils/logger');
const ResponseUtil = require('../../utils/response');

/**
 * Middleware de autenticación JWT
 * Verifica que el token sea válido y esté presente
 */
function authenticateToken(req, res, next) {
  try {
    // Obtener el token del header Authorization
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Formato: "Bearer TOKEN"

    // Verificar que el token esté presente
    if (!token) {
      logger.warn('[Auth] Token no proporcionado');
      return ResponseUtil.unauthorized(res, 'Token de autenticación requerido');
    }

    // Verificar que JWT_SECRET esté configurado
    if (!config.jwt.secret) {
      logger.error('[Auth] JWT_SECRET no está configurado');
      return ResponseUtil.serverError(res, 'Error de configuración del servidor');
    }

    // Verificar y decodificar el token
    jwt.verify(token, config.jwt.secret, (err, decoded) => {
      if (err) {
        // Token inválido o expirado
        if (err.name === 'TokenExpiredError') {
          logger.warn('[Auth] Token expirado');
          return ResponseUtil.unauthorized(res, 'Token expirado');
        }
        if (err.name === 'JsonWebTokenError') {
          logger.warn('[Auth] Token inválido');
          return ResponseUtil.unauthorized(res, 'Token inválido');
        }
        logger.error('[Auth] Error al verificar token:', err);
        return ResponseUtil.unauthorized(res, 'Token de autenticación inválido');
      }

      // Token válido - agregar información del usuario al request
      req.user = decoded;
      req.token = token;
      
      logger.info(`[Auth] Token válido para usuario: ${decoded.userId || decoded.id || 'unknown'}`);
      next();
    });
  } catch (error) {
    logger.error('[Auth] Error en middleware de autenticación:', error);
    return ResponseUtil.serverError(res, 'Error al procesar la autenticación');
  }
}

/**
 * Middleware opcional de autenticación
 * No falla si no hay token, pero valida si está presente
 */
function optionalAuthenticateToken(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      // No hay token, continuar sin autenticación
      req.user = null;
      req.token = null;
      return next();
    }

    if (!config.jwt.secret) {
      // Si no hay JWT_SECRET configurado, continuar sin validar
      req.user = null;
      req.token = token;
      return next();
    }

    // Intentar verificar el token
    jwt.verify(token, config.jwt.secret, (err, decoded) => {
      if (err) {
        // Token inválido, pero continuar sin autenticación (es opcional)
        logger.warn('[Auth] Token inválido en autenticación opcional');
        req.user = null;
        req.token = null;
      } else {
        // Token válido
        req.user = decoded;
        req.token = token;
      }
      next();
    });
  } catch (error) {
    logger.error('[Auth] Error en autenticación opcional:', error);
    // En caso de error, continuar sin autenticación
    req.user = null;
    req.token = null;
    next();
  }
}

module.exports = {
  authenticateToken,
  optionalAuthenticateToken,
};

