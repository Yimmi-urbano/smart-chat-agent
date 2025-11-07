/**
 * ============================================
 * DATABASE CONFIGURATION
 * ============================================
 * Configuración de conexiones MongoDB
 */

const mongoose = require('mongoose');
const config = require('./env.config');
const logger = require('../utils/logger');

// Conexión principal
let mainConnection = null;

// Conexión de clientes (conversaciones)
let clientsConnection = null;

/**
 * Conecta a la base de datos principal
 */
async function connectMainDatabase() {
  try {
    if (mainConnection && mainConnection.readyState === 1) {
      return mainConnection;
    }

    mainConnection = await mongoose.createConnection(config.mongo.uri, config.mongo.options);
    logger.info('✅ Main database connected');
    return mainConnection;
  } catch (error) {
    logger.error('❌ Main database connection error:', error);
    throw error;
  }
}

/**
 * Conecta a la base de datos de clientes
 */
async function connectClientsDatabase() {
  try {
    if (clientsConnection && clientsConnection.readyState === 1) {
      return clientsConnection;
    }

    clientsConnection = await mongoose.createConnection(config.mongo.clientsUri, config.mongo.options);
    logger.info('✅ Clients database connected');
    return clientsConnection;
  } catch (error) {
    logger.error('❌ Clients database connection error:', error);
    throw error;
  }
}

/**
 * Inicializa todas las conexiones
 */
async function initializeDatabases() {
  await connectMainDatabase();
  await connectClientsDatabase();
}

/**
 * Cierra todas las conexiones
 */
async function closeDatabases() {
  if (mainConnection) {
    await mainConnection.close();
    logger.info('Main database disconnected');
  }
  if (clientsConnection) {
    await clientsConnection.close();
    logger.info('Clients database disconnected');
  }
}

/**
 * Obtiene la conexión principal (lazy getter)
 */
function getMainConnection() {
  if (!mainConnection) {
    throw new Error('Main database connection not initialized. Call connectMainDatabase() first.');
  }
  return mainConnection;
}

/**
 * Obtiene la conexión de clientes (lazy getter)
 */
function getClientsConnection() {
  if (!clientsConnection) {
    throw new Error('Clients database connection not initialized. Call connectClientsDatabase() first.');
  }
  return clientsConnection;
}

module.exports = {
  get mainConnection() {
    return getMainConnection();
  },
  get clientsConnection() {
    return getClientsConnection();
  },
  connectMainDatabase,
  connectClientsDatabase,
  initializeDatabases,
  closeDatabases,
  // Exportar funciones para uso directo
  getMainConnection,
  getClientsConnection,
};

