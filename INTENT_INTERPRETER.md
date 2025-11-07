# Intent Interpreter Service

## Descripción

Sistema modular de interpretación de intenciones que permite optimizar el consumo de tokens mediante:

1. **Interpretación de intenciones**: Identifica qué quiere hacer el usuario
2. **Ejecución de tools**: Obtiene información específica según la intención
3. **Prompt dinámico**: Construye prompts con solo la información necesaria
4. **Respuesta optimizada**: El LLM responde con información precisa y relevante

## Flujo de Trabajo

```
Usuario pregunta
    ↓
Intent Interpreter (local rules o LLM)
    ↓
Tool Executor (busca información específica)
    ↓
Dynamic Prompt Builder (construye prompt con info relevante)
    ↓
LLM genera respuesta (con solo la info necesaria)
```

## Configuración

### Variables de Entorno

Agregar al archivo `.env`:

```env
# Activar/desactivar el intérprete
ENABLE_INTENT_INTERPRETER=true

# Usar reglas locales (rápido, gratis)
ENABLE_INTENT_INTERPRETER_LOCAL=true

# Usar LLM para interpretación (más preciso, multiidioma)
ENABLE_INTENT_INTERPRETER_LLM=true
```

### Opciones de Configuración

| Variable | Valor | Descripción |
|----------|-------|-------------|
| `ENABLE_INTENT_INTERPRETER` | `true`/`false` | Activa/desactiva el intérprete |
| `ENABLE_INTENT_INTERPRETER_LOCAL` | `true`/`false` | Usa reglas locales (por defecto: `true`) |
| `ENABLE_INTENT_INTERPRETER_LLM` | `true`/`false` | Usa LLM para interpretación (por defecto: `true`) |

## Intenciones Soportadas

### 1. `search_products`
Busca productos en el catálogo.

**Ejemplos:**
- "¿Qué productos tienen?"
- "Busco productos de cocina"
- "Necesito batidores"

**Tool**: `search_products`
**Parámetros**: `query`, `category`, `minPrice`, `maxPrice`, `limit`

### 2. `company_info`
Obtiene información de la empresa.

**Ejemplos:**
- "¿Quiénes son?"
- "Información de la empresa"
- "Sobre nosotros"

**Tool**: `get_company_info`

### 3. `product_price`
Obtiene el precio de un producto específico.

**Ejemplos:**
- "¿Cuánto cuesta el producto X?"
- "Precio del batidor"

**Tool**: `get_product_price`
**Parámetros**: `productId`

### 4. `product_details`
Obtiene detalles completos de un producto.

**Ejemplos:**
- "Detalles del producto X"
- "Características del batidor"

**Tool**: `get_product_details`
**Parámetros**: `productId`

### 5. `shipping_info`
Obtiene información de envío.

**Ejemplos:**
- "¿Cuánto cuesta el envío?"
- "Política de envío"

**Tool**: `get_shipping_info`

### 6. `general_chat`
Conversación general (no requiere tool).

**Ejemplos:**
- "Hola"
- "Gracias"

## Métodos de Interpretación

### 1. Reglas Locales (Local Rules)
- **Ventajas**: Rápido, gratis, sin latencia adicional
- **Desventajas**: Limitado a patrones predefinidos
- **Idiomas**: Español, Inglés, Portugués
- **Confidence**: 0.7-0.95

### 2. LLM (OpenAI o Gemini)
- **Ventajas**: Preciso, multiidioma, maneja variaciones naturales
- **Desventajas**: Latencia adicional (~200-500ms), costo mínimo
- **Fallback**: Si OpenAI falla, usa Gemini automáticamente
- **Confidence**: 0.8-0.95

### Flujo Híbrido (Recomendado)

```
1. Intentar reglas locales (rápido)
   ↓
2. Si confidence < 0.7, usar LLM (preciso)
   ↓
3. Si OpenAI falla, usar Gemini (fallback)
```

## Ejemplo de Uso

### Ejemplo 1: Búsqueda de Productos

