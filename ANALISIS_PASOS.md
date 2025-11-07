# Análisis de Pasos del Proceso de Chat

## Pasos Actuales (8+ pasos reales)

1. **Obtener/crear conversación** ✅ Necesario
2. **Obtener/construir system prompt** ✅ Necesario (puede optimizarse)
3. **Obtener historial reciente** ✅ Necesario (puede combinarse con paso 2)
4. **Interpretar intención** ⚠️ MUY LARGO (300+ líneas) - necesita refactor
5. **Decidir modelo** ✅ Necesario (puede simplificarse)
6. **Generar respuesta** ✅ Necesario (incluye fallback)
7. **Construir acción** ⚠️ MUY LARGO (200+ líneas) - necesita refactor
8. **Calcular tokens** ✅ Necesario
9. **Guardar mensajes** ✅ Necesario (puede optimizarse)
10. **Actualizar metadata** ✅ Necesario
11. **Guardar métricas** ✅ Necesario

## Problemas Identificados

### 1. Paso 4 (Interpretación) - MUY COMPLEJO
- 300+ líneas de código
- Lógica duplicada (búsqueda de productos)
- Difícil de mantener
- Muchas condiciones anidadas

### 2. Paso 7 (Construcción de Acción) - MUY COMPLEJO
- 200+ líneas de código
- Lógica duplicada (búsqueda de productos otra vez)
- Múltiples niveles de anidación
- Difícil de debuggear

### 3. Duplicación de Lógica
- Búsqueda de productos aparece en:
  - Paso 4 (interpretación)
  - Paso 7 (construcción de acción)
- Extracción de productos del mensaje duplicada

### 4. Pasos que pueden ejecutarse en paralelo
- Paso 2 (system prompt) y Paso 3 (historial) - pueden combinarse
- Paso 8-11 (guardado) - pueden optimizarse

## Propuesta de Optimización

### NUEVA ESTRUCTURA (5 pasos principales)

1. **PREPARACIÓN** (Paso 1-3 combinados)
   - Obtener conversación
   - Obtener system prompt
   - Obtener historial
   - Todo en paralelo o secuencial optimizado

2. **INTERPRETACIÓN Y TOOLS** (Paso 4 refactorizado)
   - Detectar intención
   - Buscar producto (función única)
   - Ejecutar tool si es necesario
   - Construir prompt dinámico

3. **GENERACIÓN** (Paso 5-6 combinados)
   - Decidir modelo
   - Generar respuesta
   - Manejar fallback

4. **VALIDACIÓN** (Paso 7 refactorizado)
   - Validar y construir acción
   - Usar función única para buscar productos

5. **PERSISTENCIA** (Paso 8-11 combinados)
   - Calcular tokens
   - Guardar mensajes
   - Actualizar metadata
   - Guardar métricas

## Mejoras Específicas

### 1. Extraer funciones reutilizables
- `findProductAnywhere()` - busca producto en todos los lugares posibles
- `buildActionFromContext()` - construye acción desde contexto
- `determinePromptType()` - determina tipo de prompt

### 2. Reducir complejidad
- Máximo 3 niveles de anidación
- Early returns
- Guard clauses

### 3. Optimizar rendimiento
- Ejecutar en paralelo lo posible
- Cachear resultados
- Reducir consultas a BD

### 4. Mejorar mantenibilidad
- Funciones pequeñas y enfocadas
- Documentación clara
- Logs estructurados

