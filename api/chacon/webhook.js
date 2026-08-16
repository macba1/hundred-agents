/* ============================================================
   /api/chacon/webhook — entrada de WhatsApp del agente de Chacón.

   Reutiliza de Sanmi la verificación de firma, la clasificación de entrada
   (falla-cerrado) y el envío por Graph. NO toca `lib/wa/agent.js`: el
   dominio de Chacón vive aparte, así que Sanmi no puede romperse desde aquí.
   ============================================================ */

const wa = require('../../lib/wa/whatsapp');
const inbound = require('../../lib/wa/inbound');
const store = require('../../lib/wa/store');
const repo = require('../../lib/chacon/repo');
const agente = require('../../lib/chacon/agente');
const fabrica = require('../../lib/chacon/fabrica');
const voz = require('../../lib/chacon/voz');
const formato = require('../../lib/chacon/wa-formato');
const navegacion = require('../../lib/chacon/navegacion');
const carritoNativo = require('../../lib/chacon/carrito-nativo');
const pedidoLib = require('../../lib/chacon/pedido');

const MAX_RESPUESTAS_HORA = Number(process.env.CHACON_MAX_RESPUESTAS_HORA || 40);
const HISTORIAL_MAX = Number(process.env.CHACON_HISTORIAL_MAX || 24);

const isProd = () => (process.env.VERCEL_ENV || '') === 'production';

async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

/** Historial de conversación: en Redis, namespace de Chacón. */
async function getHistorial(telefono) {
  const c = await repo.getCarrito(`hist:${telefono}`);
  return Array.isArray(c.lineas) ? c.lineas : [];
}
async function setHistorial(telefono, historial) {
  await repo.guardarCarrito({ clienteId: `hist:${telefono}`, lineas: historial.slice(-HISTORIAL_MAX) });
}

async function handler(req, res) {
  if (req.method === 'GET') {
    const q = req.query || {};
    const want = process.env.CHACON_VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN || '';
    if (q['hub.mode'] === 'subscribe' && want && q['hub.verify_token'] === want) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(String(q['hub.challenge'] || ''));
    }
    return res.status(403).send('forbidden');
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let raw;
  try { raw = await readRawBody(req); }
  catch (e) { console.error('[chacon] body ilegible:', e.message); return res.status(200).json({ status: 'ok' }); }

  const check = wa.verifySignature(raw, req.headers['x-hub-signature-256'], process.env.META_APP_SECRET || '');
  console.log('[chacon] webhook ip=%s ua=%s bytes=%s firma=%s',
    req.headers['x-forwarded-for'] || '?', String(req.headers['user-agent'] || '?').slice(0, 60),
    raw.length, check.reason);
  if (!check.ok && isProd()) {
    console.error('[chacon] firma inválida:', check.reason);
    return res.status(401).json({ error: 'invalid_signature', reason: check.reason });
  }

  let payload;
  try { payload = JSON.parse(raw.toString('utf8') || '{}'); }
  catch { return res.status(200).json({ status: 'ok' }); }

  const pendientes = [];
  try {
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        if (Array.isArray(value.statuses) && value.statuses.length) {
          for (const st of value.statuses) {
            const err = (st.errors || []).map((e) => `${e.code}:${e.title || ''}`).join(' | ');
            console.log('[chacon][status] wamid=%s estado=%s%s', st.id, st.status, err ? ' error=' + err : '');
            // Única fuente de verdad sobre si la solicitud llegó de verdad al
            // canal interno. El 200 del envío solo decía "aceptado".
            pendientes.push(fabrica.confirmarEntrega(st.id, st.status)
              .catch((e) => console.error('[chacon] confirmarEntrega:', e.message)));
          }
        }
        // Enrutado fail-closed. La app de Meta puede tener varios números y
        // este endpoint no debe contestar por ninguno que no sea el suyo:
        // respondería como Chacón a clientes de otro negocio. Si
        // CHACON_PHONE_NUMBER_ID está configurado, manda él.
        const esperado = process.env.CHACON_PHONE_NUMBER_ID || '';
        const recibido = (value.metadata || {}).phone_number_id || '';
        if (esperado && recibido && recibido !== esperado) {
          console.warn('[chacon] mensaje de otro phone_number_id (%s ≠ %s): se ignora',
            recibido, esperado);
          continue;
        }

        const mensajes = Array.isArray(value.messages) ? value.messages : [];
        if (!mensajes.length) { console.log('[status-ignored] payload sin messages'); continue; }

        for (const m of mensajes) {
          const cls = inbound.clasificar(m);
          console.log('[chacon] msg id=%s type=%s from=%s accion=%s', m.id || '?', cls.tipo, m.from || '?', cls.accion);
          if (inbound.esEcho(m, value, { phone_number_id: (value.metadata || {}).phone_number_id })) {
            console.warn('[chacon] eco ignorado'); continue;
          }
          // El carrito nativo entra por la misma puerta que todo lo demás.
          if (m.type === 'order') {
            if (await store.alreadySeen(m.id)) { console.log('[chacon] dedup', m.id); continue; }
            pendientes.push(atenderCarrito(value, m));
            continue;
          }

          // Un clic en un botón o una lista es una intención más, no un
          // camino aparte: se convierte en la frase que habría escrito.
          if (m.type === 'interactive') {
            if (await store.alreadySeen(m.id)) { console.log('[chacon] dedup', m.id); continue; }
            pendientes.push(atender(value, m));
            continue;
          }

          const ATENDIBLES = new Set(['text', 'audio', 'voice']);
          if (cls.accion !== 'agente' || !ATENDIBLES.has(cls.tipo)) {
            if (cls.accion === 'no_soportado' || !ATENDIBLES.has(cls.tipo)) {
              pendientes.push(responderTexto(value, m.from,
                'Por ahora solo puedo leer mensajes de texto y notas de voz. ¿Me escribes tu pedido?'));
            }
            continue;
          }
          if (await store.alreadySeen(m.id)) { console.log('[chacon] dedup', m.id); continue; }
          const n = await store.bumpRespuesta('chacon', m.from);
          if (n > MAX_RESPUESTAS_HORA) { console.error('[chacon] cortacircuitos', m.from, n); continue; }
          pendientes.push(atender(value, m));
        }
      }
    }
    await Promise.all(pendientes);
  } catch (err) {
    console.error('[chacon] error procesando webhook:', err.stack || err.message);
  }
  return res.status(200).json({ status: 'ok' });
}

