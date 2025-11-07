/**
 * ============================================
 * RATE LIMIT MIDDLEWARE
 * ============================================
 * Middleware para limitar la tasa de peticiones
 */

const rateLimit = require('express-rate-limit');
const config = require('../../config/env.config');

const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  message: {
    success: false,
    message: 'Too many requests, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = limiter;

