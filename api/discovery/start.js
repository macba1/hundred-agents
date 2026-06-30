/* POST /api/discovery/start — create or resume a discovery session. */
const store = require('../../lib/discovery/store');
const { GREETING } = require('../../lib/discovery/prompts');

const ALLOWED = (process.env.DISCOVERY_CLIENT_KEYS || 'gabi').split(',').map((s) => s.trim());

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const rd = store.ready();
  if (!rd.ok) return res.status(503).json({ error: 'durable_storage_unconfigured', message: rd.error });
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } } body = body || {};

  const clientKey = (body.clientKey || 'gabi').trim();
  if (!ALLOWED.includes(clientKey)) return res.status(403).json({ error: 'unknown_client' });

  try {
    // resume if a valid token is supplied
    if (body.sessionToken) {
      const existing = await store.get(body.sessionToken);
      if (existing) return res.status(200).json({ sessionToken: existing.sessionToken, resumed: true, transcript: existing.transcript, status: existing.status });
    }
    const s = store.newSession(clientKey);
    s.transcript.push({ role: 'assistant', content: GREETING, ts: new Date().toISOString() });
    await store.save(s);
    return res.status(200).json({ sessionToken: s.sessionToken, resumed: false, greeting: GREETING });
  } catch (err) {
    console.error('[discovery:start]', err && err.code, err && err.detail);
    return res.status(503).json({ error: (err && err.code) || 'store_unavailable' });
  }
};
