# 🎯 Enfoque Final: IA Selecciona Tools + Validación de Aclaración

## 📋 Estrategia Final

### ✅ **IA Selecciona Tools + Si No Usa Tools → Pedir Aclaración**

**Flujo:**
1. IA recibe mensaje + tools disponibles
2. IA DECIDE qué tool usar
3. **VALIDACIÓN**: Si la IA NO usa tools → Pedir aclaración al usuario
4. Si usa tools → Ejecutar tools y generar respuesta

---

## 🔄 Flujo Completo

### Caso 1: IA usa tools ✅

```
Usuario: "¿Qué productos tienen?"
    ↓
IA recibe mensaje + tools
    ↓
IA DECIDE: tool_call = "search_products"
    ↓
Ejecutar tool: search_products()
    ↓
IA genera respuesta con datos reales
    ↓
Respuesta: "Tenemos los siguientes productos: ..."
```

---

### Caso 2: IA NO usa tools → Pedir Aclaración ✅

```
Usuario: "Hola"
    ↓
IA recibe mensaje + tools
    ↓
IA DECIDE: NO usar tools (es un saludo)
    ↓
VALIDACIÓN: ¿Es consulta que requiere tools? ❌ No (es saludo)
    ↓
IA genera respuesta directa
    ↓
Respuesta: "¡Hola! ¿En qué puedo ayudarte?"
```

---

### Caso 3: IA NO usa tools pero DEBERÍA → Pedir Aclaración ✅

```
Usuario: "Muéstrame productos"
    ↓
IA recibe mensaje + tools
    ↓
IA DECIDE: NO usar tools (no está seguro qué tool usar)
    ↓
VALIDACIÓN: ¿Es consulta que requiere tools? ✅ Sí
    ↓
¿IA usó tools? ❌ No
    ↓
Respuesta: "Disculpa no comprendí, me puedes especificar la pregunta?"
```

---

## 🎯 Implementación

### 1. System Prompt Estricto

```javascript
const systemPrompt = `
Eres un asistente de ventas para "${domain}".

REGLAS CRÍTICAS:
1. NUNCA inventes información de productos, precios o detalles
2. SIEMPRE usa las herramientas disponibles para obtener información real
3. Si no estás seguro de qué herramienta usar, NO inventes información
4. Si no puedes responder con certeza usando herramientas, pide aclaración al usuario

HERRAMIENTAS DISPONIBLES:
- search_products: Buscar productos en el catálogo
- get_product_details: Obtener detalles de un producto específico
- search_info_business: Obtener información de la empresa
- get_product_price: Obtener precio de un producto
- search_product_recommended: Buscar productos recomendados

INSTRUCCIONES:
- Para consultas sobre productos: USA search_products
- Para detalles de producto: USA get_product_details
- Para información de la empresa: USA search_info_business
- Si no estás seguro: Pide aclaración al usuario

FORMATO DE RESPUESTA:
- Responde en JSON: {"message": "...", "audio_description": "...", "action": {...}}
- Si no puedes responder: {"message": "Disculpa no comprendí, me puedes especificar la pregunta?", "audio_description": "Disculpa no comprendí", "action": {"type": "none"}}
`;
```

---

### 2. Validación Post-IA

