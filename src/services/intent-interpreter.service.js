/**
 * ============================================
 * INTENT INTERPRETER SERVICE
 * ============================================
 * Servicio modular para interpretar intenciones del usuario
 * 
 * FLUJO:
 * 1. Reglas locales (rápido, gratis) - opcional
 * 2. LLM pequeño (OpenAI) - opcional
 * 3. Fallback a LLM (Gemini) - si OpenAI falla
 * 
 * CONFIGURACIÓN:
 * - ENABLE_INTENT_INTERPRETER=true/false (activar/desactivar)
 * - ENABLE_INTENT_INTERPRETER_LOCAL=true/false (usar reglas locales)
 * - ENABLE_INTENT_INTERPRETER_LLM=true/false (usar LLM)
 */

const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config/env.config');
const logger = require('../utils/logger');

class IntentInterpreterService {
  constructor() {
    this.enabled = config.features.intentInterpreter || false;
    this.useLocal = config.features.intentInterpreterUseLocal !== false;
    this.useLLM = config.features.intentInterpreterUseLLM !== false;
    
    // Cache simple para evitar llamadas repetidas
    this.cache = new Map();
    this.cacheTTL = 5 * 60 * 1000; // 5 minutos
    
    // Inicializar LLMs si están habilitados
    if (this.useLLM) {
      this.initLLMs();
    }
    
    logger.info(`[IntentInterpreter] Enabled: ${this.enabled}, Local: ${this.useLocal}, LLM: ${this.useLLM}`);
  }

  /**
   * Inicializa los clientes de LLM
   */
  initLLMs() {
    // OpenAI
    if (config.openai.apiKey) {
      this.openaiClient = new OpenAI({
        apiKey: config.openai.apiKey,
      });
    }
    
    // Gemini
    if (config.gemini.apiKey) {
      this.geminiClient = new GoogleGenerativeAI(config.gemini.apiKey);
    }
  }

  /**
   * Interpreta la intención del usuario
   * @param {string} userMessage - Mensaje del usuario
   * @param {string} language - Idioma (es, en, pt, etc.)
   * @param {string} domain - Dominio del negocio
   * @returns {Promise<Object>} - { intent, params, confidence, method }
   */
  async interpret(userMessage, language = 'es', domain = '') {
    const FILE_NAME = 'intent-interpreter.service.js';
    
    logger.info(`[${FILE_NAME}] ────────────────────────────────────────`);
    logger.info(`[${FILE_NAME}] 🔍 INICIANDO INTERPRETACIÓN DE INTENCIÓN`);
    logger.info(`[${FILE_NAME}] Mensaje: "${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}"`);
    logger.info(`[${FILE_NAME}] Idioma: ${language} | Dominio: ${domain}`);
    
    // Si está deshabilitado, retornar intención por defecto
    if (!this.enabled) {
      logger.info(`[${FILE_NAME}] ⚠️ Intérprete deshabilitado, retornando general_chat`);
      return {
        intent: 'general_chat',
        params: {},
        confidence: 1.0,
        method: 'disabled',
      };
    }

    // Verificar cache
    const cacheKey = this.getCacheKey(userMessage, language);
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      logger.info(`[${FILE_NAME}] ✅ Cache hit: ${cached.intent} (${cached.confidence})`);
      return cached;
    }
    logger.info(`[${FILE_NAME}] Cache miss, procesando...`);

    let result = null;
    let method = 'none';

    // 1. Intentar reglas locales primero (si está habilitado)
    if (this.useLocal) {
      logger.info(`[${FILE_NAME}] [1/3] Intentando interpretación con reglas locales...`);
      result = this.interpretWithLocalRules(userMessage, language);
      if (result && result.confidence >= 0.7) {
        method = 'local_rules';
        logger.info(`[${FILE_NAME}] [1/3] ✅ Reglas locales matched: ${result.intent} (confidence: ${result.confidence})`);
      } else {
        logger.info(`[${FILE_NAME}] [1/3] ❌ Reglas locales no match o confidence bajo (${result?.confidence || 0})`);
      }
    } else {
      logger.info(`[${FILE_NAME}] [1/3] ⚠️ Reglas locales deshabilitadas`);
    }

