/* ============================================================
   Notas de voz del agente de Chacón.

   Un tendero con las manos en el mostrador dicta "ponme dos cajas de piel de
   pollo y tres de lomo" mucho más rápido de lo que lo escribe. Por eso la voz
   importa más aquí que en un pedido de cafetería.

   Reutiliza lo que ya está probado en Sanmi —`wa.downloadMedia`,
   `openaiTranscribe` y el contador diario de `store`— sin tocar su código.
   `agent.transcribirAudio` no vale tal cual: está acoplado al objeto cliente
   de Sanmi (zona horaria, clave, tope propio). Esta es la misma secuencia
   con los parámetros de Chacón.

   Lo importante: la transcripción entra al agente **como texto normal**. No
   abre ninguna puerta. El precio lo sigue dando `consultar_precio`, el
   producto sigue exigiendo un `producto_id` real y el pedido sigue
   necesitando CONFIRMAR. Un audio no puede saltarse un guardarraíl.
   ============================================================ */

const wa = require('../wa/whatsapp');
const store = require('../wa/store');
const { openaiTranscribe } = require('../wa/agent');

/* Namespace `wa:chacon:*` para el contador: reutiliza el store de Sanmi pero
   con su propia clave, así los topes de un tenant no consumen los del otro. */
const CLAVE = 'chacon';
const ZONA = process.env.CHACON_ZONA_HORARIA || 'Europe/Madrid';

const MAX_POR_DIA = Number(process.env.CHACON_AUDIO_MAX_DIA || 60);
const MAX_SEGUNDOS = Number(process.env.CHACON_AUDIO_MAX_SEGUNDOS || 180);
const MAX_BYTES = Number(process.env.CHACON_AUDIO_MAX_BYTES || 2 * 1024 * 1024);

/* Avisos. Nunca dicen "error": dicen qué hacer ahora. */
const PEDIR_TEXTO_FALLO =
  'No he podido escuchar bien ese audio. ¿Me lo escribes o me lo mandas otra vez?';
const PEDIR_TEXTO_LARGO =
  'Ese audio es muy largo para mí. ¿Me lo mandas en uno más corto o me lo escribes?';
const PEDIR_TEXTO_LIMITE =
  'Por hoy ya no puedo procesar más audios. ¿Me escribes lo que necesitas?';

/**
 * Descarga y transcribe. Devuelve `{ texto, aviso }`: si `texto` es null,
 * `aviso` es exactamente lo que hay que responderle a la tienda.
 */
async function transcribir(telefono, mediaId) {
  const dia = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  // El tope va ANTES de descargar: si está agotado, no se gasta ni ancho de
  // banda ni una llamada a OpenAI.
  const usados = await store.bumpAudio(CLAVE, telefono, dia);
  if (usados > MAX_POR_DIA) {
    console.log('[chacon] audio: tope diario alcanzado (%s/%s) para %s', usados, MAX_POR_DIA, telefono);
    return { texto: null, aviso: PEDIR_TEXTO_LIMITE };
  }

  let media;
  try {
    media = await wa.downloadMedia(mediaId);
  } catch (err) {
    console.error('[chacon] audio: fallo descargando:', err.message);
    return { texto: null, aviso: PEDIR_TEXTO_FALLO };
  }

  if (media.size > MAX_BYTES) {
    console.log('[chacon] audio: %s bytes supera el máximo', media.size);
    return { texto: null, aviso: PEDIR_TEXTO_LARGO };
  }

  let data;
  try {
    data = await openaiTranscribe(media.buffer, media.mime);
  } catch (err) {
    console.error('[chacon] audio: fallo transcribiendo:', err.message);
    return { texto: null, aviso: PEDIR_TEXTO_FALLO };
  }

  if (data.duration != null && Number(data.duration) > MAX_SEGUNDOS) {
    console.log('[chacon] audio: %ss supera el máximo', data.duration);
    return { texto: null, aviso: PEDIR_TEXTO_LARGO };
  }

  const texto = String(data.text || '').trim();
  if (!texto) return { texto: null, aviso: PEDIR_TEXTO_FALLO };

  console.log('[chacon] audio transcrito (%s chars, %ss) de %s',
    texto.length, data.duration ?? '?', telefono);
  return { texto, aviso: '' };
}

/**
 * Devuelve lo que se ha entendido, para que la tienda lo corrija antes de
 * que llegue a un pedido. Una transcripción puede confundir "dos" con
 * "doce", y en un pedido mayorista esa diferencia es dinero. Va en código,
 * no en el prompt: el modelo no puede olvidarse de repetirlo.
 */
function ecoDeTranscripcion(texto) {
  return `🎤 Te he entendido: «${texto}»`;
}

module.exports = {
  transcribir, ecoDeTranscripcion,
  CLAVE, ZONA, MAX_POR_DIA, MAX_SEGUNDOS, MAX_BYTES,
  PEDIR_TEXTO_FALLO, PEDIR_TEXTO_LARGO, PEDIR_TEXTO_LIMITE,
};
