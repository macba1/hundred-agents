/* ============================================================
   Clasificación de lo que llega por el webhook, con criterio de
   falla-cerrado: si no es contenido real de una persona, no se invoca al
   modelo y no sale ningún mensaje.

   Existe porque el agente mandó mensajes que nadie pidió y no había forma
   de saber qué payload los había disparado: los eventos de mensaje no se
   registraban, y el caso "tipo desconocido" contestaba con un texto.
   ============================================================ */

/** Tipos que traen contenido de usuario y sí van al agente. */
const TIPOS_AGENTE = new Set(['text', 'audio', 'voice', 'image']);

/** Tipos con contenido real que no sabemos procesar: se contesta en corto. */
const TIPOS_NO_SOPORTADOS = new Set([
  'sticker', 'document', 'video', 'location', 'contacts',
]);

/**
 * Todo lo demás (reaction, system, button, interactive, order, ephemeral,
 * unsupported, request_welcome, o un tipo que Meta añada mañana) se ignora
 * en silencio: 200 y log, sin OpenAI y sin mensaje saliente.
 */
function clasificar(m) {
  const tipo = (m && m.type) || 'ausente';

  if (!m || !m.id) return { accion: 'ignorar', tipo, motivo: 'sin_id' };

  if (tipo === 'text') {
    const body = m.text && typeof m.text.body === 'string' ? m.text.body.trim() : '';
    if (!body) return { accion: 'ignorar', tipo, motivo: 'texto_vacio' };
    return { accion: 'agente', tipo };
  }

  if (tipo === 'audio' || tipo === 'voice') {
    const media = m[tipo] || {};
    if (!media.id) return { accion: 'ignorar', tipo, motivo: 'audio_sin_media_id' };
    return { accion: 'agente', tipo };
  }

  if (tipo === 'image') {
    if (!(m.image && m.image.id)) return { accion: 'ignorar', tipo, motivo: 'imagen_sin_media_id' };
    return { accion: 'agente', tipo };
  }

  if (TIPOS_NO_SOPORTADOS.has(tipo)) return { accion: 'no_soportado', tipo };

  return { accion: 'ignorar', tipo, motivo: 'tipo_no_accionable' };
}

/** Solo dígitos, para comparar teléfonos venidos de distintos campos. */
function soloDigitos(x) {
  return String(x == null ? '' : x).replace(/[^0-9]/g, '');
}

/**
 * ¿El mensaje viene del propio número del negocio? Sería un eco, y
 * contestarlo es la receta de un bucle infinito consigo mismo.
 */
function esEcho(m, value, client) {
  const from = soloDigitos(m && m.from);
  if (!from) return false;
  const propios = [
    soloDigitos((value && value.metadata && value.metadata.display_phone_number)),
    soloDigitos(client && client.phone_number_id),
  ].filter(Boolean);
  return propios.includes(from);
}

module.exports = { clasificar, esEcho, soloDigitos, TIPOS_AGENTE, TIPOS_NO_SOPORTADOS };
