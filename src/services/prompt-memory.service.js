/**
 * ============================================
 * PROMPT MEMORY SERVICE
 * ============================================
 * Servicio para memorizar y gestionar el system prompt
 * con configuración del negocio y catálogo de productos.
 * 
 * MEJORA CLAVE: Memoriza el primer prompt del sistema
 * para evitar reenviarlo en cada mensaje, ahorrando tokens.
 */

const axios = require('axios');
const config = require('../config/env.config');
const logger = require('../utils/logger');
const getProductModel = require('../models/Product');

// Caché en memoria para configuraciones de negocio
const businessConfigCache = new Map();

// Caché en memoria para catálogos de productos
const productCatalogCache = new Map();

class PromptMemoryService {
  /**
   * Obtiene la configuración del negocio por dominio
   * Usa caché para evitar consultas repetidas
   */
  async getBusinessConfig(domain) {
    // Verificar caché
    const cached = businessConfigCache.get(domain);
    if (cached && Date.now() - cached.timestamp < config.performance.businessConfigCacheTTL) {
      logger.info(`[PromptMemory] Using cached business config for ${domain}`);
      return cached.data;
    }

    try {
      if (!config.api.configurationUrl) {
        logger.warn('[PromptMemory] API_CONFIGURATION not configured, using default config');
        return this.getDefaultBusinessConfig(domain);
      }

      const { data } = await axios.get(`${config.api.configurationUrl}/api/configurations`, {
        headers: { domain },
        timeout: 5000,
      });

      const businessConfig = data?.[0] || this.getDefaultBusinessConfig(domain);

      // Guardar en caché
      businessConfigCache.set(domain, {
        data: businessConfig,
        timestamp: Date.now(),
      });

      logger.info(`[PromptMemory] ✅ Loaded business config for ${domain}`);
      return businessConfig;
    } catch (error) {
      logger.error(`[PromptMemory] Error loading business config for ${domain}:`, error.message);
      return this.getDefaultBusinessConfig(domain);
    }
  }

  /**
   * Obtiene un resumen del catálogo (solo categorías y productos destacados)
   * OPTIMIZACIÓN: No envía todos los productos para ahorrar tokens
   * Los productos se buscan dinámicamente usando function calling
   */
  async getProductCatalog(domain) {
    // Verificar caché
    const cached = productCatalogCache.get(domain);
    if (cached && Date.now() - cached.timestamp < config.performance.productCacheTTL) {
      logger.info(`[PromptMemory] Using cached product catalog summary for ${domain}`);
      return cached.data;
    }

    try {
      const Product = getProductModel();
      
      // OPTIMIZACIÓN: Solo obtener categorías únicas y algunos productos destacados
      // Esto reduce drásticamente el consumo de tokens
      const [totalProducts, categories, featuredProducts] = await Promise.all([
        Product.countDocuments({ domain, is_available: true }),
        Product.distinct('category.slug', { domain, is_available: true }),
        Product.find({
          domain,
          is_available: true,
        })
        .select('title price slug _id category')
        .limit(5) // Solo 5 productos destacados como ejemplo
        .lean(),
      ]);

      logger.info(`[PromptMemory] ✅ Loaded catalog summary: ${totalProducts} total products, ${categories.length} categories`);

      // Crear resumen compacto
      const categoriesText = categories.length > 0 
        ? `Categorías disponibles: ${categories.slice(0, 10).join(', ')}${categories.length > 10 ? ' y más...' : ''}`
        : 'No hay categorías disponibles.';

      const featuredText = featuredProducts.length > 0
        ? `\n\nEjemplos de productos:\n${featuredProducts.map((p, i) => 
            `${i + 1}. ${p.title} - S/${p.price?.regular || 'N/A'}`
          ).join('\n')}`
        : '';

      const catalogSummary = `${categoriesText}${featuredText}\n\nIMPORTANTE: Para buscar productos específicos, usa la función search_products disponible. No inventes productos que no estén en el catálogo.`;

      const catalogData = {
        text: catalogSummary,
        count: totalProducts,
        categories: categories.slice(0, 20), // Guardar hasta 20 categorías para referencia
        featuredProducts: featuredProducts.map(p => ({
          id: p._id.toString(),
          title: p.title,
          slug: p.slug,
          price: p.price,
        })),
      };

      // Guardar en caché
      productCatalogCache.set(domain, {
        data: catalogData,
        timestamp: Date.now(),
      });

      return catalogData;
    } catch (error) {
      logger.error(`[PromptMemory] Error loading product catalog for ${domain}:`, error.message);
      return {
        text: 'No hay productos disponibles en el catálogo. Usa la función search_products para buscar.',
        count: 0,
        categories: [],
        featuredProducts: [],
      };
    }
  }

