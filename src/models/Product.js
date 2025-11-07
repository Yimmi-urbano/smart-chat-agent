/**
 * ============================================
 * PRODUCT MODEL
 * ============================================
 * Modelo de productos del catálogo
 */

const mongoose = require('mongoose');
const { getMainConnection } = require('../config/database.config');

const productSchema = new mongoose.Schema({
  domain: {
    type: String,
    required: true,
    index: true,
  },
  title: {
    type: String,
    required: true,
  },
  description_short: String,
  description_long: String,
  price: {
    regular: Number,
    sale: Number,
  },
  slug: {
    type: String,
    required: true,
    index: true,
  },
  image_default: [String],
  category: {
    name: String,
    slug: String,
  },
  tags: [String],
  is_available: {
    type: Boolean,
    default: true,
    index: true,
  },
  stock: Number,
}, {
  timestamps: true,
});

// Índice compuesto para búsquedas
productSchema.index({ domain: 1, is_available: 1 });
productSchema.index({ domain: 1, 'category.slug': 1 });
productSchema.index({ domain: 1, title: 'text', description_short: 'text' });

// Función lazy para obtener el modelo (se crea cuando se necesita)
function getProductModel() {
  const mainConnection = getMainConnection();
  return mainConnection.models.Product || mainConnection.model('Product', productSchema);
}

module.exports = getProductModel;

