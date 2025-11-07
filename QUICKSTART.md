# 🚀 Quick Start Guide

Guía rápida para comenzar con Smart Chat Agent.

## 📋 Prerrequisitos

- Node.js >= 18.0.0
- MongoDB
- API Keys de OpenAI y Google Gemini

## ⚡ Instalación Rápida

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar variables de entorno

Copia el archivo `.env.example` a `.env` y configura tus credenciales:

```bash
cp .env.example .env
```

Edita `.env` con tus credenciales:

```env
# MongoDB
MONGO_URI=mongodb://localhost:27017/smart-chat-agent
MONGO_URI_CLIENTS=mongodb://localhost:27017/smart-chat-clients

# OpenAI
OPENAI_API_KEY=sk-...

# Google Gemini
GEMINI_API_KEY=...

# JWT
JWT_SECRET=tu-secret-key-aqui
```

### 3. Iniciar MongoDB

Asegúrate de que MongoDB esté corriendo:

```bash
# En Windows
mongod

# En Linux/Mac
sudo systemctl start mongod
```

### 4. Iniciar el servidor

```bash
npm start
```

O en modo desarrollo:

```bash
npm run dev
```

El servidor estará disponible en `http://localhost:3024`

## 🧪 Probar el Agente

### Usando curl

```bash
curl -X POST http://localhost:3024/api/chat/message \
  -H "Content-Type: application/json" \
  -d '{
    "userMessage": "Hola, busco zapatillas deportivas",
    "domain": "mi-tienda.com",
    "userId": "user123"
  }'
```

### Usando el script de ejemplo

```bash
node examples/test-chat.js
```

## 📊 Verificar que Funciona

### Health Check

```bash
curl http://localhost:3024/health
```

Deberías ver:

```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "service": "smart-chat-agent"
}
```

### Obtener Historial

```bash
curl "http://localhost:3024/api/chat/history/user123?domain=mi-tienda.com"
```

## 🎯 Características Principales

1. **Memorización del System Prompt**: El primer prompt se guarda y se reutiliza
2. **Prompt Caching**: OpenAI cachea automáticamente el system prompt
3. **Router Inteligente**: Decide automáticamente qué modelo usar
4. **Historial Persistente**: Las conversaciones se guardan en MongoDB

## 📝 Estructura del Proyecto

```
smart-chat-agent/
├── src/
│   ├── config/          # Configuración
│   ├── models/          # Modelos MongoDB
│   ├── services/        # Servicios principales
│   ├── api/             # API REST
│   └── utils/           # Utilidades
├── examples/            # Ejemplos de uso
├── docs/                # Documentación
└── logs/                # Logs
```

## 🔧 Configuración Avanzada

Ver `docs/MEJORAS.md` para más detalles sobre las optimizaciones implementadas.

## 🆘 Solución de Problemas

### Error: "Missing required environment variables"

Asegúrate de que todas las variables requeridas estén en `.env`:
- `MONGO_URI`
- `MONGO_URI_CLIENTS`
- `JWT_SECRET`

### Error: "MongoDB connection failed"

Verifica que MongoDB esté corriendo y que las URIs sean correctas.

### Error: "OPENAI_API_KEY not found"

Asegúrate de tener tu API key de OpenAI en `.env`.

## 📚 Documentación Completa

- [API Documentation](docs/API.md)
- [Mejoras Implementadas](docs/MEJORAS.md)
- [README](README.md)

## 🎉 ¡Listo!

Ya tienes tu agente conversacional funcionando. ¡Disfruta del ahorro de tokens!

