/* POST /api/discovery/recompile?key=<DISCOVERY_ADMIN_TOKEN>
   Admin ops tool: re-run the compile pass + rebuild artifacts for an
   existing session (e.g. after improving the compile prompt/model), and
   persist. Does NOT send a client notification. Body: { sessionToken }. */
const store = require('../../lib/discovery/store');
const compile = require('../../lib/discovery/compile');
const { buildArtifacts } = require('./finalize');

function authed(req) {
  const want = process.env.DISCOVERY_ADMIN_TOKEN;
  if (!want) return false;
  const got = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || (req.query && req.query.key) || '';
  return got && got === want;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
  const rd = store.ready();
  if (!rd.ok) return res.status(503).json({ error: 'durable_storage_unconfigured' });

  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } } body = body || {};
  const s = await store.get(body.sessionToken).catch(() => null);
  if (!s) return res.status(404).json({ error: 'session_not_found' });

  let partial = s.brainPartial || {};
  const key = process.env.OPENAI_API_KEY;
  if (key && s.transcript && s.transcript.length) {
    try { partial = await compile.compileSession(s.transcript, partial, key); }
    catch (e) { return res.status(502).json({ error: 'compile_failed', detail: (e && e.code) || 'error' }); }
  }

  const nowISO = new Date().toISOString();
  const artifacts = buildArtifacts(partial, nowISO);
  s.brainPartial = partial;
  s.artifacts = artifacts;
  if (s.status !== 'finalized') s.status = 'finalized';
  s.recompiledAt = nowISO;
  try { await store.save(s); } catch { return res.status(502).json({ error: 'store_unavailable_on_save' }); }

  const b = artifacts.brain;
  return res.status(200).json({
    ok: true,
    completeness: b.completeness,
    filled: {
      business_lines: (b.business_lines || []).length,
      business_unit_details: (b.business_unit_details || []).length,
      escalation_rules: (b.escalation_rules || []).length,
      integrations: (b.integrations || []).length,
      success_criteria: (b.success_criteria || []).length,
      faqs_by_business: (b.faqs_by_business || []).length,
      lead_capture: (b.lead_capture_fields_by_business || []).length,
    },
    scopeClass: artifacts.score.classification,
  });
};
