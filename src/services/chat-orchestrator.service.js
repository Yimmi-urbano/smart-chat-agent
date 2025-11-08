const GeminiAgentService = require('./gemini-agent.service');
const OpenAIAgentService = require('./openai-agent.service');
const ModelRouterService = require('./model-router.service');
const PromptMemoryService = require('./prompt-memory.service');
const IntentInterpreterService = require('./intent-interpreter.service');
const ToolExecutorService = require('./tool-executor.service');
const getConversationModel = require('../models/Conversation');
const getTokenUsageModel = require('../models/TokenUsage');
const logger = require('../utils/logger');
const config = require('../config/env.config');
const crypto = require('crypto');

class ChatOrchestratorService {
  constructor() {
    this.geminiService = new GeminiAgentService();
    this.openaiService = new OpenAIAgentService();
  }

  async processMessage({ userMessage, userId, domain, forceModel = null }) {
    const { fullResponse } = await this._handleRequest({ userMessage, userId, domain, forceModel, stream: false });
    return fullResponse;
  }

  async processMessageStream({ userMessage, userId, domain, forceModel, res }) {
    await this._handleRequest({ userMessage, userId, domain, forceModel, stream: true, res });
  }

  async _handleRequest({ userMessage, userId, domain, forceModel, stream, res }) {
    const startTime = Date.now();
    const FILE_NAME = 'chat-orchestrator.service.js';

    // 1. Preparación de la conversación
    const conversation = await this.getOrCreateConversation(userId, domain);
    const systemPrompt = await this._getSystemPrompt(conversation, domain);
    const history = this._getRecentHistory(conversation);

    // 2. Interpretación de la intención y ejecución de herramientas (si es necesario)
    const { interpretedIntent, toolResult, dynamicPrompt } = await this._interpretAndExecuteTools(userMessage, history, conversation, domain);
    const finalSystemPrompt = dynamicPrompt || systemPrompt;

    // 3. Generación de respuesta (con o sin streaming)
    const { selectedModel, thinkingUsed } = this._decideModel(userMessage, history, forceModel);

    const agentService = selectedModel === 'gemini' ? this.geminiService : this.openaiService;
    const responseStream = await agentService.generateResponse(userMessage, history, domain, finalSystemPrompt, thinkingUsed, true);

    let fullResponseMessage = '';
    let toolCalls = [];
    let finishReason = null;

    for await (const chunk of responseStream) {
      const delta = chunk.choices[0]?.delta;
      const text = delta?.content || '';
      
      if (delta?.tool_calls) {
        toolCalls = delta.tool_calls;
        finishReason = 'tool_calls';
        break;
      }

      if (text) {
        fullResponseMessage += text;
        if (stream && res) {
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        }
      }
      if(chunk.choices[0]?.finish_reason){
        finishReason = chunk.choices[0].finish_reason;
      }
    }

    // 4. Manejo de Tool Calls (si los hubo)
    if (finishReason === 'tool_calls' && toolCalls.length > 0) {
      // (Esta sección necesitaría una implementación más robusta para manejar múltiples tool calls)
      const toolCall = toolCalls[0];
      const functionResult = await ToolExecutorService.executeTool(toolCall.function.name, JSON.parse(toolCall.function.arguments), domain);
      
      // Añadir el resultado de la herramienta a la historia y volver a llamar al LLM
      const newHistory = [...history, { role: 'assistant', content: null, tool_calls: toolCalls }, { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(functionResult) }];
      const finalResponseStream = await agentService.generateResponse(userMessage, newHistory, domain, finalSystemPrompt, false, true);
      
      for await (const chunk of finalResponseStream) {
        const text = chunk.choices[0]?.delta?.content || '';
        if (text) {
          fullResponseMessage += text;
          if (stream && res) {
            res.write(`data: ${JSON.stringify({ text })}\n\n`);
          }
        }
      }
    }

    // 5. Validación y Persistencia
    const finalResponse = this._buildFinalResponse(fullResponseMessage, startTime);
    await this._saveConversation(conversation, userMessage, finalResponse, selectedModel, fullResponseMessage);

    return { fullResponse: finalResponse };
  }

