/**
 * ============================================
 * ENVIRONMENT CONFIGURATION
 * ============================================
 * Centraliza todas las variables de entorno
 * y valida su existencia al inicio
 */

require('dotenv').config();

const requiredEnvVars = [
  'MONGO_URI',
  'MONGO_URI_CLIENTS',
  'JWT_SECRET'
];

// Validar variables requeridas
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingVars.join(', '));
  console.error('Please check your .env file');
  process.exit(1);
}

module.exports = {
  // Server
  node_env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3024,
  
  // MongoDB
  mongo: {
    uri: process.env.MONGO_URI,
    clientsUri: process.env.MONGO_URI_CLIENTS,
    configUri: process.env.MONGO_URI_CONFIG, // Nueva conexión para configuración
    options: {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    }
  },

  // OpenAI
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0.2'),
    maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS, 10) || 500,
  },

  // Google Gemini
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    temperature: parseFloat(process.env.GEMINI_TEMPERATURE || '0.3'),
    maxTokens: parseInt(process.env.GEMINI_MAX_TOKENS, 10) || 1000,
  },

  // Groq (LLM gratuito como fallback)
  groq: {
    apiKey: process.env.GROQ_API_KEY,
    baseURL: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', // Actualizado: llama-3.1-70b-versatile fue descomisionado
    temperature: parseFloat(process.env.GROQ_TEMPERATURE || '0.3'),
    maxTokens: parseInt(process.env.GROQ_MAX_TOKENS, 10) || 1000,
    enabled: process.env.ENABLE_GROQ_FALLBACK === 'true', // Activar/desactivar Groq como fallback
  },

  // Model Router
  router: {
    defaultProvider: process.env.DEFAULT_MODEL_PROVIDER || 'auto', // 'auto' | 'gemini' | 'openai' | 'groq'
    enableFallback: process.env.ENABLE_MODEL_FALLBACK === 'true',
    enableFreeFallback: process.env.ENABLE_FREE_LLM_FALLBACK === 'true', // Activar fallback a LLM gratuito
  },

  // JWT
  jwt: {
    secret: process.env.JWT_SECRET,
    expiration: process.env.JWT_EXPIRATION || '7d',
  },

  // External APIs
  api: {
    configurationUrl: process.env.API_CONFIGURATION,
  },

  // Rate Limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 10000,
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 5,
  },

  // CORS
  cors: {
    allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  },

  // Feature Flags
  features: {
    promptCaching: process.env.ENABLE_PROMPT_CACHING !== 'false',
    thinkingMode: process.env.ENABLE_THINKING_MODE === 'true',
    automaticFunctionCalling: process.env.ENABLE_AUTOMATIC_FUNCTION_CALLING !== 'true',
    intentInterpreter: process.env.ENABLE_INTENT_INTERPRETER === 'true',
    intentInterpreterUseLLM: process.env.ENABLE_INTENT_INTERPRETER_LLM !== 'true',
    intentInterpreterUseLocal: process.env.ENABLE_INTENT_INTERPRETER_LOCAL !== 'true',
  },

  // Performance
  performance: {
    maxConversationHistory: parseInt(process.env.MAX_CONVERSATION_HISTORY, 10) || 10,
    productCacheTTL: parseInt(process.env.PRODUCT_CACHE_TTL_MS, 10) || 300000, // 5 min
    businessConfigCacheTTL: parseInt(process.env.BUSINESS_CONFIG_CACHE_TTL_MS, 10) || 3600000, // 1 hora
  },

  // Security
  security: {
    enableHelmet: process.env.ENABLE_HELMET !== 'false',
    enableRateLimit: process.env.ENABLE_RATE_LIMIT !== 'false',
  },

  // AWS (opcional - para text-to-speech)
  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1',
    polly: {
      voiceId: process.env.AWS_POLLY_VOICE_ID || 'Mia',
      languageCode: process.env.AWS_POLLY_LANGUAGE_CODE || 'es-MX',
      engine: process.env.AWS_POLLY_ENGINE || 'neural',
    },
  },
};

