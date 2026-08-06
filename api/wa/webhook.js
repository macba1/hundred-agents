/* ============================================================
   /api/wa/webhook — WhatsApp Cloud API webhook.

   GET  : Meta's subscription challenge (hub.verify_token).
   POST : inbound messages. Verifies X-Hub-Signature-256 over the RAW body,
          dedupes by message_id in Redis, then processes inline (OpenAI +
          Graph reply) before returning 200.

   Why inline instead of "reply 200 first, work later": on serverless the
   instance can be frozen the moment the response is sent, so work queued
   after it may never run. maxDuration is raised to 60s to fit the model
   call; Meta retries on timeout and the Redis dedupe absorbs the retry.

   bodyParser is disabled because the signature must be computed over the
   exact bytes Meta sent — re-serialising parsed JSON changes key order and
   escaping, and the HMAC would never match.
   ============================================================ */

const clientsLib = require('../../lib/wa/clients');
const store = require('../../lib/wa/store');
const wa = require('../../lib/wa/whatsapp');
const agent = require('../../lib/wa/agent');
const inbound = require('../../lib/wa/inbound');

// Tope de respuestas por teléfono y hora. Un cliente real no necesita más.
const MAX_RESPUESTAS_HORA = Number(process.env.WA_MAX_RESPUESTAS_HORA || 25);

/* Leído en cada request, no al cargar el módulo: una constante de nivel de
   módulo se congela con el primer cold start y no se puede ejercitar. */
function isProd() {
  return (process.env.VERCEL_ENV || '') === 'production';
}

/** Collect the raw request body. Requires bodyParser:false. */
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function handler(req, res) {
  /* ---- GET: verificación de Meta ---- */
  if (req.method === 'GET') {
    const q = req.query || {};
    const want = process.env.WHATSAPP_VERIFY_TOKEN || process.env.WA_VERIFY_TOKEN || '';
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

  /* ---- firma + parseo ---- */
  let raw;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    console.error('[wa] no se pudo leer el body:', err.message);
    return res.status(200).json({ status: 'ok' });
  }

  // Origen de la petición: sin esto no se puede responder "¿de dónde vino este
  // webhook?" después, y los logs de runtime caducan en horas.
  const origen = {
    ip: req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '?',
    ua: String(req.headers['user-agent'] || '?').slice(0, 80),
    bytes: raw.length,
  };

  const appSecret = process.env.META_APP_SECRET || '';
  const sig = req.headers['x-hub-signature-256'];
  const check = wa.verifySignature(raw, sig, appSecret);
  console.log('[wa] webhook POST desde ip=%s ua=%s bytes=%s firma=%s',
    origen.ip, origen.ua, origen.bytes, check.reason);

  if (!check.ok) {
    if (isProd()) {
      // Fail closed in production: an unverified POST could be anyone.
      console.error('[wa] firma inválida, se rechaza:', check.reason);
      return res.status(401).json({ error: 'invalid_signature', reason: check.reason });
    }
    console.warn('[wa] firma NO verificada (', check.reason, ') — se acepta fuera de producción');
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    return res.status(200).json({ status: 'ok' });
  }

  /* ---- enrutado + proceso ---- */
  const pendientes = [];
  try {
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const pnid = (value.metadata || {}).phone_number_id;
        const campo = change.field || '?';

        // Los acuses de entrega/lectura son de NUESTROS propios envíos. Nunca
        // generan respuesta. Se registran y se acaba ahí.
        if (Array.isArray(value.statuses) && value.statuses.length) {
          for (const st of value.statuses) {
            // El motivo del fallo es lo único accionable de un status, y sin él
            // un "failed" no dice si fue la ventana de 24h, el número o Meta.
            const err = (st.errors || [])
              .map((e) => `${e.code}:${e.title || e.message || ''}`).join(' | ');
            console.log('[status-ignored] wamid=%s estado=%s destinatario=%s%s',
              st.id, st.status, st.recipient_id || '?', err ? ' error=' + err : '');
            if (st.status === 'failed') {
              console.error('[wa] ENTREGA FALLIDA a %s: %s', st.recipient_id || '?', err || 'sin detalle');
            }
          }
        }

        const mensajes = Array.isArray(value.messages) ? value.messages : [];
        if (!mensajes.length) {
          // Sin messages no hay nada que atender: ni reacciones, ni cambios de
          // perfil, ni errores de plantilla, ni campos que Meta añada después.
          const otras = Object.keys(value).filter((k) => k !== 'messaging_product' && k !== 'metadata');
          console.log('[status-ignored] payload sin messages · field=%s claves=%s',
            campo, JSON.stringify(otras));
          continue;
        }

        const client = clientsLib.resolve(pnid);
        if (!client) {
          console.error('[wa] sin cliente para phone_number_id', pnid, '— se ignoran', mensajes.length, 'mensajes');
          continue;
        }

        for (const m of mensajes) {
          const cls = inbound.clasificar(m);
          // Se registra SIEMPRE qué llegó: cuando el agente contestó sin que
          // nadie escribiera, no había forma de saber qué lo disparó.
          console.log('[wa] msg id=%s type=%s from=%s ts=%s accion=%s%s',
            m.id || '?', cls.tipo, m.from || '?', m.timestamp || '?', cls.accion,
            cls.motivo ? ' motivo=' + cls.motivo : '');

          if (inbound.esEcho(m, value, client)) {
            console.warn('[wa] ECO ignorado: from coincide con el número del negocio (%s)', m.from);
            continue;
          }

          if (cls.accion === 'ignorar') continue; // 200 + log, sin OpenAI ni envío

          // Dedupe antes de cualquier trabajo: Meta reintenta, y un reintento
          // no debe producir una segunda respuesta ni un segundo lead.
          if (await store.alreadySeen(m.id)) {
            console.log('[wa] dedup:', m.id, 'ya visto');
            continue;
          }

          // Cortacircuitos: si algo dispara mensajes en bucle, aquí se corta.
          const n = await store.bumpRespuesta(client.clave, m.from);
          if (n > MAX_RESPUESTAS_HORA) {
            console.error('[wa] CORTACIRCUITOS: %s lleva %s respuestas esta hora (máx %s). No se contesta.',
              m.from, n, MAX_RESPUESTAS_HORA);
            continue;
          }

          pendientes.push(agent.handleMessage(client, m, cls));
        }
      }
    }
    await Promise.all(pendientes);
  } catch (err) {
    console.error('[wa] error procesando webhook:', err.stack || err.message);
  }

  // Siempre 200: si Meta no lo ve, reintenta y puede desactivar el webhook.
  return res.status(200).json({ status: 'ok' });
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