/**
 * Carrito enviado desde el catálogo nativo de WhatsApp.
 *
 * Se procesa en código, no por el modelo: los códigos y las cantidades ya
 * vienen estructurados y dejar que un LLM los reinterprete solo puede
 * empeorarlos. El modelo entra después, para lo que sí es conversación.
 */
async function atenderCarrito(value, m) {
  const telefono = m.from;
  try {
    const cliente = await repo.clientePorTelefono(telefono);
    if (!cliente) {
      // Sin tienda identificada no hay carrito donde volcarlo.
      return responderTexto(value, telefono,
        'He recibido tu pedido del catálogo. Antes de seguir, ¿cómo se llama tu tienda?');
    }

    const interpretado = await carritoNativo.interpretar(m.order || {});
    const r = await carritoNativo.volcar(cliente.id, telefono, interpretado, { wamid: m.id });
    console.log('[chacon] carrito nativo de %s: %s líneas, %s ambiguas, %s rechazadas',
      telefono, r.lineas_añadidas, r.pendientes_de_modalidad, (r.rechazadas || []).length);

    if (r.idempotente) return;

    const L = [];
    L.push(`He recibido tu pedido del catálogo: ${interpretado.lineas.length} producto(s).`);
    if (r.rechazadas?.length) {
      L.push('');
      L.push('No he podido añadir estos, revisa conmigo cuáles quieres:');
      for (const x of r.rechazadas) L.push(`• ${x.product_retailer_id || '(sin código)'}`);
    }
    if (r.pregunta) { L.push(''); L.push(r.pregunta); }
    else {
      const carrito = await repo.getCarrito(cliente.id);
      L.push('');
      L.push(pedidoLib.textoResumen(carrito, cliente));
    }
    await responderTexto(value, telefono, L.join('\n'));
  } catch (err) {
    console.error('[chacon] error con el carrito de', telefono, err.stack || err.message);
    await responderTexto(value, telefono,
      'He recibido tu pedido del catálogo pero he tenido un problema al leerlo. '
      + '¿Me lo confirmas por aquí?');
  }
}