  /**
   * Construye un system prompt corto para mensajes subsecuentes
   * OPTIMIZACIÓN: Versión minimalista que reduce tokens en ~80%
   */
  buildShortSystemPrompt(domain) {
    return `Eres asistente de ventas para "${domain}". 

REGLAS:
- Responde en JSON: {"message": "...", "audio_description": "...", "action": {...}}
- BÚSQUEDA INTELIGENTE: Cuando uses search_products, piensa en conceptos relacionados. Si no hay resultados exactos, busca términos relacionados (ej: "cargadores" → "batería", "batidora" → "batidor").
- Para buscar productos, usa search_products (función disponible)
- Si el usuario SOLICITA EXPLÍCITAMENTE agregar al carrito, ejecuta la acción add_to_cart con los datos del producto
- Si el usuario solo pregunta sobre productos, muestra información pero pregunta antes de agregar
- Responde en español de Perú (PEN)
- Máximo 150 caracteres
- No inventes productos`;
  }

  /**
   * Construye el system prompt completo con configuración y catálogo
   * Este prompt se memoriza y se reutiliza en toda la conversación
   * OPTIMIZACIÓN: Solo se usa en el primer mensaje
   */
  async buildSystemPrompt(domain) {
    const [businessConfig, productCatalog] = await Promise.all([
      this.getBusinessConfig(domain),
      this.getProductCatalog(domain),
    ]);

    // Optimizar información del negocio: solo campos esenciales
    const businessName = businessConfig.name || domain;
    const currency = businessConfig.currency || 'PEN';
    const country = businessConfig.country || 'Perú';
    const productCatalogSummary = productCatalog.text;
    
    return `Eres asistente de ventas para "${businessName}" (${country}, ${currency}).

FORMATO RESPUESTA (JSON obligatorio):
{"message": "texto visual", "audio_description": "texto hablado", "action": {"type": "none|add_to_cart|show_product|go_to_url", "productId": null, ...}}

REGLAS:
- Si el usuario SOLICITA EXPLÍCITAMENTE agregar al carrito (ej: "agrega al carrito", "quiero comprar", "añade"), ejecuta la acción add_to_cart con los datos del producto proporcionados
- Si el usuario solo pregunta o busca productos, muestra información pero pregunta antes de agregar al carrito
- BÚSQUEDA INTELIGENTE: Cuando uses search_products, piensa en conceptos relacionados. Si el usuario busca "cargadores portátiles" y no hay resultados exactos, busca términos relacionados como "batería portátil" o "power bank". Si busca "batidora", también considera "batidor" o "mezclador". Sé flexible y entiende la intención del usuario, no solo las palabras exactas.
- Para buscar productos: usa search_products (función disponible). NO inventes productos.
- message: texto visual (sin links/html). audio_description: texto hablado (sin mencionar botones).
- Responde en español de Perú (PEN). Máximo 150 caracteres.
- Si producto no existe después de buscar términos relacionados: "No encontré ese producto. ¿Buscamos algo similar?"

CATÁLOGO RESUMEN:
${productCatalogSummary}
NOTA: Usa search_products para buscar productos específicos.`;
  }

  /**
   * Configuración por defecto si no hay API de configuración
   */
  getDefaultBusinessConfig(domain) {
    return {
      name: domain,
      currency: 'PEN',
      language: 'es',
      country: 'Perú',
    };
  }

  /**
   * Limpia el caché de un dominio (útil cuando se actualiza el catálogo)
   */
  clearCache(domain) {
    businessConfigCache.delete(domain);
    productCatalogCache.delete(domain);
    logger.info(`[PromptMemory] Cache cleared for ${domain}`);
  }

  /**
   * Limpia todo el caché
   */
  clearAllCache() {
    businessConfigCache.clear();
    productCatalogCache.clear();
    logger.info('[PromptMemory] All cache cleared');
  }
}

module.exports = new PromptMemoryService();