```javascript
async processMessage(userMessage, userId, domain) {
    // 1. Preparar tools disponibles
    const tools = [
        {
            name: "search_products",
            description: "Buscar productos en el catálogo",
            parameters: {...}
        },
        {
            name: "get_product_details",
            description: "Obtener detalles de un producto específico",
            parameters: {...}
        },
        // ... más tools
    ];

    // 2. IA recibe mensaje + tools
    const response = await ia.generateResponse(userMessage, {
        systemPrompt: systemPrompt,
        tools: tools,
        history: conversationHistory
    });

    // 3. Validar si usó tools
    if (response.tool_calls && response.tool_calls.length > 0) {
        // ✅ IA usó tools - ejecutar normalmente
        const toolResults = await executeTools(response.tool_calls);
        
        // 4. Enviar resultados a la IA para respuesta final
        const finalResponse = await ia.generateResponseWithToolResults(
            userMessage,
            toolResults,
            conversationHistory
        );
        
        return finalResponse;
    } else {
        // ❌ IA NO usó tools - VALIDAR si debería haberlos usado
        if (requiresProductInfo(userMessage)) {
            // Es una consulta que requiere tools pero la IA no los usó
            // Pedir aclaración en lugar de forzar
            return {
                message: "Disculpa no comprendí, me puedes especificar la pregunta?",
                audio_description: "Disculpa no comprendí",
                action: { type: "none" }
            };
        } else {
            // No requiere tools (saludo, etc.) - responder normalmente
            return response;
        }
    }
}

// Función para determinar si una consulta requiere tools
function requiresProductInfo(message) {
    const lowerMessage = message.toLowerCase();
    const productKeywords = [
        'producto', 'productos', 'buscar', 'busco', 'necesito', 
        'quiero', 'tengo', 'encontrar', 'mostrar', 'muestra',
        'precio', 'cuesta', 'vale', 'detalle', 'detalles',
        'características', 'especificaciones', 'recomend', 'recomienda'
    ];
    
    return productKeywords.some(keyword => lowerMessage.includes(keyword));
}
```

---

## 🎯 Ventajas de Este Enfoque

### 1. **Seguridad Máxima**
- ✅ No fuerza el uso de tools incorrectos
- ✅ No asume qué tool usar
- ✅ Evita ejecutar tools con parámetros incorrectos

### 2. **Mejor UX**
- ✅ Pide aclaración cuando no está seguro
- ✅ Evita respuestas incorrectas
- ✅ Fuerza al usuario a ser más específico

### 3. **Prevención de Errores**
- ✅ No ejecuta tools sin estar seguro
- ✅ No inventa información
- ✅ Reduce riesgo de errores

### 4. **Flexibilidad**
- ✅ La IA decide cuándo usar tools
- ✅ Permite respuestas directas para saludos, etc.
- ✅ Valida solo cuando es necesario

---

## 📊 Comparación de Enfoques

| Enfoque | Ventaja | Desventaja |
|---------|---------|------------|
| **Forzar Tools** | Siempre ejecuta tools | Puede ejecutar tools incorrectos |
| **Pedir Aclaración** | Más seguro, evita errores | Requiere interacción adicional del usuario |
| **IA Decide Libremente** | Más flexible | Riesgo de alucinaciones |

---

## 🎯 Casos de Uso

### Caso 1: Consulta Clara ✅

```
Usuario: "¿Qué productos tienen?"
IA: Usa search_products
Respuesta: "Tenemos los siguientes productos: ..."
```

---

### Caso 2: Consulta Ambigua → Pedir Aclaración ✅

```
Usuario: "Muéstrame algo"
IA: No usa tools (no está seguro qué buscar)
Validación: Requiere tools pero no los usó
Respuesta: "Disculpa no comprendí, me puedes especificar la pregunta?"
```

---

### Caso 3: Saludo → No Requiere Tools ✅

```
Usuario: "Hola"
IA: No usa tools (es saludo)
Validación: No requiere tools
Respuesta: "¡Hola! ¿En qué puedo ayudarte?"
```

---

### Caso 4: Consulta Específica ✅

```
Usuario: "Muéstrame detalles del producto ABC123"
IA: Usa get_product_details(productId: "ABC123")
Respuesta: "Aquí están los detalles del producto: ..."
```

---

## 🔧 Implementación en el Código

### Modificar `chat-orchestrator.service.js`:

