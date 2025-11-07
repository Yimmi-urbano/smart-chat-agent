/**
 * ============================================
 * CONVERSATION MODEL
 * ============================================
 * Almacena historial de conversaciones con el system prompt memorizado
 * 
 * MEJORA CLAVE: El primer mensaje siempre es el system prompt,
 * que se memoriza y no se reenvía en cada mensaje.
 */

const mongoose = require('mongoose');
const { getClientsConnection } = require('../config/database.config');

const messageSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ['system', 'user', 'assistant'],
    required: true,
  },
  content: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
  metadata: {
    model: String, // gemini | openai
    tokens: {
      input: Number,
      output: Number,
      thinking: Number,
      cached: Number,
      total: Number,
    },
    thinkingUsed: Boolean,
    action: mongoose.Schema.Types.Mixed,
    // Auditoría: Prompt enviado al LLM
    prompt: {
      type: String, // Prompt completo enviado (system prompt + dynamic prompt si existe)
      select: false, // No incluir por defecto en queries para ahorrar espacio
    },
    promptType: {
      type: String, // 'system' | 'short' | 'dynamic' | 'system+dynamic'
      enum: ['system', 'short', 'dynamic', 'system+dynamic'],
    },
    promptLength: {
      type: Number, // Longitud del prompt en caracteres
    },
    systemPromptHash: {
      type: String, // Hash del system prompt usado (para referencia)
    },
  },
});

const conversationSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    index: true,
  },
  domain: {
    type: String,
    required: true,
    index: true,
  },
  messages: [messageSchema],
  // Metadata del system prompt para referencia
  systemPromptHash: {
    type: String,
    index: true,
  },
  status: {
    type: String,
    enum: ['active', 'closed', 'archived'],
    default: 'active',
    index: true,
  },
  metadata: {
    totalMessages: {
      type: Number,
      default: 0,
    },
    totalTokens: {
      type: Number,
      default: 0,
    },
    cachedTokens: {
      type: Number,
      default: 0,
    },
    averageResponseTime: {
      type: Number,
      default: 0,
    },
    modelsUsed: {
      gemini: {
        type: Number,
        default: 0,
      },
      openai: {
        type: Number,
        default: 0,
      },
    },
    // Contexto persistente del último producto consultado
    lastProductContext: {
      productId: String,
      slug: String,
      title: String,
      price: {
        regular: Number,
        sale: Number,
      },
      image: String,
      category: mongoose.Schema.Types.Mixed,
      tags: [String],
      description: String,
      updatedAt: Date,
    },
  },
}, {
  timestamps: true,
});

// Índice compuesto para búsquedas rápidas
conversationSchema.index({ userId: 1, domain: 1, status: 1 });
conversationSchema.index({ status: 1, updatedAt: -1 });

// TTL index: eliminar conversaciones cerradas después de 90 días
conversationSchema.index(
  { updatedAt: 1 },
  { 
    expireAfterSeconds: 7776000, // 90 días
    partialFilterExpression: { status: 'closed' }
  }
);

// Función lazy para obtener el modelo (se crea cuando se necesita)
function getConversationModel() {
  const clientsConnection = getClientsConnection();
  return clientsConnection.models.Conversation || clientsConnection.model('Conversation', conversationSchema);
}

module.exports = getConversationModel;

