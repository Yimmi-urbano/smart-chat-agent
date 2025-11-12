/**
 * ============================================
 * GEMINI AGENT SERVICE
 * ============================================
 * Servicio para Gemini 2.5 Flash con Function Calling
 * 
 * MEJORA: Usa function calling nativo para búsquedas de productos
 * y mantiene el system prompt memorizado en el historial
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config/env.config');
const logger = require('../utils/logger');
const getProductModel = require('../models/Product');
const ToolExecutorService = require('./tool-executor.service');

class GeminiAgentService {
  constructor() {
    if (!config.gemini.apiKey) {
      throw new Error('GEMINI_API_KEY not found in environment');
    }

    this.genAI = new GoogleGenerativeAI(config.gemini.apiKey);
    this.tools = this.defineTools();
  }

  /**
   * Define las herramientas (functions) disponibles para Gemini
   */
  defineTools() {
    return [
      {
        name: 'search_products',
        description: 'Busca productos en el catálogo usando búsqueda inteligente y flexible. DEBES usar esta herramienta para CUALQUIER consulta sobre productos. Entiende conceptos relacionados y sinónimos. Ejemplo: si el usuario busca "cargadores portátiles", también busca productos relacionados como "batería portátil" o "power bank".',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Texto de búsqueda flexible. Usa palabras clave principales que describan el concepto que el usuario busca. La búsqueda encuentra productos relacionados incluso si no coinciden exactamente. Ejemplos: "cargadores portátiles" encontrará "batería portátil", "batidora" encontrará "batidor", etc.',
            },
            category: {
              type: 'string',
              description: 'Categoría del producto (opcional)',
            },
            minPrice: {
              type: 'number',
              description: 'Precio mínimo (opcional)',
            },
            maxPrice: {
              type: 'number',
              description: 'Precio máximo (opcional)',
            },
            limit: {
              type: 'number',
              description: 'Número máximo de resultados (default: 5)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_product_details',
        description: 'Obtiene detalles completos de un producto específico por su ID o slug. USA esta herramienta cuando el usuario pide detalles, características o información específica de un producto.',
        parameters: {
          type: 'object',
          properties: {
            productId: {
              type: 'string',
              description: 'ID o slug del producto. Puede ser el ID completo o el slug del producto.',
            },
          },
          required: ['productId'],
        },
      },
      {
        name: 'search_info_business',
        description: 'Obtiene información de la empresa/negocio. USA esta herramienta cuando el usuario pregunta sobre la empresa, quiénes son, qué hacen, información de contacto, etc.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'get_product_price',
        description: 'Obtiene el precio de un producto específico. USA esta herramienta cuando el usuario pregunta por el precio, cuánto cuesta, o el costo de un producto.',
        parameters: {
          type: 'object',
          properties: {
            productId: {
              type: 'string',
              description: 'ID o slug del producto',
            },
          },
          required: ['productId'],
        },
      },
      {
        name: 'search_product_recommended',
        description: 'Busca productos recomendados o destacados. USA esta herramienta cuando el usuario pide recomendaciones, productos destacados, o productos populares.',
        parameters: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Número máximo de productos recomendados (default: 5)',
            },
          },
          required: [],
        },
      },
      {
        name: 'get_shipping_info',
        description: 'Obtiene información sobre envíos, políticas de envío, costos de envío, etc. USA esta herramienta cuando el usuario pregunta sobre envíos, delivery, costos de envío, políticas de envío, etc.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    ];
  }

  /**
   * Ejecuta una función llamada por Gemini
   * Mapea los nombres de funciones de Gemini a los intents de ToolExecutorService
   */
  async executeFunction(functionName, args, domain) {
    const FILE_NAME = 'gemini-agent.service.js';

    // Mapear nombres de funciones de Gemini a intents de ToolExecutorService
    const functionToIntentMap = {
      'search_products': 'search_products',
      'get_product_details': 'product_details',
      'search_info_business': 'company_info',
      'get_product_price': 'product_price',
      'search_product_recommended': 'search_products', // Los productos recomendados se buscan como search_products
      'get_shipping_info': 'shipping_info',
    };

    const intent = functionToIntentMap[functionName];
    if (!intent) {
      logger.error(`[${FILE_NAME}] ❌ Función desconocida: ${functionName}`);
      throw new Error(`Unknown function: ${functionName}`);
    }

    // Preparar parámetros según el intent
    let params = {};
    if (functionName === 'search_product_recommended') {
      // Para productos recomendados, buscar sin query específica o con query genérico
      params = { query: '', limit: args.limit || 5 };
    } else if (functionName === 'get_product_details' || functionName === 'get_product_price') {
      params = { productId: args.productId };
    } else if (functionName === 'search_products') {
      params = args;
    }
    // company_info y shipping_info no necesitan parámetros

    // Ejecutar tool usando ToolExecutorService
    const result = await ToolExecutorService.executeTool(intent, params, domain);
    
    if (!result) {
      logger.warn(`[${FILE_NAME}] ⚠️ Tool no retornó resultado para: ${functionName}`);
      return { error: 'No se pudo obtener la información solicitada' };
    }

    // Retornar solo los datos (sin el wrapper de tool)
    return result.data || result;
  }

  /**
   * Busca productos
   */
  async searchProducts(params, domain) {
    const { query, category, minPrice, maxPrice, limit = 5 } = params;

    const filter = {
      domain,
      is_available: true,
    };

    if (query) {
      const keywords = query.split(' ').filter(w => w.length > 2);
      
      if (keywords.length >= 3) {
        filter.$and = keywords.map(keyword => ({
          title: new RegExp(keyword, 'i')
        }));
      } else {
        const searchRegex = new RegExp(keywords.join('|'), 'i');
        filter.$or = [
          { title: searchRegex },
          { description_short: searchRegex },
          { 'category.slug': searchRegex },
          { tags: searchRegex },
        ];
      }
    }

    if (category) {
      filter['category.slug'] = new RegExp(category, 'i');
    }

    if (minPrice || maxPrice) {
      filter['price.regular'] = {};
      if (minPrice) filter['price.regular'].$gte = minPrice;
      if (maxPrice) filter['price.regular'].$lte = maxPrice;
    }

    const Product = getProductModel();
    let products = await Product
      .find(filter)
      .limit(Math.min(limit * 2, 20))
      .select('title description_short price slug category image_default is_available tags')
      .lean();

    // Ordenar por relevancia
    if (query && products.length > 1) {
      const keywords = query.toLowerCase().split(' ').filter(w => w.length > 2);
      products = products
        .map(p => {
          const titleLower = (p.title || '').toLowerCase();
          const matchCount = keywords.filter(kw => titleLower.includes(kw)).length;
          return { ...p, _relevanceScore: matchCount };
        })
        .sort((a, b) => b._relevanceScore - a._relevanceScore)
        .slice(0, Math.min(limit, 10));
    } else {
      products = products.slice(0, Math.min(limit, 10));
    }

    return {
      count: products.length,
      products: products.map(p => {
        let imageUrl = 'https://via.placeholder.com/300x300?text=Sin+Imagen';
        if (Array.isArray(p.image_default) && p.image_default.length > 0) {
          const img = p.image_default[0];
          imageUrl = img.startsWith('http') ? img : `https://example.com${img}`;
        }
        
        const priceObj = typeof p.price === 'object' && p.price !== null
          ? {
              regular: p.price.regular || 0,
              sale: p.price.sale || p.price.regular || 0
            }
          : {
              regular: 0,
              sale: 0
            };
        
        return {
          id: p._id.toString(),
          title: p.title || 'Sin título',
          description: p.description_short || '',
          price: priceObj,
          image: imageUrl,
          slug: p.slug || p._id.toString(),
          category: Array.isArray(p.category) ? p.category[0]?.slug : p.category,
        };
      }),
    };
  }

  /**
   * Obtiene detalles de un producto
   */
  async getProductDetails(productId, domain) {
    const Product = getProductModel();
    const product = await Product
      .findOne({
        $or: [
          { _id: productId },
          { slug: productId },
        ],
        domain,
        is_available: true,
      })
      .lean();

    if (!product) {
      return { error: 'Product not found' };
    }

    return {
      id: product._id.toString(),
      title: product.title,
      description: product.description_short || product.description_long,
      price: product.price,
      slug: product.slug,
      category: product.category,
    };
  }

  /**
   * Compara productos
   */
  async compareProducts(productIds, domain) {
    const Product = getProductModel();
    const products = await Product
      .find({
        _id: { $in: productIds },
        domain,
        is_available: true,
      })
      .lean();

    return {
      products: products.map(p => ({
        id: p._id.toString(),
        title: p.title,
        price: p.price,
      })),
    };
  }

  /**
   * Genera respuesta con Function Calling automático
   * 
   * MEJORA: Mantiene el system prompt en el historial (memorizado)
   */
  async generateResponse(userMessage, conversationHistory, domain, systemPrompt, useThinking = false) {
    const FILE_NAME = 'gemini-agent.service.js';
    try {
      const messages = this._prepareMessages(userMessage, conversationHistory, domain, systemPrompt);
      const model = this._getModel(useThinking);

      const chat = model.startChat({
        history: messages.slice(0, -1),
        tools: [{ functionDeclarations: this.tools }],
      });

      const result = await chat.sendMessage(messages[messages.length - 1].parts[0].text);

      let functionResults = [];
      const responseData = await result.response;
      const functionCalls = responseData.functionCalls() || [];

      if (Array.isArray(functionCalls) && functionCalls.length > 0) {
        // Ejecutar todas las funciones llamadas
        const functionResponses = [];
        for (const call of functionCalls) {
          try {
            const fnResult = await this.executeFunction(call.name, call.args, domain);
            functionResults.push({ functionName: call.name, result: fnResult });
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: fnResult,
              },
            });
          } catch (error) {
            logger.error(`[${FILE_NAME}] ❌ Error ejecutando función ${call.name}: ${error.message}`);
            functionResponses.push({
              functionResponse: {
                name: call.name,
                response: { error: `Error ejecutando función: ${error.message}` },
              },
            });
          }
        }

        const finalResult = await chat.sendMessage(functionResponses);

        const parsed = this.parseResponse(finalResult.response, functionResults);
        return parsed;
      }

      const parsed = this.parseResponse(result.response, []);
      return parsed;
    } catch (error) {
      // Log detallado del error de Gemini
      logger.error(`[${FILE_NAME}] ❌❌❌ ERROR EN GEMINI: ${error.message}`);
      logger.error(`[${FILE_NAME}] ❌ Tipo de error: ${error.constructor?.name || 'Unknown'}`);
      logger.error(`[${FILE_NAME}] ❌ Stack: ${error.stack}`);
      
      // Información adicional del error de Gemini
      if (error.status) {
        logger.error(`[${FILE_NAME}] ❌ Status code: ${error.status}`);
      }
      if (error.statusText) {
        logger.error(`[${FILE_NAME}] ❌ Status text: ${error.statusText}`);
      }
      if (error.response) {
        logger.error(`[${FILE_NAME}] ❌ Response data: ${JSON.stringify(error.response)}`);
      }
      if (error.errorDetails) {
        logger.error(`[${FILE_NAME}] ❌ Error details: ${JSON.stringify(error.errorDetails)}`);
      }
      if (error.cause) {
        logger.error(`[${FILE_NAME}] ❌ Error cause: ${JSON.stringify(error.cause)}`);
      }
      
      // Intentar extraer información de rate limiting
      if (error.message && error.message.includes('quota')) {
        logger.error(`[${FILE_NAME}] ⚠️⚠️⚠️ ERROR DE CUOTA: Gemini ha excedido su cuota diaria`);
        if (error.errorDetails && Array.isArray(error.errorDetails)) {
          error.errorDetails.forEach((detail, index) => {
            if (detail['@type']?.includes('QuotaFailure')) {
              logger.error(`[${FILE_NAME}] ❌ Quota violation ${index + 1}: ${JSON.stringify(detail)}`);
            }
            if (detail['@type']?.includes('RetryInfo')) {
              const retryDelay = detail.retryDelay || 'N/A';
              logger.error(`[${FILE_NAME}] ⏰ Retry delay: ${retryDelay}`);
            }
          });
        }
      }
      
      // Log completo del error para debugging
      logger.error(`[${FILE_NAME}] ❌ Error completo (JSON): ${JSON.stringify({
        name: error.name,
        message: error.message,
        status: error.status,
        statusText: error.statusText,
        stack: error.stack?.split('\n').slice(0, 5).join('\n'),
        errorDetails: error.errorDetails,
        response: error.response,
      }, null, 2)}`);
      
      throw error;
    }
  }

  /**
   * Genera respuesta como un stream de datos.
   */
  async generateResponseStream(userMessage, conversationHistory, domain, systemPrompt, useThinking = false) {
    try {
        const messages = this._prepareMessages(userMessage, conversationHistory, domain, systemPrompt);
        const model = this._getModel(useThinking);

        const chat = model.startChat({
            history: messages.slice(0, -1),
            tools: [{ functionDeclarations: this.tools }],
        });

        const { totalTokens: inputTokens } = await model.countTokens({ contents: messages });
        const result = await chat.sendMessageStream(messages[messages.length - 1].parts[0].text);

        const usagePromise = result.response.then(response => {
            const usageMetadata = response.usageMetadata || {};
            const outputTokens = usageMetadata.candidatesTokenCount || 0;
            const tokenData = {
                input: inputTokens || usageMetadata.promptTokenCount || 0,
                output: outputTokens,
                total: (inputTokens || 0) + outputTokens,
            };
            return tokenData;
        }).catch(error => {
            logger.error('[Gemini] Error resolving usage promise:', error);
            return { input: inputTokens || 0, output: 0, total: inputTokens || 0 };
        });

        return { stream: result.stream, usagePromise };
    } catch (error) {
        const FILE_NAME = 'gemini-agent.service.js';
        // Log detallado del error de Gemini en streaming
        logger.error(`[${FILE_NAME}] ❌❌❌ ERROR EN GEMINI STREAM: ${error.message}`);
        logger.error(`[${FILE_NAME}] ❌ Tipo de error: ${error.constructor?.name || 'Unknown'}`);
        logger.error(`[${FILE_NAME}] ❌ Stack: ${error.stack}`);
        
        // Información adicional del error de Gemini
        if (error.status) {
            logger.error(`[${FILE_NAME}] ❌ Status code: ${error.status}`);
        }
        if (error.statusText) {
            logger.error(`[${FILE_NAME}] ❌ Status text: ${error.statusText}`);
        }
        if (error.response) {
            logger.error(`[${FILE_NAME}] ❌ Response data: ${JSON.stringify(error.response)}`);
        }
        if (error.errorDetails) {
            logger.error(`[${FILE_NAME}] ❌ Error details: ${JSON.stringify(error.errorDetails)}`);
        }
        if (error.cause) {
            logger.error(`[${FILE_NAME}] ❌ Error cause: ${JSON.stringify(error.cause)}`);
        }
        
        // Intentar extraer información de rate limiting
        if (error.message && error.message.includes('quota')) {
            logger.error(`[${FILE_NAME}] ⚠️⚠️⚠️ ERROR DE CUOTA EN STREAM: Gemini ha excedido su cuota diaria`);
            if (error.errorDetails && Array.isArray(error.errorDetails)) {
                error.errorDetails.forEach((detail, index) => {
                    if (detail['@type']?.includes('QuotaFailure')) {
                        logger.error(`[${FILE_NAME}] ❌ Quota violation ${index + 1}: ${JSON.stringify(detail)}`);
                    }
                    if (detail['@type']?.includes('RetryInfo')) {
                        const retryDelay = detail.retryDelay || 'N/A';
                        logger.error(`[${FILE_NAME}] ⏰ Retry delay: ${retryDelay}`);
                    }
                });
            }
        }
        
        // Log completo del error para debugging
        logger.error(`[${FILE_NAME}] ❌ Error completo en STREAM (JSON): ${JSON.stringify({
            name: error.name,
            message: error.message,
            status: error.status,
            statusText: error.statusText,
            stack: error.stack?.split('\n').slice(0, 5).join('\n'),
            errorDetails: error.errorDetails,
            response: error.response,
        }, null, 2)}`);
        
        throw error;
    }
  }

  /**
   * Prepara el historial de mensajes para la API de Gemini.
   */
  _prepareMessages(userMessage, conversationHistory, domain, systemPrompt) {
    const PromptMemoryService = require('./prompt-memory.service');
    
    // ENFOQUE: Function calling puro
    // - SIEMPRE usar prompt corto (solo instrucciones, sin datos)
    // - La IA obtiene información usando tools dinámicamente
    // - Cada mensaje del usuario incluye el mini system prompt
    // - El mensaje actual del usuario incluye contexto de productos mencionados recientemente
    const shortPrompt = PromptMemoryService.buildShortSystemPrompt(domain);
    const conversationMessages = conversationHistory.filter(m => m.role !== 'system');
    
    // Extraer contexto de productos del historial reciente para mantener fluidez conversacional
    let currentContext = '';
    if (conversationMessages.length > 0) {
      // Buscar en los últimos mensajes del asistente para encontrar productos mencionados
      const assistantMessages = conversationMessages.filter(m => m.role === 'assistant').slice(-2);
      
      for (const assistantMsg of assistantMessages.reverse()) {
        if (assistantMsg && assistantMsg.content) {
          // Buscar [CONTEXTO_PRODUCTOS: ...] en el mensaje del asistente
          const contextMatch = assistantMsg.content.match(/\[CONTEXTO_PRODUCTOS:([^\]]+)\]/);
          if (contextMatch) {
            const productInfo = contextMatch[1].trim();
            // Extraer información del producto de forma estructurada
            const productMatch = productInfo.match(/([^(]+)\s*\(ID:\s*([^,]+)(?:,\s*slug:\s*([^)]+))?\)/);
            if (productMatch) {
              const productName = productMatch[1].trim();
              const productId = productMatch[2].trim();
              const productSlug = productMatch[3] ? productMatch[3].trim() : null;
              
              // Crear contexto natural y fluido
              currentContext = `\n\nCONTEXTO DE LA CONVERSACIÓN:\n- El producto que acabas de mencionar al cliente es: "${productName}" (ID: ${productId}${productSlug ? `, slug: ${productSlug}` : ''})\n- Si el cliente responde con palabras como "si", "sí", "ok", "está bien", "agrégalo", "agregalo", "dámelo", "lo quiero", etc., se está refiriendo a este producto.\n- Debes usar get_product_details con el ID o slug de este producto para obtener todos los datos y luego agregarlo al carrito.`;
            } else {
              // Fallback: usar la información tal como está
              currentContext = `\n\nCONTEXTO DE LA CONVERSACIÓN:\n- El producto mencionado más recientemente es: ${productInfo}\n- Si el cliente responde "si", "sí", "ok", "agrégalo", etc., se refiere a este producto.`;
            }
            break; // Usar el producto más reciente encontrado
          }
        }
      }
    }
    
    // Construir mensajes: cada mensaje del usuario incluye el system prompt
    const messages = conversationMessages.map(msg => {
      if (msg.role === 'assistant') {
        return {
          role: 'model',
          parts: [{ text: msg.content }],
        };
      } else {
        // Cada mensaje del usuario incluye el system prompt
        return {
          role: 'user',
          parts: [{ text: `${shortPrompt}\n\n${msg.content}` }],
        };
      }
    });
    
    // Agregar el mensaje actual del usuario con system prompt + contexto actual
    messages.push({
      role: 'user',
      parts: [{ text: `${shortPrompt}${currentContext}\n\n${userMessage}` }],
    });
    
    return messages;
  }

  /**
   * Configura y devuelve el modelo generativo.
   */
  _getModel(useThinking) {
    const generationConfig = {
      temperature: config.gemini.temperature,
      maxOutputTokens: config.gemini.maxTokens,
    };

    const thinkingSupportedModels = ['gemini-2.0-flash-exp', 'gemini-2.0-flash-thinking-exp'];
    const modelSupportsThinking = thinkingSupportedModels.includes(config.gemini.model);

    if (useThinking && config.features.thinkingMode && modelSupportsThinking) {
      generationConfig.thinkingMode = 'AUTO';
    } else if (useThinking && !modelSupportsThinking) {
      logger.warn(`[Gemini] Thinking mode requested but model ${config.gemini.model} does not support it. Ignoring.`);
    }

    return this.genAI.getGenerativeModel({
      model: config.gemini.model,
      generationConfig,
    });
  }

  /**
   * Extrae JSON de bloques de código markdown si está presente
   */
  extractJsonFromMarkdown(text) {
    const FILE_NAME = 'gemini-agent.service.js';
    
    // Buscar bloques de código markdown con JSON
    const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)```/g;
    const matches = [...text.matchAll(jsonBlockRegex)];
    
    if (matches.length > 0) {
      // Tomar el primer bloque de código que contenga JSON
      const jsonContent = matches[0][1].trim();
      return jsonContent;
    }
    
    // MEJORA: Buscar JSON al final del texto (cuando Gemini lo incluye después del mensaje)
    // Primero, buscar si hay un JSON completo al final que comience con {
    const lastBraceIndex = text.lastIndexOf('}');
    if (lastBraceIndex > 0) {
      // Buscar hacia atrás para encontrar el inicio del JSON
      let braceCount = 0;
      let jsonStart = -1;
      
      for (let i = lastBraceIndex; i >= 0; i--) {
        if (text[i] === '}') {
          braceCount++;
        } else if (text[i] === '{') {
          braceCount--;
          if (braceCount === 0) {
            jsonStart = i;
            break;
          }
        }
      }
      
      if (jsonStart !== -1 && jsonStart < lastBraceIndex) {
        try {
          const jsonCandidate = text.substring(jsonStart, lastBraceIndex + 1);
          const parsed = JSON.parse(jsonCandidate);
          // Verificar que tenga la estructura esperada (message o action)
          if (parsed.message !== undefined || parsed.action !== undefined) {
            return jsonCandidate;
          }
        } catch (e) {
          // No es JSON válido, continuar
        }
      }
    }
    
    // MEJORA: Buscar cualquier objeto JSON válido que contenga "message" y "action"
    // Buscar desde el final hacia atrás para encontrar el JSON más reciente
    const jsonPattern = /\{"message"[\s\S]*?"action"[\s\S]*?\}/;
    const jsonMatch = text.match(jsonPattern);
    
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.message !== undefined || parsed.action !== undefined) {
          return jsonMatch[0];
        }
      } catch (e) {
        logger.warn(`[${FILE_NAME}] ⚠️ Patrón JSON encontrado pero no parseable: ${e.message}`);
      }
    }
    
    // Si no hay bloques de código ni JSON válido, devolver el texto original
    return text;
  }

  /**
   * Parsea la respuesta de Gemini
   */
  parseResponse(response, functionResults) {
    const FILE_NAME = 'gemini-agent.service.js';
    const text = response.text();
    
    // MEJORA: Detectar si el texto contiene JSON embebido al final
    // Caso común: Gemini devuelve texto + JSON al final (ej: "mensaje\n\n{json}")
    // Buscar el primer { que podría ser el inicio de un JSON válido
    let jsonStartIndex = -1;
    let jsonText = null;
    let textBeforeJson = text;
    
    // Estrategia 1: Buscar JSON al final del texto (desde el último })
    const lastBraceIndex = text.lastIndexOf('}');
    if (lastBraceIndex > 0) {
      // Buscar hacia atrás desde el último } para encontrar el { correspondiente
      let braceCount = 0;
      let startIndex = -1;
      
      for (let i = lastBraceIndex; i >= 0; i--) {
        if (text[i] === '}') {
          braceCount++;
        } else if (text[i] === '{') {
          braceCount--;
          if (braceCount === 0) {
            startIndex = i;
            break;
          }
        }
      }
      
      if (startIndex !== -1 && startIndex < lastBraceIndex) {
        try {
          const jsonCandidate = text.substring(startIndex, lastBraceIndex + 1);
          const parsed = JSON.parse(jsonCandidate);
          
          // Verificar que tenga la estructura esperada (message o action)
          if (parsed.message !== undefined || parsed.action !== undefined) {
            jsonStartIndex = startIndex;
            jsonText = jsonCandidate;
            textBeforeJson = text.substring(0, startIndex).trim();
          }
        } catch (e) {
          // No es JSON válido en esa posición
        }
      }
    }
    
    // Estrategia 2: Buscar el primer { que parece ser inicio de JSON válido
    // Buscar desde el inicio del texto hacia adelante
    if (!jsonText) {
      // Buscar todas las ocurrencias de { que podrían ser inicio de JSON
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') {
          // Intentar encontrar el } correspondiente
          let braceCount = 0;
          let endIndex = -1;
          
          for (let j = i; j < text.length; j++) {
            if (text[j] === '{') braceCount++;
            if (text[j] === '}') {
              braceCount--;
              if (braceCount === 0) {
                endIndex = j;
                break;
              }
            }
          }
          
          if (endIndex !== -1) {
            try {
              const jsonCandidate = text.substring(i, endIndex + 1);
              const parsed = JSON.parse(jsonCandidate);
              
              // Verificar que tenga la estructura esperada
              if ((parsed.message !== undefined || parsed.action !== undefined) && jsonCandidate.length > 50) {
                // Este parece ser un JSON válido con la estructura esperada
                jsonText = jsonCandidate;
                jsonStartIndex = i;
                textBeforeJson = text.substring(0, i).trim();
                break;
              }
            } catch (e) {
              // No es JSON válido, continuar buscando
            }
          }
        }
      }
    }
    
    // Si encontramos JSON embebido, procesarlo
    if (jsonText) {
      try {
        const parsed = JSON.parse(jsonText);
        
        // Decidir qué mensaje usar:
        // Si encontramos texto antes del JSON, ese es el mensaje limpio
        // El mensaje del JSON probablemente contiene el mismo texto + JSON embebido
        
        let finalMessage = textBeforeJson; // Usar texto antes del JSON (más limpio)
        
        // Si no hay texto antes del JSON, usar el mensaje del JSON pero limpiarlo
        if (!finalMessage || finalMessage.length === 0) {
          if (parsed.message) {
            finalMessage = parsed.message;
            // Limpiar si contiene JSON embebido
            if (finalMessage.includes('{"message"')) {
              const jsonIndex = finalMessage.indexOf('{"message"');
              if (jsonIndex > 0) {
                finalMessage = finalMessage.substring(0, jsonIndex).trim();
              }
            }
          }
        } else {
          // Hay texto antes del JSON - verificar si el mensaje del JSON es diferente
          // Si el mensaje del JSON no contiene el texto antes del JSON, puede ser más completo
          if (parsed.message && !parsed.message.includes(textBeforeJson.substring(0, Math.min(50, textBeforeJson.length)))) {
            // El mensaje del JSON es diferente, usar ese pero limpiarlo
            let cleanParsedMessage = parsed.message;
            if (cleanParsedMessage.includes('{"message"')) {
              const jsonIndex = cleanParsedMessage.indexOf('{"message"');
              if (jsonIndex > 0) {
                cleanParsedMessage = cleanParsedMessage.substring(0, jsonIndex).trim();
              }
            }
            // Si el mensaje limpio del JSON es más largo y completo, usarlo
            if (cleanParsedMessage.length > textBeforeJson.length * 1.2) {
              finalMessage = cleanParsedMessage;
            }
          }
        }
        
        // Asegurar que el mensaje final no esté vacío
        if (!finalMessage || finalMessage.length === 0) {
          finalMessage = parsed.message || textBeforeJson || text.substring(0, 200) || 'He encontrado información. ¿Puedo ayudarte con algo más?';
        }
        
        // Limpiar audio_description
        let cleanAudioDescription = parsed.audio_description || finalMessage;
        if (cleanAudioDescription.includes('{"message"')) {
          const jsonIndex = cleanAudioDescription.indexOf('{"message"');
          if (jsonIndex > 0) {
            cleanAudioDescription = cleanAudioDescription.substring(0, jsonIndex).trim();
          }
        }
        
        // Validar y normalizar el action
        let normalizedAction = {
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
        
        if (parsed.action && parsed.action.type) {
          normalizedAction = {
            type: parsed.action.type || 'none',
            productId: parsed.action.productId || null,
            quantity: parsed.action.quantity || 1,
            url: parsed.action.url || null,
            price_sale: parsed.action.price_sale || null,
            title: parsed.action.title || null,
            price_regular: parsed.action.price_regular || null,
            image: parsed.action.image || null,
            slug: parsed.action.slug || null,
          };
        } else {
          logger.warn(`[${FILE_NAME}] ⚠️ JSON parseado pero sin action válido`);
        }
        
        return {
          message: finalMessage,
          audio_description: cleanAudioDescription,
          action: normalizedAction,
          thinking: parsed.thinking || null,
          functionResults,
          usageMetadata: response.usageMetadata || {},
        };
      } catch (error) {
        logger.error(`[${FILE_NAME}] ❌ Error parseando JSON extraído: ${error.message}`);
        logger.error(`[${FILE_NAME}] JSON candidate: ${jsonText.substring(0, 200)}...`);
      }
    }
    
    // Si no encontramos JSON embebido, intentar parsear todo el texto como JSON
    try {
      const parsed = JSON.parse(text);
      
      if (parsed.message || parsed.action) {
        let normalizedAction = {
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
        
        if (parsed.action && parsed.action.type) {
          normalizedAction = {
            type: parsed.action.type || 'none',
            productId: parsed.action.productId || null,
            quantity: parsed.action.quantity || 1,
            url: parsed.action.url || null,
            price_sale: parsed.action.price_sale || null,
            title: parsed.action.title || null,
            price_regular: parsed.action.price_regular || null,
            image: parsed.action.image || null,
            slug: parsed.action.slug || null,
          };
        }
        
        return {
          message: parsed.message || text,
          audio_description: parsed.audio_description || parsed.message || text,
          action: normalizedAction,
          thinking: parsed.thinking || null,
          functionResults,
          usageMetadata: response.usageMetadata || {},
        };
      }
    } catch (error) {
      // No es JSON válido completo
    }
    
    // Fallback: texto natural sin JSON
    return {
      message: text || 'He encontrado información. ¿Puedo ayudarte con algo más?',
      audio_description: text || 'Encontré información',
      action: {
        type: 'none',
        productId: null,
        quantity: null,
        url: null,
        price_sale: null,
        title: null,
        price_regular: null,
        image: null,
        slug: null,
      },
      thinking: null,
      functionResults,
      usageMetadata: response.usageMetadata || {},
    };
  }
}

module.exports = GeminiAgentService;

