/* ============================================================
   WhatsApp Cloud API (Graph) — outbound messages, media download and
   webhook signature verification.
   ============================================================ */

const crypto = require('crypto');

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

/** Send a plain text message. Returns true only on a 2xx from Graph. */
async function sendText(client, to, body) {
  const pnid = client.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID || '';
  const tok = token();
  if (!tok || !pnid) {
    console.warn('[wa] sin token o phone_number_id; no se envía a', to);
    return false;
  }
  const r = await fetch(`${GRAPH}/${pnid}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: String(body).slice(0, 4096) },
    }),
  });
  if (!r.ok) {
    console.error('[wa] envío falló', to, r.status, (await r.text()).slice(0, 400));
    return false;
  }
  return true;
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

module.exports = { GRAPH, API_VERSION, sendText, downloadMedia, verifySignature, token };
