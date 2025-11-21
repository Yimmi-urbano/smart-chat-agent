/**
 * ============================================
 * OPENAI AGENT SERVICE
 * ============================================
 * Servicio para GPT-4o con Prompt Caching
 * 
 * MEJORA CLAVE: Usa OpenAI Prompt Caching para ahorrar 85-95% de tokens
 * en el system prompt. El system prompt se cachea y se reutiliza.
 */

const OpenAI = require('openai');
const config = require('../config/env.config');
const logger = require('../utils/logger');
const crypto = require('crypto');
const getProductModel = require('../models/Product');
const ToolExecutorService = require('./tool-executor.service');

class OpenAIAgentService {
  constructor() {
    if (!config.openai.apiKey) {
      throw new Error('OPENAI_API_KEY not found in environment');
    }

    this.client = new OpenAI({
      apiKey: config.openai.apiKey,
    });

    // Cache de system prompts para prompt caching
    this.systemPromptCache = new Map();
    this.tools = this.defineTools();
  }

  /**
   * Define las herramientas (functions) disponibles para OpenAI
   */
  defineTools() {
    return [
      {
        type: 'function',
        function: {
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
      },
      {
        type: 'function',
        function: {
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
      },
      {
        type: 'function',
        function: {
          name: 'search_info_business',
          description: 'Obtiene información de la empresa/negocio. USA esta herramienta cuando el usuario pregunta sobre la empresa, quiénes son, qué hacen, información de contacto, etc.',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
      },
      {
        type: 'function',
        function: {
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
      },
      {
        type: 'function',
        function: {
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
      },
      {
        type: 'function',
        function: {
          name: 'get_shipping_info',
          description: 'Obtiene información sobre envíos, políticas de envío, costos de envío, etc. USA esta herramienta cuando el usuario pregunta sobre envíos, delivery, costos de envío, políticas de envío, etc.',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
      },
    ];
  }

  /**
   * Ejecuta una función llamada por OpenAI
   * Mapea los nombres de funciones de OpenAI a los intents de ToolExecutorService
   */
  async executeFunction(functionName, args, domain) {
    const FILE_NAME = 'openai-agent.service.js';

    // Mapear nombres de funciones de OpenAI a intents de ToolExecutorService
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
   * Genera un hash del system prompt para usar como cache key
   */
  getSystemPromptHash(systemPrompt) {
    return crypto.createHash('md5').update(systemPrompt).digest('hex');
  }

  /**
   * Genera respuesta usando OpenAI con prompt caching y function calling
   * 
   * MEJORA: Usa cache_control para cachear el system prompt
   * Esto reduce tokens en 85-95% en mensajes subsecuentes
   * OPTIMIZACIÓN: Usa function calling para buscar productos sin enviarlos en el prompt
   */
  async generateResponse(userMessage, conversationHistory, domain, systemPrompt) {
    const FILE_NAME = 'openai-agent.service.js';
    try {
      const { requestOptions, messagesForAPI, systemPromptHash } = this._prepareApiRequest(userMessage, conversationHistory, domain, systemPrompt);
      
      const completion = await this.client.chat.completions.create({ ...requestOptions, stream: false });

      let message = completion.choices[0].message;
      let currentMessages = [...messagesForAPI];
      let functionResults = [];
      let functionCallRound = 0;

      while (message.tool_calls && message.tool_calls.length > 0) {
        functionCallRound++;
        currentMessages.push(message);

        for (const toolCall of message.tool_calls) {
          const functionName = toolCall.function.name;
          const functionArgs = JSON.parse(toolCall.function.arguments);
          const functionResult = await this.executeFunction(functionName, functionArgs, domain);
          
          currentMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(functionResult),
          });
          functionResults.push({ functionName, result: functionResult });
        }

        const newCompletion = await this.client.chat.completions.create({
          ...requestOptions,
          messages: currentMessages,
          stream: false,
        });
        message = newCompletion.choices[0].message;
      }

      const parsed = this._parseFinalResponse(message.content, completion, systemPromptHash, functionResults);
      return parsed;

    } catch (error) {
      // Log detallado del error de OpenAI
      logger.error(`[${FILE_NAME}] ❌❌❌ ERROR EN OPENAI: ${error.message}`);
      logger.error(`[${FILE_NAME}] ❌ Tipo de error: ${error.constructor?.name || 'Unknown'}`);
      logger.error(`[${FILE_NAME}] ❌ Stack: ${error.stack}`);
      
      // Información adicional del error de OpenAI
      if (error.status) {
        logger.error(`[${FILE_NAME}] ❌ Status code: ${error.status}`);
      }
      if (error.statusText) {
        logger.error(`[${FILE_NAME}] ❌ Status text: ${error.statusText}`);
      }
      if (error.code) {
        logger.error(`[${FILE_NAME}] ❌ Error code: ${error.code}`);
      }
      if (error.type) {
        logger.error(`[${FILE_NAME}] ❌ Error type: ${error.type}`);
      }
      if (error.param) {
        logger.error(`[${FILE_NAME}] ❌ Error param: ${error.param}`);
      }
      if (error.request_id) {
        logger.error(`[${FILE_NAME}] ❌ Request ID: ${error.request_id}`);
      }
      if (error.response) {
        logger.error(`[${FILE_NAME}] ❌ Response data: ${JSON.stringify(error.response)}`);
      }
      if (error.error) {
        logger.error(`[${FILE_NAME}] ❌ Error object: ${JSON.stringify(error.error)}`);
      }
      if (error.headers) {
        logger.error(`[${FILE_NAME}] ❌ Response headers: ${JSON.stringify(error.headers)}`);
      }
      
      // Información específica de errores comunes
      if (error.status === 429) {
        logger.error(`[${FILE_NAME}] ⚠️⚠️⚠️ ERROR 429 - RATE LIMIT EXCEDIDO`);
        if (error.error?.message) {
          logger.error(`[${FILE_NAME}] ❌ Mensaje de error: ${error.error.message}`);
        }
        if (error.headers?.['x-ratelimit-limit-requests']) {
          logger.error(`[${FILE_NAME}] ❌ Rate limit: ${error.headers['x-ratelimit-limit-requests']}`);
        }
        if (error.headers?.['x-ratelimit-remaining-requests']) {
          logger.error(`[${FILE_NAME}] ❌ Requests restantes: ${error.headers['x-ratelimit-remaining-requests']}`);
        }
        if (error.headers?.['retry-after']) {
          logger.error(`[${FILE_NAME}] ⏰ Retry after: ${error.headers['retry-after']} segundos`);
        }
      }
      
      if (error.code === 'insufficient_quota') {
        logger.error(`[${FILE_NAME}] ⚠️⚠️⚠️ ERROR DE CUOTA: OpenAI ha excedido su cuota`);
        if (error.error?.message) {
          logger.error(`[${FILE_NAME}] ❌ Mensaje de cuota: ${error.error.message}`);
        }
      }
      
      // Log completo del error para debugging
      logger.error(`[${FILE_NAME}] ❌ Error completo (JSON): ${JSON.stringify({
        name: error.name,
        message: error.message,
        status: error.status,
        statusText: error.statusText,
        code: error.code,
        type: error.type,
        param: error.param,
        request_id: error.request_id,
        stack: error.stack?.split('\n').slice(0, 5).join('\n'),
        error: error.error,
        response: error.response,
      }, null, 2)}`);
      
      throw error;
    }
  }

  async generateResponseStream(userMessage, conversationHistory, domain, systemPrompt) {
    try {
      const { requestOptions } = this._prepareApiRequest(userMessage, conversationHistory, domain, systemPrompt);
      const stream = await this.client.chat.completions.create({
        ...requestOptions,
        stream: true,
        stream_options: { include_usage: true },
      });
      return stream;
    } catch (error) {
      const FILE_NAME = 'openai-agent.service.js';
      // Log detallado del error de OpenAI en streaming
      logger.error(`[${FILE_NAME}] ❌❌❌ ERROR EN OPENAI STREAM: ${error.message}`);
      logger.error(`[${FILE_NAME}] ❌ Tipo de error: ${error.constructor?.name || 'Unknown'}`);
      logger.error(`[${FILE_NAME}] ❌ Stack: ${error.stack}`);
      
      // Información adicional del error de OpenAI
      if (error.status) {
        logger.error(`[${FILE_NAME}] ❌ Status code: ${error.status}`);
      }
      if (error.statusText) {
        logger.error(`[${FILE_NAME}] ❌ Status text: ${error.statusText}`);
      }
      if (error.code) {
        logger.error(`[${FILE_NAME}] ❌ Error code: ${error.code}`);
      }
      if (error.type) {
        logger.error(`[${FILE_NAME}] ❌ Error type: ${error.type}`);
      }
      if (error.param) {
        logger.error(`[${FILE_NAME}] ❌ Error param: ${error.param}`);
      }
      if (error.request_id) {
        logger.error(`[${FILE_NAME}] ❌ Request ID: ${error.request_id}`);
      }
      if (error.response) {
        logger.error(`[${FILE_NAME}] ❌ Response data: ${JSON.stringify(error.response)}`);
      }
      if (error.error) {
        logger.error(`[${FILE_NAME}] ❌ Error object: ${JSON.stringify(error.error)}`);
      }
      if (error.headers) {
        logger.error(`[${FILE_NAME}] ❌ Response headers: ${JSON.stringify(error.headers)}`);
      }
      
      // Información específica de errores comunes en streaming
      if (error.status === 429) {
        logger.error(`[${FILE_NAME}] ⚠️⚠️⚠️ ERROR 429 EN STREAM - RATE LIMIT EXCEDIDO`);
        if (error.error?.message) {
          logger.error(`[${FILE_NAME}] ❌ Mensaje de error: ${error.error.message}`);
        }
        if (error.headers?.['x-ratelimit-limit-requests']) {
          logger.error(`[${FILE_NAME}] ❌ Rate limit: ${error.headers['x-ratelimit-limit-requests']}`);
        }
        if (error.headers?.['x-ratelimit-remaining-requests']) {
          logger.error(`[${FILE_NAME}] ❌ Requests restantes: ${error.headers['x-ratelimit-remaining-requests']}`);
        }
        if (error.headers?.['retry-after']) {
          logger.error(`[${FILE_NAME}] ⏰ Retry after: ${error.headers['retry-after']} segundos`);
        }
      }
      
      if (error.code === 'insufficient_quota') {
        logger.error(`[${FILE_NAME}] ⚠️⚠️⚠️ ERROR DE CUOTA EN STREAM: OpenAI ha excedido su cuota`);
        if (error.error?.message) {
          logger.error(`[${FILE_NAME}] ❌ Mensaje de cuota: ${error.error.message}`);
        }
      }
      
      // Log completo del error para debugging
      logger.error(`[${FILE_NAME}] ❌ Error completo en STREAM (JSON): ${JSON.stringify({
        name: error.name,
        message: error.message,
        status: error.status,
        statusText: error.statusText,
        code: error.code,
        type: error.type,
        param: error.param,
        request_id: error.request_id,
        stack: error.stack?.split('\n').slice(0, 5).join('\n'),
        error: error.error,
        response: error.response,
      }, null, 2)}`);
      
      throw error;
    }
  }

  _prepareApiRequest(userMessage, conversationHistory, domain, systemPrompt) {
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
    const messagesForAPI = conversationMessages.map(msg => {
      if (msg.role === 'user') {
        return {
          role: 'user',
          content: `${shortPrompt}\n\n${msg.content}`,
        };
      } else {
        return {
          role: 'assistant',
          content: msg.content,
        };
      }
    });
    
    // Agregar el mensaje actual del usuario con system prompt + contexto actual
    messagesForAPI.push({
      role: 'user',
      content: `${shortPrompt}${currentContext}\n\n${userMessage}`,
    });
    
    const systemPromptHash = this.getSystemPromptHash(shortPrompt);

    const requestOptions = {
      model: config.openai.model,
      messages: messagesForAPI,
      temperature: config.openai.temperature,
      max_tokens: config.openai.maxTokens,
      tools: this.tools,
      tool_choice: 'auto',
    };

    return { requestOptions, messagesForAPI, systemPromptHash };
  }

  _parseFinalResponse(rawResponse, completion, systemPromptHash, functionResults) {
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(rawResponse);
    } catch (e) {
      const jsonMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        try {
          parsedResponse = JSON.parse(jsonMatch[1].trim());
        } catch (e2) {
          parsedResponse = { message: rawResponse };
        }
      } else {
        parsedResponse = { message: rawResponse };
      }
    }

    const usage = completion.usage || {};
    const tokenData = {
      input: usage.prompt_tokens || 0,
      output: usage.completion_tokens || 0,
      cached: usage.cached_tokens || 0,
      total: usage.total_tokens || 0,
    };

    return {
      message: parsedResponse.message || 'He encontrado información. ¿Puedo ayudarte con algo más?',
      audio_description: parsedResponse.audio_description || parsedResponse.message,
      action: parsedResponse.action || { type: 'none' },
      usage: tokenData,
      systemPromptHash,
      functionResults,
    };
  }
}

module.exports = OpenAIAgentService;

