/**
 * ============================================
 * GROQ AGENT SERVICE
 * ============================================
 * Servicio para interactuar con Groq API (LLM gratuito como fallback)
 * Groq ofrece un tier gratuito generoso con modelos rápidos
 * 
 * IMPORTANTE: Este es un fallback cuando OpenAI y Gemini fallan
 */

const axios = require('axios');
const logger = require('../utils/logger');
const config = require('../config/env.config');
const ToolExecutorService = require('./tool-executor.service');

class GroqAgentService {
  constructor() {
    this.apiKey = config.groq?.apiKey;
    this.baseURL = config.groq?.baseURL || 'https://api.groq.com/openai/v1';
    this.model = config.groq?.model || 'llama-3.3-70b-versatile'; // Actualizado: llama-3.1-70b-versatile fue descomisionado
    this.temperature = config.groq?.temperature || 0.3;
    this.maxTokens = config.groq?.maxTokens || 1000;
    // ToolExecutorService se exporta como instancia singleton, no como clase
    this.toolExecutor = ToolExecutorService;
    this.tools = this.defineTools();
  }

  /**
   * Define las funciones disponibles para Groq
   */
  defineTools() {
    return [
      {
        type: 'function',
        function: {
          name: 'search_products',
          description: 'Busca productos en el catálogo. Realiza búsquedas flexibles e inteligentes, entendiendo sinónimos y conceptos relacionados. Por ejemplo, si buscan "cargadores portátiles", también busca "baterías portátiles" o términos similares.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Términos de búsqueda del producto (puede ser el nombre, descripción, o características)',
              },
              limit: {
                type: 'number',
                description: 'Número máximo de resultados (default: 5)',
                default: 5,
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
          description: 'Obtiene los detalles completos de un producto específico por su ID',
          parameters: {
            type: 'object',
            properties: {
              productId: {
                type: 'string',
                description: 'ID del producto',
              },
            },
            required: ['productId'],
          },
        },
      },
    ];
  }

  /**
   * Ejecuta una función/tool
   */
  async executeFunction(functionName, args, domain) {
    const FILE_NAME = 'groq-agent.service.js';
    try {
      let result;
      switch (functionName) {
        case 'search_products':
          // Validar y convertir tipos: limit debe ser número
          const limit = args.limit ? parseInt(args.limit, 10) : 5;
          const query = args.query || '';
          if (isNaN(limit) || limit < 1) {
            logger.warn(`[${FILE_NAME}] ⚠️ Limit inválido: ${args.limit}, usando default: 5`);
            const validLimit = 5;
            result = await this.toolExecutor.searchProducts({ query, limit: validLimit }, domain);
          } else {
            result = await this.toolExecutor.searchProducts({ query, limit }, domain);
          }
          // ToolExecutorService retorna { tool: 'search_products', data: {...} }
          // Extraer solo la parte data para Groq
          return result?.data || result || { error: 'No se encontraron productos' };
        case 'get_product_details':
          const productId = args.productId || '';
          if (!productId) {
            logger.warn(`[${FILE_NAME}] ⚠️ ProductId vacío o inválido`);
            return { error: 'ProductId es requerido' };
          }
          result = await this.toolExecutor.getProductDetails({ productId }, domain);
          // ToolExecutorService retorna { tool: 'product_details', data: {...} } o null
          // Extraer solo la parte data para Groq
          return result?.data || result || { error: 'Producto no encontrado' };
        default:
          logger.warn(`[${FILE_NAME}] ⚠️ Función desconocida: ${functionName}`);
          return { error: `Función ${functionName} no encontrada` };
      }
    } catch (error) {
      logger.error(`[${FILE_NAME}] ❌ Error ejecutando función ${functionName}: ${error.message}`);
      return { error: error.message };
    }
  }

