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
        logger.info(`[${FILE_NAME}] findProductAnywhere() - ✅ Producto encontrado en toolResult: ${product.title}`);
        return { product, source: 'toolResult' };
      } else if (toolResult.data.productId || toolResult.data.id) {
        logger.info(`[${FILE_NAME}] findProductAnywhere() - ✅ Producto encontrado en toolResult: ${toolResult.data.title}`);
        return { product: toolResult.data, source: 'toolResult' };
      }
    }

    // PRIORIDAD 2: Producto del mensaje del asistente
    if (responseMessage && responseMessage.length > 10) {
      const extracted = await this.extractProductFromMessage(responseMessage, domain);
      if (extracted) {
        logger.info(`[${FILE_NAME}] findProductAnywhere() - ✅ Producto extraído del mensaje asistente: ${extracted.title}`);
        return { product: extracted, source: 'assistant_message' };
      }
    }

    // PRIORIDAD 3: Producto del mensaje del usuario
    if (userMessage && userMessage.length > 5) {
      const extracted = await this.findProductByNameInMessage(userMessage, domain);
      if (extracted) {
        logger.info(`[${FILE_NAME}] findProductAnywhere() - ✅ Producto extraído del mensaje usuario: ${extracted.title}`);
        return { product: extracted, source: 'user_message' };
      }
    }

    // PRIORIDAD 4: Producto del contexto persistente (último recurso)
    const productInHistory = this.findProductInHistory(history, conversation);
    if (productInHistory && productInHistory.fullData) {
      logger.info(`[${FILE_NAME}] findProductAnywhere() - ✅ Producto encontrado en contexto: ${productInHistory.fullData.title}`);
      return { product: productInHistory.fullData, source: 'conversation_context' };
    }

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

    logger.info(`[${FILE_NAME}] ========================================`);
    logger.info(`[${FILE_NAME}] 🔄 INICIANDO PROCESAMIENTO DE MENSAJE`);
    logger.info(`[${FILE_NAME}] Usuario: ${userId} | Dominio: ${domain}`);
    logger.info(`[${FILE_NAME}] Mensaje: "${userMessage.substring(0, 100)}${userMessage.length > 100 ? '...' : ''}"`);
    logger.info(`[${FILE_NAME}] ========================================`);

    try {
      // Obtener o crear conversación
      let conversation = await this.getOrCreateConversation(userId, domain);
      logger.info(`[${FILE_NAME}] [PASO 1/5] ✅ Conversación: ${conversation._id} (${conversation.messages?.length || 0} mensajes)`);

      // Obtener o construir el system prompt
      let systemPrompt = null;
      let systemPromptHash = null;

      // Verificar si ya hay un system prompt en el historial (memorizado)
      const hasSystemPrompt = conversation.messages &&
                              conversation.messages.length > 0 &&
                              conversation.messages[0].role === 'system';

      if (hasSystemPrompt) {
        // Usar el system prompt memorizado
        systemPrompt = conversation.messages[0].content;
        systemPromptHash = conversation.systemPromptHash ||
                          crypto.createHash('md5').update(systemPrompt).digest('hex');

        // OPTIMIZACIÓN: Si el system prompt es muy grande (>5000 caracteres), es una versión antigua
        if (systemPrompt.length > 5000) {
          logger.warn(`[${FILE_NAME}] [PASO 1/5] ⚠️ System prompt antiguo (${systemPrompt.length} chars), regenerando...`);
          systemPrompt = await PromptMemoryService.buildSystemPrompt(domain);
          systemPromptHash = crypto.createHash('md5').update(systemPrompt).digest('hex');
          conversation.messages[0].content = systemPrompt;
          conversation.systemPromptHash = systemPromptHash;
          await conversation.save();
          logger.info(`[${FILE_NAME}] [PASO 1/5] ✅ System prompt regenerado (${systemPrompt.length} chars)`);
        } else {
          logger.info(`[${FILE_NAME}] [PASO 1/5] ✅ System prompt encontrado (${systemPrompt.length} chars)`);
        }
      } else {
        // Primera vez: construir y memorizar el system prompt
        logger.info(`[${FILE_NAME}] [PASO 1/5] Construyendo nuevo system prompt...`);
        systemPrompt = await PromptMemoryService.buildSystemPrompt(domain);
        systemPromptHash = crypto.createHash('md5').update(systemPrompt).digest('hex');

        if (!conversation.messages) conversation.messages = [];
        conversation.messages.unshift({ role: 'system', content: systemPrompt, timestamp: new Date() });
        conversation.systemPromptHash = systemPromptHash;
        await conversation.save();

        const Conversation = getConversationModel();
        conversation = await Conversation.findById(conversation._id);
        logger.info(`[${FILE_NAME}] [PASO 1/5] ✅ System prompt guardado (${systemPrompt.length} chars)`);
      }

      // Obtener historial reciente
      const history = this.getRecentHistory(conversation);
      logger.info(`[${FILE_NAME}] [PASO 1/5] ✅ Historial obtenido: ${history.length} mensajes`);

      // ========================================================================
      // PASO 2: INTERPRETACIÓN Y TOOLS
      // ========================================================================
      logger.info(`[${FILE_NAME}] [PASO 2/5] INTERPRETACIÓN: Analizando intención y ejecutando tools...`);
      let interpretedIntent = null;
      let toolResult = null;
      let dynamicPrompt = null;

      if (IntentInterpreterService.enabled) {
        try {
          // Detectar idioma e interpretar intención
          const language = this.detectLanguage(userMessage);
          interpretedIntent = await IntentInterpreterService.interpret(userMessage, language, domain);
          logger.info(`[${FILE_NAME}] [PASO 2/5] ✅ Intención: ${interpretedIntent.intent} (confidence: ${interpretedIntent.confidence})`);

          // Si la intención es específica, ejecutar tool
          if (interpretedIntent.intent !== 'general_chat' && interpretedIntent.confidence >= 0.6) {
            // Buscar producto en historial si falta
            const productIntentions = ['add_to_cart', 'product_details', 'product_price'];
            if (productIntentions.includes(interpretedIntent.intent) &&
                !interpretedIntent.params.productId &&
                !interpretedIntent.params.query) {
              const productInHistory = this.findProductInHistory(history, conversation);
              if (productInHistory) {
                interpretedIntent.params.productId = productInHistory.productId;
              }
            }

            // Detectar "ver más detalles" y forzar product_details
            if ((userMessage.toLowerCase().includes('detalle') || userMessage.toLowerCase().includes('detalles') ||
                 userMessage.toLowerCase().includes('ver más')) &&
                interpretedIntent.intent === 'general_chat') {
              const productInHistory = this.findProductInHistory(history, conversation);
              if (productInHistory) {
                interpretedIntent.intent = 'product_details';
                interpretedIntent.params.productId = productInHistory.productId;
                interpretedIntent.confidence = 0.8;
              }
            }

            // Ejecutar tool
            toolResult = await ToolExecutorService.executeTool(
              interpretedIntent.intent,
              interpretedIntent.params,
              domain
            );

            if (toolResult) {
              dynamicPrompt = this.buildDynamicPrompt(interpretedIntent.intent, toolResult, systemPrompt, domain);
              logger.info(`[${FILE_NAME}] [PASO 2/5] ✅ Tool ejecutado: ${toolResult.tool}, prompt dinámico creado`);
            } else if (interpretedIntent.intent === 'add_to_cart') {
              dynamicPrompt = `${PromptMemoryService.buildShortSystemPrompt(domain)}\n\nINSTRUCCIONES: El usuario quiere agregar un producto al carrito pero no se encontró. Busca el producto mencionado usando search_products o pregunta al usuario por más detalles.`;
            }
          }
        } catch (error) {
          logger.error(`[${FILE_NAME}] [PASO 2/5] ❌ Error en interpretación: ${error.message}`);
        }
      } else {
        // IntentInterpreter deshabilitado: detectar referencias simples a productos
        const lowerMessage = userMessage.toLowerCase().trim();
        const isProductReference = lowerMessage.includes('detalle') || lowerMessage.includes('detalles') ||
                                   lowerMessage.includes('ver más') || lowerMessage.includes('agregar') ||
                                   lowerMessage.includes('añadir') || lowerMessage.includes('carrito') ||
                                   lowerMessage.includes('precio');
        const isConfirmation = ['sí', 'si', 'sir', 'ok', 'okay', 'claro', 'perfecto', 'dale', 'va', 'vamos', 'adelante', 'por supuesto'].includes(lowerMessage);

        if (isProductReference || isConfirmation) {
          // Buscar producto del mensaje del usuario primero
          let productFromUserMessage = null;
          if (userMessage && userMessage.length > 5 && (!isConfirmation || userMessage.length > 10)) {
            productFromUserMessage = await this.findProductByNameInMessage(userMessage, domain);
          }

          // Buscar en historial si no se encontró
          let productInHistory = productFromUserMessage ?
            { productId: productFromUserMessage.productId, foundIn: 'user_message', fullData: productFromUserMessage } :
            this.findProductInHistory(history, conversation);

          if (productInHistory && productInHistory.productId) {
            const productId = productInHistory.productId;
            const isObjectId = /^[0-9a-fA-F]{24}$/.test(productId);
            const isValidSlug = /^[a-zA-Z0-9\-_]{3,}$/.test(productId);
            const commonWords = ['del', 'de', 'la', 'el', 'los', 'las', 'un', 'una', 'uno', 'dos', 'tres', 'con', 'por', 'para', 'ver', 'mas', 'más', 'detalles', 'detalle'];

            if ((isObjectId || isValidSlug) && !commonWords.includes(productId.toLowerCase())) {
              // Determinar intención
              let detectedIntent = 'product_details';
              if (isConfirmation) {
                const assistantMessages = history.filter(msg => msg.role === 'assistant');
                const lastAssistantMsg = assistantMessages[assistantMessages.length - 1];
                if (lastAssistantMsg?.content) {
                  const lastContent = lastAssistantMsg.content.toLowerCase();
                  if (lastContent.includes('carrito') || lastContent.includes('agregar') || lastContent.includes('añadir')) {
                    detectedIntent = 'add_to_cart';
                  }
                }
              } else if (lowerMessage.includes('agregar') || lowerMessage.includes('añadir') || lowerMessage.includes('carrito')) {
                detectedIntent = 'add_to_cart';
              } else if (lowerMessage.includes('precio') || lowerMessage.includes('cuesta') || lowerMessage.includes('vale')) {
                detectedIntent = 'product_price';
              }

              interpretedIntent = { intent: detectedIntent, params: { productId }, confidence: isConfirmation ? 0.8 : 0.7, method: 'history_lookup' };
              toolResult = await ToolExecutorService.executeTool(detectedIntent, { productId }, domain);

              if (toolResult) {
                dynamicPrompt = this.buildDynamicPrompt(detectedIntent, toolResult, systemPrompt, domain);
                logger.info(`[${FILE_NAME}] [PASO 2/5] ✅ Tool ejecutado desde historial: ${detectedIntent}`);
              }
            }
          }
        }
      }

      // ========================================================================
      // PASO 3: GENERACIÓN DE RESPUESTA
      // ========================================================================
      logger.info(`[${FILE_NAME}] [PASO 3/5] GENERACIÓN: Decidiendo modelo y generando respuesta...`);
      let selectedModel = forceModel || config.router.defaultProvider;

      if (selectedModel === 'auto') {
        selectedModel = ModelRouterService.decideModel(userMessage, history);
          logger.info(`[${FILE_NAME}] [PASO 3/5] Modelo auto-seleccionado: ${selectedModel}`);
      } else {
        logger.info(`[${FILE_NAME}] [PASO 3/5] Modelo forzado: ${selectedModel}`);
      }

      // Si hay prompt dinámico, usarlo; si no, usar el system prompt original
      const finalSystemPrompt = dynamicPrompt || systemPrompt;
      logger.info(`[${FILE_NAME}] [PASO 3/5] Generando respuesta con modelo: ${selectedModel}`);
      logger.info(`[${FILE_NAME}] [PASO 3/5] Usando prompt: ${dynamicPrompt ? 'dinámico' : 'original'} (${finalSystemPrompt.length} caracteres)`);
      
      let response;
      let usedModel = selectedModel;
      let thinkingUsed = false;
      let fallbackUsed = false;
      // Guardar el prompt enviado para auditoría (se usará al guardar el mensaje)
      let promptSentForAudit = finalSystemPrompt;

      try {
        if (selectedModel === 'gemini') {
          thinkingUsed = ModelRouterService.shouldUseThinking(userMessage);
          logger.info(`[${FILE_NAME}] [PASO 3/5] Llamando a GeminiAgentService.generateResponse() (thinking: ${thinkingUsed})...`);
          response = await this.geminiService.generateResponse(
            userMessage,
            history,
            domain,
            finalSystemPrompt,
            thinkingUsed
          );
          usedModel = 'gemini';
          logger.info(`[${FILE_NAME}] [PASO 3/5] ✅ Respuesta de Gemini generada`);
        } else {
          logger.info(`[${FILE_NAME}] [PASO 3/5] Llamando a OpenAIAgentService.generateResponse()...`);
          response = await this.openaiService.generateResponse(
            userMessage,
            history,
            domain,
            finalSystemPrompt
          );
          usedModel = 'openai';
          logger.info(`[${FILE_NAME}] [PASO 3/5] ✅ Respuesta de OpenAI generada`);
        }
      } catch (error) {
        // Fallback si falla el modelo principal
        logger.error(`[${FILE_NAME}] [PASO 3/5] ❌ Error generando respuesta con ${usedModel}: ${error.message}`);
        if (config.router.enableFallback) {
          logger.warn(`[${FILE_NAME}] [PASO 3/5] Intentando fallback...`);
          fallbackUsed = true;

          try {
            if (usedModel === 'gemini') {
              logger.info(`[${FILE_NAME}] [PASO 3/5] Fallback a OpenAI...`);
              response = await this.openaiService.generateResponse(userMessage, history, domain, finalSystemPrompt);
              usedModel = 'openai';
              promptSentForAudit = finalSystemPrompt;
              logger.info(`[${FILE_NAME}] [PASO 3/5] ✅ Fallback exitoso (OpenAI)`);
            } else {
              thinkingUsed = false;
              logger.info(`[${FILE_NAME}] [PASO 3/5] Fallback a Gemini...`);
              response = await this.geminiService.generateResponse(userMessage, history, domain, finalSystemPrompt, false);
              usedModel = 'gemini';
              promptSentForAudit = finalSystemPrompt;
              logger.info(`[${FILE_NAME}] [PASO 3/5] ✅ Fallback exitoso (Gemini)`);
            }
          } catch (fallbackError) {
            logger.error(`[${FILE_NAME}] [PASO 3/5] ❌ Fallback también falló: ${fallbackError.message}`);
            logger.error(`[${FILE_NAME}] [PASO 3/5] Error original: ${error.message}`);

            response = {
              message: 'Lo siento, estoy teniendo problemas técnicos en este momento. Por favor, intenta de nuevo en unos momentos.',
              audio_description: 'Lo siento, estoy teniendo problemas técnicos. Por favor, intenta de nuevo.',
              action: { type: 'none', productId: null, quantity: null, url: null, price_sale: null, title: null, price_regular: null, image: null, slug: null },
            };
            usedModel = 'error_fallback';
            thinkingUsed = false;
            promptSentForAudit = finalSystemPrompt;
            logger.warn(`[${FILE_NAME}] [PASO 3/5] ⚠️ Usando respuesta de error amigable (ambos modelos fallaron)`);
          }
        } else {
          logger.error(`[${FILE_NAME}] [PASO 3/5] ❌ Error y fallback deshabilitado: ${error.message}`);

          response = {
            message: 'Lo siento, estoy teniendo problemas técnicos en este momento. Por favor, intenta de nuevo en unos momentos.',
            audio_description: 'Lo siento, estoy teniendo problemas técnicos. Por favor, intenta de nuevo.',
            action: { type: 'none', productId: null, quantity: null, url: null, price_sale: null, title: null, price_regular: null, image: null, slug: null },
          };
          usedModel = 'error_fallback';
          thinkingUsed = false;
          promptSentForAudit = finalSystemPrompt;
          logger.warn(`[${FILE_NAME}] [PASO 3/5] ⚠️ Usando respuesta de error amigable`);
        }
      }

      // ========================================================================
      // PASO 4: VALIDACIÓN Y CONSTRUCCIÓN DE ACCIÓN
      // ========================================================================
      // REGLAS:
      // 1. Si el mensaje es una pregunta → NO construir acción
      // 2. Solo construir add_to_cart si el mensaje confirma que se agregó (pasado)
      // 3. Prioridad de producto: toolResult > mensaje asistente > mensaje usuario > contexto
      // ========================================================================
      logger.info(`[${FILE_NAME}] [PASO 4/5] VALIDACIÓN: Construyendo acción...`);

      // Si es respuesta de error, usar la acción que ya viene en response
      let validatedAction = response.action || {
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

      // Si es error_fallback, usar acción por defecto
      if (usedModel === 'error_fallback') {
        logger.info(`[${FILE_NAME}] [PASO 4/5] Respuesta de error, usando acción por defecto (none)`);
      } else {
        // Determinar condiciones para construir acción
        const assistantMessage = (response.message || '').toLowerCase();
        const isQuestion = assistantMessage.includes('?') ||
                          /\b(te\s+gustaría|quieres|deseas|puedo|podemos|te\s+interesa|gustaría\s+agregar|quiero\s+agregar)\s+(agregar|añadir)/i.test(assistantMessage) ||
                          /\b(¿.*agregar|agregar.*\?|agregarlo|agregarla)/i.test(assistantMessage);
        const confirmsAdded = /\b(añadido|agregado|añadí|agregué|agregamos|ya\s+está|listo|completado).*\b(carrito|agregar)/i.test(assistantMessage) ||
                             /\b(listo|completado|hecho).*\b(carrito)/i.test(assistantMessage);
        const hasLLMAction = !isQuestion && response.action && response.action.type && response.action.type !== 'none' &&
                             response.action.productId && response.action.title;
        const hasAddToCartTool = !isQuestion && toolResult && toolResult.tool === 'add_to_cart' && toolResult.data &&
                                 (toolResult.data.productId || toolResult.data.id);

        logger.info(`[${FILE_NAME}] [PASO 4/5] Condiciones: isQuestion=${isQuestion}, confirmsAdded=${confirmsAdded}, hasLLMAction=${hasLLMAction}, hasAddToCartTool=${hasAddToCartTool}`);

        // Buscar producto (función unificada)
        const productResult = await this.findProductAnywhere({
          toolResult,
          responseMessage: response.message,
          userMessage,
          history,
          conversation,
          domain
        });

        // Actualizar contexto si se encontró producto
        if (productResult && productResult.product) {
          this.updateProductContext(conversation, productResult.product);
          logger.info(`[${FILE_NAME}] [PASO 4/5] ✅ Producto encontrado: ${productResult.product.title} (${productResult.source})`);
        }

        // Construir acción según reglas
        if (hasLLMAction) {
          validatedAction = this.sanitizeAction(response.action);
          logger.info(`[${FILE_NAME}] [PASO 4/5] ✅ Acción del LLM: ${validatedAction.type} - ${validatedAction.title}`);
        } else if (hasAddToCartTool && productResult) {
          validatedAction = this.buildActionFromProduct(productResult.product);
          logger.info(`[${FILE_NAME}] [PASO 4/5] ✅ Acción desde tool: ${validatedAction.title}`);
        } else if (confirmsAdded && !isQuestion && productResult) {
          validatedAction = this.buildActionFromProduct(productResult.product);
          logger.info(`[${FILE_NAME}] [PASO 4/5] ✅ Acción desde confirmación: ${validatedAction.title}`);
        } else if (!isQuestion && response.action && response.action.type === 'add_to_cart' && productResult) {
          validatedAction = this.sanitizeAction(response.action);
          const product = productResult.product;
          if (!validatedAction.productId) validatedAction.productId = product.productId || product.id;
          if (!validatedAction.title) validatedAction.title = product.title;
          if (!validatedAction.slug) validatedAction.slug = product.slug;
          if (!validatedAction.price_regular) validatedAction.price_regular = product.price?.regular || null;
          if (!validatedAction.price_sale) validatedAction.price_sale = product.price?.sale || product.price?.regular || null;
          if (!validatedAction.image) validatedAction.image = (product.image || (product.images && product.images[0])) || null;
          if (!validatedAction.url && product.slug) validatedAction.url = `/product/${product.slug}`;
          logger.info(`[${FILE_NAME}] [PASO 4/5] ✅ Acción completada: ${validatedAction.title}`);
        } else if (isQuestion) {
          validatedAction = { type: 'none', productId: null, quantity: null, url: null, price_sale: null, title: null, price_regular: null, image: null, slug: null };
          logger.info(`[${FILE_NAME}] [PASO 4/5] ⚠️ Mensaje es pregunta, acción = none`);
        } else {
          validatedAction.type = 'none';
          logger.info(`[${FILE_NAME}] [PASO 4/5] ⚠️ No se construye acción`);
        }
      }

      // ========================================================================
      // PASO 5: PERSISTENCIA Y RESPUESTA
      // ========================================================================
      logger.info(`[${FILE_NAME}] [PASO 5/5] PERSISTENCIA: Guardando mensajes y métricas...`);

      // Calcular tokens y costo
      const tokenData = {
        input: response.usage?.input || response.usageMetadata?.promptTokenCount || 0,
        output: response.usage?.output || response.usageMetadata?.candidatesTokenCount || 0,
        thinking: response.usage?.thinking || response.usageMetadata?.thinkingTokenCount || 0,
        cached: response.usage?.cached || 0,
        total: response.usage?.total || 0,
      };

      if (tokenData.total === 0) {
        tokenData.total = tokenData.input + tokenData.output + tokenData.thinking;
      }

      const cost = getTokenUsageModel.calculateCost(
        usedModel === 'gemini' ? 'gemini' : 'openai',
        usedModel === 'gemini' ? config.gemini.model : config.openai.model,
        tokenData
      );

      // Guardar mensaje del usuario
      conversation.messages.push({
        role: 'user',
        content: userMessage,
        timestamp: new Date(),
      });

      // Preparar y guardar mensaje del asistente
      // MEJORA: Incluir información del producto en metadata si existe en toolResult
      // AUDITORÍA: Guardar el prompt completo enviado al LLM

      // Determinar el tipo de prompt usado y construir el prompt completo enviado
      // NOTA: El prompt guardado es el que se envía al LLM (system prompt o dynamic prompt)
      let promptType = 'system';
      let promptFull = promptSentForAudit; // Usar el prompt que realmente se envió al LLM

      // Determinar el tipo de prompt basado en el contenido
      if (dynamicPrompt) {
        // Si hay prompt dinámico, el prompt incluye system + dynamic
        promptType = 'system+dynamic';
        logger.info(`[${FILE_NAME}] [AUDITORÍA] Guardando prompt tipo: ${promptType} (${promptFull.length} caracteres)`);
      } else {
        // Verificar si es short prompt o system prompt completo
        // Comparar el prompt enviado con el short prompt para determinar el tipo
        const shortPrompt = PromptMemoryService.buildShortSystemPrompt(domain);
        const shortPromptLength = shortPrompt.length;

        // Si el prompt enviado es similar al short prompt (margen de 50% para variaciones)
        if (promptFull.length <= shortPromptLength * 1.5 && promptFull.length >= shortPromptLength * 0.8) {
          promptType = 'short';
        } else if (promptFull.length > shortPromptLength * 1.5) {
          promptType = 'system';
        } else {
          // Si es muy corto, podría ser un prompt mínimo, tratarlo como short
          promptType = 'short';
        }
        logger.info(`[${FILE_NAME}] [AUDITORÍA] Guardando prompt tipo: ${promptType} (${promptFull.length} caracteres, short: ${shortPromptLength})`);
      }

      // Calcular hash del system prompt base para referencia (usar hash corto para auditoría)
      const promptHashForAudit = crypto.createHash('md5').update(systemPrompt).digest('hex').substring(0, 8);

      const assistantMetadata = {
          model: usedModel,
          tokens: tokenData,
          thinkingUsed,
          cachedTokens: tokenData.cached,
          action: validatedAction,
          // Auditoría: Prompt enviado
          prompt: promptFull,
          promptType: promptType,
          promptLength: promptFull.length,
          systemPromptHash: promptHashForAudit,
      };

      // Guardar información del producto en metadata para referencia futura
      // NOTA: El contexto persistente ya se actualizó en PASO 4/5 cuando se encontró el producto
      if (toolResult && toolResult.data) {
        if (toolResult.data.products && toolResult.data.products.length > 0) {
          const firstProduct = toolResult.data.products[0];
          assistantMetadata.lastProductShown = {
            productId: firstProduct.id,
            slug: firstProduct.slug,
            title: firstProduct.title,
          };
          logger.info(`[${FILE_NAME}] Guardando último producto mostrado en metadata: ${firstProduct.title} (${firstProduct.id})`);
        } else if (toolResult.data.productId || toolResult.data.id) {
          assistantMetadata.lastProductShown = {
            productId: toolResult.data.productId || toolResult.data.id,
            slug: toolResult.data.slug,
            title: toolResult.data.title,
          };
          logger.info(`[${FILE_NAME}] Guardando producto en metadata: ${assistantMetadata.lastProductShown.title} (${assistantMetadata.lastProductShown.productId})`);
        }
      }

      // Si la acción validada tiene un producto, guardarlo en metadata también
      if (validatedAction && validatedAction.type !== 'none' && validatedAction.productId && validatedAction.title) {
        if (!assistantMetadata.lastProductShown) {
          assistantMetadata.lastProductShown = {
            productId: validatedAction.productId,
            slug: validatedAction.slug,
            title: validatedAction.title,
          };
          logger.info(`[${FILE_NAME}] Guardando producto desde acción validada en metadata: ${validatedAction.title} (${validatedAction.productId})`);
        }
      }

      conversation.messages.push({
        role: 'assistant',
        content: response.message,
        timestamp: new Date(),
        metadata: assistantMetadata,
      });

      // Actualizar metadata y guardar
      conversation.metadata.totalMessages += 2;
      conversation.metadata.totalTokens += tokenData.total;
      conversation.metadata.cachedTokens += tokenData.cached;
      conversation.metadata.modelsUsed[usedModel] += 1;

      const responseTime = Date.now() - startTime;
      conversation.metadata.averageResponseTime =
        (conversation.metadata.averageResponseTime + responseTime) / 2;

      await conversation.save();

      // Guardar métricas de tokens (en paralelo para no bloquear)
      const TokenUsage = getTokenUsageModel();
      await TokenUsage.create({
        domain,
        userId,
        conversationId: conversation._id,
        provider: usedModel === 'gemini' ? 'gemini' : 'openai',
        model: usedModel === 'gemini' ? config.gemini.model : config.openai.model,
        tokens: tokenData,
        cost,
        metadata: {
          endpoint: '/api/chat/message',
          responseTime,
          cacheHit: tokenData.cached > 0,
          fallbackUsed,
          errorOccurred: false,
        },
      });

      // Preparar respuesta final
      logger.info(`[${FILE_NAME}] [PASO 5/5] ✅ Persistencia completada`);
      const finalResponse = {
        message: response.message,
        audio_description: response.audio_description,
        action: validatedAction,
        model_used: usedModel,
        thinking_used: thinkingUsed,
        thinking: response.thinking || null,
        fallback_used: fallbackUsed,
        tokens: tokenData,
        cost,
        response_time_ms: responseTime,
        conversation_id: conversation._id,
        system_prompt_memorized: true,
        intent_interpreted: interpretedIntent ? {
          intent: interpretedIntent.intent,
          confidence: interpretedIntent.confidence,
          method: interpretedIntent.method,
        } : null,
        tool_executed: toolResult ? {
          tool: toolResult.tool,
          data_count: toolResult.data?.count || toolResult.data?.products?.length || 0,
        } : null,
      };

      logger.info(`[${FILE_NAME}] ========================================`);
      logger.info(`[${FILE_NAME}] ✅ PROCESAMIENTO COMPLETADO`);
      logger.info(`[${FILE_NAME}] Modelo usado: ${usedModel}`);
      logger.info(`[${FILE_NAME}] Tokens: ${tokenData.total} (input: ${tokenData.input}, output: ${tokenData.output})`);
      logger.info(`[${FILE_NAME}] Tiempo: ${responseTime}ms`);
      logger.info(`[${FILE_NAME}] Intención: ${interpretedIntent?.intent || 'N/A'}`);
      logger.info(`[${FILE_NAME}] Tool ejecutado: ${toolResult?.tool || 'N/A'}`);
      logger.info(`[${FILE_NAME}] ========================================`);

      return finalResponse;

    } catch (error) {
      logger.error(`[${FILE_NAME}] ❌ ERROR CRÍTICO procesando mensaje: ${error.message}`);
      logger.error(`[${FILE_NAME}] Stack: ${error.stack}`);
      throw error;
    }
  }

  /**
   * Obtiene o crea una conversación
   */
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
      });
      logger.info(`[Orchestrator] Created new conversation for user ${userId}`);
    } else {
      // Asegurarse de que messages esté inicializado
      if (!conversation.messages) {
        conversation.messages = [];
      }
      logger.info(`[Orchestrator] Found existing conversation with ${conversation.messages.length} messages`);
    }

    return conversation;
  }

  /**
   * Obtiene historial reciente (últimos N mensajes)
   * OPTIMIZACIÓN: Reduce el historial para ahorrar tokens
   * IMPORTANTE: Siempre preserva el system prompt como primer mensaje
   */
  getRecentHistory(conversation) {
    const FILE_NAME = 'chat-orchestrator.service.js';

    // OPTIMIZACIÓN: Aumentar a 6 mensajes (3 turnos) para mantener mejor contexto
    // Esto asegura que referencias como "ver más detalles" tengan el contexto necesario
    const maxHistory = Math.min(config.performance.maxConversationHistory || 10, 6);
    const messages = conversation.messages || [];
    
    logger.info(`[${FILE_NAME}] getRecentHistory() - Total mensajes en conversación: ${messages.length}`);

    if (messages.length === 0) {
      return [];
    }

    // El primer mensaje siempre es el system prompt (memorizado)
    const systemMessage = messages[0].role === 'system' ? [messages[0]] : [];

    // Tomar los últimos N mensajes (excluyendo el system prompt)
    const conversationMessages = messages.slice(systemMessage.length);
    const recentMessages = conversationMessages.slice(-maxHistory);
    
    logger.info(`[${FILE_NAME}] getRecentHistory() - Mensajes de conversación: ${conversationMessages.length}, Tomando últimos ${maxHistory}: ${recentMessages.length}`);

    // OPTIMIZACIÓN: Aumentar límite de caracteres para mantener contexto de productos
    const MAX_MESSAGE_LENGTH = 500; // Máximo 500 caracteres por mensaje (antes 300)

    // Combinar: system prompt + mensajes recientes (truncados)
    // MEJORA: Incluir metadata en el historial para facilitar búsqueda de productos
    const history = [...systemMessage, ...recentMessages].map((msg, index) => {
      let content = msg.content || '';
      const originalLength = content.length;

      // MEJORA: Si el mensaje tiene metadata con información de producto, agregarla al contenido
      // Esto ayuda a que el LLM y la búsqueda de productos tengan mejor contexto
      if (msg.metadata && msg.metadata.lastProductShown) {
        const productInfo = msg.metadata.lastProductShown;
        // Agregar información del producto al final del mensaje para referencia
        content += ` [PRODUCTO_MENCIONADO: ID=${productInfo.productId}, slug=${productInfo.slug}, título=${productInfo.title}]`;
      } else if (msg.metadata && msg.metadata.action && msg.metadata.action.productId) {
        const action = msg.metadata.action;
        content += ` [PRODUCTO_ACCION: ID=${action.productId}${action.slug ? `, slug=${action.slug}` : ''}${action.title ? `, título=${action.title}` : ''}]`;
      }

      // Truncar mensajes muy largos (excepto el system prompt)
      if (msg.role !== 'system' && content.length > MAX_MESSAGE_LENGTH) {
        content = content.substring(0, MAX_MESSAGE_LENGTH) + '...';
        logger.info(`[${FILE_NAME}] Truncated message ${index} (${msg.role}) from ${originalLength} to ${content.length} chars`);
      }

      return {
      role: msg.role,
        content: content,
        metadata: msg.metadata, // Incluir metadata para búsqueda
      };
    });

    // Log detallado del historial que se enviará
    logger.info(`[${FILE_NAME}] getRecentHistory() - Historial preparado (${history.length} mensajes):`);
    history.forEach((msg, idx) => {
      const preview = msg.content.substring(0, 50).replace(/\n/g, ' ');
      logger.info(`[${FILE_NAME}]   [${idx}] ${msg.role}: "${preview}${msg.content.length > 50 ? '...' : ''}" (${msg.content.length} chars)`);
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
    logger.info(`[Orchestrator] Closed conversation ${conversationId}`);
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

      logger.info(`[${FILE_NAME}] ✅ Contexto de producto actualizado: ${conversation.metadata.lastProductContext.title} (${conversation.metadata.lastProductContext.productId})`);
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

      logger.info(`[${FILE_NAME}] ✅ Contexto de producto actualizado desde acción: ${conversation.metadata.lastProductContext.title} (${conversation.metadata.lastProductContext.productId})`);
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

      logger.info(`[${FILE_NAME}] findProductByNameInMessage() - Términos de búsqueda: ${searchTerms.slice(0, 3).join(', ')}`);

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
          logger.info(`[${FILE_NAME}] ✅ Producto encontrado por nombre: ${product.title} (${product._id})`);
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
      logger.info(`[${FILE_NAME}] extractProductFromMessage() - Mensaje: "${message.substring(0, 100)}"`);

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

        logger.info(`[${FILE_NAME}] extractProductFromMessage() - Títulos potenciales encontrados: ${potentialTitles.length}`);

        // Buscar cada título potencial en la base de datos
        const Product = getProductModel();
        for (const potentialTitle of potentialTitles) {
          logger.info(`[${FILE_NAME}] extractProductFromMessage() - Intentando buscar: "${potentialTitle}"`);

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
            logger.info(`[${FILE_NAME}] ✅ Producto encontrado por título: ${product.title} (${product._id})`);
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
              logger.info(`[${FILE_NAME}] extractProductFromMessage() - Intentando búsqueda flexible: "${shortTitle}"`);

              const productFlex = await Product.findOne({
                domain,
                title: new RegExp(shortTitle.replace(/\s+/g, '\\s+'), 'i'),
                is_available: true,
              }).lean();

              if (productFlex) {
                logger.info(`[${FILE_NAME}] ✅ Producto encontrado por búsqueda flexible: ${productFlex.title} (${productFlex._id})`);
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
      logger.info(`[${FILE_NAME}] findProductInHistory() - ✅ Product encontrado en contexto persistente: ${productContext.title} (${productContext.productId})`);
      return {
        productId: productContext.productId,
        foundIn: 'conversation_context',
        context: `Contexto persistente: ${productContext.title}`,
        fullData: productContext, // Incluir datos completos
      };
    }

    // Buscar en los últimos mensajes del historial
    const messagesToCheck = history.slice(-6).reverse(); // Últimos 6 mensajes, más recientes primero

    logger.info(`[${FILE_NAME}] findProductInHistory() - Buscando productos en ${messagesToCheck.length} mensajes recientes`);

    for (const msg of messagesToCheck) {
      // 1. PRIORIDAD: Buscar en metadata.lastProductShown (mejor fuente - producto más reciente mostrado)
      if (msg.metadata && msg.metadata.lastProductShown) {
        const product = msg.metadata.lastProductShown;
        logger.info(`[${FILE_NAME}] findProductInHistory() - ✅ Product encontrado en lastProductShown: ${product.productId} (${product.title})`);
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
          logger.info(`[${FILE_NAME}] findProductInHistory() - ✅ Product ID encontrado en metadata.action: ${action.productId}`);
          return {
            productId: action.productId,
            foundIn: msg.role,
            context: `Metadata action: ${action.title || action.slug || 'producto'}`,
          };
        }
        if (action.slug) {
          logger.info(`[${FILE_NAME}] findProductInHistory() - ✅ Product slug encontrado en metadata.action: ${action.slug}`);
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
        logger.info(`[${FILE_NAME}] findProductInHistory() - ✅ Product ID encontrado en contenido: ${objectIdMatch[0]}`);
        return {
          productId: objectIdMatch[0],
          foundIn: msg.role,
          context: msg.content.substring(0, 100),
        };
      }

      // Buscar en el contenido agregado por getRecentHistory (PRODUCTO_MENCIONADO)
      const productoMencionadoMatch = msg.content.match(/\[PRODUCTO_MENCIONADO:.*?ID=([a-zA-Z0-9\-_]+)/);
      if (productoMencionadoMatch) {
        logger.info(`[${FILE_NAME}] findProductInHistory() - ✅ Product ID encontrado en PRODUCTO_MENCIONADO: ${productoMencionadoMatch[1]}`);
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
            logger.info(`[${FILE_NAME}] findProductInHistory() - ✅ Product identificador encontrado: ${slugMatch[1]}`);
            return {
              productId: slugMatch[1],
              foundIn: msg.role,
              context: msg.content.substring(0, 100),
            };
          } else {
            logger.debug(`[${FILE_NAME}] findProductInHistory() - ⚠️ Ignorando palabra común: ${foundSlug}`);
          }
        }
      }
    }

    logger.info(`[${FILE_NAME}] findProductInHistory() - ❌ No se encontró producto en el historial`);
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
}

module.exports = ChatOrchestratorService;
