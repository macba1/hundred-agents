/* ============================================================
   Autorización del canal y consentimiento comercial.

   Dos cosas distintas que aquí no se mezclan nunca:

   **Uso operativo** — identificar a la tienda, gestionar sus pedidos y
   avisarle de incidencias. Sin esto no hay servicio, así que se informa y se
   pide continuar de forma explícita antes de automatizar nada.

   **Marketing** — ofertas y novedades que arranca Chacón. Es opcional,
   separado, y **rechazarlo no puede impedir comprar**. Reutilizar la
   aceptación del canal como si fuera permiso comercial sería exactamente el
   consentimiento agrupado que la normativa no admite.

   El registro va por TELÉFONO, no por cliente: la tienda acepta el canal
   antes de que sepamos quién es, y el mismo teléfono debe poder identificarse
   después sin volver a pasar por el aviso.

   Nada de esto lo decide el modelo. Son banderas deterministas y persistidas.
   ============================================================ */

const repo = require('./repo');

/**
 * Versión del aviso mostrado. Si el texto cambia de forma material, se sube
 * la versión y a quien tenga una anterior se le vuelve a pedir. Así se puede
 * demostrar qué vio cada cliente y cuándo.
 */
const VERSION_AVISO = process.env.CHACON_AVISO_VERSION || '2026-08-v1';

/**
 * URL de la política completa. **No se inventa**: si no está configurada, el
 * aviso lo dice en vez de enseñar un enlace falso, que sería peor que no
 * enseñar ninguno.
 */
const urlPolitica = () => (process.env.CHACON_PRIVACIDAD_URL || '').trim() || null;

/** Primera capa: corta, y con el enlace al texto completo. */
function textoAviso() {
  const url = urlPolitica();
  const L = [
    'Hola 👋 Soy el asistente de pedidos de *Chacón Alcántara*.',
    '',
    'Para gestionar tus pedidos usaremos tu número de WhatsApp y los datos '
    + 'que compartas en esta conversación.',
  ];
  if (url) L.push(`Política de privacidad: ${url}`);
  else L.push('_(La política de privacidad completa te la facilitará Chacón Alcántara.)_');
  L.push('');
  L.push('¿Quieres continuar usando este WhatsApp para gestionar tus pedidos?');
  return L.join('\n');
}

const ESTADOS = { ACEPTADO: 'aceptado', RECHAZADO: 'rechazado' };

/* ---- registro por teléfono ---------------------------------------------- */
async function registro(telefono) {
  return repo.getPrivacidad(telefono);
}

/**
 * ¿Puede este teléfono seguir sin volver a ver el aviso?
 * Solo si aceptó Y la versión que vio sigue vigente.
 */
async function canalAutorizado(telefono) {
  const r = await registro(telefono);
  if (!r || r.status !== ESTADOS.ACEPTADO) return false;
  return r.privacy_notice_version === VERSION_AVISO;
}

/**
 * Deja constancia de la acción explícita. Se guarda lo justo para poder
 * demostrar qué versión se mostró, cuándo, a qué número y qué hizo: no hace
 * falta archivar la conversación entera.
 */
async function registrarDecision(telefono, status, {
  customer_id = null, accepted_action = null, wamid = null, source = 'whatsapp_conversation',
  recorded_by = null, method = null, nota = null } = {}) {
  const previo = await registro(telefono);
  const reg = {
    phone_number: telefono,
    customer_id: customer_id || (previo && previo.customer_id) || null,
    channel: 'whatsapp',
    privacy_notice_version: VERSION_AVISO,
    privacy_notice_url: urlPolitica(),
    status,
    accepted_at: status === ESTADOS.ACEPTADO ? new Date().toISOString()
      : (previo && previo.accepted_at) || null,
    declined_at: status === ESTADOS.RECHAZADO ? new Date().toISOString() : null,
    accepted_action,
    source,
    interaction_id: wamid || null,
    recorded_by,
    method,
    nota,
    // El marketing NO se toca aquí: es una decisión aparte.
    marketing_opt_in: previo ? !!previo.marketing_opt_in : false,
    marketing_opt_in_at: previo ? previo.marketing_opt_in_at || null : null,
    marketing_opt_in_source: previo ? previo.marketing_opt_in_source || null : null,
    marketing_notice_version: previo ? previo.marketing_notice_version || null : null,
    marketing_opt_out_at: previo ? previo.marketing_opt_out_at || null : null,
    historial: [...((previo && previo.historial) || []), {
      ts: new Date().toISOString(), status, version: VERSION_AVISO,
      accepted_action, source, recorded_by }].slice(-30),
  };
  await repo.guardarPrivacidad(reg);
  console.log('[chacon][evento] privacy_onboarding_%s tel=%s version=%s source=%s',
    status === ESTADOS.ACEPTADO ? 'accepted' : 'declined', telefono, VERSION_AVISO, source);
  return reg;
}

/** Al identificar la tienda se ata el registro a su ficha. */
async function vincularCliente(telefono, customerId) {
  const r = await registro(telefono);
  if (!r || r.customer_id === customerId) return r;
  r.customer_id = customerId;
  await repo.guardarPrivacidad(r);
  return r;
}

/* ---- marketing, completamente aparte ------------------------------------ */
/**
 * Ofertas y novedades. Independiente del canal: se puede comprar sin esto, y
 * quitarlo no afecta a los pedidos.
 */
async function fijarMarketing(telefono, quiere, {
  source = 'whatsapp_conversation', recorded_by = null } = {}) {
  const r = (await registro(telefono)) || await registrarDecision(telefono, ESTADOS.ACEPTADO,
    { accepted_action: 'implicito_al_fijar_marketing', source });
  const ahora = new Date().toISOString();
  r.marketing_opt_in = !!quiere;
  if (quiere) {
    r.marketing_opt_in_at = ahora;
    r.marketing_opt_in_source = source;
    r.marketing_notice_version = VERSION_AVISO;
    r.marketing_opt_out_at = null;
  } else {
    r.marketing_opt_out_at = ahora;
  }
  r.historial = [...(r.historial || []), {
    ts: ahora, marketing: !!quiere, source, recorded_by }].slice(-30);
  await repo.guardarPrivacidad(r);
  console.log('[chacon][evento] marketing_opt_%s tel=%s source=%s',
    quiere ? 'in' : 'out', telefono, source);
  return r;
}

async function quiereMarketing(telefono) {
  const r = await registro(telefono);
  return !!(r && r.marketing_opt_in);
}

/** Frases con las que la gente pide dejar de recibir promociones. */
const BAJA_MARKETING = /\b(no|dejad?|dejar|parad?|quitad?|baja)\b[^.]{0,30}\b(ofertas?|promocion|promociones|publicidad|novedades|marketing|spam)\b|\b(ofertas?|promocion|promociones|publicidad)\b[^.]{0,20}\b(no|nunca|basta)\b/i;

const pideBajaMarketing = (texto) => BAJA_MARKETING.test(String(texto || ''));

module.exports = {
  VERSION_AVISO, ESTADOS, urlPolitica, textoAviso,
  registro, canalAutorizado, registrarDecision, vincularCliente,
  fijarMarketing, quiereMarketing, pideBajaMarketing, BAJA_MARKETING,
};
