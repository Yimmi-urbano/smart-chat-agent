/**
 * ============================================
 * TEXT TO SPEECH SERVICE
 * ============================================
 * Servicio para convertir texto a voz usando AWS Polly
 */

const logger = require('../utils/logger');
const config = require('../config/env.config');

class TextToSpeechService {
  constructor() {
    this.polly = null;
    this.initialized = false;
    this._initializeAWS();
  }

  /**
   * Inicializa AWS Polly solo si está configurado
   */
  _initializeAWS() {
    try {
      if (config.aws && config.aws.accessKeyId && config.aws.secretAccessKey) {
        // Verificar si aws-sdk está instalado
        let AWS;
        try {
          AWS = require('aws-sdk');
        } catch (requireError) {
          logger.error('[TextToSpeech] aws-sdk no está instalado. Ejecute: npm install aws-sdk');
          this.initialized = false;
          return;
        }
        
        AWS.config.update({
          region: config.aws.region || 'us-east-1',
          accessKeyId: config.aws.accessKeyId,
          secretAccessKey: config.aws.secretAccessKey,
        });

        this.polly = new AWS.Polly();
        this.initialized = true;
        logger.info('[TextToSpeech] AWS Polly inicializado correctamente');
      } else {
        logger.warn('[TextToSpeech] AWS credentials no configuradas. El servicio de text-to-speech estará deshabilitado.');
        this.initialized = false;
      }
    } catch (error) {
      logger.error('[TextToSpeech] Error inicializando AWS Polly:', error);
      this.initialized = false;
    }
  }

  /**
   * Sintetiza texto a voz
   * @param {string} text - Texto a convertir
   * @param {object} options - Opciones de síntesis (voiceId, languageCode, engine)
   * @returns {Promise<Buffer>} - Stream de audio
   */
  async synthesizeSpeech(text, options = {}) {
    if (!this.initialized || !this.polly) {
      throw new Error('AWS Polly no está inicializado. Verifique las credenciales de AWS.');
    }

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('El texto no puede estar vacío');
    }

    const params = {
      Text: text,
      OutputFormat: options.outputFormat || 'mp3',
      Engine: options.engine || 'neural',
      VoiceId: options.voiceId || config.aws?.polly?.voiceId || 'Mia',
      LanguageCode: options.languageCode || config.aws?.polly?.languageCode || 'es-MX',
    };

    try {
      logger.info(`[TextToSpeech] Sintetizando texto (${text.length} caracteres)`);
      const data = await this.polly.synthesizeSpeech(params).promise();
      return data.AudioStream;
    } catch (error) {
      logger.error('[TextToSpeech] Error sintetizando voz:', error);
      throw new Error(`Error al sintetizar voz: ${error.message}`);
    }
  }

  /**
   * Verifica si el servicio está disponible
   * @returns {boolean}
   */
  isAvailable() {
    return this.initialized && this.polly !== null;
  }
}

module.exports = new TextToSpeechService();

