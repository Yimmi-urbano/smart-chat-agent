/**
 * ============================================
 * TOOL EXECUTOR SERVICE
 * ============================================
 * Ejecuta herramientas (tools) según la intención interpretada
 * 
 * TOOLS DISPONIBLES:
 * - search_products: Busca productos
 * - get_company_info: Obtiene información de la empresa
 * - get_product_price: Obtiene precio de un producto
 * - get_product_details: Obtiene detalles de un producto
 * - get_shipping_info: Obtiene información de envío
 */

const getProductModel = require('../models/Product');
const getConfigurationModel = require('../models/Configuration');
const logger = require('../utils/logger');
const axios = require('axios');
const config = require('../config/env.config');

class ToolExecutorService {
  /**
   * Ejecuta un tool según la intención
   * @param {string} intent - Intención identificada
   * @param {Object} params - Parámetros del tool
   * @param {string} domain - Dominio del negocio
   * @returns {Promise<Object>} - Resultado del tool
   */
  async executeTool(intent, params, domain) {
    const FILE_NAME = 'tool-executor.service.js';

    let result = null;

    switch (intent) {
      case 'search_products':
        result = await this.searchProducts(params, domain);
        break;
      
      case 'add_to_cart':
        result = await this.addToCart(params, domain);
        break;
      
      case 'company_info':
        result = await this.getCompanyInfo(domain);
        break;
      
      case 'product_price':
        result = await this.getProductPrice(params, domain);
        break;
      
      case 'product_details':
        result = await this.getProductDetails(params, domain);
        break;
      
      case 'shipping_info':
        result = await this.getShippingInfo(domain);
        break;
      
      default:
        logger.warn(`[${FILE_NAME}] ⚠️ Intent desconocido: ${intent}`);
        return null;
    }

    if (!result) {
      logger.warn(`[${FILE_NAME}] ⚠️ Tool no retornó resultado`);
    }
    
    return result;
  }

  /**
   * Busca productos con búsqueda flexible e inteligente
   * El LLM ya interpretó la intención, aquí hacemos búsqueda flexible por palabras clave
   */
  async searchProducts(params, domain) {
    const { query = '', category, minPrice, maxPrice, limit = 5 } = params;

    const filter = {
      domain,
      is_available: true,
    };

    if (query) {
      // Búsqueda flexible: buscar palabras individuales que pueden estar en cualquier orden
      // Esto permite encontrar "batería portátil" cuando buscan "cargadores portátiles"
      const keywords = query
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 2) // Filtrar palabras muy cortas
        .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); // Escapar caracteres especiales
      