/**
 * Decide con qué formato se contesta.
 *
 * El texto de las fichas y de las familias sale de las herramientas, no de
 * lo que redacte el modelo: así el precio y el peso que ve la tienda son
 * exactamente los del catálogo. El modelo solo pone la frase de entrada.
 *
 * Si no hay ninguna pantalla que encaje, devuelve null y se contesta en
 * texto plano, que es el camino de siempre.
 */
function componerPantallas(r, eco = '') {
  const usadas = r.tools || [];
  const ultima = (nombres) => [...usadas].reverse()
    .find((t) => nombres.includes(t.nombre) && t.res && t.res.ok !== false);

  const pagina = ultima(['ver_productos', 'ver_mas_productos']);
  if (pagina && pagina.res.productos?.length) {
    return formato.paginaDeProductos(pagina.res, { titulo: (eco + r.respuesta).trim() || null });
  }

  const cats = ultima(['ver_categorias']);
  if (cats && cats.res.categorias?.length) {
    const out = [];
    const intro = (eco + r.respuesta).trim();
    if (intro) out.push(formato.texto(intro));
    out.push(formato.menuCategorias(cats.res.categorias));
    return out;
  }

  // El saludo lleva sus tres accesos rápidos como botones.
  if (!eco && r.respuesta && r.respuesta.includes('¿Qué necesitas hoy?')) {
    return [formato.accesosRapidos(r.respuesta.split('\n')[0])];
  }
  return null;
}

async function responderTexto(value, telefono, texto) {
  const cliente = { phone_number_id: (value.metadata || {}).phone_number_id
    || process.env.CHACON_PHONE_NUMBER_ID || '' };
  return wa.sendText(cliente, telefono, texto);
}

async function atender(value, m) {
  const telefono = m.from;
  try {
    // Una nota de voz se convierte en texto y sigue exactamente el mismo
    // camino que un mensaje escrito. No abre ninguna puerta: el precio lo
    // sigue dando la herramienta y el pedido sigue exigiendo CONFIRMAR.
    const esVoz = m.type === 'audio' || m.type === 'voice';
    let texto = esVoz ? null : (m.text || {}).body || null;
    let eco = '';

    if (m.type === 'interactive') {
      texto = formato.textoDeId(formato.idPulsado(m), { categorias: navegacion.listarCategorias() });
      console.log('[chacon] clic "%s" -> "%s"', formato.idPulsado(m), texto);
    }
    if (esVoz) {
      // WhatsApp manda las notas de voz como `audio`; `voice` existe en
      // algunos payloads. Los dos traen el media id en el mismo sitio.
      const media = m.audio || m.voice || {};
      const t = await voz.transcribir(telefono, media.id);
      if (!t.texto) return responderTexto(value, telefono, t.aviso);
      texto = t.texto;
      eco = voz.ecoDeTranscripcion(t.texto) + '\n\n';
    }
    if (!texto) return;

    const historial = await getHistorial(telefono);
    const r = await agente.responder({
      telefono, texto, historial,
      // El wamid hace la confirmación idempotente: reenviar el mismo mensaje
      // no puede generar dos pedidos.
      claveIdempotencia: m.id,
    });
    await setHistorial(telefono, r.historial);
    if (r.consultas_alergeno_sin_dato.length) {
      console.warn('[chacon] consulta de alérgenos sin dato:', JSON.stringify(r.consultas_alergeno_sin_dato));
    }
    const pantallas = componerPantallas(r, eco);
    if (pantallas) {
      const cliente = { phone_number_id: (value.metadata || {}).phone_number_id
        || process.env.CHACON_PHONE_NUMBER_ID || '' };
      await formato.enviar(cliente, telefono, pantallas);
    } else {
      await responderTexto(value, telefono, eco + r.respuesta);
    }
  } catch (err) {
    console.error('[chacon] error atendiendo a', telefono, err.stack || err.message);
    await responderTexto(value, telefono, 'Hemos tenido un problema técnico. ¿Me repites el mensaje?');
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
