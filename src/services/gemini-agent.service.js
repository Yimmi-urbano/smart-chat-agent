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
      {
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
      {
        name: 'compare_products',
        description: 'Compara múltiples productos entre sí',
        parameters: {
          type: 'object',
          properties: {
            productIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array de IDs de productos a comparar',
            },
          },
          required: ['productIds'],
        },
      },
    ];
  }

  /**
   * Ejecuta una función llamada por Gemini
   */
  async executeFunction(functionName, args, domain) {
    logger.info(`[Gemini] Executing function: ${functionName}`);

    switch (functionName) {
      case 'search_products':
        return await this.searchProducts(args, domain);
      
      case 'get_product_details':
        return await this.getProductDetails(args.productId, domain);
      
      case 'compare_products':
        return await this.compareProducts(args.productIds, domain);
      
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

    logger.info(`[Gemini] ✅ Found ${products.length} products for query: "${query}"`);

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
        for (const call of functionCalls) {
          const fnResult = await this.executeFunction(call.name, call.args, domain);
          functionResults.push({ functionName: call.name, result: fnResult });
        }

        const finalResult = await chat.sendMessage([{
          functionResponse: {
            name: functionCalls[0].name,
            response: functionResults[0].result,
          },
        }]);

        return this.parseResponse(finalResult.response, functionResults);
      }

      return this.parseResponse(result.response, []);
    } catch (error) {
      logger.error('[Gemini] Error generating response:', error);
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
            logger.info(`[Gemini] Stream usage resolved: In ${tokenData.input}, Out ${tokenData.output}`);
            return tokenData;
        }).catch(error => {
            logger.error('[Gemini] Error resolving usage promise:', error);
            return { input: inputTokens || 0, output: 0, total: inputTokens || 0 };
        });

        return { stream: result.stream, usagePromise };
    } catch (error) {
        logger.error('[Gemini] Error generating stream response:', error);
        throw error;
    }
  }

  /**
   * Prepara el historial de mensajes para la API de Gemini.
   */
  _prepareMessages(userMessage, conversationHistory, domain, systemPrompt) {
    const PromptMemoryService = require('./prompt-memory.service');
    const isFirstUserMessage = conversationHistory.filter(m => m.role === 'user').length === 0;

    let messages;
    if (isFirstUserMessage) {
      messages = [
        { role: 'user', parts: [{ text: systemPrompt }] },
        { role: 'model', parts: [{ text: '¡Hola! ¿En qué puedo ayudarte hoy?' }] },
      ];
      logger.info('[Gemini] Using full system prompt (first message)');
    } else {
      const shortPrompt = PromptMemoryService.buildShortSystemPrompt(domain);
      const conversationMessages = conversationHistory.filter(m => m.role !== 'system');
      messages = [
        { role: 'user', parts: [{ text: shortPrompt }] },
        ...conversationMessages.map(msg => ({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }],
        })),
      ];
      logger.info(`[Gemini] Using short prompt + ${conversationMessages.length} history messages`);
    }

    messages.push({ role: 'user', parts: [{ text: userMessage }] });
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
      logger.info(`[Gemini] Using thinking mode for model: ${config.gemini.model}`);
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
    // Buscar bloques de código markdown con JSON
    const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)```/g;
    const matches = [...text.matchAll(jsonBlockRegex)];
    
    if (matches.length > 0) {
      // Tomar el primer bloque de código que contenga JSON
      const jsonContent = matches[0][1].trim();
      logger.info('[Gemini] Extracted JSON from markdown code block');
      return jsonContent;
    }
    
    // Si no hay bloques de código, devolver el texto original
    return text;
  }

  /**
   * Parsea la respuesta de Gemini
   */
  parseResponse(response, functionResults) {
    const text = response.text();
    
    // Extraer JSON de bloques de código markdown si está presente
    const jsonText = this.extractJsonFromMarkdown(text);
    
    // Intentar parsear como JSON
    try {
      const parsed = JSON.parse(jsonText);
      
      return {
        message: parsed.message || text,
        audio_description: parsed.audio_description || parsed.message || text,
        action: parsed.action || {
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
        thinking: parsed.thinking || null,
        functionResults,
        usageMetadata: response.usageMetadata || {},
      };
    } catch (error) {
      // Si no es JSON válido, Gemini devolvió texto natural
      logger.info('[Gemini] Response is natural text (expected with function calling)');
      
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
}

module.exports = GeminiAgentService;