      if (keywords.length > 0) {
        // Estrategia 1: Búsqueda por palabras individuales (más flexible)
        // Buscar productos que contengan CUALQUIERA de las palabras clave
        // Esto permite encontrar productos relacionados aunque no coincidan exactamente
        const wordRegex = new RegExp(`(${keywords.join('|')})`, 'i');
        
        filter.$or = [
          // Buscar en título (mayor peso)
          { title: wordRegex },
          // Buscar en descripción corta
          { description_short: wordRegex },
          // Buscar en descripción larga
          { description_long: wordRegex },
          // Buscar en categoría
          { 'category.slug': wordRegex },
          { 'category.name': wordRegex },
          // Buscar en tags
          { tags: wordRegex },
        ];
      }
    }

    if (category) {
      filter['category.slug'] = new RegExp(category, 'i');
    }

    if (minPrice || maxPrice) {
      filter['price.regular'] = {};
      if (minPrice) filter['price.regular'].$gte = minPrice;
      if (maxPrice) filter['price.regular'].$lte = maxPrice;
    }

    const Product = getProductModel();
    let products = await Product
      .find(filter)
      .limit(Math.min(limit * 2, 20))
      .select('title description_short price slug category image_default is_available tags')
      .lean();

    // Ordenar por relevancia basado en coincidencias de palabras clave
    if (query && products.length > 1) {
      const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      
      products = products
        .map(p => {
          const titleLower = (p.title || '').toLowerCase();
          const descLower = ((p.description_short || '') + ' ' + (p.description_long || '')).toLowerCase();
          
          let score = 0;
          
          // Calcular relevancia basado en cuántas palabras clave coinciden
          keywords.forEach(kw => {
            // Mayor puntuación si la palabra está en el título
            if (titleLower.includes(kw)) {
              score += 10;
              // Bonus si está al inicio del título
              if (titleLower.startsWith(kw) || titleLower.indexOf(` ${kw}`) === 0) {
                score += 5;
              }
            }
            // Puntuación media si está en la descripción
            if (descLower.includes(kw)) {
              score += 3;
            }
          });
          
          // Bonus si todas las palabras clave aparecen (coincidencia completa)
          const allKeywordsMatch = keywords.every(kw => 
            titleLower.includes(kw) || descLower.includes(kw)
          );
          if (allKeywordsMatch) {
            score += 10;
          }
          
          return { ...p, _relevanceScore: score };
        })
        .sort((a, b) => {
          // Ordenar por relevancia (mayor a menor)
          if (b._relevanceScore !== a._relevanceScore) {
            return b._relevanceScore - a._relevanceScore;
          }
          // Si hay empate, ordenar alfabéticamente
          return (a.title || '').localeCompare(b.title || '');
        })
        .slice(0, Math.min(limit, 10));
    } else {
      products = products.slice(0, Math.min(limit, 10));
    }

    return {
      tool: 'search_products',
      data: {
        count: products.length,
        products: products.map(p => {
          let imageUrl = 'https://via.placeholder.com/300x300?text=Sin+Imagen';
          if (Array.isArray(p.image_default) && p.image_default.length > 0) {
            const img = p.image_default[0];
            imageUrl = img.startsWith('http') ? img : `https://example.com${img}`;
          }
          
          const priceObj = typeof p.price === 'object' && p.price !== null
            ? {
                regular: p.price.regular || 0,
                sale: p.price.sale || p.price.regular || 0
              }
            : {
                regular: 0,
                sale: 0
              };
          
          return {
            id: p._id.toString(),
            title: p.title || 'Sin título',
            description: p.description_short || '',
            price: priceObj,
            image: imageUrl,
            slug: p.slug || p._id.toString(),
            category: Array.isArray(p.category) ? p.category[0]?.slug : p.category,
          };
        }),
      },
    };
  }

  /**
   * Agrega producto al carrito (obtiene información del producto para agregarlo)
   */
  async addToCart(params, domain) {
    const FILE_NAME = 'tool-executor.service.js';
    const { productId, query, quantity = 1 } = params;
    
    // Si hay productId, obtener información del producto
    if (productId) {
      const productDetails = await this.getProductDetails({ productId }, domain);
      if (productDetails && productDetails.data) {
        return {
          tool: 'add_to_cart',
          data: {
            productId: productDetails.data.id,
            title: productDetails.data.title,
            price: productDetails.data.price,
            slug: productDetails.data.slug,
            quantity: quantity,
            image: productDetails.data.images && productDetails.data.images[0] ? productDetails.data.images[0] : null,
          },
        };
      } else {
        logger.warn(`[${FILE_NAME}] ⚠️ No se encontró producto con ID: ${productId}`);
      }
    }
    
    // Si hay query, buscar el producto primero
    if (query) {
      const searchResult = await this.searchProducts({ query, limit: 1 }, domain);
      if (searchResult && searchResult.data && searchResult.data.products && searchResult.data.products.length > 0) {
        const product = searchResult.data.products[0];
        return {
          tool: 'add_to_cart',
          data: {
            productId: product.id,
            title: product.title,
            price: product.price,
            slug: product.slug,
            quantity: quantity,
            image: product.image,
          },
        };
      } else {
        logger.warn(`[${FILE_NAME}] ⚠️ No se encontró producto con query: "${query}"`);
      }
    }
    
    logger.warn(`[${FILE_NAME}] ❌ No se pudo encontrar el producto para agregar al carrito`);
    return null;
  }

  /**
   * Obtiene información de la empresa desde MongoDB
   * Extrae: title, meta_description, social_links, whatsapp_home, type_store, meta_keyword, slogan
   */
  async getCompanyInfo(domain) {
    const FILE_NAME = 'tool-executor.service.js';
    try {
      // Intentar obtener desde MongoDB (configuración)
      const Configuration = getConfigurationModel();
      
      if (Configuration) {
        const configData = await Configuration.findOne({ domain }).lean();
        
        if (configData) {
          // Extraer solo los campos requeridos
          const companyInfo = {
            title: configData.title || '',
            slogan: configData.slogan || '',
            meta_description: configData.meta_description || '',
            meta_keyword: configData.meta_keyword || '',
            type_store: configData.type_store || '',
            social_links: configData.social_links || [],
            whatsapp_home: configData.whatsapp_home || null,
          };
          
          return {
            tool: 'company_info',
            data: companyInfo,
          };
        } else {
          logger.warn(`[${FILE_NAME}] ⚠️ No se encontró configuración en MongoDB para dominio: ${domain}`);
        }
      } else {
        logger.warn(`[${FILE_NAME}] ⚠️ Conexión a base de datos de configuración no disponible`);
      }
      
      // Fallback: Intentar obtener desde API si está configurada
      if (config.api.configurationUrl) {
        try {
          const { data } = await axios.get(`${config.api.configurationUrl}/api/configurations`, {
            headers: { domain },
            timeout: 5000,
          });

          const businessConfig = data?.[0] || { name: domain };

          return {
            tool: 'company_info',
            data: {
              title: businessConfig.title || businessConfig.name || domain,
              slogan: businessConfig.slogan || '',
              meta_description: businessConfig.meta_description || businessConfig.description || '',
              meta_keyword: businessConfig.meta_keyword || '',
              type_store: businessConfig.type_store || '',
              social_links: businessConfig.social_links || [],
              whatsapp_home: businessConfig.whatsapp_home || null,
            },
          };
        } catch (apiError) {
          logger.error(`[${FILE_NAME}] Error obteniendo configuración desde API: ${apiError.message}`);
        }
      }
      
      // Si no se pudo obtener de ninguna fuente, retornar datos mínimos
      return {
        tool: 'company_info',
        data: {
          title: domain,
          slogan: '',
          meta_description: 'Información de la empresa no disponible',
          meta_keyword: '',
          type_store: '',
          social_links: [],
          whatsapp_home: null,
        },
      };
    } catch (error) {
      logger.error(`[${FILE_NAME}] ❌ Error getting company info: ${error.message}`);
      logger.error(`[${FILE_NAME}] Stack: ${error.stack}`);
      return {
        tool: 'company_info',
        data: {
          title: domain,
          slogan: '',
          meta_description: 'No se pudo obtener la información de la empresa',
          meta_keyword: '',
          type_store: '',
          social_links: [],
          whatsapp_home: null,
        },
      };
    }
  }

  /**
   * Obtiene precio de un producto
   */
  async getProductPrice(params, domain) {
    const { productId } = params;
    if (!productId) {
      return null;
    }

    const Product = getProductModel();
    const product = await Product
      .findOne({
        $or: [
          { _id: productId },
          { slug: productId },
        ],
        domain,
        is_available: true,
      })
      .select('title price slug')
      .lean();

    if (!product) {
      return null;
    }

    const price = typeof product.price === 'object' && product.price !== null
      ? {
          regular: product.price.regular || 0,
          sale: product.price.sale || product.price.regular || 0
        }
      : {
          regular: 0,
          sale: 0
        };

    return {
      tool: 'product_price',
      data: {
        productId: product._id.toString(),
        title: product.title,
        price,
        slug: product.slug,
      },
    };
  }

  /**
   * Obtiene detalles de un producto
   */
  async getProductDetails(params, domain) {
    const FILE_NAME = 'tool-executor.service.js';
    const { productId } = params;
    
    if (!productId) {
      logger.warn(`[${FILE_NAME}] getProductDetails() - ❌ productId no proporcionado`);
      return null;
    }

    // Validar que productId sea válido (ObjectId de 24 caracteres o slug válido)
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(productId);
    const isValidSlug = /^[a-zA-Z0-9\-_]{3,}$/.test(productId);
    
    // Excluir palabras comunes
    const commonWords = ['del', 'de', 'la', 'el', 'los', 'las', 'un', 'una', 'uno', 'dos', 'tres', 'con', 'por', 'para', 'ver', 'mas', 'más', 'detalles', 'detalle'];
    if (commonWords.includes(productId.toLowerCase())) {
      logger.warn(`[${FILE_NAME}] getProductDetails() - ❌ productId es una palabra común: ${productId}`);
      return null;
    }
    
    if (!isObjectId && !isValidSlug) {
      logger.warn(`[${FILE_NAME}] getProductDetails() - ❌ productId inválido: ${productId} (debe ser ObjectId de 24 caracteres o slug válido)`);
      return null;
    }

    const Product = getProductModel();
    
    try {
      // Construir la consulta según el tipo de ID
      const query = {
        domain,
        is_available: true,
      };
      
      if (isObjectId) {
        query._id = productId;
      } else {
        query.slug = productId;
      }
      
      // OPTIMIZACIÓN MULTITENANT: Usar select() para limitar campos y mejorar performance
      // Solo seleccionar campos necesarios para la respuesta
      const product = await Product.findOne(query)
        .select('title slug price image_default category tags description_short description_long _id')
        .lean();

      if (!product) {
        logger.warn(`[${FILE_NAME}] getProductDetails() - ❌ Producto no encontrado: ${productId}`);
        return null;
      }

      return {
        tool: 'product_details',
        data: {
          id: product._id.toString(),
          title: product.title,
          description: product.description_short || product.description_long || '',
          price: product.price,
          slug: product.slug,
          category: product.category,
          images: product.image_default || [],
          tags: product.tags || [],
        },
      };
    } catch (error) {
      logger.error(`[${FILE_NAME}] getProductDetails() - ❌ Error buscando producto: ${error.message}`);
      if (error.name === 'CastError') {
        logger.error(`[${FILE_NAME}] getProductDetails() - ⚠️ Error de casteo: ${productId} no es un ID válido`);
      }
      return null;
    }
  }

  /**
   * Obtiene información de envío
   */
  async getShippingInfo(domain) {
    try {
      if (!config.api.configurationUrl) {
        return {
          tool: 'shipping_info',
          data: {
            message: 'Información de envío no disponible',
          },
        };
      }

      const { data } = await axios.get(`${config.api.configurationUrl}/api/configurations`, {
        headers: { domain },
        timeout: 5000,
      });

      const businessConfig = data?.[0] || {};

      return {
        tool: 'shipping_info',
        data: {
          shippingPolicy: businessConfig.shipping_policy || businessConfig.shipping_info || '',
          freeShippingThreshold: businessConfig.free_shipping_threshold || null,
          shippingZones: businessConfig.shipping_zones || [],
        },
      };
    } catch (error) {
      logger.error(`[ToolExecutor] Error getting shipping info: ${error.message}`);
      return {
        tool: 'shipping_info',
        data: {
          message: 'No se pudo obtener la información de envío',
        },
      };
    }
  }
}

module.exports = new ToolExecutorService();

