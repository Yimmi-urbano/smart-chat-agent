/**
 * ============================================
 * TEXT TO SPEECH CONTROLLER
 * ============================================
 * Controlador para convertir texto a voz
 */

const textToSpeechService = require('../../services/text-to-speech.service');
const ResponseUtil = require('../../utils/response');
const logger = require('../../utils/logger');

class TextToSpeechController {
  constructor() {
    this.convertTextToSpeech = this.convertTextToSpeech.bind(this);
  }

  /**
   * POST /api/text-to-speech/speak
   * Convierte texto a voz
   */
  async convertTextToSpeech(req, res) {
    try {
      const { text } = req.body;

      // Validación
      if (!text) {
        return ResponseUtil.badRequest(res, 'Texto requerido');
      }

      if (typeof text !== 'string') {
        return ResponseUtil.badRequest(res, 'El texto debe ser una cadena de caracteres');
      }

      if (text.trim().length === 0) {
        return ResponseUtil.badRequest(res, 'El texto no puede estar vacío');
      }

      // Verificar si el servicio está disponible
      if (!textToSpeechService.isAvailable()) {
        return ResponseUtil.serverError(
          res,
          'Servicio de text-to-speech no disponible. Verifique la configuración de AWS.'
        );
      }

      // Sintetizar voz
      const audioStream = await textToSpeechService.synthesizeSpeech(text);

      // Enviar respuesta con audio
      res.set({
        'Content-Type': 'audio/mpeg',
        'Content-Disposition': 'inline; filename=speech.mp3',
        'Cache-Control': 'public, max-age=3600', // Cache por 1 hora
      });

      return res.send(audioStream);
    } catch (error) {
      logger.error('[TextToSpeech] Error en convertTextToSpeech:', error);
      
      // Asegurarse de que no se envíe una respuesta de error si ya se envió el header
      if (!res.headersSent) {
        return ResponseUtil.serverError(res, error.message || 'Error generando audio');
      }
    }
  }
}

module.exports = new TextToSpeechController();

