# 📡 API Documentation

## Endpoints

### POST /api/chat/message

Procesa un mensaje del usuario y devuelve la respuesta del agente.

**Request Body:**
```json
{
  "userMessage": "Busco zapatillas deportivas",
  "domain": "mi-tienda.com",
  "userId": "user123",
  "forceModel": "auto" // opcional: "gemini" | "openai" | "auto"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Message processed successfully",
  "data": {
    "message": "Encontré varias opciones de zapatillas deportivas. ¿Te gustaría verlas?",
    "audio_description": "Encontré zapatillas deportivas. ¿Quieres verlas?",
    "action": {
      "type": "none",
      "productId": null,
      "quantity": null,
      "url": null,
      "price_sale": null,
      "title": null,
      "price_regular": null,
      "image": null,
      "slug": null
    },
    "model_used": "gemini",
    "thinking_used": false,
    "fallback_used": false,
    "tokens": {
      "input": 150,
      "output": 50,
      "thinking": 0,
      "cached": 0,
      "total": 200
    },
    "cost": {
      "input": 0,
      "output": 0,
      "cached": 0,
      "total": 0,
      "currency": "USD"
    },
    "response_time_ms": 1200,
    "conversation_id": "507f1f77bcf86cd799439011",
    "system_prompt_memorized": true
  }
}
```

### GET /api/chat/history/:userId

Obtiene el historial de conversación de un usuario.

**Query Parameters:**
- `domain` (required): Dominio de la tienda

**Response:**
```json
{
  "success": true,
  "message": "History retrieved successfully",
  "data": {
    "conversationId": "507f1f77bcf86cd799439011",
    "messages": [
      {
        "role": "system",
        "content": "Eres un asistente...",
        "timestamp": "2024-01-01T00:00:00.000Z"
      },
      {
        "role": "user",
        "content": "Hola",
        "timestamp": "2024-01-01T00:01:00.000Z"
      },
      {
        "role": "assistant",
        "content": "¡Hola! ¿En qué puedo ayudarte?",
        "timestamp": "2024-01-01T00:01:01.000Z",
        "metadata": {
          "model": "openai",
          "tokens": {
            "input": 100,
            "output": 20,
            "cached": 80,
            "total": 120
          }
        }
      }
    ],
    "metadata": {
      "totalMessages": 3,
      "totalTokens": 120,
      "cachedTokens": 80,
      "averageResponseTime": 1200,
      "modelsUsed": {
        "gemini": 0,
        "openai": 1
      }
    },
    "systemPromptMemorized": true
  }
}
```

### POST /api/chat/close/:conversationId

Cierra una conversación.

**Response:**
```json
{
  "success": true,
  "message": "Conversation closed successfully",
  "data": null
}
```

### GET /api/chat/stats

Obtiene estadísticas de uso.

**Query Parameters:**
- `domain` (required): Dominio de la tienda
- `startDate` (optional): Fecha de inicio (ISO 8601)
- `endDate` (optional): Fecha de fin (ISO 8601)

**Response:**
```json
{
  "success": true,
  "message": "Stats retrieved successfully",
  "data": [
    {
      "_id": "openai",
      "totalTokens": 10000,
      "totalCachedTokens": 8000,
      "totalCost": 0.05,
      "count": 100,
      "avgResponseTime": 1200
    },
    {
      "_id": "gemini",
      "totalTokens": 5000,
      "totalCachedTokens": 0,
      "totalCost": 0,
      "count": 50,
      "avgResponseTime": 800
    }
  ]
}
```

## Rate Limiting

- **Límite**: 5 requests por 10 segundos por IP
- **Headers de respuesta**:
  - `X-RateLimit-Limit`: Límite de requests
  - `X-RateLimit-Remaining`: Requests restantes
  - `X-RateLimit-Reset`: Tiempo de reset

## Códigos de Estado

- `200`: Success
- `400`: Bad Request
- `401`: Unauthorized
- `403`: Forbidden
- `404`: Not Found
- `429`: Too Many Requests
- `500`: Internal Server Error

