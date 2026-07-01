/* GET /api/discovery/admin — internal review. Token-protected.
   Returns session list, or one session's full artifacts (?s=token). */
const store = require('../../lib/discovery/store');

function authed(req) {
  const want = process.env.DISCOVERY_ADMIN_TOKEN;
  if (!want) return false; // closed by default if unset
  const got = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')
    || (req.query && req.query.key) || '';
  return got && got === want;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'method_not_allowed' }); }
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
  const rd = store.ready();
  if (!rd.ok) return res.status(503).json({ error: 'durable_storage_unconfigured', message: rd.error });

  try {
    const token = req.query && req.query.s;
    if (token) {
      const s = await store.get(token);
      if (!s) return res.status(404).json({ error: 'session_not_found' });
      return res.status(200).json(s);
    }
    const all = await store.list();
    const summary = all.map((s) => ({
      sessionToken: s.sessionToken, status: s.status,
      email: (s.brainPartial && s.brainPartial.client_contact && s.brainPartial.client_contact.email)
        || (s.artifacts && s.artifacts.brain && s.artifacts.brain.client_contact && s.artifacts.brain.client_contact.email) || null,
      scopeClass: s.artifacts && s.artifacts.score && s.artifacts.score.classification,
      completeness: s.artifacts && s.artifacts.brain && s.artifacts.brain.completeness,
      humanReviewRequired: s.artifacts && s.artifacts.proposal && s.artifacts.proposal.human_review_required,
      isTest: !!(s.metadata && s.metadata.is_test === true),
      testReason: s.metadata && s.metadata.test_reason,
      createdAt: s.createdAt, finalizedAt: s.finalizedAt,
    }));
    // Real sessions first (default review set); test sessions kept separate.
    return res.status(200).json({
      sessions: summary.filter((x) => !x.isTest),
      testSessions: summary.filter((x) => x.isTest),
    });
  } catch (e) {
    return res.status(503).json({ error: 'store_unavailable' });
  }
};
