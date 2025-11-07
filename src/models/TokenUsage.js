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
    enum: ['openai', 'gemini'],
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
      'gpt-4o-mini': {
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
  };

  const providerPricing = pricing[provider]?.[model] || pricing.openai['gpt-4o'];
  
  const inputCost = (tokens.input / 1000000) * providerPricing.input;
  const outputCost = (tokens.output / 1000000) * providerPricing.output;
  const cachedCost = (tokens.cached / 1000000) * providerPricing.cached;

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

