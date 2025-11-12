# Configuración de Groq (LLM Gratuito como Fallback)

## Descripción

Groq es un LLM gratuito que se activa automáticamente cuando tanto OpenAI como Gemini fallan (por ejemplo, cuando exceden su cuota). Esto garantiza que el servicio siempre pueda responder, incluso cuando los proveedores principales están fuera de servicio.

## Configuración

### 1. Obtener API Key de Groq

1. Visita [https://console.groq.com/](https://console.groq.com/)
2. Crea una cuenta gratuita
3. Ve a "API Keys" y genera una nueva clave
4. Copia la API key

### 2. Configurar Variables de Entorno

Agrega las siguientes variables a tu archivo `.env`:

```env
# Groq (LLM Gratuito como Fallback)
GROQ_API_KEY=tu_api_key_aqui
GROQ_MODEL=llama-3.3-70b-versatile
GROQ_TEMPERATURE=0.3
GROQ_MAX_TOKENS=1000
ENABLE_GROQ_FALLBACK=true
ENABLE_FREE_LLM_FALLBACK=true
```

### 3. Modelos Disponibles en Groq

Groq ofrece varios modelos gratuitos:

- `llama-3.3-70b-versatile` (Recomendado) - Modelo grande y versátil (actualizado)
- `llama-3.3-8b-instant` - Modelo rápido y ligero (actualizado)
- `llama-3.1-8b-instant` - Modelo rápido y ligero (legacy)
- `mixtral-8x22b-instruct` - Modelo Mixtral grande (actualizado)
- `mixtral-8x7b-32768` - Modelo Mixtral con contexto largo (legacy)

**⚠️ NOTA:** El modelo `llama-3.1-70b-versatile` fue descomisionado. Usa `llama-3.3-70b-versatile` en su lugar.

### 4. Flujo de Fallback

El sistema intenta los modelos en este orden:

1. **Modelo Principal** (Gemini o OpenAI según el router)
2. **Fallback Principal** (OpenAI o Gemini, el contrario)
3. **Fallback Gratuito** (Groq) - Solo si está habilitado y los otros dos fallan

## Ventajas de Groq

- ✅ **Gratis**: Tier gratuito generoso
- ✅ **Rápido**: Respuestas muy veloces
- ✅ **Confiable**: Alta disponibilidad
- ✅ **Function Calling**: Soporta llamadas a funciones (tools)
- ✅ **Sin costo**: No consume créditos de los proveedores principales

## Usar SOLO Groq (Más Rápido)

Para usar **solo Groq** y evitar intentos con OpenAI/Gemini (más rápido, ~3-4s vs ~9-10s):

```env
# Usar Groq como modelo principal
DEFAULT_MODEL_PROVIDER=groq

# Desactivar fallback entre modelos (opcional, pero recomendado)
ENABLE_MODEL_FALLBACK=false

# Configuración de Groq
GROQ_API_KEY=tu_groq_api_key_aqui
GROQ_MODEL=llama-3.3-70b-versatile
ENABLE_GROQ_FALLBACK=true
```

**Resultado**: El sistema usará solo Groq directamente, sin intentar OpenAI o Gemini primero. Tiempo de respuesta: ~3-4 segundos.

## Desactivar Groq

Si no deseas usar Groq como fallback:

```env
ENABLE_GROQ_FALLBACK=false
ENABLE_FREE_LLM_FALLBACK=false
```

O simplemente no configures `GROQ_API_KEY`.

## Logs

Cuando Groq se active como fallback, verás logs como:

```
🆓🆓🆓 INTENTANDO FALLBACK A LLM GRATUITO (Groq)...
🆓 Llamando a Groq (FREE LLM)...
✅✅✅ FALLBACK GRATUITO EXITOSO: Groq respondió correctamente
```

## Notas

- Groq no soporta streaming directamente, por lo que en modo stream se envía la respuesta completa de una vez
- Los tokens de Groq se registran pero el costo es $0.00 (gratis)
- Groq se usa solo como último recurso cuando los otros modelos fallan

