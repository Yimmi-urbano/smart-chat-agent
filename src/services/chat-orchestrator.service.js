/**
 * ============================================
 * CHAT ORCHESTRATOR SERVICE
 * ============================================
 * Orquesta la comunicación entre el router, los modelos
 * y la persistencia de conversaciones
 */

const GeminiAgentService = require('./gemini-agent.service');
const OpenAIAgentService = require('./openai-agent.service');
const ModelRouterService = require('./model-router.service');
const PromptMemoryService = require('./prompt-memory.service');
const IntentInterpreterService = require('./intent-interpreter.service');
const ToolExecutorService = require('./tool-executor.service');
const getConversationModel = require('../models/Conversation');
const getTokenUsageModel = require('../models/TokenUsage');
const getProductModel = require('../models/Product');
const logger = require('../utils/logger');
const config = require('../config/env.config');
const crypto = require('crypto');

class ChatOrchestratorService {
  constructor() {
    this.geminiService = new GeminiAgentService();
    this.openaiService = new OpenAIAgentService();
  }

  async processMessage({ userMessage, userId, domain, forceModel = null }) {
    const startTime = Date.now();
    const FILE_NAME = 'chat-orchestrator.service.js';
    logger.info(`[${FILE_NAME}] 🔄 INICIANDO PROCESAMIENTO DE MENSAJE (NO-STREAM)`);

    try {
        let conversation = await this.getOrCreateConversation(userId, domain);
        const { systemPrompt, history, interpretedIntent, toolResult, dynamicPrompt } = await this._prepareConversation(userMessage, conversation, domain);
        const finalSystemPrompt = dynamicPrompt || systemPrompt;

        let response;
        let usedModel;
        let thinkingUsed = false;
        let fallbackUsed = false;

        const selectedModel = forceModel || ModelRouterService.decideModel(userMessage, history);
        logger.info(`[${FILE_NAME}] [PASO 3/5] Modelo seleccionado: ${selectedModel}`);

        try {
            if (selectedModel === 'gemini') {
                thinkingUsed = ModelRouterService.shouldUseThinking(userMessage);
                response = await this.geminiService.generateResponse(userMessage, history, domain, finalSystemPrompt, thinkingUsed);
                usedModel = 'gemini';
            } else {
                response = await this.openaiService.generateResponse(userMessage, history, domain, finalSystemPrompt);
                usedModel = 'openai';
            }
        } catch (error) {
            logger.error(`[${FILE_NAME}] ❌ Error inicial con ${selectedModel}: ${error.message}`);
            fallbackUsed = true;
            const fallbackResponse = await this._performFallback(selectedModel, userMessage, history, domain, finalSystemPrompt);
            response = fallbackResponse.response;
            usedModel = fallbackResponse.usedModel;
        }

        const finalResponse = await this._finalizeAndPersistConversation({
            response,
            conversation,
            userMessage,
            history,
            interpretedIntent,
            toolResult,
            systemPrompt,
            dynamicPrompt,
            usedModel,
            thinkingUsed,
            fallbackUsed,
            domain,
            userId,
            startTime,
        });

        logger.info(`[${FILE_NAME}] ✅ PROCESAMIENTO (NO-STREAM) COMPLETADO en ${Date.now() - startTime}ms`);
        return finalResponse;

    } catch (error) {
        logger.error(`[${FILE_NAME}] ❌ ERROR CRÍTICO en processMessage: ${error.message}`, { stack: error.stack });
        throw error;
    }
  }

