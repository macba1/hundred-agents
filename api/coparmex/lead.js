/* ============================================================
   POST /api/coparmex/lead
   Captures a lead from the Coparmex landing (name + email).
   Stores it in Redis (lib/coparmex) and, if LEADS_NOTIFY_WEBHOOK
   is set, forwards a copy there. Always fast; storage failures
   return 502 so the client can surface a friendly message.
   ============================================================ */

const { addLead } = require('../../lib/coparmex');
const { validEmail } = require('../../lib/notion');

function clientIp(req) {
  const xff = (req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '';
  const ip = String(xff).split(',')[0].trim();
  return ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const name = String(body.name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().slice(0, 200);

  if (!name) return res.status(400).json({ ok: false, error: 'name_required' });
  if (!validEmail(email)) return res.status(400).json({ ok: false, error: 'bad_email' });

  const lead = {
    name,
    email,
    ts: new Date().toISOString(),
    ua: String((req.headers && req.headers['user-agent']) || '').slice(0, 300),
    ip: clientIp(req),
    consent: body.consent === false ? false : true,
    source: 'coparmex',
  };

  try {
    await addLead(lead);
  } catch (err) {
    console.error('[coparmex:lead]', (err && err.code) || 'error', err && err.message);
    return res.status(502).json({ ok: false, error: 'store_unavailable' });
  }

  // Optional fire-and-forget notification (never blocks the response path hard).
  const notify = process.env.LEADS_NOTIFY_WEBHOOK;
  if (notify) {
    try {
      await fetch(notify, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `Nuevo lead Coparmex: ${name} <${email}>`, lead }),
      });
    } catch (err) {
      console.error('[coparmex:lead:notify]', err && err.message);
    }
  }

  return res.status(200).json({ ok: true });
};
