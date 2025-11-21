/**
 * ============================================
 * SERVER
 * ============================================
 * Servidor principal de la aplicación
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const bodyParser = require('body-parser');
const config = require('./config/env.config');
const { initializeDatabases } = require('./config/database.config');
const logger = require('./utils/logger');
const errorHandler = require('./api/middlewares/error-handler.middleware');

// Importar rutas
const chatRoutes = require('./api/routes/chat.routes');
const textToSpeechRoutes = require('./api/routes/text-to-speech.routes');

const app = express();

// Middlewares de seguridad
if (config.security.enableHelmet) {
  app.use(helmet());
}

// CORS
app.use(cors({
  origin: config.cors.allowedOrigins,
  credentials: true,
}));

// Compression
app.use(compression());

// Body parser
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'smart-chat-agent',
  });
});

// API Routes
app.use('/api/chat', chatRoutes);
app.use('/api/text-to-speech', textToSpeechRoutes);

// Error handler
app.use(errorHandler);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
  });
});

// Inicializar servidor
async function startServer() {
  try {
    // Inicializar bases de datos
    await initializeDatabases();

    // Iniciar servidor
    const port = config.port;
    app.listen(port, () => {
      // Server started successfully
    });
  } catch (error) {
    logger.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Manejo de errores no capturados
process.on('unhandledRejection', (error) => {
  logger.error('Unhandled Rejection:', error);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

// Iniciar servidor
startServer();

module.exports = app;