  async processMessageStream({ userMessage, userId, domain, forceModel = null, res }) {
    const startTime = Date.now();
    const FILE_NAME = 'chat-orchestrator.service.js';
    logger.info(`[${FILE_NAME}] 🔄 INICIANDO PROCESAMIENTO DE MENSAJE (STREAM)`);

    let conversation;
    try {
        conversation = await this.getOrCreateConversation(userId, domain);
        const { systemPrompt, history, interpretedIntent, toolResult, dynamicPrompt } = await this._prepareConversation(userMessage, conversation, domain);
        const finalSystemPrompt = dynamicPrompt || systemPrompt;

        const selectedModel = forceModel || ModelRouterService.decideModel(userMessage, history);
        logger.info(`[${FILE_NAME}] [PASO 3/5] Modelo seleccionado para stream: ${selectedModel}`);

        let stream;
        let usedModel = selectedModel;
        let thinkingUsed = false;
        let fallbackUsed = false;

        try {
            if (selectedModel === 'gemini') {
                thinkingUsed = ModelRouterService.shouldUseThinking(userMessage);
                stream = await this.geminiService.generateResponseStream(userMessage, history, domain, finalSystemPrompt, thinkingUsed);
            } else {
                stream = await this.openaiService.generateResponseStream(userMessage, history, domain, finalSystemPrompt);
            }
        } catch (error) {
            logger.error(`[${FILE_NAME}] ❌ Error inicial en stream con ${selectedModel}: ${error.message}`);
            fallbackUsed = true;
            try {
                const fallbackModel = selectedModel === 'gemini' ? 'openai' : 'gemini';
                logger.warn(`[${FILE_NAME}] Intentando fallback de stream a ${fallbackModel}...`);
                if (fallbackModel === 'gemini') {
                    thinkingUsed = ModelRouterService.shouldUseThinking(userMessage);
                    stream = await this.geminiService.generateResponseStream(userMessage, history, domain, finalSystemPrompt, thinkingUsed);
                } else {
                    stream = await this.openaiService.generateResponseStream(userMessage, history, domain, finalSystemPrompt);
                }
                usedModel = fallbackModel;
            } catch (fallbackError) {
                logger.error(`[${FILE_NAME}] ❌ Fallback de stream también falló: ${fallbackError.message}`);
                if (!res.headersSent) {
                    res.write('event: error\ndata: {"message": "Lo siento, estoy teniendo problemas técnicos."}\n\n');
                }
                return;
            }
        }

        let fullResponseMessage = '';
        if (usedModel === 'openai') {
            for await (const chunk of stream) {
                const content = chunk.choices[0]?.delta?.content || '';
                if (content) {
                    fullResponseMessage += content;
                    res.write(`data: ${JSON.stringify({ message: content })}\n\n`);
                }
            }
        } else { // Gemini
            for await (const chunk of stream) {
                const content = chunk.text();
                if (content) {
                    fullResponseMessage += content;
                    res.write(`data: ${JSON.stringify({ message: content })}\n\n`);
                }
            }
        }

        logger.info(`[${FILE_NAME}] ✅ Stream finalizado. Respuesta completa: "${fullResponseMessage.substring(0, 100)}..."`);

        const responseForPersistence = {
            message: fullResponseMessage,
            usage: { input: 0, output: 0, thinking: 0, cached: 0, total: 0 },
            usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, thinkingTokenCount: 0 },
        };

        await this._finalizeAndPersistConversation({
            response: responseForPersistence,
            conversation,
            userMessage,
            history,
            interpretedIntent,
            toolResult,
            systemPrompt,
            dynamicPrompt,
            usedModel,
            thinkingUsed,
            fallbackUsed,
            domain,
            userId,
            startTime,
        });
        logger.info(`[${FILE_NAME}] ✅ PROCESAMIENTO (STREAM) COMPLETADO en ${Date.now() - startTime}ms`);

    } catch (error) {
        logger.error(`[${FILE_NAME}] ❌ ERROR CRÍTICO en processMessageStream: ${error.message}`, { stack: error.stack });
        if (!res.headersSent) {
            res.write('event: error\ndata: {"message": "Ocurrió un error inesperado."}\n\n');
        }
    } finally {
        if (!res.writableEnded) {
            res.end();
        }
    }
}

  async _prepareConversation(userMessage, conversation, domain) {
    const FILE_NAME = 'chat-orchestrator.service.js';
    try {
        const systemPrompt = await PromptMemoryService.buildSystemPrompt(domain);
        const history = this.getRecentHistory(conversation);
        logger.info(`[${FILE_NAME}] [PASO 1/5] ✅ Preparación completa`);

    logger.info(`[${FILE_NAME}] [PASO 2/5] INTERPRETACIÓN: Analizando intención...`);
    let interpretedIntent = null;
    let toolResult = null;
    let dynamicPrompt = null;
    try {
        interpretedIntent = await IntentInterpreterService.interpret(userMessage, 'es', domain);
        if (interpretedIntent.intent !== 'general_chat' && interpretedIntent.confidence >= 0.6) {
            toolResult = await ToolExecutorService.executeTool(interpretedIntent.intent, interpretedIntent.params, domain);
            if (toolResult) {
                dynamicPrompt = this.buildDynamicPrompt(interpretedIntent.intent, toolResult, systemPrompt, domain);
                logger.info(`[${FILE_NAME}] [PASO 2/5] ✅ Tool ejecutado: ${toolResult.tool}`);
            }
        }
    } catch (error) {
        logger.error(`[${FILE_NAME}] [PASO 2/5] ❌ Error en interpretación: ${error.message}`);
    }
     return { systemPrompt, history, interpretedIntent, toolResult, dynamicPrompt };
    } catch (error) {
        logger.error(`[${FILE_NAME}] ❌ ERROR FATAL en _prepareConversation: ${error.message}`);
        throw new Error('No se pudo preparar la conversación: ' + error.message);
    }
  }

  async _performFallback(originalModel, userMessage, history, domain, finalSystemPrompt) {
    const FILE_NAME = 'chat-orchestrator.service.js';
    if (!config.router.enableFallback) {
        throw new Error('Fallback is disabled.');
    }
    const fallbackModel = originalModel === 'gemini' ? 'openai' : 'gemini';
    logger.warn(`[${FILE_NAME}] Intentando fallback a ${fallbackModel}...`);
    try {
        let response;
        if (fallbackModel === 'gemini') {
            const thinkingUsed = ModelRouterService.shouldUseThinking(userMessage);
            response = await this.geminiService.generateResponse(userMessage, history, domain, finalSystemPrompt, thinkingUsed);
        } else {
            response = await this.openaiService.generateResponse(userMessage, history, domain, finalSystemPrompt);
        }
        return { response, usedModel: fallbackModel };
    } catch (fallbackError) {
        logger.error(`[${FILE_NAME}] ❌ Fallback también falló: ${fallbackError.message}`);
        return {
            response: {
                message: 'Lo siento, estoy teniendo problemas técnicos en este momento. Por favor, intenta de nuevo en unos momentos.',
                audio_description: 'Lo siento, estoy teniendo problemas técnicos.',
                action: { type: 'none' },
                usage: { input: 0, output: 0, thinking: 0, cached: 0, total: 0 },
                usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, thinkingTokenCount: 0 },
            },
            usedModel: 'error_fallback',
        };
    }
}

  async _finalizeAndPersistConversation({
    response, conversation, userMessage, history, interpretedIntent, toolResult,
    systemPrompt, dynamicPrompt, usedModel, thinkingUsed, fallbackUsed,
    domain, userId, startTime,
  }) {
    const FILE_NAME = 'chat-orchestrator.service.js';
    logger.info(`[${FILE_NAME}] [PASO 4/5 & 5/5] Finalizando y persistiendo...`);

    const productResult = await this.findProductAnywhere({ toolResult, responseMessage: response.message, userMessage, history, conversation, domain });
    if (productResult && productResult.product) {
        this.updateProductContext(conversation, productResult.product);
    }

    let validatedAction = { type: 'none' };
    const assistantMessage = (response.message || '').toLowerCase();
    const isQuestion = assistantMessage.includes('?');
    if (!isQuestion && toolResult && toolResult.tool === 'add_to_cart' && productResult) {
        validatedAction = this.buildActionFromProduct(productResult.product);
    } else if (response.action && response.action.type !== 'none') {
        validatedAction = this.sanitizeAction(response.action);
    }

    const tokenData = {
        input: response.usage?.input || response.usageMetadata?.promptTokenCount || 0,
        output: response.usage?.output || response.usageMetadata?.candidatesTokenCount || 0,
        thinking: response.usage?.thinking || response.usageMetadata?.thinkingTokenCount || 0,
        cached: response.usage?.cached || 0,
        total: 0,
    };
    tokenData.total = tokenData.input + tokenData.output + tokenData.thinking;

    const cost = getTokenUsageModel.calculateCost(
        usedModel === 'error_fallback' ? 'openai' : usedModel,
        usedModel === 'gemini' ? config.gemini.model : config.openai.model,
        tokenData
    );

    conversation.messages.push({ role: 'user', content: userMessage, timestamp: new Date() });

    const promptFull = dynamicPrompt || systemPrompt;
    conversation.messages.push({
        role: 'assistant',
        content: response.message,
        timestamp: new Date(),
        metadata: { model: usedModel, tokens: tokenData, action: validatedAction, promptLength: promptFull.length },
    });

    conversation.metadata.totalMessages = (conversation.metadata.totalMessages || 0) + 2;
    conversation.metadata.totalTokens = (conversation.metadata.totalTokens || 0) + tokenData.total;
    await conversation.save();

    const responseTime = Date.now() - startTime;
    await getTokenUsageModel().create({
        domain, userId, conversationId: conversation._id, provider: usedModel,
        model: usedModel === 'gemini' ? config.gemini.model : config.openai.model,
        tokens: tokenData, cost, metadata: { responseTime, fallbackUsed },
    });

    return {
        message: response.message,
        audio_description: response.audio_description,
        action: validatedAction,
        model_used: usedModel,
        response_time_ms: responseTime,
        conversation_id: conversation._id,
    };
  }

  // ============================================
  // ORIGINAL HELPER METHODS
  // ============================================

  async findProductAnywhere({ toolResult, responseMessage, userMessage, history, conversation, domain }) {
    const FILE_NAME = 'chat-orchestrator.service.js';
    if (toolResult && toolResult.data) {
      if (toolResult.data.products && toolResult.data.products.length > 0) {
        const product = toolResult.data.products[0];
        logger.info(`[${FILE_NAME}] findProductAnywhere() - ✅ Producto encontrado en toolResult: ${product.title}`);
        return { product, source: 'toolResult' };
      } else if (toolResult.data.productId || toolResult.data.id) {
        logger.info(`[${FILE_NAME}] findProductAnywhere() - ✅ Producto encontrado en toolResult: ${toolResult.data.title}`);
        return { product: toolResult.data, source: 'toolResult' };
      }
    }
    if (responseMessage && responseMessage.length > 10) {
      const extracted = await this.extractProductFromMessage(responseMessage, domain);
      if (extracted) {
        logger.info(`[${FILE_NAME}] findProductAnywhere() - ✅ Producto extraído del mensaje asistente: ${extracted.title}`);
        return { product: extracted, source: 'assistant_message' };
      }
    }
    if (userMessage && userMessage.length > 5) {
      const extracted = await this.findProductByNameInMessage(userMessage, domain);
      if (extracted) {
        logger.info(`[${FILE_NAME}] findProductAnywhere() - ✅ Producto extraído del mensaje usuario: ${extracted.title}`);
        return { product: extracted, source: 'user_message' };
      }
    }
    const productInHistory = this.findProductInHistory(history, conversation);
    if (productInHistory && productInHistory.fullData) {
      logger.info(`[${FILE_NAME}] findProductAnywhere() - ✅ Producto encontrado en contexto: ${productInHistory.fullData.title}`);
      return { product: productInHistory.fullData, source: 'conversation_context' };
    }
    return null;
  }

  buildActionFromProduct(product, quantity = 1) {
    return {
      type: 'add_to_cart',
      productId: product.productId || product.id,
      quantity: quantity,
      url: product.slug ? `/product/${product.slug}` : null,
      price_sale: product.price?.sale || product.price?.regular || null,
      title: product.title || null,
      price_regular: product.price?.regular || null,
      image: (product.image || (product.images && product.images[0])) || null,
      slug: product.slug || null,
    };
  }

  async getOrCreateConversation(userId, domain) {
    const Conversation = getConversationModel();
    let conversation = await Conversation.findOne({
      userId,
      domain,
      status: 'active',
    }).sort({ updatedAt: -1 });

    if (!conversation) {
      conversation = await Conversation.create({
        userId,
        domain,
        messages: [],
        status: 'active',
        metadata: { totalMessages: 0, totalTokens: 0, modelsUsed: {}, averageResponseTime: 0 }
      });
    } else if (!conversation.metadata) {
        conversation.metadata = { totalMessages: 0, totalTokens: 0, modelsUsed: {}, averageResponseTime: 0 };
    }
    if (!conversation.messages) {
        conversation.messages = [];
    }
    return conversation;
  }

  getRecentHistory(conversation) {
    const messages = conversation.messages || [];
    if (messages.length === 0) return [];
    const systemMessage = messages[0].role === 'system' ? [messages[0]] : [];
    const conversationMessages = messages.slice(systemMessage.length);
    const recentMessages = conversationMessages.slice(-6);
    return [...systemMessage, ...recentMessages];
  }

  sanitizeAction(action) {
    if (!action || !action.type) {
      return { type: 'none' };
    }
    return {
      type: action.type,
      productId: action.productId || null,
      quantity: action.quantity || null,
      url: action.url || null,
      price_sale: action.price_sale || null,
      title: action.title || null,
      price_regular: action.price_regular || null,
      image: action.image || null,
      slug: action.slug || null,
    };
  }

  async closeConversation(conversationId) {
    const Conversation = getConversationModel();
    await Conversation.findByIdAndUpdate(conversationId, { status: 'closed' });
    logger.info(`[Orchestrator] Closed conversation ${conversationId}`);
  }

  detectLanguage(message) {
    const spanishWords = ['qué', 'cómo', 'cuándo', 'dónde', 'por qué'];
    const lowerMessage = message.toLowerCase();
    if (spanishWords.some(word => lowerMessage.includes(word))) {
      return 'es';
    }
    return 'en';
  }

  updateProductContext(conversation, productData) {
    if (!conversation || !productData) return;
    conversation.metadata.lastProductContext = {
      productId: productData.productId || productData.id || null,
      slug: productData.slug || null,
      title: productData.title || null,
      updatedAt: new Date(),
    };
  }

  async findProductByNameInMessage(message, domain) {
    // Simplified stub
    return null;
  }

  async extractProductFromMessage(message, domain) {
    // Simplified stub
    return null;
  }

  findProductInHistory(history, conversation = null) {
    if (conversation?.metadata?.lastProductContext?.productId) {
      return {
        productId: conversation.metadata.lastProductContext.productId,
        fullData: conversation.metadata.lastProductContext,
      };
    }
    // Simplified stub
    return null;
  }

  buildDynamicPrompt(intent, toolResult, baseSystemPrompt, domain) {
    const shortPrompt = PromptMemoryService.buildShortSystemPrompt(domain);
    let contextualInfo = '';
    if (intent === 'search_products' && toolResult.data?.products?.length > 0) {
        contextualInfo = `\n\nINFORMACIÓN RELEVANTE:\n` + toolResult.data.products.map(p => p.title).join(', ');
    }
    return `${shortPrompt}${contextualInfo}`;
  }

  async getUsageStats(domain, startDate, endDate) {
    // Simplified stub
    return [];
  }
}

module.exports = ChatOrchestratorService;
