/* POST /api/discovery/finalize — compile Business Brain from the
   transcript, then derive Scope Score, Agent Blueprint and the
   internal Proposal Draft. Persists artifacts on the session.
   Never sends anything to Gabi; output is for human review. */
const store = require('../../lib/discovery/store');
const brainLib = require('../../lib/discovery/brain');
const { scoreBrain } = require('../../lib/discovery/score');
const { buildBlueprint } = require('../../lib/discovery/blueprint');
const { buildProposal } = require('../../lib/discovery/proposal');
const { COMPILE_SYSTEM, UPDATE_BRAIN_TOOL } = require('../../lib/discovery/prompts');

const MODEL = 'gpt-4o-mini';

async function callOpenAI(payload, key) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!r.ok) throw { code: 'upstream', status: r.status, detail: await r.text().catch(() => '') };
  return r.json();
}

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
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } } body = body || {};

  let s;
  try { s = await store.get(body.sessionToken); } catch (e) { return res.status(503).json({ error: 'store_unavailable' }); }
  if (!s) return res.status(404).json({ error: 'session_not_found' });

  let partial = s.brainPartial || {};

  // Optional LLM compile pass to fill gaps from the full transcript.
  const key = process.env.OPENAI_API_KEY;
  if (key && s.transcript && s.transcript.length) {
    try {
      const convo = s.transcript.map((m) => `${m.role}: ${m.content}`).join('\n');
      const out = await callOpenAI({
        model: MODEL,
        messages: [{ role: 'system', content: COMPILE_SYSTEM }, { role: 'user', content: 'Transcript:\n' + convo }],
        tools: [UPDATE_BRAIN_TOOL], tool_choice: { type: 'function', function: { name: 'update_brain' } },
        temperature: 0.1, max_tokens: 1500,
      }, key);
      const tc = out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.tool_calls && out.choices[0].message.tool_calls[0];
      if (tc) { let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch {} partial = brainLib.mergePartial(partial, args); }
    } catch (e) {
      // compile is best-effort; fall back to the incrementally-collected partial
      console.error('[discovery:finalize:compile]', e && e.code, e && e.detail);
    }
  }

  const nowISO = new Date().toISOString();
  const artifacts = buildArtifacts(partial, nowISO);
  const valid = brainLib.validate(artifacts.brain);

  s.brainPartial = partial;
  s.artifacts = artifacts;
  s.status = 'finalized';
  s.finalizedAt = nowISO;
  try { await store.save(s); } catch (e) { return res.status(502).json({ error: 'store_unavailable_on_save' }); }

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
