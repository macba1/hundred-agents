/* POST /api/discovery/finalize — compile Business Brain from the
   transcript, then derive Scope Score, Agent Blueprint and the
   internal Proposal Draft. Persists artifacts on the session.
   Never sends anything to Gabi; output is for human review. */
const store = require('../../lib/discovery/store');
const brainLib = require('../../lib/discovery/brain');
const { scoreBrain } = require('../../lib/discovery/score');
const { buildBlueprint } = require('../../lib/discovery/blueprint');
const { buildProposal } = require('../../lib/discovery/proposal');
const compile = require('../../lib/discovery/compile');
const notify = require('../../lib/discovery/notify');

/** Build the four artifacts from a (possibly LLM-compiled) partial brain. */
function buildArtifacts(partial, nowISO) {
  const brain = brainLib.finalizeBrain(partial);
  brain.captured_at = nowISO;
  const score = scoreBrain(brain);
  const blueprint = buildBlueprint(brain, score);
  const proposal = buildProposal(brain, score, blueprint);
  return { brain, score, blueprint, proposal };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const rd = store.ready();
  if (!rd.ok) return res.status(503).json({ error: 'durable_storage_unconfigured', message: rd.error });
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } } body = body || {};

  let s;
  try { s = await store.get(body.sessionToken); } catch (e) { return res.status(503).json({ error: 'store_unavailable' }); }
  if (!s) return res.status(404).json({ error: 'session_not_found' });

  let partial = s.brainPartial || {};

  // LLM compile pass to fill gaps from the full transcript (best-effort).
  const key = process.env.OPENAI_API_KEY;
  if (key && s.transcript && s.transcript.length) {
    try { partial = await compile.compileSession(s.transcript, partial, key); }
    catch (e) { console.error('[discovery:finalize:compile]', e && e.code, e && e.detail); }
  }

  // Email is required before finalization. Persist progress, then ask for it.
  if (!brainLib.hasEmail(partial)) {
    s.brainPartial = partial;
    try { await store.save(s); } catch {}
    return res.status(400).json({
      ok: false,
      error: 'email_required',
      message: '¿Cuál es el mejor email para enviarte la propuesta de implantación y comercial con precios?',
    });
  }

  const nowISO = new Date().toISOString();
  const artifacts = buildArtifacts(partial, nowISO);
  const valid = brainLib.validate(artifacts.brain);

  s.brainPartial = partial;
  s.artifacts = artifacts;
  s.status = 'finalized';
  s.finalizedAt = nowISO;
  try { await store.save(s); } catch (e) { return res.status(502).json({ error: 'store_unavailable_on_save' }); }

  // Notify the team in Notion on REAL (non-test) completions. Best-effort.
  if (notify.shouldNotify(s)) {
    try { await notify.notifyCompleted({ brain: artifacts.brain, score: artifacts.score, sessionToken: s.sessionToken }); }
    catch (e) { console.error('[discovery:notify]', e && e.message); }
  }

  return res.status(200).json({
    ok: true,
    businessBrainValid: valid.valid,
    completeness: artifacts.brain.completeness,
    scopeClass: artifacts.score.classification,
    humanReviewRequired: artifacts.proposal.human_review_required,
    priceGatePassed: artifacts.proposal.price_gate_passed,
  });
};

module.exports.buildArtifacts = buildArtifacts;
