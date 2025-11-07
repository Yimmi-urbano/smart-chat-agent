/**
 * ============================================
 * TEST CHAT EXAMPLE
 * ============================================
 * Ejemplo de uso del agente conversacional
 */

const axios = require('axios');

const API_URL = 'http://localhost:3024/api/chat';
const DOMAIN = 'mi-tienda.com';
const USER_ID = 'test-user-123';

async function testChat() {
  try {
    console.log('🧪 Testing Smart Chat Agent...\n');

    // Test 1: Primer mensaje (crea conversación y memoriza system prompt)
    console.log('📝 Test 1: Primer mensaje');
    const response1 = await axios.post(`${API_URL}/message`, {
      userMessage: 'Hola, busco zapatillas deportivas',
      domain: DOMAIN,
      userId: USER_ID,
    });

    console.log('✅ Response:', {
      message: response1.data.data.message,
      model: response1.data.data.model_used,
      tokens: response1.data.data.tokens,
      systemPromptMemorized: response1.data.data.system_prompt_memorized,
    });
    console.log('');

    // Test 2: Segundo mensaje (usa system prompt memorizado)
    console.log('📝 Test 2: Segundo mensaje (system prompt memorizado)');
    const response2 = await axios.post(`${API_URL}/message`, {
      userMessage: 'Muéstrame las opciones',
      domain: DOMAIN,
      userId: USER_ID,
    });

    console.log('✅ Response:', {
      message: response2.data.data.message,
      model: response2.data.data.model_used,
      tokens: response2.data.data.tokens,
      cachedTokens: response2.data.data.tokens.cached,
    });
    console.log('');

    // Test 3: Obtener historial
    console.log('📝 Test 3: Obtener historial');
    const history = await axios.get(`${API_URL}/history/${USER_ID}?domain=${DOMAIN}`);
    
    console.log('✅ Historial:', {
      totalMessages: history.data.data.messages.length,
      systemPromptMemorized: history.data.data.systemPromptMemorized,
      firstMessageRole: history.data.data.messages[0]?.role,
    });
    console.log('');

    // Test 4: Estadísticas
    console.log('📝 Test 4: Estadísticas');
    const stats = await axios.get(`${API_URL}/stats?domain=${DOMAIN}`);
    
    console.log('✅ Stats:', stats.data.data);
    console.log('');

    console.log('✅ All tests completed!');

  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

// Ejecutar tests
testChat();

