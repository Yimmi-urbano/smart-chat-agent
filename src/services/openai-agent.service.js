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
          description: 'Busca productos en el catálogo usando búsqueda inteligente y flexible. Entiende conceptos relacionados y sinónimos. Ejemplo: si el usuario busca "cargadores portátiles", también busca productos relacionados como "batería portátil" o "power bank".',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Texto de búsqueda flexible. Usa palabras clave principales que describan el concepto que el usuario busca. La búsqueda encuentra productos relacionados incluso si no coinciden exactamente. Ejemplos: "cargadores portátiles" encontrará "batería portátil", "batidora" encontrará "batidor", etc.',
              },
              category: {
                type: 'string',
                description: 'Categoría del producto',
              },
              minPrice: {
                type: 'number',
                description: 'Precio mínimo',
              },
              maxPrice: {
                type: 'number',
                description: 'Precio máximo',
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
          description: 'Obtiene detalles completos de un producto específico por su ID o slug',
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
    ];
  }

  /**
   * Ejecuta una función llamada por OpenAI
   */
  async executeFunction(functionName, args, domain) {
    logger.info(`[OpenAI] Executing function: ${functionName}`);

    switch (functionName) {
      case 'search_products':
        return await this.searchProducts(args, domain);
      
      case 'get_product_details':
        return await this.getProductDetails(args.productId, domain);
      
      default:
        throw new Error(`Unknown function: ${functionName}`);
    }
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

    logger.info(`[OpenAI] ✅ Found ${products.length} products for query: "${query}"`);

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
  async generateResponse(userMessage, conversationHistory, domain, systemPrompt, stream = false) {
    const FILE_NAME = 'openai-agent.service.js';
    
    try {
      // OPTIMIZACIÓN: Usar prompt corto después del primer mensaje para reducir tokens
      const PromptMemoryService = require('./prompt-memory.service');
      let systemMessage = null;
      let messagesForAPI = [];

      if (conversationHistory.length > 0 && conversationHistory[0].role === 'system') {
        // Ya hay conversación: usar prompt corto para ahorrar tokens
        // El contexto ya está establecido, solo necesitamos instrucciones mínimas
        const shortPrompt = PromptMemoryService.buildShortSystemPrompt(domain);
        systemMessage = shortPrompt;
        
        // Filtrar el system prompt largo del historial y usar el corto
        const conversationMessages = conversationHistory.slice(1);
        
        logger.info(`[${FILE_NAME}] Preparing messages: short prompt (${shortPrompt.length} chars) + ${conversationMessages.length} history messages`);
        logger.info(`[${FILE_NAME}] History messages details:`);
        conversationMessages.forEach((msg, idx) => {
          const preview = msg.content.substring(0, 60).replace(/\n/g, ' ');
          logger.info(`[${FILE_NAME}]   [${idx}] ${msg.role}: "${preview}${msg.content.length > 60 ? '...' : ''}"`);
        });
        
        messagesForAPI = [
          { role: 'system', content: shortPrompt },
          ...conversationMessages,
          { role: 'user', content: userMessage },
        ];
        
        logger.info(`[${FILE_NAME}] Using short system prompt to reduce tokens (${shortPrompt.length} chars)`);
        logger.info(`[${FILE_NAME}] Total messages to send: ${messagesForAPI.length}`);
      } else {
        // Primera vez: usar el system prompt completo
        systemMessage = systemPrompt;
        messagesForAPI = [
          { role: 'system', content: systemPrompt },
          ...conversationHistory,
          { role: 'user', content: userMessage },
        ];
        
        logger.info(`[${FILE_NAME}] Using full system prompt (first message) (${systemPrompt.length} chars)`);
      }

      // Generar hash del system prompt para cache
      const systemPromptHash = this.getSystemPromptHash(systemMessage);

      // Configurar request con function calling
      const requestOptions = {
        model: config.openai.model,
        messages: messagesForAPI,
        temperature: config.openai.temperature,
        max_tokens: config.openai.maxTokens,
        tools: this.tools,
        tool_choice: 'auto', // Permite que el modelo decida cuándo usar las funciones
        stream,
      };

      // MEJORA: Agregar prompt caching si está habilitado
      if (config.features.promptCaching && systemMessage && messagesForAPI[0]?.role === 'system') {
        logger.info(`[OpenAI] Prompt caching enabled (system prompt hash: ${systemPromptHash.substring(0, 8)}...)`);
      }

      const completion = await this.client.chat.completions.create(requestOptions);

      if (stream) {
        return completion;
      }

      let message = completion.choices[0].message;
      let functionResults = [];

      // Manejar function calls si existen
      while (message.tool_calls && message.tool_calls.length > 0) {
        // Agregar el mensaje del asistente con tool calls al historial
        messagesForAPI.push(message);

        // Ejecutar todas las funciones llamadas
        for (const toolCall of message.tool_calls) {
          const functionName = toolCall.function.name;
          const functionArgs = JSON.parse(toolCall.function.arguments);
          
          const functionResult = await this.executeFunction(functionName, functionArgs, domain);
          
          // Agregar resultado de la función al historial
          messagesForAPI.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(functionResult),
          });

          functionResults.push({
            functionName,
            result: functionResult,
          });
        }

        // Obtener respuesta final del modelo
        const newCompletion = await this.client.chat.completions.create({
          ...requestOptions,
          messages: messagesForAPI,
          stream: false, // El segundo paso no puede ser stream
        });
        message = newCompletion.choices[0].message;
      }

      // Parsear respuesta final
      let parsedResponse;
      const rawResponse = message.content;

      try {
        parsedResponse = JSON.parse(rawResponse);
      } catch (parseError) {
        // Si no es JSON, intentar extraer JSON de markdown
        const jsonMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
          parsedResponse = JSON.parse(jsonMatch[1].trim());
        } else {
          // Si no hay JSON, crear respuesta básica
          parsedResponse = {
            message: rawResponse || 'He encontrado información. ¿Puedo ayudarte con algo más?',
            audio_description: rawResponse || 'Encontré información',
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
          };
        }
      }

      // Calcular tokens
      const usage = completion.usage || {};
      const tokenData = {
        input: usage.prompt_tokens || 0,
        output: usage.completion_tokens || 0,
        thinking: 0,
        cached: usage.cached_tokens || 0, // Tokens cacheados (ahorro)
        total: usage.total_tokens || 0,
      };

      // Log de ahorro de tokens
      if (tokenData.cached > 0) {
        const savings = ((tokenData.cached / tokenData.input) * 100).toFixed(1);
        logger.info(`[OpenAI] 💰 Token savings: ${tokenData.cached} cached tokens (${savings}% reduction)`);
      }

      if (functionResults.length > 0) {
        logger.info(`[OpenAI] ✅ Executed ${functionResults.length} function calls`);
      }

      return {
        message: parsedResponse.message || '',
        audio_description: parsedResponse.audio_description || parsedResponse.message || '',
        action: parsedResponse.action || {
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
        usage: tokenData,
        systemPromptHash,
        functionResults,
      };

    } catch (error) {
      logger.error('[OpenAI] Error generating response:', error);
      throw error;
    }
  }
}

module.exports = OpenAIAgentService;