  /**
   * Prepara los mensajes para la API de Groq
   */
  _prepareMessages(userMessage, conversationHistory, domain, systemPrompt) {
    const PromptMemoryService = require('./prompt-memory.service');
    
    // ENFOQUE: Function calling puro
    // - SIEMPRE usar prompt corto (solo instrucciones, sin datos)
    // - La IA obtiene información usando tools dinámicamente
    // - Cada mensaje del usuario incluye el mini system prompt
    // - El mensaje actual del usuario incluye contexto de productos mencionados recientemente
    const shortPrompt = PromptMemoryService.buildShortSystemPrompt(domain);
    const messages = [];

    // Extraer contexto de productos del historial reciente para mantener fluidez conversacional
    let currentContext = '';
    if (conversationHistory && conversationHistory.length > 0) {
      // Buscar en los últimos mensajes del asistente para encontrar productos mencionados
      const assistantMessages = conversationHistory.filter(m => m.role === 'assistant').slice(-2);
      
      for (const assistantMsg of assistantMessages.reverse()) {
        if (assistantMsg && assistantMsg.content) {
          const content = typeof assistantMsg.content === 'string' 
            ? assistantMsg.content 
            : JSON.stringify(assistantMsg.content);
          // Buscar [CONTEXTO_PRODUCTOS: ...] en el mensaje del asistente
          const contextMatch = content.match(/\[CONTEXTO_PRODUCTOS:([^\]]+)\]/);
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

    // Agregar historial de conversación: cada mensaje del usuario incluye el system prompt
    if (conversationHistory && conversationHistory.length > 0) {
      conversationHistory.forEach(msg => {
        if (msg.role === 'user') {
          const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          messages.push({
            role: 'user',
            content: `${shortPrompt}\n\n${content}`,
          });
        } else if (msg.role === 'assistant') {
          messages.push({
            role: 'assistant',
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          });
        }
      });
    }

    // Agregar mensaje del usuario con system prompt + contexto actual
    messages.push({
      role: 'user',
      content: `${shortPrompt}${currentContext}\n\n${userMessage}`,
    });

    return messages;
  }

  /**
   * Parsea la respuesta final de Groq
   */
  _parseFinalResponse(content, completion, functionResults = []) {
    const FILE_NAME = 'groq-agent.service.js';
    try {
      let message = content;
      let action = { type: 'none', productId: null, quantity: null, url: null, price_sale: null, title: null, price_regular: null, image: null, slug: null };
      let audio_description = content;

      if (!content || typeof content !== 'string') {
        logger.warn(`[${FILE_NAME}] ⚠️ Contenido inválido o vacío`);
      } else {
        // Limpiar el contenido
        const cleanContent = content.trim();
        
        // Intentar parsear JSON de múltiples formas
        let jsonData = null;
        let parsed = false;
        
        // Método 1: Intentar parsear como JSON directo
        try {
          jsonData = JSON.parse(cleanContent);
          parsed = true;
        } catch (e1) {
          // Método 2: Intentar extraer de markdown code blocks
          const jsonMatch = cleanContent.match(/```json\s*([\s\S]*?)\s*```/);
          if (jsonMatch) {
            try {
              jsonData = JSON.parse(jsonMatch[1].trim());
              parsed = true;
            } catch (e2) {
              // Continuar con siguiente método
            }
          }
          
          // Método 3: Buscar JSON en el texto (patrón general)
          if (!parsed) {
            const jsonPattern = /\{[\s\S]*"message"[\s\S]*\}/;
            const jsonMatch2 = cleanContent.match(jsonPattern);
            if (jsonMatch2) {
              try {
                jsonData = JSON.parse(jsonMatch2[0]);
                parsed = true;
              } catch (e3) {
                // Continuar
              }
            }
          }
        }

        // Si encontramos JSON, extraer los campos
        if (parsed && jsonData && typeof jsonData === 'object') {
          // Extraer message
          let extractedMessage = jsonData.message;
          
          // Si message es un string JSON, parsearlo también
          if (typeof extractedMessage === 'string' && extractedMessage.trim().startsWith('{')) {
            try {
              const nestedJson = JSON.parse(extractedMessage);
              if (nestedJson.message) {
                message = nestedJson.message;
              } else {
                message = extractedMessage;
              }
              if (nestedJson.audio_description) {
                audio_description = nestedJson.audio_description;
              }
              if (nestedJson.action && typeof nestedJson.action === 'object') {
                action = { ...action, ...nestedJson.action };
              }
            } catch (e) {
              // Si no se puede parsear el JSON anidado, usar el string directamente
              message = extractedMessage;
              logger.warn(`[${FILE_NAME}] ⚠️ No se pudo parsear JSON anidado en message, usando string directo`);
            }
          } else if (extractedMessage) {
            message = extractedMessage;
          }
          
          // Extraer audio_description
          if (jsonData.audio_description) {
            audio_description = jsonData.audio_description;
          }
          
          // Extraer action
          if (jsonData.action && typeof jsonData.action === 'object') {
            action = { ...action, ...jsonData.action };
          }
        } else {
          // Si no hay JSON, usar el contenido como mensaje directo
          message = cleanContent;
          audio_description = cleanContent;
        }
      }

      // Asegurar que message y audio_description sean strings válidos
      if (typeof message !== 'string') {
        message = String(message || 'Lo siento, hubo un problema procesando la respuesta.');
      }
      if (typeof audio_description !== 'string') {
        audio_description = String(audio_description || message);
      }

      // Extraer información de tokens
      const usage = {
        input: completion.usage?.prompt_tokens || 0,
        output: completion.usage?.completion_tokens || 0,
        cached: 0,
        thinking: 0,
        total: completion.usage?.total_tokens || 0,
      };

      return {
        message,
        audio_description,
        action,
        usage,
        usageMetadata: {
          promptTokenCount: usage.input,
          candidatesTokenCount: usage.output,
          thinkingTokenCount: 0,
        },
        functionResults,
      };
    } catch (error) {
      logger.error(`[${FILE_NAME}] ❌ Error parsing response: ${error.message}`, error);
      return {
        message: content || 'Lo siento, hubo un problema procesando la respuesta.',
        audio_description: content || 'Lo siento, hubo un problema.',
        action: { type: 'none', productId: null, quantity: null, url: null, price_sale: null, title: null, price_regular: null, image: null, slug: null },
        usage: { input: 0, output: 0, cached: 0, thinking: 0, total: 0 },
        usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, thinkingTokenCount: 0 },
        functionResults: [],
      };
    }
  }

  /**
   * Genera respuesta usando Groq con function calling
   */
  async generateResponse(userMessage, conversationHistory, domain, systemPrompt) {
    const FILE_NAME = 'groq-agent.service.js';
    try {
      if (!this.apiKey) {
        throw new Error('Groq API key no configurada');
      }

      const messages = this._prepareMessages(userMessage, conversationHistory, domain, systemPrompt);
      
      let completion;
      let currentMessages = [...messages];
      let functionResults = [];
      let functionCallRound = 0;
      const maxRounds = 3; // Limitar rondas de function calling

      while (functionCallRound < maxRounds) {
        const requestBody = {
          model: this.model,
          messages: currentMessages,
          temperature: this.temperature,
          max_tokens: this.maxTokens,
          tools: this.tools.length > 0 ? this.tools : undefined,
          tool_choice: functionCallRound === 0 ? 'auto' : 'none', // Solo permitir tools en primera ronda
        };

        const response = await axios.post(
          `${this.baseURL}/chat/completions`,
          requestBody,
          {
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 30000, // 30 segundos timeout
          }
        );

        completion = response.data;

        const message = completion.choices[0].message;

        // Verificar si hay tool calls
        if (message.tool_calls && message.tool_calls.length > 0) {
          functionCallRound++;
          currentMessages.push(message);

          // Ejecutar todas las funciones
          for (const toolCall of message.tool_calls) {
            const functionName = toolCall.function.name;
            const functionArgs = JSON.parse(toolCall.function.arguments || '{}');
            const functionResult = await this.executeFunction(functionName, functionArgs, domain);
            
            currentMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(functionResult),
            });
            functionResults.push({ functionName, result: functionResult });
          }

          // Continuar con la siguiente ronda si hay más tool calls
          if (functionCallRound >= maxRounds) {
            logger.warn(`[${FILE_NAME}] ⚠️ Límite de rondas de function calling alcanzado (${maxRounds})`);
            break;
          }
        } else {
          // No hay más tool calls, retornar respuesta final
          break;
        }
      }

      const finalMessage = completion.choices[0].message;
      const parsed = this._parseFinalResponse(finalMessage.content, completion, functionResults);
      
      return parsed;

    } catch (error) {
      const FILE_NAME = 'groq-agent.service.js';
      // Log detallado del error de Groq
      logger.error(`[${FILE_NAME}] ❌❌❌ ERROR EN GROQ: ${error.message}`);
      logger.error(`[${FILE_NAME}] ❌ Tipo de error: ${error.constructor?.name || 'Unknown'}`);
      logger.error(`[${FILE_NAME}] ❌ Stack: ${error.stack}`);
      
      // Información adicional del error
      if (error.response) {
        logger.error(`[${FILE_NAME}] ❌ Status code: ${error.response.status}`);
        logger.error(`[${FILE_NAME}] ❌ Response data: ${JSON.stringify(error.response.data)}`);
      }
      if (error.config) {
        logger.error(`[${FILE_NAME}] ❌ Request URL: ${error.config.url}`);
      }
      
      // Log completo del error
      logger.error(`[${FILE_NAME}] ❌ Error completo (JSON): ${JSON.stringify({
        name: error.name,
        message: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        stack: error.stack?.split('\n').slice(0, 5).join('\n'),
      }, null, 2)}`);
      
      throw error;
    }
  }
}

module.exports = GroqAgentService;

