/**
 * ============================================
 * RESPONSE UTILITY
 * ============================================
 * Utilidades para formatear respuestas HTTP
 */

const { StatusCodes } = require('http-status-codes');

class ResponseUtil {
  static success(res, data, message = 'Success') {
    return res.status(StatusCodes.OK).json({
      success: true,
      message,
      data,
    });
  }

  static badRequest(res, message = 'Bad Request') {
    return res.status(StatusCodes.BAD_REQUEST).json({
      success: false,
      message,
    });
  }

  static unauthorized(res, message = 'Unauthorized') {
    return res.status(StatusCodes.UNAUTHORIZED).json({
      success: false,
      message,
    });
  }

  static forbidden(res, message = 'Forbidden') {
    return res.status(StatusCodes.FORBIDDEN).json({
      success: false,
      message,
    });
  }

  static notFound(res, message = 'Not Found') {
    return res.status(StatusCodes.NOT_FOUND).json({
      success: false,
      message,
    });
  }

  static serverError(res, message = 'Internal Server Error') {
    return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      success: false,
      message,
    });
  }
}

module.exports = ResponseUtil;