    // 2. Si las reglas locales fallan o no están habilitadas, usar LLM
    if (!result || result.confidence < 0.7) {
      if (this.useLLM) {
        logger.info(`[${FILE_NAME}] [2/3] Usando LLM para interpretación...`);
        result = await this.interpretWithLLM(userMessage, language, domain);
        if (result) {
          method = result.method || 'llm';
          logger.info(`[${FILE_NAME}] [2/3] ✅ LLM interpretó: ${result.intent} (confidence: ${result.confidence}, method: ${method})`);
        } else {
          logger.warn(`[${FILE_NAME}] [2/3] ⚠️ LLM no retornó resultado`);
        }
      } else {
        logger.info(`[${FILE_NAME}] [2/3] ⚠️ LLM deshabilitado`);
      }
    }

    // 3. Si todo falla, usar intención por defecto
    if (!result) {
      logger.info(`[${FILE_NAME}] [3/3] Usando intención por defecto (general_chat)`);
      result = {
        intent: 'general_chat',
        params: {},
        confidence: 0.5,
        method: 'default',
      };
    }

    // Guardar en cache
    this.saveToCache(cacheKey, result);
    logger.info(`[${FILE_NAME}] ✅ Interpretación completada: ${result.intent} (${result.confidence})`);
    logger.info(`[${FILE_NAME}] ────────────────────────────────────────`);

