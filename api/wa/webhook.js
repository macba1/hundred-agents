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

        for (const st of value.statuses || []) {
          console.log('[wa] status', st.id, '->', st.status);
        }

        const mensajes = value.messages || [];
        if (!mensajes.length) continue;

        const client = clientsLib.resolve(pnid);
        if (!client) {
          console.error('[wa] sin cliente para phone_number_id', pnid, '— se ignoran', mensajes.length, 'mensajes');
          continue;
        }

        for (const m of mensajes) {
          // Dedupe before any work: Meta retries, and a retry must not
          // produce a second reply or a second lead.
          if (m.id && await store.alreadySeen(m.id)) {
            console.log('[wa] dedup:', m.id, 'ya visto');
            continue;
          }
          pendientes.push(agent.handleMessage(client, m));
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
