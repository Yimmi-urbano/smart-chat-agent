/**
 * ============================================
 * CHAT CONTROLLER
 * ============================================
 * Maneja las peticiones HTTP del chatbot
 */

const ChatOrchestratorService = require('../../services/chat-orchestrator.service');
const ResponseUtil = require('../../utils/response');
const logger = require('../../utils/logger');

class ChatController {
  constructor() {
    this.orchestrator = new ChatOrchestratorService();
  }

  /**
   * POST /api/chat/message
   * Procesa un mensaje del usuario
   */
  async sendMessage(req, res) {
    try {
      const { userMessage, domain, userId, forceModel, stream } = req.body;

      // Validaciones básicas
      if (!userMessage || !domain || !userId) {
        return ResponseUtil.badRequest(
          res,
          'Missing required fields: userMessage, domain, userId'
        );
      }

      if (userMessage.length > 2000) {
        return ResponseUtil.badRequest(
          res,
          'Message too long (max 2000 characters)'
        );
      }

      logger.info(`[Chat] Processing message from user ${userId} on domain ${domain}`);

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // El orquestador se encargará de escribir en el stream y de la persistencia.
        await this.orchestrator.processMessageStream({
          userMessage,
          userId,
          domain,
          forceModel,
          res, // Pasamos el objeto de respuesta para el streaming
        });

        res.end();
      } else {
        // Procesamiento normal sin streaming
        const response = await this.orchestrator.processMessage({
          userMessage,
          userId,
          domain,
          forceModel,
        });

        return ResponseUtil.success(res, response, 'Message processed successfully');
      }
    } catch (error) {
      logger.error('[Chat] Error in sendMessage:', error);
      // Asegurarse de que no se envíe una respuesta de error si el stream ya comenzó
      if (!res.headersSent) {
        return ResponseUtil.serverError(res, 'Failed to process message');
      }
    }
  }

  /**
   * GET /api/chat/history/:userId
   * Obtiene el historial de conversación
   */
  async getHistory(req, res) {
    try {
      const { userId } = req.params;
      const { domain } = req.query;

      if (!domain) {
        return ResponseUtil.badRequest(res, 'Missing domain query parameter');
      }

      const getConversationModel = require('../../models/Conversation');
      const Conversation = getConversationModel();
      
      const conversation = await Conversation.findOne({
        userId,
        domain,
        status: 'active',
      }).sort({ updatedAt: -1 });

      if (!conversation) {
        return ResponseUtil.success(res, { messages: [] }, 'No conversation found');
      }

      return ResponseUtil.success(res, {
        conversationId: conversation._id,
        messages: conversation.messages,
        metadata: conversation.metadata,
        systemPromptMemorized: conversation.messages[0]?.role === 'system',
      }, 'History retrieved successfully');

    } catch (error) {
      logger.error('[Chat] Error in getHistory:', error);
      return ResponseUtil.serverError(res, 'Failed to retrieve history');
    }
  }

  /**
   * POST /api/chat/close/:conversationId
   * Cierra una conversación
   */
  async closeConversation(req, res) {
    try {
      const { conversationId } = req.params;

      await this.orchestrator.closeConversation(conversationId);

      return ResponseUtil.success(res, null, 'Conversation closed successfully');

    } catch (error) {
      logger.error('[Chat] Error in closeConversation:', error);
      return ResponseUtil.serverError(res, 'Failed to close conversation');
    }
  }

  /**
   * GET /api/chat/stats
   * Obtiene estadísticas de uso
   */
  async getStats(req, res) {
    try {
      const { domain, startDate, endDate } = req.query;

      if (!domain) {
        return ResponseUtil.badRequest(res, 'Missing domain query parameter');
      }

      const start = startDate ? new Date(startDate) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const end = endDate ? new Date(endDate) : new Date();

      const stats = await this.orchestrator.getUsageStats(domain, start, end);

      return ResponseUtil.success(res, stats, 'Stats retrieved successfully');

    } catch (error) {
      logger.error('[Chat] Error in getStats:', error);
      return ResponseUtil.serverError(res, 'Failed to retrieve stats');
    }
  }
}

module.exports = new ChatController();

