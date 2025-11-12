/**
 * ============================================
 * CHAT ORCHESTRATOR SERVICE
 * ============================================
 * Orquesta la comunicación entre el router, los modelos
 * y la persistencia de conversaciones
 * 
 * MEJORA CLAVE: Memoriza el system prompt y lo mantiene
 * en el historial para evitar reenviarlo en cada mensaje
 */

const GeminiAgentService = require('./gemini-agent.service');
const OpenAIAgentService = require('./openai-agent.service');
const GroqAgentService = require('./groq-agent.service');
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
    // Inicializar Groq solo si está habilitado y tiene API key
    if (config.groq?.enabled && config.groq?.apiKey) {
      this.groqService = new GroqAgentService();
    } else {
      this.groqService = null;
    }
  }

  /**
   * Detecta si un mensaje es una despedida
   * @param {string} message - Mensaje del usuario
   * @returns {boolean}
   */
  isFarewellMessage(toolResults) {
    // ENFOQUE: La IA decide si es una despedida usando la herramienta is_farewell
    // Ya no usamos expresiones regulares, confiamos en la decisión del LLM
    if (!toolResults || toolResults.length === 0) {
      return false;
    }

    return toolResults.some(tool => tool.functionName === 'is_farewell');
  }

  async processMessageStream({ userMessage, userId, domain, forceModel = null, res }) {
    const startTime = Date.now();
    const FILE_NAME = 'chat-orchestrator.service.js';

    // Configurar headers SSE ANTES de cualquier operación
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Deshabilitar buffering de nginx

    let conversation;
    try {
        conversation = await this.getOrCreateConversation(userId, domain);
        const { history } = await this._prepareConversation(userMessage, conversation, domain);

        let selectedModel = forceModel || ModelRouterService.decideModel(userMessage, history);

        // OPTIMIZACIÓN: Solo aplicar optimización automática si forceModel no fue especificado
        // Si el usuario especifica forceModel explícitamente, respetar su elección
        if (!forceModel || forceModel === 'auto') {
            const message = userMessage.toLowerCase().trim();
            const isProductSearch = ModelRouterService.detectsProductIntent(message);
            if (selectedModel === 'groq' && isProductSearch) {
                // Si es búsqueda de productos, usar Gemini directamente (más rápido)
                selectedModel = 'gemini';
            }
        }

        let stream;
        let usagePromise = null;
        let usedModel = selectedModel;
        let thinkingUsed = false;
        let fallbackUsed = false;

        try {
            if (selectedModel === 'groq') {
                if (!this.groqService) {
                    throw new Error('Groq service no está disponible. Configura GROQ_API_KEY y ENABLE_GROQ_FALLBACK=true');
                }
                const groqResponse = await this.groqService.generateResponse(userMessage, history, domain, null);
                usedModel = 'groq';
                
                // Simular streaming para Groq para una experiencia de usuario consistente
                await this._pseudoStreamText(res, groqResponse.message);
                
                const toolsUsed = groqResponse.functionResults && groqResponse.functionResults.length > 0;
                await this._finalizeAndPersistConversation({
                    response: {
                        message: groqResponse.message,
                        usage: groqResponse.usage,
                        usageMetadata: groqResponse.usageMetadata,
                        functionResults: groqResponse.functionResults || [],
                    },
                    conversation,
                    userMessage,
                    history,
                    interpretedIntent: { intent: toolsUsed ? 'tool_used' : 'general_chat', method: 'function_calling' },
                    toolResult: null,
                    toolResults: groqResponse.functionResults || [],
                    systemPrompt: null,
                    dynamicPrompt: null,
                    usedModel: 'groq',
                    thinkingUsed: false,
                    fallbackUsed: false,
                    domain,
                    userId,
                    startTime,
                });
                return;
            } else if (selectedModel === 'gemini') {
                thinkingUsed = ModelRouterService.shouldUseThinking(userMessage);
                const geminiResult = await this.geminiService.generateResponseStream(userMessage, history, domain, null, thinkingUsed);
                stream = geminiResult.stream;
                usagePromise = geminiResult.usagePromise;
            } else {
                stream = await this.openaiService.generateResponseStream(userMessage, history, domain, null);
            }
        } catch (error) {
            logger.error(`[${FILE_NAME}] ❌ Error inicial en stream con ${selectedModel}: ${error.message}`);
            fallbackUsed = true;
            try {
                const fallbackModel = selectedModel === 'gemini' ? 'openai' : 'gemini';
                logger.warn(`[${FILE_NAME}] Intentando fallback de stream a ${fallbackModel}...`);
                if (fallbackModel === 'gemini') {
                    thinkingUsed = ModelRouterService.shouldUseThinking(userMessage);
                    const geminiResult = await this.geminiService.generateResponseStream(userMessage, history, domain, null, thinkingUsed);
                    stream = geminiResult.stream;
                    usagePromise = geminiResult.usagePromise;
                } else {
                    stream = await this.openaiService.generateResponseStream(userMessage, history, domain, null);
                }
                usedModel = fallbackModel;
            } catch (fallbackError) {
                logger.error(`[${FILE_NAME}] ❌ Fallback de stream también falló: ${fallbackError.message}`);
                
                // Intentar fallback a LLM gratuito (Groq) si está habilitado
                if (config.router.enableFreeFallback && this.groqService) {
                    logger.warn(`[${FILE_NAME}] 🆓🆓🆓 INTENTANDO FALLBACK A LLM GRATUITO (Groq) EN STREAM...`);
                    try {
                    // Groq no soporta streaming directamente, usar respuesta normal
                    const groqResponse = await this.groqService.generateResponse(userMessage, history, domain, null);
                    const toolsUsed = groqResponse.functionResults && groqResponse.functionResults.length > 0;
                    
                    // ENFOQUE: Function calling puro - La IA decide qué tools usar
                    // Confiamos completamente en la decisión de la IA, sin validación algorítmica
                    
                    // Simular streaming para una experiencia de usuario consistente
                    await this._pseudoStreamText(res, groqResponse.message);
                    usedModel = 'groq';
                    
                    // Continuar con la persistencia
                    const responseForPersistence = {
                        message: groqResponse.message,
                        usage: groqResponse.usage,
                        usageMetadata: groqResponse.usageMetadata,
                        functionResults: groqResponse.functionResults || [],
                    };
                    await this._finalizeAndPersistConversation({
                        response: responseForPersistence,
                        conversation,
                        userMessage,
                        history,
                        interpretedIntent: { intent: toolsUsed ? 'tool_used' : 'general_chat', method: 'function_calling' },
                        toolResult: null,
                        toolResults: groqResponse.functionResults || [],
                        systemPrompt: null,
                        dynamicPrompt: null,
                        usedModel: 'groq',
                        thinkingUsed: false,
                        fallbackUsed: true,
                        domain,
                        userId,
                        startTime,
                    });
                    return;
                    } catch (groqError) {
                        logger.error(`[${FILE_NAME}] ❌❌❌ FALLBACK GRATUITO EN STREAM TAMBIÉN FALLÓ: ${groqError.message}`);
                        logger.error(`[${FILE_NAME}] ❌ Código de error de Groq: ${groqError.response?.status || groqError.status || 'N/A'}`);
                        logger.error(`[${FILE_NAME}] ❌❌❌ TODOS LOS MODELOS FALLARON EN STREAM`);
                    }
                }
                
                // Si llegamos aquí, todos los modelos fallaron
                if (!res.headersSent) {
                    res.write('event: error\ndata: {"message": "Lo siento, estoy teniendo problemas técnicos."}\n\n');
                }
                return;
            }
        }

        let fullResponseMessage = '';
        let tokenData = { input: 0, output: 0, thinking: 0, cached: 0, total: 0 };

        if (usedModel === 'openai') {
            for await (const chunk of stream) {
                if (chunk.usage) {
                    tokenData = {
                        input: chunk.usage.prompt_tokens || 0,
                        output: chunk.usage.completion_tokens || 0,
                        total: chunk.usage.total_tokens || 0,
                        cached: 0, thinking: 0,
                    };
                }
                const content = chunk.choices[0]?.delta?.content || '';
                if (content) {
                    fullResponseMessage += content;
                    res.write(`data: ${JSON.stringify({ message: content })}\n\n`);
                }
            }
        } else { // Gemini
            for await (const chunk of stream) {
                let content = '';
                // Gemini puede devolver chunks de diferentes formas
                if (typeof chunk.text === 'function') {
                    content = chunk.text();
                } else if (typeof chunk.text === 'string') {
                    content = chunk.text;
                } else if (chunk.candidates && chunk.candidates[0] && chunk.candidates[0].content) {
                    // Formato alternativo de Gemini
                    const parts = chunk.candidates[0].content.parts;
                    if (parts && parts[0] && parts[0].text) {
                        content = parts[0].text;
                    }
                }
                if (content) {
                    fullResponseMessage += content;
                    res.write(`data: ${JSON.stringify({ message: content })}\n\n`);
                }
            }
            if (usagePromise) {
                try {
                    tokenData = await usagePromise;
                } catch (error) {
                    logger.error(`[${FILE_NAME}] Error obteniendo usage de Gemini: ${error.message}`);
                }
            }
        }

        const responseForPersistence = {
            message: fullResponseMessage,
            usage: tokenData,
            usageMetadata: {}, // Let _finalizeAndPersistConversation handle this from usage
        };

        await this._finalizeAndPersistConversation({
            response: responseForPersistence,
            conversation,
            userMessage,
            history,
            interpretedIntent: { intent: 'general_chat', method: 'function_calling' },
            toolResult: null,
            toolResults: [],
            systemPrompt: null,
            dynamicPrompt: null,
            usedModel,
            thinkingUsed,
            fallbackUsed,
            domain,
            userId,
            startTime,
        });

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
        // ENFOQUE: Function calling puro
        // - System prompt SIEMPRE corto (solo instrucciones)
        // - NO incluimos información de empresa/catálogo en el prompt
        // - La IA obtiene TODO usando tools dinámicamente
        // - Esto previene alucinaciones y asegura información actualizada
        
        let history = this.getRecentHistory(conversation);

        // Si es una nueva sesión, agregar un contexto simple para que la IA sepa cómo saludar
        if (conversation._isNewSession && history.length === 0) {
          const contextMessage = conversation._hasPreviousHistory
            ? "CONTEXTO: Nueva sesión. El usuario ya tiene historial previo."
            : "CONTEXTO: Nueva sesión. Es la primera conversación del usuario.";

          // Agregar como mensaje de sistema al inicio del historial para que la IA lo vea
          history.unshift({
            role: 'system',
            content: contextMessage,
          });
        }

        // NO construimos systemPrompt aquí, los agentes lo construirán dinámicamente
        // usando buildShortSystemPrompt() que solo tiene instrucciones (sin datos)
        return { systemPrompt: null, history, interpretedIntent: null, toolResult: null, dynamicPrompt: null };
    } catch (error) {
        logger.error(`[${FILE_NAME}] ❌ ERROR FATAL en _prepareConversation: ${error.message}`);
        throw new Error('No se pudo preparar la conversación: ' + error.message);
    }
  }

  async _performFallback(originalModel, userMessage, history, domain, systemPrompt) {
    const FILE_NAME = 'chat-orchestrator.service.js';
    if (!config.router.enableFallback) {
        logger.error(`[${FILE_NAME}] ❌ Fallback está deshabilitado en configuración`);
        throw new Error('Fallback is disabled.');
    }
    const fallbackModel = originalModel === 'gemini' ? 'openai' : 'gemini';
    logger.warn(`[${FILE_NAME}] 🔄 FALLBACK: Intentando responder con ${fallbackModel} (falló ${originalModel})...`);
    try {
        let response;
        if (fallbackModel === 'gemini') {
            const thinkingUsed = ModelRouterService.shouldUseThinking(userMessage);
            response = await this.geminiService.generateResponse(userMessage, history, domain, null, thinkingUsed);
          } else {
            response = await this.openaiService.generateResponse(userMessage, history, domain, null);
        }
        return { response, usedModel: fallbackModel };
    } catch (fallbackError) {
        logger.error(`[${FILE_NAME}] ❌❌❌ FALLBACK TAMBIÉN FALLÓ: ${fallbackError.message}`);
        logger.error(`[${FILE_NAME}] ❌ Código de error del fallback: ${fallbackError.status || fallbackError.code || 'N/A'}`);
        logger.error(`[${FILE_NAME}] ❌❌❌ AMBOS MODELOS (${originalModel} y ${fallbackModel}) FALLARON`);
        
        // Intentar fallback a LLM gratuito (Groq) si está habilitado
        if (config.router.enableFreeFallback && this.groqService) {
            logger.warn(`[${FILE_NAME}] 🆓🆓🆓 INTENTANDO FALLBACK A LLM GRATUITO (Groq)...`);
            try {
                const groqResponse = await this.groqService.generateResponse(userMessage, history, domain, null);
                return { response: groqResponse, usedModel: 'groq' };
            } catch (groqError) {
                logger.error(`[${FILE_NAME}] ❌❌❌ FALLBACK GRATUITO TAMBIÉN FALLÓ: ${groqError.message}`);
                logger.error(`[${FILE_NAME}] ❌ Código de error de Groq: ${groqError.response?.status || groqError.status || 'N/A'}`);
                logger.error(`[${FILE_NAME}] ❌❌❌ TODOS LOS MODELOS (${originalModel}, ${fallbackModel} y groq) FALLARON`);
          }
        } else {
            if (!config.router.enableFreeFallback) {
                logger.warn(`[${FILE_NAME}] ⚠️ Fallback a LLM gratuito está deshabilitado (ENABLE_FREE_LLM_FALLBACK=false)`);
            }
            if (!this.groqService) {
                logger.warn(`[${FILE_NAME}] ⚠️ Groq no está disponible (no configurado o deshabilitado)`);
            }
        }
        
        // Si llegamos aquí, todos los modelos fallaron
        logger.error(`[${FILE_NAME}] ❌❌❌ TODOS LOS MODELOS FALLARON - Retornando respuesta de error`);
        logger.warn(`[${FILE_NAME}] ⚠️⚠️⚠️ Retornando respuesta de error con usedModel='error_fallback' (NO es un éxito)`);
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
    response, conversation, userMessage, history, interpretedIntent, toolResult, toolResults,
    systemPrompt, dynamicPrompt, usedModel, thinkingUsed, fallbackUsed,
    domain, userId, startTime,
  }) {
    const FILE_NAME = 'chat-orchestrator.service.js';

    // Validar que response existe
    if (!response || typeof response !== 'object') {
        logger.error(`[${FILE_NAME}] ❌ Response es inválido: ${JSON.stringify(response)}`);
        response = {
            message: 'Lo siento, estoy teniendo problemas técnicos en este momento. Por favor, intenta de nuevo en unos momentos.',
            audio_description: 'Lo siento, estoy teniendo problemas técnicos.',
            action: { type: 'none', productId: null, quantity: null, url: null, price_sale: null, title: null, price_regular: null, image: null, slug: null },
            usage: { input: 0, output: 0, thinking: 0, cached: 0, total: 0 },
            usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, thinkingTokenCount: 0 },
        };
        usedModel = 'error_fallback';
    }

    // OPTIMIZACIÓN: Solo buscar productos si no hay toolResults (la IA ya los obtuvo)
    // Si hay toolResults, usar esos productos directamente sin búsquedas adicionales en BD
    let productResult = null;
    if (toolResults && toolResults.length > 0) {
        // La IA ya obtuvo productos de las herramientas - usar esos directamente
        const firstToolResult = toolResults[0];
        if (firstToolResult && firstToolResult.result) {
            if (firstToolResult.result.products && firstToolResult.result.products.length > 0) {
                productResult = { 
                    product: firstToolResult.result.products[0], 
                    source: 'toolResults' 
                };
            } else if (firstToolResult.result.id || firstToolResult.result.productId) {
                productResult = { 
                    product: firstToolResult.result, 
                    source: 'toolResults' 
                };
            }
        }
    }
    
    // Solo buscar en BD si no hay toolResults (fallback)
    if (!productResult) {
        productResult = await this.findProductAnywhere({ toolResult, responseMessage: response.message, userMessage, history, conversation, domain });
    }
    
    if (productResult && productResult.product) {
        this.updateProductContext(conversation, productResult.product);
    }

    // ENFOQUE: La IA construye el action completo según el contexto
    // El sistema solo valida y completa campos faltantes si es necesario, pero respeta la decisión de la IA
    let validatedAction = { type: 'none', productId: null, quantity: null, url: null, price_sale: null, title: null, price_regular: null, image: null, slug: null };
    
    if (usedModel === 'error_fallback') {
        // No construir acción para errores
        validatedAction = { type: 'none', productId: null, quantity: null, url: null, price_sale: null, title: null, price_regular: null, image: null, slug: null };
    } else if (response.action && response.action.type) {
        // La IA construyó un action - validar y completar solo si es necesario
        validatedAction = this.sanitizeAction(response.action);
        
        // Si el action es add_to_cart pero le faltan datos, completar desde productResult
        if (validatedAction.type === 'add_to_cart' && productResult && productResult.product) {
            const product = productResult.product;
            
            // Completar campos faltantes desde el producto encontrado
            if (!validatedAction.productId) validatedAction.productId = product.productId || product.id || product._id;
            if (!validatedAction.title) validatedAction.title = product.title;
            if (!validatedAction.slug) validatedAction.slug = product.slug;
            if (!validatedAction.price_regular) validatedAction.price_regular = product.price?.regular || null;
            if (!validatedAction.price_sale) validatedAction.price_sale = product.price?.sale || product.price?.regular || null;
            if (!validatedAction.image) validatedAction.image = (product.image || (product.images && product.images[0]) || product.image_default) || null;
            if (!validatedAction.url && validatedAction.slug) validatedAction.url = `/product/${validatedAction.slug}`;
            if (!validatedAction.quantity) validatedAction.quantity = 1;
        } else if (validatedAction.type === 'add_to_cart') {
            // La IA quiere add_to_cart pero no hay producto en el contexto
            // Validar que tenga al menos productId y title
            if (!validatedAction.productId || !validatedAction.title) {
                logger.warn(`[${FILE_NAME}] ⚠️ Acción add_to_cart incompleta (falta productId o title), cambiando a none`);
                validatedAction = { type: 'none', productId: null, quantity: null, url: null, price_sale: null, title: null, price_regular: null, image: null, slug: null };
            }
        }
    } else {
        // La IA no incluyó action o está vacío - usar none por defecto
        validatedAction = { type: 'none', productId: null, quantity: null, url: null, price_sale: null, title: null, price_regular: null, image: null, slug: null };
    }
    
    // Validar que el mensaje incluya una pregunta (embudo de compra)
    // EXCEPCIÓN: No validar si el usuario se está despidiendo (decidido por el LLM)
    const assistantMessage = response.message || '';
    const hasQuestion = assistantMessage.includes('?');
    const isFarewell = this.isFarewellMessage(toolResults);
    
    if (isFarewell && !hasQuestion) {
      logger.info(`[${FILE_NAME}] ✓ Respuesta de despedida detectada (vía tool is_farewell) - no se requiere pregunta`);
    } else if (!hasQuestion && usedModel !== 'error_fallback' && !isFarewell) {
      // Ya no es una advertencia crítica, solo una nota informativa
      logger.info(`[${FILE_NAME}] ⓘ La respuesta no terminó en pregunta. Es aceptable si la conversación fluye naturalmente.`);
    }

    // Si el usuario se despidió, marcar la conversación como closed después de responder
    if (isFarewell && conversation && !conversation.isInMemory) {
        // Marcar para cerrar después de guardar los mensajes
        conversation._shouldCloseAfterSave = true;
    }

    // Construir tokenData con valores por defecto seguros
    // IMPORTANTE: Asegurar que tokenData siempre tenga la estructura correcta
    let tokenData = {
        input: 0,
        output: 0,
        thinking: 0,
        cached: 0,
        total: 0,
    };

    try {
        // Intentar extraer datos de usage
        if (response && response.usage && typeof response.usage === 'object') {
            tokenData.input = (typeof response.usage.input === 'number' && !isNaN(response.usage.input)) ? response.usage.input : 0;
            tokenData.output = (typeof response.usage.output === 'number' && !isNaN(response.usage.output)) ? response.usage.output : 0;
            tokenData.thinking = (typeof response.usage.thinking === 'number' && !isNaN(response.usage.thinking)) ? response.usage.thinking : 0;
            tokenData.cached = (typeof response.usage.cached === 'number' && !isNaN(response.usage.cached)) ? response.usage.cached : 0;
        }
        
        // Intentar extraer datos de usageMetadata si usage no tiene datos
        if ((tokenData.input === 0 && tokenData.output === 0) && response && response.usageMetadata && typeof response.usageMetadata === 'object') {
            tokenData.input = (typeof response.usageMetadata.promptTokenCount === 'number' && !isNaN(response.usageMetadata.promptTokenCount)) ? response.usageMetadata.promptTokenCount : 0;
            tokenData.output = (typeof response.usageMetadata.candidatesTokenCount === 'number' && !isNaN(response.usageMetadata.candidatesTokenCount)) ? response.usageMetadata.candidatesTokenCount : 0;
            tokenData.thinking = (typeof response.usageMetadata.thinkingTokenCount === 'number' && !isNaN(response.usageMetadata.thinkingTokenCount)) ? response.usageMetadata.thinkingTokenCount : 0;
        }
        
        tokenData.total = tokenData.input + tokenData.output + tokenData.thinking;
    } catch (error) {
        logger.error(`[${FILE_NAME}] ❌ Error construyendo tokenData: ${error.message}`);
        // Asegurar valores por defecto
        tokenData = { input: 0, output: 0, thinking: 0, cached: 0, total: 0 };
    }

    // Validación final: asegurar que todas las propiedades son números válidos
    if (!tokenData || typeof tokenData !== 'object' || 
        typeof tokenData.input !== 'number' || isNaN(tokenData.input) ||
        typeof tokenData.output !== 'number' || isNaN(tokenData.output)) {
        logger.warn(`[${FILE_NAME}] ⚠️ tokenData inválido después de construcción, usando valores por defecto. Response: ${JSON.stringify(response?.usage || response?.usageMetadata || 'no usage data')}`);
        tokenData = { input: 0, output: 0, thinking: 0, cached: 0, total: 0 };
    }

    // Calcular costo de forma segura
    // IMPORTANTE: Si usedModel es 'error_fallback', no calcular costo (no hubo llamada real a API)
    let cost;
    if (usedModel === 'error_fallback') {
        // No calcular costo si ambos modelos fallaron
        cost = { input: 0, output: 0, cached: 0, thinking: 0, total: 0, currency: 'USD' };
    } else {
        try {
            const TokenUsage = getTokenUsageModel();
            const modelName = usedModel === 'gemini' ? config.gemini.model : 
                            usedModel === 'groq' ? config.groq.model : 
                            config.openai.model;
            cost = TokenUsage.calculateCost(usedModel, modelName, tokenData);
        } catch (costError) {
            logger.error(`[${FILE_NAME}] ❌ Error calculando costo: ${costError.message}`);
            // Costo por defecto
            cost = { input: 0, output: 0, cached: 0, thinking: 0, total: 0, currency: 'USD' };
        }
    }

    conversation.messages.push({ role: 'user', content: userMessage, timestamp: new Date() });

    // Preparar metadata con auditoría completa
    const promptFull = dynamicPrompt || systemPrompt || '';
    let promptType = 'system';
    if (dynamicPrompt) {
        promptType = 'system+dynamic';
    } else if (systemPrompt) {
        const shortPrompt = PromptMemoryService.buildShortSystemPrompt(domain);
        const shortPromptLength = shortPrompt.length;
        if (systemPrompt.length <= shortPromptLength * 1.5 && systemPrompt.length >= shortPromptLength * 0.8) {
            promptType = 'short';
        } else {
            promptType = 'system';
        }
    }
    const promptHashForAudit = systemPrompt ? crypto.createHash('md5').update(systemPrompt).digest('hex').substring(0, 8) : null;

    const assistantMetadata = {
          model: usedModel,
          tokens: tokenData,
        thinkingUsed: thinkingUsed || false,
          cachedTokens: tokenData.cached,
          action: validatedAction,
        prompt: promptFull,
        promptType: promptType,
        promptLength: promptFull.length,
        systemPromptHash: promptHashForAudit,
        intent_interpreted: interpretedIntent,
        tool_executed: toolResults || [], // Usar toolResults (plural) que es el array completo
    };

    // MEJORA: Extraer información de productos de functionResults para incluir en el historial
    // Esto permite que la IA tenga contexto de productos mencionados en mensajes anteriores
    const mentionedProducts = [];
    
    // Asegurar que toolResults esté definido (puede ser undefined si no se pasó)
    const safeToolResults = toolResults || [];
    
    // Extraer productos de functionResults (resultados de herramientas)
    if (safeToolResults && Array.isArray(safeToolResults) && safeToolResults.length > 0) {
        for (const toolResult of safeToolResults) {
            if (toolResult.result && toolResult.result.products && Array.isArray(toolResult.result.products)) {
                // Múltiples productos (búsqueda)
                for (const product of toolResult.result.products) {
                    if (product.id || product._id) {
                        mentionedProducts.push({
                            productId: product.id || product._id,
                            slug: product.slug || null,
                            title: product.title || null,
                        });
                    }
                }
            } else if (toolResult.result && (toolResult.result.id || toolResult.result._id || toolResult.result.productId)) {
                // Producto individual (detalles, precio)
                mentionedProducts.push({
                    productId: toolResult.result.id || toolResult.result._id || toolResult.result.productId,
                    slug: toolResult.result.slug || null,
                    title: toolResult.result.title || null,
                });
            }
        }
    }
    
    // Extraer productos de toolResult (formato antiguo)
    if (toolResult && toolResult.data) {
        if (toolResult.data.products && Array.isArray(toolResult.data.products)) {
            for (const product of toolResult.data.products) {
                if (product.id || product._id) {
                    mentionedProducts.push({
                        productId: product.id || product._id,
                        slug: product.slug || null,
                        title: product.title || null,
                    });
                }
            }
        } else if (toolResult.data.productId || toolResult.data.id || toolResult.data._id) {
            mentionedProducts.push({
                productId: toolResult.data.productId || toolResult.data.id || toolResult.data._id,
                slug: toolResult.data.slug || null,
                title: toolResult.data.title || null,
            });
        }
    }
    
    // Eliminar duplicados por productId
    const uniqueProducts = mentionedProducts.filter((product, index, self) => 
        index === self.findIndex(p => p.productId === product.productId)
    );
    
    // Guardar información de productos en metadata
    if (uniqueProducts.length > 0) {
        assistantMetadata.mentionedProducts = uniqueProducts;
        assistantMetadata.lastProductShown = uniqueProducts[0]; // Primer producto para compatibilidad
    }
    
    // Si hay acción validada, agregar ese producto también
    if (validatedAction && validatedAction.type !== 'none' && validatedAction.productId && validatedAction.title) {
        const actionProduct = {
            productId: validatedAction.productId,
            slug: validatedAction.slug || null,
            title: validatedAction.title || null,
        };
        
        // Agregar si no existe ya
        if (!uniqueProducts.find(p => p.productId === actionProduct.productId)) {
            if (!assistantMetadata.mentionedProducts) {
                assistantMetadata.mentionedProducts = [];
            }
            assistantMetadata.mentionedProducts.push(actionProduct);
        }
        
        if (!assistantMetadata.lastProductShown) {
            assistantMetadata.lastProductShown = actionProduct;
        }
    }

    // El mensaje del asistente se guarda limpio, sin contexto técnico adicional
    const cleanMessage = (response.message || '').replace(/\[CONTEXTO_PRODUCTOS:[^\]]+\]/g, '').trim();

    conversation.messages.push({
        role: 'assistant',
        content: cleanMessage, // Usar el mensaje limpio
        timestamp: new Date(),
        metadata: assistantMetadata,
    });

    // MEJORA: El contexto del producto se inyecta como un mensaje de sistema separado.
    // Se usa un formato simple y claro (tipo atributo) para que la IA lo pueda parsear fácilmente.
    if (uniqueProducts.length > 0) {
      const contextAttributes = uniqueProducts.map(p =>
        `productId="${p.productId || ''}" slug="${p.slug || ''}" title="${p.title || ''}"`
      ).join(' ');

      conversation.messages.push({
        role: 'system',
        content: `[CONTEXTO ${contextAttributes}]`,
        timestamp: new Date(),
        metadata: { type: 'product_context' },
      });
    }

    // Asegurar que metadata existe (para conversaciones en memoria)
    if (!conversation.metadata) {
        conversation.metadata = {
            totalMessages: 0,
            totalTokens: 0,
            cachedTokens: 0,
            modelsUsed: { gemini: 0, openai: 0, groq: 0 },
            averageResponseTime: 0,
        };
    }

    // Actualizar metadata de conversación (completo)
    conversation.metadata.totalMessages = (conversation.metadata.totalMessages || 0) + 2;
    conversation.metadata.totalTokens = (conversation.metadata.totalTokens || 0) + tokenData.total;
    conversation.metadata.cachedTokens = (conversation.metadata.cachedTokens || 0) + tokenData.cached;
    conversation.metadata.modelsUsed = conversation.metadata.modelsUsed || { gemini: 0, openai: 0, groq: 0 };
    conversation.metadata.modelsUsed[usedModel] = (conversation.metadata.modelsUsed[usedModel] || 0) + 1;

      const responseTime = Date.now() - startTime;
      conversation.metadata.averageResponseTime = 
        (conversation.metadata.averageResponseTime + responseTime) / 2;

    // Guardar conversación con manejo de errores de MongoDB
    // OPTIMIZACIÓN: Persistencia asíncrona (no bloquear la respuesta)
    // Guardar en background para reducir tiempo de respuesta en 200-1000ms
    setImmediate(async () => {
        try {
            // Guardar conversación con manejo de errores de MongoDB
            if (!conversation.isInMemory) {
                await conversation.save();
                
                // Si el usuario se despidió, cerrar la conversación
                if (conversation._shouldCloseAfterSave) {
                    const Conversation = getConversationModel();
                    await Conversation.findByIdAndUpdate(conversation._id, {
                        status: 'closed',
                    });
                    logger.info(`[${FILE_NAME}] ✓ Conversación ${conversation._id} cerrada por despedida del usuario`);
                }
            } else {
                logger.warn(`[${FILE_NAME}] ⚠️ Conversación en memoria, no se guarda en MongoDB`);
            }
        } catch (saveError) {
            logger.error(`[${FILE_NAME}] ❌ Error guardando conversación (async): ${saveError.message}`);
        }

        // Guardar métricas de tokens (no crítico si falla)
        try {
            const isValidProvider = usedModel === 'gemini' || usedModel === 'openai' || usedModel === 'groq';
            const hasValidConversationId = conversation._id && !conversation.isInMemory;
            
            if (hasValidConversationId && isValidProvider) {
                const TokenUsage = getTokenUsageModel();
                const modelName = usedModel === 'gemini' ? config.gemini.model : 
                                usedModel === 'groq' ? config.groq.model : 
                                config.openai.model;
                const tokenUsageData = {
                    domain,
                    userId,
                    conversationId: conversation._id,
                    provider: usedModel,
                    model: modelName,
                    tokens: tokenData,
                    cost,
                    metadata: {
                        responseTime,
                        fallbackUsed,
                        thinkingUsed: thinkingUsed || false,
                    },
                };
                
                await TokenUsage.create(tokenUsageData);
            }
        } catch (tokenError) {
            logger.error(`[${FILE_NAME}] ❌ Error guardando métricas de tokens (async): ${tokenError.message}`);
            if (tokenError.name === 'ValidationError') {
                logger.error(`[${FILE_NAME}] ❌ Error de validación: ${JSON.stringify(tokenError.errors || {})}`);
            }
        }
    });

      // Limpiar el mensaje antes de devolverlo al usuario (remover [CONTEXTO_PRODUCTOS])
      const cleanMessageForUser = (response.message || '').replace(/\[CONTEXTO_PRODUCTOS:[^\]]+\]/g, '').trim();
      
      return {
        message: cleanMessageForUser, // Mensaje limpio sin [CONTEXTO_PRODUCTOS]
        audio_description: response.audio_description || cleanMessageForUser,
        action: validatedAction,
        model_used: usedModel,
        tokens: tokenData,
        cost,
        response_time_ms: responseTime,
        conversation_id: conversation._id || null, // Puede ser null si es conversación en memoria
        thinking_used: thinkingUsed,
        fallback_used: fallbackUsed,
        intent_interpreted: interpretedIntent,
        tool_executed: toolResult,
    };
  }

  /**
   * Busca un producto en TODOS los lugares posibles (función unificada)
   * Prioridad: toolResult > mensaje asistente > mensaje usuario > contexto persistente
   */
  async findProductAnywhere({ toolResult, responseMessage, userMessage, history, conversation, domain }) {
    const FILE_NAME = 'chat-orchestrator.service.js';

    // PRIORIDAD 1: Producto del toolResult (más confiable)
    if (toolResult && toolResult.data) {
      if (toolResult.data.products && toolResult.data.products.length > 0) {
        const product = toolResult.data.products[0];
        return { product, source: 'toolResult' };
      } else if (toolResult.data.productId || toolResult.data.id) {
        return { product: toolResult.data, source: 'toolResult' };
      }
    }

    // OPTIMIZACIÓN: Solo buscar en BD si es realmente necesario (último recurso)
    // Las búsquedas en BD son lentas, preferir usar contexto de conversación
    
    // PRIORIDAD 2: Producto del contexto persistente (rápido, sin BD)
    const productInHistory = this.findProductInHistory(history, conversation);
    if (productInHistory && productInHistory.fullData) {
      return { product: productInHistory.fullData, source: 'conversation_context' };
    }

    // PRIORIDAD 3: Búsquedas en BD solo si no hay contexto (LENTO - evitar si es posible)
    // Estas búsquedas pueden tardar 500ms-2000ms cada una
    // Solo hacer si realmente es necesario
    
    // Comentado para optimizar - las búsquedas en BD son muy lentas
    // Si la IA no obtuvo productos de las herramientas, probablemente no hay producto relevante
    /*
    if (responseMessage && responseMessage.length > 10) {
      const extracted = await this.extractProductFromMessage(responseMessage, domain);
      if (extracted) {
        return { product: extracted, source: 'assistant_message' };
      }
    }

    if (userMessage && userMessage.length > 5) {
      const extracted = await this.findProductByNameInMessage(userMessage, domain);
      if (extracted) {
        return { product: extracted, source: 'user_message' };
      }
    }
    */

    return null;
  }

  /**
   * Construye una acción add_to_cart desde un producto
   */
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

  /**
   * Procesa un mensaje del usuario (VERSIÓN OPTIMIZADA - 5 PASOS)
   *
   * PASO 1: PREPARACIÓN (Conversación, System Prompt, Historial)
   * PASO 2: INTERPRETACIÓN Y TOOLS (Intención, Tools, Prompt Dinámico)
   * PASO 3: GENERACIÓN (Modelo, Respuesta, Fallback)
   * PASO 4: VALIDACIÓN (Construcción de Acción)
   * PASO 5: PERSISTENCIA (Guardar mensajes, métricas, respuesta)
   */
  async processMessage({ userMessage, userId, domain, forceModel = null }) {
    const startTime = Date.now();
    const FILE_NAME = 'chat-orchestrator.service.js';

    try {
        let conversation = await this.getOrCreateConversation(userId, domain);
        const { history } = await this._prepareConversation(userMessage, conversation, domain);

        let response;
        let usedModel;
        let thinkingUsed = false;
        let fallbackUsed = false;
        let toolsUsed = false;
        let toolResults = [];

        let selectedModel = forceModel || ModelRouterService.decideModel(userMessage, history);

        try {
            // OPTIMIZACIÓN: Usar Gemini directamente para búsquedas de productos (más rápido)
            // PERO: Solo aplicar si forceModel no fue especificado (es null o "auto")
            // Si el usuario especifica forceModel explícitamente, respetar su elección
            if (!forceModel || forceModel === 'auto') {
                const message = userMessage.toLowerCase().trim();
                const isProductSearch = ModelRouterService.detectsProductIntent(message);
                if (selectedModel === 'groq' && isProductSearch) {
                    // Si es búsqueda de productos, usar Gemini directamente (más rápido)
                    selectedModel = 'gemini';
                }
            }
            
            if (selectedModel === 'groq') {
                if (!this.groqService) {
                    throw new Error('Groq service no está disponible. Configura GROQ_API_KEY y ENABLE_GROQ_FALLBACK=true');
                }
                response = await this.groqService.generateResponse(userMessage, history, domain, null);
                usedModel = 'groq';
                // Groq también tiene function calling, verificar si usó tools
                toolsUsed = response.functionResults && response.functionResults.length > 0;
                toolResults = response.functionResults || [];
            } else if (selectedModel === 'gemini') {
                thinkingUsed = ModelRouterService.shouldUseThinking(userMessage);
                response = await this.geminiService.generateResponse(userMessage, history, domain, null, thinkingUsed);
                usedModel = 'gemini';
                // Gemini retorna functionResults si usó tools
                toolsUsed = response.functionResults && response.functionResults.length > 0;
                toolResults = response.functionResults || [];
            } else {
                response = await this.openaiService.generateResponse(userMessage, history, domain, null);
                usedModel = 'openai';
                // OpenAI retorna functionResults si usó tools
                toolsUsed = response.functionResults && response.functionResults.length > 0;
                toolResults = response.functionResults || [];
            }
    } catch (error) {
            logger.error(`[${FILE_NAME}] ❌❌❌ Error inicial con ${selectedModel}: ${error.message}`);
            logger.error(`[${FILE_NAME}] ❌ Código de error: ${error.status || error.code || 'N/A'}`);
            fallbackUsed = true;
            try {
                const fallbackResponse = await this._performFallback(selectedModel, userMessage, history, domain, null);
                response = fallbackResponse.response;
                usedModel = fallbackResponse.usedModel;
                toolsUsed = response.functionResults && response.functionResults.length > 0;
                toolResults = response.functionResults || [];
                // Solo loggear como exitoso si realmente fue exitoso (no error_fallback)
                if (usedModel === 'error_fallback') {
                    logger.warn(`[${FILE_NAME}] ⚠️⚠️⚠️ Fallback retornó error_fallback (ambos modelos fallaron)`);
                }
            } catch (fallbackError) {
                logger.error(`[${FILE_NAME}] ❌❌❌ Error en fallback: ${fallbackError.message}`);
                logger.error(`[${FILE_NAME}] ❌❌❌ AMBOS MODELOS FALLARON - Usando respuesta de error`);
                // Si el fallback falla o está deshabilitado, usar respuesta de error
                response = {
                    message: 'Lo siento, estoy teniendo problemas técnicos en este momento. Por favor, intenta de nuevo en unos momentos.',
                    audio_description: 'Lo siento, estoy teniendo problemas técnicos.',
                    action: { type: 'none', productId: null, quantity: null, url: null, price_sale: null, title: null, price_regular: null, image: null, slug: null },
                    usage: { input: 0, output: 0, thinking: 0, cached: 0, total: 0 },
                    usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, thinkingTokenCount: 0 },
                    functionResults: [],
                };
                usedModel = 'error_fallback';
                toolsUsed = false;
                toolResults = [];
                logger.warn(`[${FILE_NAME}] ⚠️ Usando respuesta de error (usedModel: error_fallback)`);
            }
        }

        // ENFOQUE: Function calling puro - La IA decide qué tools usar
        // Confiamos completamente en la decisión de la IA mediante function calling nativo
        // No usamos validación algorítmica con palabras clave
        // Si la IA no usa tools cuando debería, debemos mejorar el prompt, no forzarlo con algoritmos

        // Log del estado final antes de persistir
        if (usedModel === 'error_fallback') {
            logger.warn(`[${FILE_NAME}] ⚠️⚠️⚠️ ESTADO FINAL: Error fallback activado (ningún modelo respondió)`);
        }

        // Preparar toolResult para compatibilidad con _finalizeAndPersistConversation
        let toolResult = null;
        if (toolResults && toolResults.length > 0) {
            // Tomar el primer tool result para compatibilidad
            const firstToolResult = toolResults[0];
            toolResult = {
                tool: firstToolResult.functionName || 'unknown',
                data: firstToolResult.result || firstToolResult,
            };
        }

        const finalResponse = await this._finalizeAndPersistConversation({
            response,
            conversation,
            userMessage,
            history,
            interpretedIntent: { intent: toolsUsed ? 'tool_used' : 'general_chat', method: 'function_calling' },
            toolResult,
            toolResults: toolResults || [],
            systemPrompt: null,
            dynamicPrompt: null,
            usedModel,
            thinkingUsed,
            fallbackUsed,
            domain,
            userId,
            startTime,
        });

        return finalResponse;

    } catch (error) {
        logger.error(`[${FILE_NAME}] ❌ ERROR CRÍTICO en processMessage: ${error.message}`, { stack: error.stack });
      throw error;
    }
  }

  /**
   * Obtiene o crea una conversación
   * Detecta nueva sesión si pasaron más de 15 minutos o hubo despedida previa
   */
  async getOrCreateConversation(userId, domain) {
    const FILE_NAME = 'chat-orchestrator.service.js';
    const Conversation = getConversationModel();
    
    try {
    // OPTIMIZACIÓN MULTITENANT: Usar select() para limitar campos y mejorar performance
    // No usar lean() aquí porque necesitamos el documento Mongoose para .save() después
    let conversation = await Conversation.findOne({
      userId,
      domain,
      status: 'active',
    })
    .select('userId domain status messages metadata updatedAt')
    .sort({ updatedAt: -1 });

    let isNewSession = false;
    let hasPreviousHistory = false;

    if (conversation) {
      // Verificar si debe ser nueva sesión
      const now = new Date();
      const lastUpdate = new Date(conversation.updatedAt);
      const minutesSinceLastMessage = (now - lastUpdate) / (1000 * 60);

      // Verificar si el último mensaje fue una despedida
      const messages = conversation.messages || [];
      let lastMessageWasFarewell = false;

      if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        // Programación defensiva: asegurar que metadata y tool_executed existen y son un array
        if (lastMessage.role === 'assistant' && lastMessage.metadata && Array.isArray(lastMessage.metadata.tool_executed)) {
          lastMessageWasFarewell = lastMessage.metadata.tool_executed.some(tool => tool && tool.functionName === 'is_farewell');
        }
      }

      // Nueva sesión si: pasaron más de 15 minutos O hubo despedida previa
      if (minutesSinceLastMessage > 15 || lastMessageWasFarewell) {
        isNewSession = true;
        // Cerrar la conversación anterior
        await Conversation.findByIdAndUpdate(conversation._id, {
          status: 'closed',
        });
        conversation = null; // Forzar creación de nueva conversación
      } else {
        // Asegurarse de que messages esté inicializado
        if (!conversation.messages) {
          conversation.messages = [];
        }
      }
    }

    // Si no hay conversación activa, verificar si el usuario tiene historial previo
    if (!conversation) {
      // Verificar si el usuario tiene historial previo (cualquier conversación, activa o cerrada)
      const previousConversations = await Conversation.countDocuments({
        userId,
        domain,
      });
      hasPreviousHistory = previousConversations > 0;
      isNewSession = true;

      // Crear nueva conversación
      conversation = await Conversation.create({
        userId,
        domain,
        messages: [],
        status: 'active',
        metadata: {
          isNewSession: true,
          hasPreviousHistory: hasPreviousHistory,
        },
      });
    } else {
      // Si es conversación existente, actualizar metadata si es necesario
      if (!conversation.metadata) {
        conversation.metadata = {};
      }
      conversation.metadata.isNewSession = false;
      conversation.metadata.hasPreviousHistory = false; // Ya está en conversación activa
    }

    // Agregar flags a la conversación para que la IA los use
    conversation._isNewSession = isNewSession;
    conversation._hasPreviousHistory = hasPreviousHistory;

    return conversation;
    } catch (error) {
      logger.error(`[${FILE_NAME}] ❌ Error en getOrCreateConversation: ${error.message}`);
      // Si MongoDB falla, crear una conversación en memoria para que el servicio continúe
      // Esto permite que el servicio funcione incluso si MongoDB no está disponible
      logger.warn(`[${FILE_NAME}] ⚠️ MongoDB no disponible, usando conversación en memoria`);
      return {
        _id: null,
        userId,
        domain,
        messages: [],
        status: 'active',
        metadata: {
          totalMessages: 0,
          totalTokens: 0,
          cachedTokens: 0,
          modelsUsed: { gemini: 0, openai: 0, groq: 0 },
          averageResponseTime: 0,
        },
        save: async function() {
          logger.warn(`[${FILE_NAME}] ⚠️ Intento de guardar conversación en memoria (MongoDB no disponible)`);
          // No hacer nada, solo loguear
        },
        isInMemory: true, // Flag para identificar conversaciones en memoria
      };
    }
  }

  /**
   * Obtiene historial reciente (últimos N mensajes)
   * OPTIMIZACIÓN: Reduce el historial para ahorrar tokens
   * IMPORTANTE: NO incluye el system prompt, solo los últimos mensajes de conversación
   */
  getRecentHistory(conversation) {
    const FILE_NAME = 'chat-orchestrator.service.js';

    // OPTIMIZACIÓN: Aumentar a 6 mensajes (3 turnos) para mantener mejor contexto
    // Esto asegura que referencias como "ver más detalles" tengan el contexto necesario
    const maxHistory = Math.min(config.performance.maxConversationHistory || 10, 6);
    const messages = conversation.messages || [];
    
    if (messages.length === 0) {
      return [];
    }

    // Excluir el system prompt (si existe como primer mensaje)
    const conversationMessages = messages[0]?.role === 'system' 
      ? messages.slice(1) 
      : messages;
    
    // Tomar los últimos N mensajes (sin system prompt)
    const recentMessages = conversationMessages.slice(-maxHistory);

    // OPTIMIZACIÓN: Aumentar límite de caracteres para mantener contexto de productos
    const MAX_MESSAGE_LENGTH = 500; // Máximo 500 caracteres por mensaje (antes 300)

    // Mapear los mensajes al formato de historial esperado, manteniendo el contenido limpio
    const history = recentMessages.map(msg => {
      let content = msg.content || '';

      // Truncar mensajes muy largos para optimizar tokens
      if (content.length > MAX_MESSAGE_LENGTH) {
        content = content.substring(0, MAX_MESSAGE_LENGTH) + '...';
      }

      return {
        role: msg.role,
        content: content,
        // Incluir metadata es útil para otras funciones de búsqueda en el historial
        metadata: msg.metadata,
      };
    });

    return history;
  }

  /**
   * Sanitiza una acción para corregir problemas comunes
   */
  sanitizeAction(action) {
    if (!action || !action.type) {
      return {
        type: 'none',
        productId: null,
        quantity: null,
        url: null,
        price_sale: null,
        title: null,
        price_regular: null,
        image: null,
        slug: null,
      };
    }

    return {
      type: action.type || 'none',
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

  /**
   * Cierra una conversación
   */
  async closeConversation(conversationId) {
    const Conversation = getConversationModel();
    await Conversation.findByIdAndUpdate(conversationId, {
      status: 'closed',
    });
  }

  /**
   * Detecta el idioma del mensaje (detección simple)
   */
  detectLanguage(message) {
    // Detección simple basada en palabras comunes
    const spanishWords = ['qué', 'cómo', 'cuándo', 'dónde', 'por qué', 'tiene', 'tengo', 'quiero', 'necesito'];
    const englishWords = ['what', 'how', 'when', 'where', 'why', 'have', 'need', 'want'];
    const portugueseWords = ['o que', 'como', 'quando', 'onde', 'por que', 'tem', 'preciso', 'quero'];

    const lowerMessage = message.toLowerCase();

    const spanishCount = spanishWords.filter(word => lowerMessage.includes(word)).length;
    const englishCount = englishWords.filter(word => lowerMessage.includes(word)).length;
    const portugueseCount = portugueseWords.filter(word => lowerMessage.includes(word)).length;

    if (spanishCount > englishCount && spanishCount > portugueseCount) return 'es';
    if (portugueseCount > englishCount && portugueseCount > spanishCount) return 'pt';
    if (englishCount > spanishCount && englishCount > portugueseCount) return 'en';

    // Default a español
    return 'es';
  }

  /**
   * @deprecated ELIMINADO: Este método usaba detección algorítmica de palabras clave.
   * 
   * ENFOQUE ACTUAL: Function calling puro
   * - La IA decide qué tools usar mediante function calling nativo (OpenAI, Gemini, Groq)
   * - No usamos algoritmos de detección de palabras clave
   * - Confiamos completamente en la decisión de la IA basada en el prompt y las herramientas disponibles
   * - Si la IA no usa tools cuando debería, debemos mejorar el prompt, no forzarlo con algoritmos
   * 
   * Este método fue eliminado porque era inconsistente con el enfoque de function calling puro.
   */

  /**
   * Actualiza el contexto persistente del producto en la conversación
   */
  updateProductContext(conversation, productData) {
    const FILE_NAME = 'chat-orchestrator.service.js';

    if (!conversation || !productData) return;

    try {
      conversation.metadata.lastProductContext = {
        productId: productData.productId || productData.id || null,
        slug: productData.slug || null,
        title: productData.title || null,
        price: {
          regular: productData.price?.regular || (typeof productData.price === 'object' && productData.price !== null ? productData.price.regular : null) || null,
          sale: productData.price?.sale || (typeof productData.price === 'object' && productData.price !== null ? productData.price.sale : null) || null,
        },
        image: productData.image || (productData.images && productData.images[0]) || null,
        category: productData.category || null,
        tags: productData.tags || [],
        description: productData.description || productData.description_short || productData.description_long || null,
        updatedAt: new Date(),
      };
    } catch (error) {
      logger.error(`[${FILE_NAME}] ❌ Error actualizando contexto de producto: ${error.message}`);
    }
  }

  /**
   * Actualiza el contexto persistente del producto desde una acción validada
   */
  updateProductContextFromAction(conversation, action) {
    const FILE_NAME = 'chat-orchestrator.service.js';

    if (!conversation || !action || !action.productId) return;

    try {
      conversation.metadata.lastProductContext = {
        productId: action.productId,
        slug: action.slug || null,
        title: action.title || null,
        price: {
          regular: action.price_regular || null,
          sale: action.price_sale || null,
        },
        image: action.image || null,
        category: null,
        tags: [],
        description: null,
        updatedAt: new Date(),
      };
    } catch (error) {
      logger.error(`[${FILE_NAME}] ❌ Error actualizando contexto de producto desde acción: ${error.message}`);
    }
  }

  /**
   * Busca un producto por nombre en el mensaje del usuario
   * Versión rápida para búsquedas en tiempo real
   */
  async findProductByNameInMessage(message, domain) {
    const FILE_NAME = 'chat-orchestrator.service.js';

    if (!message || !domain || message.length < 3) return null;

    try {
      // Limpiar el mensaje y buscar palabras clave de productos
      const cleanMessage = message.trim();

      // Si el mensaje es muy corto (solo confirmación), no buscar
      if (cleanMessage.length < 5) return null;

      // Buscar patrones de nombres de productos (palabras en mayúsculas o títulos)
      const productPatterns = [
        // Títulos completos con mayúsculas: "SILPAT DE SILICONA"
        /([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]+(?:[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s]*)+)/g,
        // Palabras clave comunes seguidas de descripción
        /(silpat|batidor|cortador|rodillo|molde|espátula|termómetro|balanza)[\s]+(?:de\s+)?([a-záéíóúñ\s]+)/gi,
      ];

      let searchTerms = [];
      for (const pattern of productPatterns) {
        const matches = message.match(pattern);
        if (matches) {
          searchTerms.push(...matches.map(m => m.trim()));
        }
      }

      // Si no hay patrones, usar el mensaje completo (sin palabras comunes)
      if (searchTerms.length === 0) {
        const words = cleanMessage.split(/\s+/).filter(w =>
          w.length > 3 &&
          !['quiero', 'comprar', 'busco', 'necesito', 'deseo', 'agregar', 'añadir', 'carrito'].includes(w.toLowerCase())
        );
        if (words.length > 0) {
          searchTerms.push(words.join(' '));
        }
      }

      if (searchTerms.length === 0) return null;

      // Ordenar por longitud (el más largo primero)
      searchTerms = searchTerms.sort((a, b) => b.length - a.length);

      const Product = getProductModel();

      // Buscar cada término
      for (const term of searchTerms.slice(0, 3)) { // Máximo 3 intentos
        if (term.length < 3) continue;

        // Crear regex flexible para la búsqueda
        const searchRegex = new RegExp(term.replace(/\s+/g, '\\s+'), 'i');

        const product = await Product.findOne({
          domain,
          $or: [
            { title: searchRegex },
            { 'category.slug': searchRegex },
            { tags: searchRegex },
          ],
          is_available: true,
        })
        .select('title slug price image_default category tags description_short description_long')
        .lean();

        if (product) {
          return {
            id: product._id.toString(),
            productId: product._id.toString(),
            title: product.title,
            slug: product.slug,
            price: product.price,
            images: product.image_default || [],
            category: product.category,
            tags: product.tags || [],
            description: product.description_short || product.description_long,
          };
        }
      }
    } catch (error) {
      logger.error(`[${FILE_NAME}] ❌ Error buscando producto por nombre: ${error.message}`);
    }

    return null;
  }

  /**
   * Extrae información del producto desde el mensaje del asistente
   * Busca títulos de productos mencionados en el mensaje
   */
  async extractProductFromMessage(message, domain) {
    const FILE_NAME = 'chat-orchestrator.service.js';

    if (!message || !domain) return null;

    try {
      // Buscar patrones comunes de productos en el mensaje
      // Ejemplo: "Batidor GLOBO DE ACERO N° 22" o "Batidor GLOBO DE ACERO N° 22 añadido"
      // Mejorar el patrón para capturar títulos con números y caracteres especiales
      const productTitlePatterns = [
        // Patrón 1: Palabras que empiezan con mayúscula seguidas de más palabras y números
        /([A-ZÁÉÍÓÚÑ][A-Za-záéíóúñÁÉÍÓÚÑ\s]+(?:[A-ZÁÉÍÓÚÑ][A-Za-záéíóúñÁÉÍÓÚÑ\s]*)*(?:\s*N[°º]\s*\d+)?)/g,
        // Patrón 2: Títulos que contienen palabras comunes de productos
        /(Batidor|Cortador|Rodillo|Molde|Espátula|Termómetro|Balanza)[A-Za-záéíóúñÁÉÍÓÚÑ\s]+(?:[A-ZÁÉÍÓÚÑ][A-Za-záéíóúñÁÉÍÓÚÑ\s]*)*(?:\s*N[°º]?\s*\d+)?/gi,
      ];

      // Buscar títulos de productos mencionados
      let potentialTitles = [];
      for (const pattern of productTitlePatterns) {
        const matches = message.match(pattern);
        if (matches && matches.length > 0) {
          potentialTitles.push(...matches);
        }
      }

      if (potentialTitles.length > 0) {
        // Limpiar y ordenar por longitud (el más largo es probablemente el título completo)
        potentialTitles = potentialTitles
          .map(t => t.trim())
          .filter(t => t.length > 5)
          .sort((a, b) => b.length - a.length);

        // Buscar cada título potencial en la base de datos
        const Product = getProductModel();
        for (const potentialTitle of potentialTitles) {
          // Crear regex más flexible para la búsqueda
          // Escapar caracteres especiales pero permitir variaciones
          const searchTitle = potentialTitle
            .replace(/[°º]/g, '[°º]?') // N° o Nº
            .replace(/\s+/g, '\\s+') // Espacios
            .replace(/[Nn]\s*[°º]?\s*(\d+)/g, 'N[°º]?\\s*$1'); // N° 22

          const product = await Product.findOne({
            domain,
            title: new RegExp(searchTitle, 'i'),
            is_available: true,
          }).lean();

          if (product) {
            return {
              id: product._id.toString(),
              productId: product._id.toString(),
              title: product.title,
              slug: product.slug,
              price: product.price,
              images: product.image_default || [],
              category: product.category,
              tags: product.tags || [],
              description: product.description_short || product.description_long,
            };
          } else {
            // Intentar búsqueda más flexible: buscar solo las primeras palabras
            const words = potentialTitle.split(/\s+/).slice(0, 3); // Primeras 3 palabras
            if (words.length >= 2) {
              const shortTitle = words.join(' ');

              const productFlex = await Product.findOne({
                domain,
                title: new RegExp(shortTitle.replace(/\s+/g, '\\s+'), 'i'),
                is_available: true,
              }).lean();

              if (productFlex) {
                return {
                  id: productFlex._id.toString(),
                  productId: productFlex._id.toString(),
                  title: productFlex.title,
                  slug: productFlex.slug,
                  price: productFlex.price,
                  images: productFlex.image_default || [],
                  category: productFlex.category,
                  tags: productFlex.tags || [],
                  description: productFlex.description_short || productFlex.description_long,
                };
              }
            }
          }
        }
      }
    } catch (error) {
      logger.error(`[${FILE_NAME}] ❌ Error extrayendo producto del mensaje: ${error.message}`);
      logger.error(`[${FILE_NAME}] Stack: ${error.stack}`);
    }

    logger.warn(`[${FILE_NAME}] extractProductFromMessage() - No se encontró producto en el mensaje`);
    return null;
  }

  /**
   * Busca referencias a productos en el historial para entender contexto
   * Útil cuando el usuario dice "ver más detalles" sin especificar producto
   * AHORA TAMBIÉN busca en el contexto persistente de la conversación
   */
  findProductInHistory(history, conversation = null) {
    const FILE_NAME = 'chat-orchestrator.service.js';

    // PRIORIDAD 1: Buscar en el contexto persistente de la conversación (más confiable)
    if (conversation && conversation.metadata && conversation.metadata.lastProductContext && conversation.metadata.lastProductContext.productId) {
      const productContext = conversation.metadata.lastProductContext;
      return {
        productId: productContext.productId,
        foundIn: 'conversation_context',
        context: `Contexto persistente: ${productContext.title}`,
        fullData: productContext, // Incluir datos completos
      };
    }

    // Buscar en los últimos mensajes del historial
    const messagesToCheck = history.slice(-6).reverse(); // Últimos 6 mensajes, más recientes primero

    for (const msg of messagesToCheck) {
      // 1. PRIORIDAD: Buscar en metadata.lastProductShown (mejor fuente - producto más reciente mostrado)
      if (msg.metadata && msg.metadata.lastProductShown) {
        const product = msg.metadata.lastProductShown;
        return {
          productId: product.productId,
          foundIn: msg.role,
          context: `Metadata lastProductShown: ${product.title}`,
        };
      }

      // 2. Buscar en metadata.action si existe
      if (msg.metadata && msg.metadata.action) {
        const action = msg.metadata.action;
        if (action.productId) {
          return {
            productId: action.productId,
            foundIn: msg.role,
            context: `Metadata action: ${action.title || action.slug || 'producto'}`,
          };
        }
        if (action.slug) {
          return {
            productId: action.slug,
            foundIn: msg.role,
            context: `Metadata action: ${action.title || action.slug}`,
          };
        }
      }

      // 3. Buscar en el contenido del mensaje si existe
      if (!msg.content) continue;

      // Buscar IDs de productos (MongoDB ObjectId) en el contenido
      const objectIdMatch = msg.content.match(/\b[0-9a-fA-F]{24}\b/);
      if (objectIdMatch) {
        return {
          productId: objectIdMatch[0],
          foundIn: msg.role,
          context: msg.content.substring(0, 100),
        };
      }

      // Buscar en el contenido agregado por getRecentHistory (PRODUCTO_MENCIONADO)
      const productoMencionadoMatch = msg.content.match(/\[PRODUCTO_MENCIONADO:.*?ID=([a-zA-Z0-9\-_]+)/);
      if (productoMencionadoMatch) {
        return {
          productId: productoMencionadoMatch[1],
          foundIn: msg.role,
          context: msg.content.substring(0, 100),
        };
      }

      // Buscar slugs de productos (formato común: /product/xxx o slug: xxx)
      // Excluir palabras comunes del español que podrían ser capturadas incorrectamente
      const commonWords = ['del', 'de', 'la', 'el', 'los', 'las', 'un', 'una', 'uno', 'dos', 'tres', 'con', 'por', 'para', 'ver', 'mas', 'más', 'detalles', 'detalle'];

      const slugPatterns = [
        /(?:slug|ID|productId)[:\s]+([a-zA-Z0-9\-_]{3,})/i, // Mínimo 3 caracteres
        /\/product\/([a-zA-Z0-9\-_]{3,})/i, // Mínimo 3 caracteres
        /productId["\s:]+["']?([a-zA-Z0-9\-_]{3,})["']?/i, // Mínimo 3 caracteres
      ];

      for (const pattern of slugPatterns) {
        const slugMatch = msg.content.match(pattern);
        if (slugMatch && slugMatch[1]) {
          const foundSlug = slugMatch[1].toLowerCase();
          // Validar que no sea una palabra común
          if (!commonWords.includes(foundSlug) && foundSlug.length >= 3) {
            return {
              productId: slugMatch[1],
              foundIn: msg.role,
              context: msg.content.substring(0, 100),
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Construye un prompt dinámico basado en la intención y resultado del tool
   */
  buildDynamicPrompt(intent, toolResult, baseSystemPrompt, domain) {
    const shortPrompt = PromptMemoryService.buildShortSystemPrompt(domain);

    let contextualInfo = '';

    switch (intent) {
      case 'search_products':
        if (toolResult.data && toolResult.data.products && toolResult.data.products.length > 0) {
          const products = toolResult.data.products.slice(0, 5); // Limitar a 5 productos
          contextualInfo = `\n\nINFORMACIÓN RELEVANTE - Productos encontrados (${toolResult.data.count} total):\n`;
          contextualInfo += products.map((p, i) =>
            `${i + 1}. ${p.title} - S/${p.price.regular}${p.price.sale !== p.price.regular ? ` (Oferta: S/${p.price.sale})` : ''} - ID: ${p.id} - Slug: ${p.slug}`
          ).join('\n');
          contextualInfo += '\n\nINSTRUCCIONES: Presenta estos productos de forma amable. Si el usuario pregunta por un producto específico, usa el ID o slug para acciones.';
        } else {
          contextualInfo = '\n\nINFORMACIÓN: No se encontraron productos. Informa amablemente al usuario y pregunta si busca algo específico.';
        }
        break;

      case 'company_info':
        if (toolResult.data) {
          contextualInfo = `\n\nINFORMACIÓN DE LA EMPRESA:\n`;
          if (toolResult.data.name) contextualInfo += `Nombre: ${toolResult.data.name}\n`;
          if (toolResult.data.description) contextualInfo += `Descripción: ${toolResult.data.description}\n`;
          if (toolResult.data.address) contextualInfo += `Dirección: ${toolResult.data.address}\n`;
          if (toolResult.data.phone) contextualInfo += `Teléfono: ${toolResult.data.phone}\n`;
          if (toolResult.data.email) contextualInfo += `Email: ${toolResult.data.email}\n`;
          contextualInfo += '\n\nINSTRUCCIONES: Responde con esta información de forma natural y amable.';
        }
        break;

      case 'product_price':
        if (toolResult.data) {
          contextualInfo = `\n\nINFORMACIÓN DEL PRODUCTO:\n`;
          contextualInfo += `Nombre: ${toolResult.data.title}\n`;
          contextualInfo += `Precio regular: S/${toolResult.data.price.regular}\n`;
          if (toolResult.data.price.sale !== toolResult.data.price.regular) {
            contextualInfo += `Precio de oferta: S/${toolResult.data.price.sale}\n`;
          }
          contextualInfo += `ID: ${toolResult.data.productId}\n`;
          contextualInfo += '\n\nINSTRUCCIONES: Informa el precio de forma clara y amable.';
        }
        break;

      case 'product_details':
        if (toolResult.data) {
          contextualInfo = `\n\nINFORMACIÓN DEL PRODUCTO:\n`;
          contextualInfo += `Nombre: ${toolResult.data.title}\n`;
          contextualInfo += `Descripción: ${toolResult.data.description}\n`;
          if (toolResult.data.price) {
            contextualInfo += `Precio: S/${toolResult.data.price.regular || toolResult.data.price}\n`;
          }
          contextualInfo += `ID: ${toolResult.data.id}\n`;
          contextualInfo += `Slug: ${toolResult.data.slug}\n`;
          contextualInfo += '\n\nINSTRUCCIONES: Presenta los detalles del producto de forma clara y atractiva.';
        }
        break;

      case 'shipping_info':
        if (toolResult.data) {
          contextualInfo = `\n\nINFORMACIÓN DE ENVÍO:\n`;
          if (toolResult.data.shippingPolicy) contextualInfo += `Política: ${toolResult.data.shippingPolicy}\n`;
          if (toolResult.data.freeShippingThreshold) {
            contextualInfo += `Envío gratis a partir de: S/${toolResult.data.freeShippingThreshold}\n`;
          }
          contextualInfo += '\n\nINSTRUCCIONES: Explica la información de envío de forma clara.';
        }
        break;

      case 'add_to_cart':
        if (toolResult.data) {
          contextualInfo = `\n\nPRODUCTO PARA AGREGAR AL CARRITO:\n`;
          contextualInfo += `ID: ${toolResult.data.productId}\n`;
          contextualInfo += `Nombre: ${toolResult.data.title}\n`;
          contextualInfo += `Precio: S/${toolResult.data.price.regular || toolResult.data.price}\n`;
          if (toolResult.data.price.sale && toolResult.data.price.sale !== toolResult.data.price.regular) {
            contextualInfo += `Precio oferta: S/${toolResult.data.price.sale}\n`;
          }
          contextualInfo += `Cantidad: ${toolResult.data.quantity || 1}\n`;
          contextualInfo += `Slug: ${toolResult.data.slug}\n`;
          if (toolResult.data.image) {
            contextualInfo += `Imagen: ${toolResult.data.image}\n`;
          }
          contextualInfo += '\n\nINSTRUCCIONES: Ejecuta la acción add_to_cart con estos datos. Responde confirmando que se agregó al carrito.';
        }
        break;
    }

    // Construir prompt dinámico: instrucciones base + información contextual
    return `${shortPrompt}${contextualInfo}`;
  }

  /**
   * Obtiene estadísticas de uso
   */
  async getUsageStats(domain, startDate, endDate) {
    const TokenUsage = getTokenUsageModel();
    const stats = await TokenUsage.aggregate([
      {
        $match: {
          domain,
          timestamp: {
            $gte: startDate,
            $lte: endDate,
          },
        },
      },
      {
        $group: {
          _id: '$provider',
          totalTokens: { $sum: '$tokens.total' },
          totalCachedTokens: { $sum: '$tokens.cached' },
          totalCost: { $sum: '$cost.total' },
          count: { $sum: 1 },
          avgResponseTime: { $avg: '$metadata.responseTime' },
        },
      },
    ]);

    return stats;
  }

  /**
   * Simula un stream de texto para modelos que no lo soportan nativamente (como Groq)
   * @param {object} res - El objeto de respuesta de Express
   * @param {string} text - El texto completo a "streamear"
   */
  async _pseudoStreamText(res, text) {
    const words = text.split(/(\s+)/); // Dividir por espacios, manteniendo los espacios
    const delay = 50; // ms de retraso entre palabras para simular escritura

    for (const word of words) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ message: word })}\n\n`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        break; // Detener si el cliente cierra la conexión
      }
    }
  }
}

module.exports = ChatOrchestratorService;