    return {
      ...result,
      method,
    };
  }

  /**
   * Interpreta usando reglas locales (patrones)
   * @param {string} message - Mensaje del usuario
   * @param {string} language - Idioma
   * @returns {Object|null} - Resultado de la interpretación o null
   */
  interpretWithLocalRules(message, language) {
    const FILE_NAME = 'intent-interpreter.service.js';
    const normalizedMessage = message.toLowerCase().trim();
    
    logger.info(`[${FILE_NAME}] interpretWithLocalRules() - Analizando: "${normalizedMessage.substring(0, 30)}..."`);
    
    // Patrones por idioma
    const patterns = this.getPatternsByLanguage(language);
    logger.info(`[${FILE_NAME}] Patrones disponibles: ${Object.keys(patterns).join(', ')}`);
    
    let bestMatch = null;
    let bestScore = 0;

    for (const [intent, patternConfig] of Object.entries(patterns)) {
      const { regex, keywords, confidence } = patternConfig;
      
      let score = 0;
      
      // Verificar regex
      if (regex && regex.test(normalizedMessage)) {
        score += 0.5;
        logger.info(`[${FILE_NAME}] Regex match para ${intent}: ✅`);
      }
      
      // Verificar keywords
      if (keywords) {
        const foundKeywords = keywords.filter(keyword => 
          normalizedMessage.includes(keyword.toLowerCase())
        ).length;
        score += (foundKeywords / keywords.length) * 0.5;
        if (foundKeywords > 0) {
          logger.info(`[${FILE_NAME}] Keywords match para ${intent}: ${foundKeywords}/${keywords.length}`);
        }
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = {
          intent,
          params: this.extractParamsFromMessage(message, intent, language),
          confidence: Math.min(score * confidence, 0.95),
        };
        logger.info(`[${FILE_NAME}] Nuevo mejor match: ${intent} (score: ${score}, confidence: ${bestMatch.confidence})`);
      }
    }

    if (bestMatch) {
      logger.info(`[${FILE_NAME}] ✅ Mejor match encontrado: ${bestMatch.intent} (confidence: ${bestMatch.confidence})`);
    } else {
      logger.info(`[${FILE_NAME}] ❌ No se encontró match con reglas locales`);
    }

    return bestMatch;
  }

  /**
   * Obtiene patrones por idioma
   */
  getPatternsByLanguage(language) {
    const patterns = {
      es: {
        search_products: {
          regex: /(producto|productos|buscar|buscando|necesito|quiero|tengo|encontrar|mostrar|muestra|muéstrame)/i,
          keywords: ['producto', 'productos', 'buscar', 'necesito', 'quiero', 'tengo', 'encontrar', 'mostrar', 'muestra'],
          confidence: 0.9,
        },
        add_to_cart: {
          regex: /(agregar|añadir|agrega|añade|poner|pon|meter|mete|carrito|comprar|quiero.*comprar|agregar.*carrito|añadir.*carrito)/i,
          keywords: ['agregar', 'añadir', 'agrega', 'añade', 'carrito', 'comprar', 'quiero comprar'],
          confidence: 0.9,
        },
        company_info: {
          regex: /(empresa|quienes|sobre.*nosotros|información.*empresa|quién.*son|historia)/i,
          keywords: ['empresa', 'quienes', 'sobre nosotros', 'información', 'historia'],
          confidence: 0.9,
        },
        product_price: {
          regex: /(precio|cuánto|cuesta|vale|costar|tarifa)/i,
          keywords: ['precio', 'cuánto', 'cuesta', 'vale', 'costar'],
          confidence: 0.85,
        },
        product_details: {
          regex: /(detalle|detalles|característica|especificación|información.*producto)/i,
          keywords: ['detalle', 'detalles', 'característica', 'especificación'],
          confidence: 0.85,
        },
        shipping_info: {
          regex: /(envío|enviamos|entrega|delivery|envío.*gratis|costo.*envío)/i,
          keywords: ['envío', 'entrega', 'delivery', 'shipping'],
          confidence: 0.85,
        },
      },
      en: {
        search_products: {
          regex: /(product|products|search|looking|need|want|find|show|show me)/i,
          keywords: ['product', 'products', 'search', 'need', 'want', 'find', 'show'],
          confidence: 0.9,
        },
        add_to_cart: {
          regex: /(add|add to cart|cart|buy|purchase|want to buy|add.*cart|put.*cart)/i,
          keywords: ['add', 'cart', 'buy', 'purchase', 'want to buy'],
          confidence: 0.9,
        },
        company_info: {
          regex: /(company|about|who|information|history|story)/i,
          keywords: ['company', 'about', 'who', 'information', 'history'],
          confidence: 0.9,
        },
        product_price: {
          regex: /(price|how much|cost|worth|pricing)/i,
          keywords: ['price', 'how much', 'cost', 'worth'],
          confidence: 0.85,
        },
        product_details: {
          regex: /(detail|details|specification|feature|information.*product)/i,
          keywords: ['detail', 'details', 'specification', 'feature'],
          confidence: 0.85,
        },
        shipping_info: {
          regex: /(shipping|delivery|ship|free shipping|shipping cost)/i,
          keywords: ['shipping', 'delivery', 'ship', 'free shipping'],
          confidence: 0.85,
        },
      },
      pt: {
        search_products: {
          regex: /(produto|produtos|buscar|procurando|preciso|quero|encontrar|mostrar|mostre)/i,
          keywords: ['produto', 'produtos', 'buscar', 'preciso', 'quero', 'encontrar'],
          confidence: 0.9,
        },
        add_to_cart: {
          regex: /(adicionar|adiciona|adicionar.*carrinho|carrinho|comprar|quero.*comprar)/i,
          keywords: ['adicionar', 'adiciona', 'carrinho', 'comprar', 'quero comprar'],
          confidence: 0.9,
        },
        company_info: {
          regex: /(empresa|sobre|quem|informação|história)/i,
          keywords: ['empresa', 'sobre', 'quem', 'informação'],
          confidence: 0.9,
        },
        product_price: {
          regex: /(preço|quanto|custa|vale)/i,
          keywords: ['preço', 'quanto', 'custa', 'vale'],
          confidence: 0.85,
        },
        product_details: {
          regex: /(detalhe|detalhes|característica|especificação)/i,
          keywords: ['detalhe', 'detalhes', 'característica'],
          confidence: 0.85,
        },
        shipping_info: {
          regex: /(envio|entrega|frete|frete.*grátis)/i,
          keywords: ['envio', 'entrega', 'frete'],
          confidence: 0.85,
        },
      },
    };

    return patterns[language] || patterns.es; // Fallback a español
  }

  /**
   * Extrae parámetros del mensaje según la intención
   */
  extractParamsFromMessage(message, intent, language) {
    const params = {};

    switch (intent) {
      case 'search_products':
        // Intentar extraer términos de búsqueda
        const searchTerms = this.extractSearchTerms(message, language);
        if (searchTerms) {
          params.query = searchTerms;
        }
        break;
      
      case 'add_to_cart':
      case 'product_price':
      case 'product_details':
        // Intentar extraer ID, slug o nombre del producto
        const productRef = this.extractProductReference(message);
        if (productRef) {
          params.productId = productRef;
        } else {
          // Intentar extraer nombre del producto del mensaje
          const productName = this.extractProductName(message, language);
          if (productName) {
            params.query = productName; // Usar como query para buscar
          }
        }
        // Intentar extraer cantidad
        const quantity = this.extractQuantity(message);
        if (quantity) {
          params.quantity = quantity;
        }
        break;
    }

    return params;
  }

  /**
   * Extrae nombre del producto del mensaje
   */
  extractProductName(message, language) {
    const stopWords = {
      es: ['agregar', 'añadir', 'agrega', 'añade', 'quiero', 'carrito', 'al', 'al carrito', 'comprar'],
      en: ['add', 'to', 'cart', 'want', 'buy', 'purchase'],
      pt: ['adicionar', 'adiciona', 'ao', 'carrinho', 'quero', 'comprar'],
    };

    const words = message.toLowerCase().split(/\s+/);
    const stops = stopWords[language] || stopWords.es;
    const relevantWords = words.filter(word => 
      word.length > 2 && !stops.includes(word)
    );

    // Tomar las últimas 3-5 palabras que probablemente sean el nombre del producto
    return relevantWords.slice(-5).join(' ') || null;
  }

  /**
   * Extrae cantidad del mensaje
   */
  extractQuantity(message) {
    // Buscar números que indiquen cantidad
    const quantityMatch = message.match(/\b(\d+)\s*(unidad|unidades|pcs|piezas|units?)\b/i);
    if (quantityMatch) {
      return parseInt(quantityMatch[1]);
    }
    
    // Buscar números simples cerca de palabras de cantidad
    const simpleNumber = message.match(/\b(\d+)\b/);
    if (simpleNumber) {
      const num = parseInt(simpleNumber[1]);
      // Solo si es un número razonable (1-100)
      if (num >= 1 && num <= 100) {
        return num;
      }
    }

    return null;
  }

  /**
   * Extrae términos de búsqueda del mensaje
   */
  extractSearchTerms(message, language) {
    // Remover palabras comunes
    const stopWords = {
      es: ['quiero', 'necesito', 'buscar', 'producto', 'productos', 'tengo', 'muestra', 'muéstrame'],
      en: ['want', 'need', 'search', 'product', 'products', 'show', 'show me', 'looking'],
      pt: ['quero', 'preciso', 'buscar', 'produto', 'produtos', 'mostre'],
    };

    const words = message.toLowerCase().split(/\s+/);
    const relevantWords = words.filter(word => {
      const stops = stopWords[language] || stopWords.es;
      return word.length > 2 && !stops.includes(word);
    });

    return relevantWords.join(' ') || null;
  }

  /**
   * Extrae referencia a producto (ID, nombre, etc.)
   */
  extractProductReference(message) {
    // Buscar IDs (MongoDB ObjectId format)
    const objectIdMatch = message.match(/\b[0-9a-fA-F]{24}\b/);
    if (objectIdMatch) {
      return objectIdMatch[0];
    }

    // Buscar números que podrían ser IDs
    const numberMatch = message.match(/\b\d{6,}\b/);
    if (numberMatch) {
      return numberMatch[0];
    }

    return null;
  }

  /**
   * Interpreta usando LLM (OpenAI con fallback a Gemini)
   */
  async interpretWithLLM(message, language, domain) {
    // Intentar OpenAI primero
    if (this.openaiClient) {
      try {
        const result = await this.interpretWithOpenAI(message, language, domain);
        if (result) {
          return { ...result, method: 'openai' };
        }
      } catch (error) {
        logger.warn(`[IntentInterpreter] OpenAI failed: ${error.message}`);
      }
    }

    // Fallback a Gemini
    if (this.geminiClient) {
      try {
        const result = await this.interpretWithGemini(message, language, domain);
        if (result) {
          return { ...result, method: 'gemini' };
        }
      } catch (error) {
        logger.warn(`[IntentInterpreter] Gemini failed: ${error.message}`);
      }
    }

    return null;
  }

  /**
   * Interpreta usando OpenAI
   */
  async interpretWithOpenAI(message, language, domain) {
    const FILE_NAME = 'intent-interpreter.service.js';
    
    logger.info(`[${FILE_NAME}] interpretWithOpenAI() - Llamando a OpenAI...`);
    
    const systemPrompt = `Eres un clasificador de intenciones para ${domain || 'una tienda online'}.
    
Clasifica la intención del usuario en JSON válido:
{
  "intent": "search_products | add_to_cart | company_info | product_price | product_details | shipping_info | general_chat",
  "params": {
    "query": "términos de búsqueda si aplica",
    "productId": "ID del producto si aplica",
    "quantity": "cantidad si aplica"
  },
  "confidence": 0.0-1.0
}

Idioma: ${language}
Responde SOLO con JSON válido.`;

    try {
      const response = await this.openaiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 150,
      });

      const content = response.choices[0].message.content;
      logger.info(`[${FILE_NAME}] Respuesta de OpenAI: ${content.substring(0, 100)}...`);
      
      const parsed = JSON.parse(content);
      logger.info(`[${FILE_NAME}] ✅ OpenAI interpretó: ${parsed.intent} (confidence: ${parsed.confidence})`);

      return {
        intent: parsed.intent || 'general_chat',
        params: parsed.params || {},
        confidence: parsed.confidence || 0.8,
      };
    } catch (error) {
      logger.error(`[${FILE_NAME}] ❌ Error en interpretWithOpenAI: ${error.message}`);
      throw error;
    }
  }

  /**
   * Interpreta usando Gemini
   */
  async interpretWithGemini(message, language, domain) {
    const FILE_NAME = 'intent-interpreter.service.js';
    
    logger.info(`[${FILE_NAME}] interpretWithGemini() - Llamando a Gemini...`);
    
    const prompt = `Eres un clasificador de intenciones para ${domain || 'una tienda online'}.

Clasifica la intención del usuario. Responde SOLO con JSON válido:
{
  "intent": "search_products | add_to_cart | company_info | product_price | product_details | shipping_info | general_chat",
  "params": {
    "query": "términos de búsqueda si aplica",
    "productId": "ID del producto si aplica",
    "quantity": "cantidad si aplica"
  },
  "confidence": 0.0-1.0
}

Idioma: ${language}

Mensaje del usuario: ${message}`;

    try {
      const model = this.geminiClient.getGenerativeModel({
        model: 'gemini-2.0-flash-exp',
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 150,
        },
      });

      const result = await model.generateContent(prompt);
      const response = result.response.text();
      logger.info(`[${FILE_NAME}] Respuesta de Gemini: ${response.substring(0, 100)}...`);
      
      // Extraer JSON de la respuesta
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        logger.info(`[${FILE_NAME}] ✅ Gemini interpretó: ${parsed.intent} (confidence: ${parsed.confidence})`);
        return {
          intent: parsed.intent || 'general_chat',
          params: parsed.params || {},
          confidence: parsed.confidence || 0.8,
        };
      } else {
        logger.warn(`[${FILE_NAME}] ⚠️ No se pudo extraer JSON de la respuesta de Gemini`);
      }

      return null;
    } catch (error) {
      logger.error(`[${FILE_NAME}] ❌ Error en interpretWithGemini: ${error.message}`);
      throw error;
    }
  }

  /**
   * Obtiene clave de cache
   */
  getCacheKey(message, language) {
    return `${language}:${message.substring(0, 50).toLowerCase().trim()}`;
  }

  /**
   * Obtiene del cache
   */
  getFromCache(key) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data;
    }
    this.cache.delete(key);
    return null;
  }

  /**
   * Guarda en cache
   */
  saveToCache(key, data) {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Limpia el cache
   */
  clearCache() {
    this.cache.clear();
    logger.info('[IntentInterpreter] Cache cleared');
  }
}

module.exports = new IntentInterpreterService();

