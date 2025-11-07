/**
 * ============================================
 * MODEL ROUTER SERVICE
 * ============================================
 * Decide inteligentemente qué modelo usar:
 * - Gemini 2.5 Flash: búsquedas, comparaciones, razonamiento (GRATIS)
 * - GPT-4o: conversaciones simples, saludos (con prompt caching)
 * 
 * MEJORA: Optimiza la distribución para ahorrar tokens
 */

const logger = require('../utils/logger');

class ModelRouterService {
  /**
   * Decide qué modelo usar basándose en la complejidad del mensaje
   * @returns {string} 'gemini' | 'openai'
   */
  static decideModel(userMessage, conversationHistory = []) {
    const message = userMessage.toLowerCase().trim();

    // Casos triviales -> OpenAI (más rápido y con prompt caching)
    if (this.isTrivialMessage(message)) {
      logger.info('[Router] Using openai: Trivial message detected');
      return 'openai';
    }

    // Búsqueda de productos -> Gemini (Function Calling, GRATIS)
    if (this.detectsProductIntent(message)) {
      logger.info('[Router] Using gemini: Product search detected');
      return 'gemini';
    }

    // Comparaciones -> Gemini (mejor razonamiento, GRATIS)
    if (this.requiresComparison(message)) {
      logger.info('[Router] Using gemini: Comparison required');
      return 'gemini';
    }

    // Cálculos o lógica compleja -> Gemini (GRATIS)
    if (this.requiresCalculation(message)) {
      logger.info('[Router] Using gemini: Calculation required');
      return 'gemini';
    }

    // Múltiples condiciones -> Gemini (GRATIS)
    if (this.hasMultipleConditions(message)) {
      logger.info('[Router] Using gemini: Multiple conditions detected');
      return 'gemini';
    }

    // Preguntas sobre funcionalidades -> Gemini (thinking mode, GRATIS)
    if (this.requiresThinking(message)) {
      logger.info('[Router] Using gemini: Thinking mode required');
      return 'gemini';
    }

    // Default: OpenAI (conversaciones generales con prompt caching)
    logger.info('[Router] Using openai: Default conversational response (with prompt caching)');
    return 'openai';
  }

  /**
   * Detecta mensajes triviales
   */
  static isTrivialMessage(message) {
    const trivialPatterns = [
      /^(hola|hello|hi|hey|buenos días|buenas tardes|buenas noches)$/i,
      /^(gracias|thanks|thank you|muchas gracias)$/i,
      /^(adiós|chao|bye|hasta luego|nos vemos)$/i,
      /^(ok|okay|vale|bien|perfecto|entendido)$/i,
      /^(sí|si|no|nope|yes|yep)$/i,
      /^\?+$/,
      /^\.+$/,
    ];

    return trivialPatterns.some(pattern => pattern.test(message));
  }

  /**
   * Detecta intención de búsqueda de productos
   */
  static detectsProductIntent(message) {
    const searchKeywords = [
      'busco', 'buscar', 'quiero', 'necesito', 'me interesa',
      'muéstrame', 'mostrar', 'ver', 'productos', 'producto',
      'artículo', 'tienes', 'tienen', 'venden', 'hay',
      'dame', 'recomienda', 'sugerir', 'encuentra', 'encontrar',
    ];

    const productTypes = [
      'zapatillas', 'zapatos', 'camisa', 'pantalón', 'polo',
      'vestido', 'laptop', 'celular', 'teléfono', 'computadora',
      'tablet', 'audífonos', 'mouse', 'teclado', 'monitor',
    ];

    const hasSearchKeyword = searchKeywords.some(keyword => message.includes(keyword));
    const hasProductType = productTypes.some(type => message.includes(type));
    
    return hasSearchKeyword || hasProductType;
  }

  /**
   * Detecta necesidad de comparación
   */
  static requiresComparison(message) {
    const comparisonKeywords = [
      'compara', 'comparar', 'diferencia', 'diferencias',
      'vs', 'versus', 'mejor', 'mejores', 'entre',
      'cuál es', 'cual es', 'qué es', 'que es', 'opciones',
    ];

    return comparisonKeywords.some(keyword => message.includes(keyword));
  }

  /**
   * Detecta necesidad de cálculo
   */
  static requiresCalculation(message) {
    const calculationKeywords = [
      'cuánto', 'cuanto', 'precio', 'costo', 'total',
      'descuento', 'envío', 'delivery', 'calcular',
      'suma', 'cantidad', 'pagar', 'cobran',
    ];

    const hasNumbers = /\d+/.test(message);
    const hasCalcKeyword = calculationKeywords.some(keyword => message.includes(keyword));
    
    return hasNumbers && hasCalcKeyword;
  }

  /**
   * Detecta múltiples condiciones (AND/OR)
   */
  static hasMultipleConditions(message) {
    const andPatterns = [
      / y /, / con /, / que /, / además /, / también /,
    ];

    const orPatterns = [
      / o /, / entre /,
    ];

    const hasMultipleAnd = andPatterns.filter(pattern => pattern.test(message)).length >= 2;
    const hasOr = orPatterns.some(pattern => pattern.test(message));
    
    return hasMultipleAnd || hasOr;
  }

  /**
   * Detecta necesidad de razonamiento profundo
   */
  static requiresThinking(message) {
    const thinkingKeywords = [
      'cómo', 'como', 'por qué', 'porque', 'explica',
      'explicar', 'funciona', 'funcionamiento', 'proceso',
      'pasos', 'método', 'manera',
    ];

    return thinkingKeywords.some(keyword => message.includes(keyword));
  }

  /**
   * Determina si debe usar modo thinking en Gemini
   */
  static shouldUseThinking(userMessage) {
    const message = userMessage.toLowerCase().trim();
    
    return this.requiresThinking(message) || 
           this.requiresComparison(message) || 
           this.hasMultipleConditions(message);
  }
}

module.exports = ModelRouterService;

