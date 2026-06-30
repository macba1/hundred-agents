/* GET /api/discovery/health — storage health check (admin-token protected).
   Exercises write -> read -> update -> persist artifacts -> admin read ->
   delete on the active storage backend, and reports the mode. Use this in
   preview/production to confirm durable KV is wired before sending the URL. */
const store = require('../../lib/discovery/store');
const { buildArtifacts } = require('./finalize');

function authed(req) {
  const want = process.env.DISCOVERY_ADMIN_TOKEN;
  if (!want) return false;
  const got = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || (req.query && req.query.key) || '';
  return got && got === want;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'method_not_allowed' }); }
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });

  const rd = store.ready();
  const steps = { mode: rd.mode, write: false, read: false, update: false, persist_artifacts: false, admin_read: false, delete: false };
  if (!rd.ok) return res.status(503).json({ ok: false, error: 'durable_storage_unconfigured', message: rd.error, steps });

  let tok = null;
  try {
    const s = store.newSession('gabi');
    s.brainPartial = { client_name: 'HealthCheck', client_contact: { email: 'health@check.dev' }, business_lines: [{ name: 'Glamping', status: 'active' }] };
    tok = s.sessionToken;

    await store.save(s); steps.write = true;
    const r1 = await store.get(tok); steps.read = !!(r1 && r1.sessionToken === tok);

    r1.transcript.push({ role: 'user', content: 'ping', ts: new Date().toISOString() });
    await store.save(r1);
    const r2 = await store.get(tok); steps.update = !!(r2 && r2.transcript.length === 1);

    r2.artifacts = buildArtifacts(r2.brainPartial, new Date().toISOString());
    r2.status = 'finalized';
    await store.save(r2);
    const r3 = await store.get(tok);
    steps.persist_artifacts = !!(r3 && r3.artifacts && r3.artifacts.proposal && r3.artifacts.proposal.human_review_required === true
      && r3.artifacts.brain.client_contact.email === 'health@check.dev');

    const all = await store.list();
    steps.admin_read = Array.isArray(all) && all.some((x) => x.sessionToken === tok);

    await store.del(tok);
    const gone = await store.get(tok);
    steps.delete = gone === null;

    const ok = steps.write && steps.read && steps.update && steps.persist_artifacts && steps.admin_read && steps.delete;
    return res.status(ok ? 200 : 500).json({ ok, steps });
  } catch (err) {
    if (tok) { try { await store.del(tok); } catch {} }
    return res.status(503).json({ ok: false, error: (err && err.code) || 'store_error', message: err && err.message, steps });
  }
};
