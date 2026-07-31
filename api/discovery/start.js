/* POST /api/discovery/start — create or resume a discovery session. */
const store = require('../../lib/discovery/store');
const { forClient } = require('../../lib/discovery/prompts');
const rl = require('../../lib/discovery/ratelimit');

const ALLOWED = (process.env.DISCOVERY_CLIENT_KEYS || 'gabi,hundred').split(',').map((s) => s.trim());

/** Campaign / source tag from the landing (?ref=). Kept short and boring so a
    crafted link can't stuff arbitrary text into the session metadata. */
function cleanRef(v) {
  const s = String(v == null ? '' : v).trim().slice(0, 60);
  return /^[\w .:@/-]*$/.test(s) ? s : '';
}

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
    // rate-limit NEW session creation per IP (resume above is exempt)
    const lim = await rl.check('start', rl.clientIp(req), rl.LIMITS.start_per_ip_hour);
    if (!lim.ok) return res.status(429).json({ error: 'rate_limited', message: rl.FRIENDLY });

    const greeting = forClient(clientKey).GREETING;
    const s = store.newSession(clientKey);
    const ref = cleanRef(body.ref);
    if (ref) s.metadata = Object.assign({}, s.metadata, { ref });
    s.transcript.push({ role: 'assistant', content: greeting, ts: new Date().toISOString() });
    await store.save(s);
    return res.status(200).json({ sessionToken: s.sessionToken, resumed: false, greeting });
  } catch (err) {
    console.error('[discovery:start]', err && err.code, err && err.detail);
    return res.status(503).json({ error: (err && err.code) || 'store_unavailable' });
  }
};
