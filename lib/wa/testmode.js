/* ============================================================
   Separación entre tráfico de prueba y tráfico real.

   Todo número que empiece con WA_TEST_PREFIX es de prueba:
     - NO se notifica el escalamiento a nadie por WhatsApp
     - sus leads quedan marcados test:true, filtrables y purgables

   El prefijo por defecto (5215550000) tiene longitud de móvil mexicano
   válido pero no corresponde a ningún número real, así que no puede
   colisionar con un cliente de verdad.
   ============================================================ */

const TEST_PREFIX = process.env.WA_TEST_PREFIX || '5215550000';

/** ¿Este teléfono pertenece al rango reservado para pruebas? */
function esTest(phone) {
  return String(phone || '').startsWith(TEST_PREFIX);
}

module.exports = { esTest, TEST_PREFIX };
