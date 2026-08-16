/* ============================================================
   WhatsApp Cloud API (Graph) — outbound messages, media download and
   webhook signature verification.
   ============================================================ */

const crypto = require('crypto');
const { esTest } = require('./testmode');

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v20.0';
const GRAPH = `https://graph.facebook.com/${API_VERSION}`;

function token() {
  return process.env.WHATSAPP_TOKEN || process.env.WA_ACCESS_TOKEN || '';
}

/**
 * Verify Meta's X-Hub-Signature-256 over the RAW request body.
 * Must run on the exact bytes received: re-serialising the parsed JSON
 * changes key order and escaping, and the HMAC would never match.
 */
function verifySignature(rawBody, header, appSecret) {
  if (!appSecret) return { ok: false, reason: 'no_app_secret' };
  if (!header) return { ok: false, reason: 'no_signature_header' };
  if (!rawBody || !rawBody.length) return { ok: false, reason: 'no_raw_body' };

  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret)
    .update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  if (a.length !== b.length) return { ok: false, reason: 'length_mismatch' };
  return crypto.timingSafeEqual(a, b)
    ? { ok: true, reason: 'valid' }
    : { ok: false, reason: 'mismatch' };
}

/**
 * Normaliza el destino antes de mandárselo a Graph.
 *
 * México es el caso raro: el wa_id canónico lleva un 1 tras el 52
 * (5213471109971), pero Graph SOLO acepta como input la forma sin ese 1
 * (523471109971) y él mismo lo añade. Mandar la forma canónica devuelve
 * `(#131030) Recipient phone number not in allowed list` — un error que
 * apunta a la lista de autorizados cuando el número sí está autorizado.
 */
function normalizarDestino(to) {
  const d = String(to == null ? '' : to).replace(/[^0-9]/g, '');
  // El rango reservado de pruebas también empieza con 521 y no es un número
  // real: tocarlo solo confundiría los logs.
  if (esTest(d)) return d;
  // 521 + 10 dígitos = 13 → 52 + 10 dígitos
  if (d.length === 13 && d.startsWith('521')) return '52' + d.slice(3);
  return d;
}

/** Send a plain text message. Returns true only on a 2xx from Graph. */
async function sendText(client, to, body) {
  return (await sendTextDetailed(client, to, body)).ok;
}

/**
 * Same send, but returns Graph's answer instead of a bare boolean:
 * { ok, status, detail }. Callers that need to record WHY a send failed
 * (24h window vs. allow-list vs. bad token) use this one.
 */
async function sendTextDetailed(client, to, body) {
  const pnid = client.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID || '';
  const tok = token();
  if (!tok || !pnid) {
    console.warn('[wa] sin token o phone_number_id; no se envía a', to);
    return { ok: false, status: 0, detail: 'sin token o phone_number_id' };
  }
  const destino = normalizarDestino(to);
  if (destino !== String(to)) {
    console.log('[wa] destino normalizado %s -> %s (México: Graph exige 52+10)', to, destino);
  }
  const r = await fetch(`${GRAPH}/${pnid}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: destino,
      type: 'text',
      text: { body: String(body).slice(0, 4096) },
    }),
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => '')).slice(0, 400);
    console.error('[wa] envío falló', destino, r.status, detail);
    return { ok: false, status: r.status, detail };
  }
  // El wamid permite correlacionar después el webhook de estado (sent /
  // delivered / failed). Graph devolver 200 solo significa "aceptado".
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  return { ok: true, status: r.status, wamid: j?.messages?.[0]?.id || null };
}

/**
 * Download media from Graph.
 * @returns {{buffer: Buffer, mime: string, size: number}}
 */
async function downloadMedia(mediaId) {
  const tok = token();
  const meta = await fetch(`${GRAPH}/${mediaId}`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (!meta.ok) throw new Error(`graph media meta ${meta.status}`);
  const info = await meta.json();

  const bin = await fetch(info.url, { headers: { Authorization: `Bearer ${tok}` } });
  if (!bin.ok) throw new Error(`graph media download ${bin.status}`);
  const buffer = Buffer.from(await bin.arrayBuffer());

  return {
    buffer,
    mime: info.mime_type || 'application/octet-stream',
    size: Number(info.file_size || buffer.length),
  };
}

module.exports = { GRAPH, API_VERSION, sendText, sendTextDetailed, downloadMedia, verifySignature, token, normalizarDestino };
