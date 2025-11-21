/**
 * ============================================
 * TEXT TO SPEECH ROUTES
 * ============================================
 * Rutas del API de text-to-speech
 */

const express = require('express');
const router = express.Router();
const textToSpeechController = require('../controllers/text-to-speech.controller');
const rateLimitMiddleware = require('../middlewares/rate-limit.middleware');
const { authenticateToken } = require('../middlewares/auth.middleware');

// Aplicar rate limiting
router.use(rateLimitMiddleware);

// Aplicar autenticación a todas las rutas
router.use(authenticateToken);

// Rutas
router.post('/speak', textToSpeechController.convertTextToSpeech);

module.exports = router;

