/**
 * Script para validar las variables de entorno
 * Uso: node scripts/check-env.js
 */

require('dotenv').config();
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const requiredVars = [
  'MONGO_URI',
  'MONGO_URI_CLIENTS',
  'JWT_SECRET',
];

const recommendedVars = [
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
];

const optionalVars = {
  'Server': [
    'NODE_ENV',
    'PORT',
  ],
  'OpenAI': [
    'OPENAI_MODEL',
    'OPENAI_TEMPERATURE',
    'OPENAI_MAX_TOKENS',
  ],
  'Gemini': [
    'GEMINI_MODEL',
    'GEMINI_TEMPERATURE',
    'GEMINI_MAX_TOKENS',
  ],
  'Groq': [
    'GROQ_MODEL',
    'GROQ_TEMPERATURE',
    'GROQ_MAX_TOKENS',
    'ENABLE_GROQ_FALLBACK',
    'ENABLE_FREE_LLM_FALLBACK',
  ],
  'Router': [
    'DEFAULT_MODEL_PROVIDER',
    'ENABLE_MODEL_FALLBACK',
  ],
  'Features': [
    'ENABLE_PROMPT_CACHING',
    'ENABLE_THINKING_MODE',
    'ENABLE_INTENT_INTERPRETER',
    'ENABLE_INTENT_INTERPRETER_LLM',
    'ENABLE_INTENT_INTERPRETER_LOCAL',
  ],
};

function checkVar(varName, required = false) {
  const value = process.env[varName];
  const exists = value !== undefined && value !== '';
  const isSet = exists && value !== `tu_${varName.toLowerCase()}_aqui` && !value.includes('tu_');
  
  return {
    exists,
    isSet,
    value: isSet ? (varName.includes('KEY') || varName.includes('SECRET') ? '***' + value.slice(-4) : value) : 'NOT SET',
    status: required 
      ? (isSet ? 'required' : 'missing')
      : (isSet ? 'set' : 'optional'),
  };
}

function printSection(title, vars, isRequired = false) {
  console.log(`\n${colors.cyan}${'='.repeat(60)}${colors.reset}`);
  console.log(`${colors.cyan}${title}${colors.reset}`);
  console.log(`${colors.cyan}${'='.repeat(60)}${colors.reset}`);
  
  let allOk = true;
  
  vars.forEach(varName => {
    const check = checkVar(varName, isRequired);
    const icon = check.isSet 
      ? `${colors.green}✅${colors.reset}` 
      : (isRequired ? `${colors.red}❌${colors.reset}` : `${colors.yellow}⚠️${colors.reset}`);
    const statusColor = check.isSet 
      ? colors.green 
      : (isRequired ? colors.red : colors.yellow);
    
    console.log(`${icon} ${varName.padEnd(35)} ${statusColor}${check.status.toUpperCase()}${colors.reset}`);
    if (check.isSet) {
      console.log(`   ${colors.blue}Value:${colors.reset} ${check.value}`);
    } else {
      console.log(`   ${colors.yellow}Default/Not Set${colors.reset}`);
    }
    
    if (isRequired && !check.isSet) {
      allOk = false;
    }
  });
  
  return allOk;
}

console.log(`${colors.blue}╔══════════════════════════════════════════════════════════╗${colors.reset}`);
console.log(`${colors.blue}║${colors.reset}  ${colors.cyan}VALIDACIÓN DE VARIABLES DE ENTORNO${colors.reset}              ${colors.blue}║${colors.reset}`);
console.log(`${colors.blue}╚══════════════════════════════════════════════════════════╝${colors.reset}`);

// Verificar variables requeridas
const requiredOk = printSection('VARIABLES REQUERIDAS', requiredVars, true);

// Verificar variables recomendadas
console.log(`\n${colors.yellow}⚠️  Las siguientes variables son RECOMENDADAS pero no obligatorias:${colors.reset}`);
printSection('VARIABLES RECOMENDADAS (LLM Providers)', recommendedVars, false);

// Verificar variables opcionales
Object.entries(optionalVars).forEach(([section, vars]) => {
  printSection(`VARIABLES OPCIONALES - ${section}`, vars, false);
});

// Resumen
console.log(`\n${colors.cyan}${'='.repeat(60)}${colors.reset}`);
console.log(`${colors.cyan}RESUMEN${colors.reset}`);
console.log(`${colors.cyan}${'='.repeat(60)}${colors.reset}`);

// Verificar configuración de Groq
const groqKey = checkVar('GROQ_API_KEY');
const groqEnabled = process.env.ENABLE_GROQ_FALLBACK === 'true';
const freeFallbackEnabled = process.env.ENABLE_FREE_LLM_FALLBACK === 'true';

console.log(`\n${colors.blue}Configuración de Groq (LLM Gratuito):${colors.reset}`);
if (groqKey.isSet && groqEnabled && freeFallbackEnabled) {
  console.log(`${colors.green}✅ Groq está completamente configurado y habilitado${colors.reset}`);
  console.log(`   - API Key: ${groqKey.value}`);
  console.log(`   - Modelo: ${process.env.GROQ_MODEL || 'llama-3.1-70b-versatile'}`);
  console.log(`   - Fallback habilitado: ${groqEnabled}`);
  console.log(`   - Free LLM Fallback habilitado: ${freeFallbackEnabled}`);
} else {
  console.log(`${colors.yellow}⚠️  Groq no está completamente configurado:${colors.reset}`);
  if (!groqKey.isSet) console.log(`   ${colors.red}❌ GROQ_API_KEY no está configurada${colors.reset}`);
  if (!groqEnabled) console.log(`   ${colors.yellow}⚠️  ENABLE_GROQ_FALLBACK no está en 'true'${colors.reset}`);
  if (!freeFallbackEnabled) console.log(`   ${colors.yellow}⚠️  ENABLE_FREE_LLM_FALLBACK no está en 'true'${colors.reset}`);
  console.log(`   ${colors.blue}💡 Groq se usará como fallback cuando OpenAI y Gemini fallen${colors.reset}`);
}

// Verificar configuración de fallback
const modelFallback = process.env.ENABLE_MODEL_FALLBACK === 'true';
console.log(`\n${colors.blue}Configuración de Fallback:${colors.reset}`);
console.log(`   - Fallback entre modelos (OpenAI ↔ Gemini): ${modelFallback ? colors.green + '✅ Habilitado' : colors.red + '❌ Deshabilitado'}${colors.reset}`);
console.log(`   - Fallback a LLM gratuito (Groq): ${freeFallbackEnabled ? colors.green + '✅ Habilitado' : colors.yellow + '⚠️  Deshabilitado'}${colors.reset}`);

// Resultado final
console.log(`\n${colors.cyan}${'='.repeat(60)}${colors.reset}`);
if (requiredOk) {
  console.log(`${colors.green}✅ TODAS LAS VARIABLES REQUERIDAS ESTÁN CONFIGURADAS${colors.reset}`);
  console.log(`${colors.green}   El servicio debería iniciarse correctamente${colors.reset}`);
} else {
  console.log(`${colors.red}❌ FALTAN VARIABLES REQUERIDAS${colors.reset}`);
  console.log(`${colors.red}   Por favor, configura las variables faltantes en tu archivo .env${colors.reset}`);
  process.exit(1);
}

console.log(`\n${colors.blue}💡 Tip: Copia .env.example a .env y completa las variables necesarias${colors.reset}`);
console.log(`${colors.reset}`);