```javascript
async processMessage({ userMessage, userId, domain, forceModel = null }) {
    // 1. Preparar tools disponibles
    const tools = this.getAvailableTools();
    
    // 2. Obtener system prompt
    const systemPrompt = await PromptMemoryService.buildSystemPrompt(domain);
    
    // 3. IA genera respuesta con tools
    const response = await this.iaService.generateResponse(
        userMessage,
        conversationHistory,
        domain,
        systemPrompt,
        tools // Pasar tools a la IA
    );
    
    // 4. Validar si usó tools
    if (response.tool_calls && response.tool_calls.length > 0) {
        // ✅ IA usó tools
        const toolResults = await this.executeTools(response.tool_calls, domain);
        
        // 5. Generar respuesta final con resultados
        const finalResponse = await this.iaService.generateResponseWithToolResults(
            userMessage,
            toolResults,
            conversationHistory,
            systemPrompt
        );
        
        return finalResponse;
    } else {
        // ❌ IA NO usó tools
        if (this.requiresProductInfo(userMessage)) {
            // Requiere tools pero no los usó → Pedir aclaración
            return {
                message: "Disculpa no comprendí, me puedes especificar la pregunta?",
                audio_description: "Disculpa no comprendí",
                action: { type: "none" },
                tokens: { input: 0, output: 0, total: 0 },
                cost: { total: 0 }
            };
        } else {
            // No requiere tools → Responder normalmente
            return response;
        }
    }
}

// Función auxiliar para determinar si requiere tools
requiresProductInfo(message) {
    const lowerMessage = message.toLowerCase();
    const productKeywords = [
        'producto', 'productos', 'buscar', 'busco', 'necesito', 
        'quiero', 'tengo', 'encontrar', 'mostrar', 'muestra',
        'precio', 'cuesta', 'vale', 'detalle', 'detalles',
        'características', 'especificaciones', 'recomend', 'recomienda',
        'agregar', 'añadir', 'carrito', 'comprar'
    ];
    
    return productKeywords.some(keyword => lowerMessage.includes(keyword));
}
```

---

## 🎯 System Prompt Mejorado

```javascript
buildSystemPrompt(domain) {
    return `Eres un asistente de ventas para "${domain}".

REGLAS CRÍTICAS:
1. NUNCA inventes información de productos, precios o detalles
2. SIEMPRE usa las herramientas disponibles para obtener información real
3. Si no estás seguro de qué herramienta usar, NO inventes información
4. Si no puedes responder con certeza usando herramientas, pide aclaración

HERRAMIENTAS DISPONIBLES:
- search_products: Buscar productos en el catálogo. USA esta herramienta para consultas sobre productos.
- get_product_details: Obtener detalles de un producto específico. USA esta herramienta cuando el usuario pide detalles de un producto.
- search_info_business: Obtener información de la empresa. USA esta herramienta para consultas sobre la empresa.
- get_product_price: Obtener precio de un producto. USA esta herramienta para consultas de precios.
- search_product_recommended: Buscar productos recomendados. USA esta herramienta cuando el usuario pide recomendaciones.

INSTRUCCIONES:
- Para consultas sobre productos: DEBES usar search_products
- Para detalles de producto: DEBES usar get_product_details
- Para información de la empresa: DEBES usar search_info_business
- Si no estás seguro de qué herramienta usar: NO inventes, pide aclaración

FORMATO DE RESPUESTA:
- Responde en JSON: {"message": "...", "audio_description": "...", "action": {...}}
- Si no puedes responder con certeza: {"message": "Disculpa no comprendí, me puedes especificar la pregunta?", "audio_description": "Disculpa no comprendí", "action": {"type": "none"}}

IDIOMA: Español de Perú (PEN)
TONO: Amable y servicial`;
}
```

---

## ✅ Resumen

### Estrategia Final:

1. **IA selecciona tools** (function calling nativo)
2. **Si usa tools** → Ejecutar y generar respuesta
3. **Si NO usa tools** → Validar si debería haberlos usado
   - Si debería → Pedir aclaración: "Disculpa no comprendí, me puedes especificar la pregunta?"
   - Si no debería → Responder normalmente (saludos, etc.)

### Ventajas:

- ✅ Más seguro: No fuerza tools incorrectos
- ✅ Mejor UX: Pide aclaración cuando no está seguro
- ✅ Prevención de errores: No inventa información
- ✅ Flexible: IA decide cuándo usar tools

### Implementación:

- System prompt estricto: Instrucciones claras sobre cuándo usar tools
- Validación post-IA: Verificar si debería haber usado tools
- Respuesta de aclaración: Pedir especificación cuando no está claro

**Este es el enfoque más profesional y seguro.** 🎯

