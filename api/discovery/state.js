/* GET /api/discovery/state?s=<token> — fetch session for resume. */
const store = require('../../lib/discovery/store');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const t = (req.query && req.query.s) || '';
  if (!t) return res.status(400).json({ error: 'missing_token' });
  try {
    const s = await store.get(t);
    if (!s) return res.status(404).json({ error: 'session_not_found' });
    return res.status(200).json({
      sessionToken: s.sessionToken, status: s.status,
      transcript: s.transcript.map((m) => ({ role: m.role, content: m.content })),
    });
  } catch (e) {
    return res.status(503).json({ error: 'store_unavailable' });
  }
};