  _decideModel(userMessage, history, forceModel) {
    const selectedModel = forceModel || ModelRouterService.decideModel(userMessage, history);
    const thinkingUsed = selectedModel === 'gemini' ? ModelRouterService.shouldUseThinking(userMessage) : false;
    return { selectedModel, thinkingUsed };
  }

  async _getSystemPrompt(conversation, domain) {
    if (conversation.messages && conversation.messages.length > 0 && conversation.messages[0].role === 'system') {
      return conversation.messages[0].content;
    }
    const systemPrompt = await PromptMemoryService.buildSystemPrompt(domain);
    conversation.messages.unshift({ role: 'system', content: systemPrompt, timestamp: new Date() });
    conversation.systemPromptHash = crypto.createHash('md5').update(systemPrompt).digest('hex');
    await conversation.save();
    return systemPrompt;
  }

  _getRecentHistory(conversation) {
    const maxHistory = 6;
    const messages = conversation.messages || [];
    if (messages.length === 0) return [];
    
    const systemMessage = messages[0].role === 'system' ? [messages[0]] : [];
    const conversationMessages = messages.slice(systemMessage.length);
    const recentMessages = conversationMessages.slice(-maxHistory);
    
    return [...systemMessage, ...recentMessages];
  }

  async _interpretAndExecuteTools(userMessage, history, conversation, domain) {
      let interpretedIntent = null;
      let toolResult = null;
      let dynamicPrompt = null;

      if (IntentInterpreterService.enabled) {
        const language = this.detectLanguage(userMessage);
        interpretedIntent = await IntentInterpreterService.interpret(userMessage, language, domain);

        if (interpretedIntent.intent !== 'general_chat' && interpretedIntent.confidence >= 0.6) {
            toolResult = await ToolExecutorService.executeTool(
              interpretedIntent.intent,
              interpretedIntent.params,
              domain
            );

            if (toolResult) {
              const systemPrompt = await this._getSystemPrompt(conversation, domain);
              dynamicPrompt = this.buildDynamicPrompt(interpretedIntent.intent, toolResult, systemPrompt, domain);
            }
        }
    }
    return { interpretedIntent, toolResult, dynamicPrompt };
  }

  _buildFinalResponse(fullResponseMessage, startTime) {
    // Esta es una simplificación. En una implementación real, se necesitaría una
    // lógica más robusta para construir la acción y otros metadatos.
    return {
      message: fullResponseMessage,
      audio_description: fullResponseMessage.substring(0, 150),
      action: { type: 'none' },
      response_time_ms: Date.now() - startTime,
    };
  }

  async _saveConversation(conversation, userMessage, response, usedModel, fullResponseMessage) {
    conversation.messages.push({ role: 'user', content: userMessage, timestamp: new Date() });
    conversation.messages.push({
      role: 'assistant',
      content: fullResponseMessage,
      timestamp: new Date(),
      metadata: { model: usedModel },
    });
    conversation.metadata.totalMessages += 2;
    await conversation.save();
    logger.info(`[${'chat-orchestrator.service.js'}] ✅ Conversación guardada.`);
  }

  detectLanguage(message) {
    // Detección simple basada en palabras comunes
    const spanishWords = ['qué', 'cómo', 'cuándo', 'dónde', 'por qué', 'tiene', 'tengo', 'quiero', 'necesito'];
    const englishWords = ['what', 'how', 'when', 'where', 'why', 'have', 'need', 'want'];
    const portugueseWords = ['o que', 'como', 'quando', 'onde', 'por que', 'tem', 'preciso', 'quero'];

    const lowerMessage = message.toLowerCase();

    const spanishCount = spanishWords.filter(word => lowerMessage.includes(word)).length;
    const englishCount = englishWords.filter(word => lowerMessage.includes(word)).length;
    const portugueseCount = portugueseWords.filter(word => lowerMessage.includes(word)).length;

    if (spanishCount > englishCount && spanishCount > portugueseCount) return 'es';
    if (portugueseCount > englishCount && portugueseCount > spanishCount) return 'pt';
    if (englishCount > spanishCount && englishCount > portugueseCount) return 'en';

    // Default a español
    return 'es';
  }
}

module.exports = ChatOrchestratorService;
