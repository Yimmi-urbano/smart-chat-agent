/**
 * ============================================
 * TOKEN USAGE MODEL
 * ============================================
 * Registra el uso de tokens y costos por conversación
 */

const mongoose = require('mongoose');
const { getClientsConnection } = require('../config/database.config');

const tokenUsageSchema = new mongoose.Schema({
  domain: {
    type: String,
    required: true,
    index: true,
  },
  userId: {
    type: String,
    required: true,
    index: true,
  },
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation',
    index: true,
  },
  provider: {
    type: String,
    enum: ['openai', 'gemini', 'groq'],
    required: true,
  },
  model: {
    type: String,
    required: true,
  },
  tokens: {
    input: Number,
    output: Number,
    thinking: Number,
    cached: Number,
    total: Number,
  },
  cost: {
    total: Number,
    currency: {
      type: String,
      default: 'USD',
    },
  },
  metadata: {
    endpoint: String,
    responseTime: Number,
    cacheHit: Boolean,
    fallbackUsed: Boolean,
    errorOccurred: Boolean,
    errorMessage: String,
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true,
  },
}, {
  timestamps: true,
});

// Índices para analytics
tokenUsageSchema.index({ domain: 1, timestamp: -1 });
tokenUsageSchema.index({ provider: 1, timestamp: -1 });

/**
 * Calcula el costo basándose en el proveedor y modelo
 * Función independiente que puede ser usada sin el modelo
 */
function calculateCost(provider, model, tokens) {
  // Precios por 1M tokens (actualizados 2024)
  const pricing = {
    openai: {
      'gpt-4o': {
        input: 2.50, // $2.50 por 1M tokens
        output: 10.00, // $10.00 por 1M tokens
        cached: 0.25, // $0.25 por 1M tokens (85% descuento)
      },
      'gpt-4o-mini': {
        input: 0.15,
        output: 0.60,
        cached: 0.075,
      },
    },
    gemini: {
      'gemini-2.5-flash': {
        input: 0, // Gratis
        output: 0,
        cached: 0,
      },
      'gemini-2.0-flash-exp': {
        input: 0,
        output: 0,
        cached: 0,
      },
    },
    groq: {
      'llama-3.3-70b-versatile': {
        input: 0, // Gratis (tier gratuito generoso) - Modelo actualizado
        output: 0,
        cached: 0,
      },
      'llama-3.1-70b-versatile': {
        input: 0, // Descomisionado - mantener para compatibilidad
        output: 0,
        cached: 0,
      },
      'llama-3.1-8b-instant': {
        input: 0, // Gratis
        output: 0,
        cached: 0,
      },
      'llama-3.3-8b-instant': {
        input: 0, // Gratis - Modelo rápido actualizado
        output: 0,
        cached: 0,
      },
      'mixtral-8x7b-32768': {
        input: 0, // Gratis
        output: 0,
        cached: 0,
      },
      'mixtral-8x22b-instruct': {
        input: 0, // Gratis - Modelo Mixtral actualizado
        output: 0,
        cached: 0,
      },
    },
  };

  const providerPricing = pricing[provider]?.[model] || pricing.openai['gpt-4o'];
  
  // Validar que tokens existe y tiene la estructura correcta
  if (!tokens || typeof tokens !== 'object') {
    tokens = { input: 0, output: 0, thinking: 0, cached: 0, total: 0 };
  }
  
  // Asegurar que todas las propiedades existen y son números (valores por defecto seguros)
  const inputTokens = (typeof tokens.input === 'number' && !isNaN(tokens.input)) ? tokens.input : 0;
  const outputTokens = (typeof tokens.output === 'number' && !isNaN(tokens.output)) ? tokens.output : 0;
  const cachedTokens = (typeof tokens.cached === 'number' && !isNaN(tokens.cached)) ? tokens.cached : 0;
  
  const inputCost = (inputTokens / 1000000) * providerPricing.input;
  const outputCost = (outputTokens / 1000000) * providerPricing.output;
  const cachedCost = (cachedTokens / 1000000) * providerPricing.cached;

  return {
    input: inputCost,
    output: outputCost,
    cached: cachedCost,
    total: inputCost + outputCost + cachedCost,
    currency: 'USD',
  };
};

// Asignar también como método estático del schema
tokenUsageSchema.statics.calculateCost = calculateCost;

// Función lazy para obtener el modelo (se crea cuando se necesita)
function getTokenUsageModel() {
  const clientsConnection = getClientsConnection();
  return clientsConnection.models.TokenUsage || clientsConnection.model('TokenUsage', tokenUsageSchema);
}

// Exportar tanto la función como el modelo
getTokenUsageModel.calculateCost = calculateCost;

module.exports = getTokenUsageModel;