```javascript
// Usuario: "¿Qué productos de cocina tienen?"

// 1. Interpretación
const intent = await IntentInterpreterService.interpret(
  "¿Qué productos de cocina tienen?",
  "es",
  "tienda.com"
);
// Resultado: { intent: "search_products", params: { query: "cocina" }, confidence: 0.9 }

// 2. Ejecución de tool
const toolResult = await ToolExecutorService.executeTool(
  "search_products",
  { query: "cocina" },
  "tienda.com"
);
// Resultado: { tool: "search_products", data: { products: [...], count: 5 } }

// 3. Prompt dinámico (solo con productos encontrados)
const dynamicPrompt = buildDynamicPrompt(intent, toolResult, systemPrompt, domain);

// 4. LLM responde con solo la información relevante
```

### Ejemplo 2: Información de Empresa

```javascript
// Usuario: "¿Quiénes son?"

// 1. Interpretación
const intent = await IntentInterpreterService.interpret(
  "¿Quiénes son?",
  "es",
  "tienda.com"
);
// Resultado: { intent: "company_info", params: {}, confidence: 0.9 }

// 2. Ejecución de tool
const toolResult = await ToolExecutorService.executeTool(
  "company_info",
  {},
  "tienda.com"
);
// Resultado: { tool: "company_info", data: { name: "...", description: "..." } }

// 3. Prompt dinámico (solo con info de empresa)
const dynamicPrompt = buildDynamicPrompt(intent, toolResult, systemPrompt, domain);

// 4. LLM responde con solo la información de la empresa
```

## Optimización de Tokens

### Antes (sin intérprete)
- System prompt: ~10,000 tokens (todo el catálogo)
- Historial: ~1,500 tokens
- **Total**: ~11,500 tokens

### Después (con intérprete)
- System prompt corto: ~50 tokens
- Información específica: ~200-500 tokens (solo lo necesario)
- Historial: ~300 tokens
- **Total**: ~550-850 tokens

**Ahorro**: ~90-95% de tokens

## Respuesta del API

La respuesta incluye información sobre la interpretación:

```json
{
  "message": "...",
  "audio_description": "...",
  "action": {...},
  "intent_interpreted": {
    "intent": "search_products",
    "confidence": 0.9,
    "method": "local_rules"
  },
  "tool_executed": {
    "tool": "search_products",
    "data_count": 5
  },
  "tokens": {...},
  "cost": {...}
}
```

## Agregar Nuevas Intenciones

### 1. Agregar patrón en `intent-interpreter.service.js`

```javascript
// En getPatternsByLanguage()
es: {
  nueva_intencion: {
    regex: /(patrón|regex)/i,
    keywords: ['palabra1', 'palabra2'],
    confidence: 0.9,
  }
}
```

### 2. Agregar tool en `tool-executor.service.js`

```javascript
async executeTool(intent, params, domain) {
  switch (intent) {
    case 'nueva_intencion':
      return await this.nuevaFuncion(params, domain);
    // ...
  }
}
```

### 3. Agregar caso en `buildDynamicPrompt()` del orchestrator

```javascript
case 'nueva_intencion':
  // Construir prompt con información específica
  break;
```

## Troubleshooting

### El intérprete no se activa
- Verificar que `ENABLE_INTENT_INTERPRETER=true` en `.env`
- Verificar logs: `[IntentInterpreter] Enabled: true`

### Siempre retorna `general_chat`
- Verificar que las reglas locales o LLM estén configurados
- Revisar logs para ver qué método se está usando
- Aumentar el `confidence` threshold si es necesario

### LLM falla constantemente
- Verificar que las API keys estén configuradas
- El sistema tiene fallback automático (OpenAI → Gemini)
- Revisar logs para ver errores específicos

## Métricas y Monitoreo

El sistema registra:
- Intención identificada
- Método usado (local_rules, openai, gemini)
- Confidence score
- Tool ejecutado
- Tiempo de respuesta

Revisar logs para monitorear el rendimiento.

