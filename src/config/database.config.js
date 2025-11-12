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

// Conexión de configuración
let configConnection = null;

/**
 * Conecta a la base de datos principal
 */
async function connectMainDatabase() {
  try {
    if (mainConnection && mainConnection.readyState === 1) {
      return mainConnection;
    }

    // OPTIMIZACIÓN MULTITENANT: Pool de conexiones optimizado para múltiples dominios
    const optimizedOptions = {
      ...config.mongo.options,
      // Aumentar pool size para multitenant (más dominios = más conexiones concurrentes)
      maxPoolSize: config.mongo.options?.maxPoolSize || 50,
      minPoolSize: config.mongo.options?.minPoolSize || 5,
      // Mantener conexiones vivas más tiempo para reutilización
      maxIdleTimeMS: config.mongo.options?.maxIdleTimeMS || 30000,
      // Timeouts optimizados para multitenant
      serverSelectionTimeoutMS: config.mongo.options?.serverSelectionTimeoutMS || 5000,
      socketTimeoutMS: config.mongo.options?.socketTimeoutMS || 45000,
    };
    
    mainConnection = await mongoose.createConnection(config.mongo.uri, optimizedOptions);
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

    // OPTIMIZACIÓN MULTITENANT: Pool de conexiones optimizado
    const optimizedOptions = {
      ...config.mongo.options,
      maxPoolSize: config.mongo.options?.maxPoolSize || 50,
      minPoolSize: config.mongo.options?.minPoolSize || 5,
      maxIdleTimeMS: config.mongo.options?.maxIdleTimeMS || 30000,
      serverSelectionTimeoutMS: config.mongo.options?.serverSelectionTimeoutMS || 5000,
      socketTimeoutMS: config.mongo.options?.socketTimeoutMS || 45000,
    };
    
    clientsConnection = await mongoose.createConnection(config.mongo.clientsUri, optimizedOptions);
    return clientsConnection;
  } catch (error) {
    logger.error('❌ Clients database connection error:', error);
    throw error;
  }
}

/**
 * Conecta a la base de datos de configuración
 */
async function connectConfigDatabase() {
  try {
    if (!config.mongo.configUri) {
      logger.warn('⚠️ MONGO_URI_CONFIG not configured, skipping config database connection');
      return null;
    }

    if (configConnection && configConnection.readyState === 1) {
      return configConnection;
    }

    // OPTIMIZACIÓN MULTITENANT: Pool de conexiones optimizado
    const optimizedOptions = {
      ...config.mongo.options,
      maxPoolSize: config.mongo.options?.maxPoolSize || 20, // Menos conexiones para config (menos consultas)
      minPoolSize: config.mongo.options?.minPoolSize || 2,
      maxIdleTimeMS: config.mongo.options?.maxIdleTimeMS || 60000, // Más tiempo idle (config cambia poco)
      serverSelectionTimeoutMS: config.mongo.options?.serverSelectionTimeoutMS || 5000,
      socketTimeoutMS: config.mongo.options?.socketTimeoutMS || 45000,
    };
    
    configConnection = await mongoose.createConnection(config.mongo.configUri, optimizedOptions);
    return configConnection;
  } catch (error) {
    logger.error('❌ Config database connection error:', error);
    throw error;
  }
}

/**
 * Inicializa todas las conexiones
 */
async function initializeDatabases() {
  await connectMainDatabase();
  await connectClientsDatabase();
  await connectConfigDatabase();
}

/**
 * Cierra todas las conexiones
 */
async function closeDatabases() {
  if (mainConnection) {
    await mainConnection.close();
  }
  if (clientsConnection) {
    await clientsConnection.close();
  }
  if (configConnection) {
    await configConnection.close();
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

/**
 * Obtiene la conexión de configuración (lazy getter)
 */
function getConfigConnection() {
  if (!configConnection) {
    // No lanzar error, solo warning, porque puede no estar configurado
    logger.warn('Config database connection not initialized. Call connectConfigDatabase() first.');
    return null;
  }
  return configConnection;
}

module.exports = {
  get mainConnection() {
    return getMainConnection();
  },
  get clientsConnection() {
    return getClientsConnection();
  },
  get configConnection() {
    return getConfigConnection();
  },
  connectMainDatabase,
  connectClientsDatabase,
  connectConfigDatabase,
  initializeDatabases,
  closeDatabases,
  getMainConnection,
  getClientsConnection,
  getConfigConnection,
};

