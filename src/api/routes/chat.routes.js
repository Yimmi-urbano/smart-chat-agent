/**
 * ============================================
 * CHAT ROUTES
 * ============================================
 * Rutas del API de chat
 */

const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chat.controller');
const rateLimitMiddleware = require('../middlewares/rate-limit.middleware');

// Aplicar rate limiting
router.use(rateLimitMiddleware);

// Rutas
router.post('/message', chatController.sendMessage.bind(chatController));
router.get('/history/:userId', chatController.getHistory.bind(chatController));
router.post('/close/:conversationId', chatController.closeConversation.bind(chatController));
router.get('/stats', chatController.getStats.bind(chatController));

module.exports = router;

