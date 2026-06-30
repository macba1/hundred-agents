/* GET /api/discovery/livetest?key=<DISCOVERY_ADMIN_TOKEN>&run=1
   TEMPORARY admin-only live smoke test. Runs the REAL Discovery Agent
   pipeline (same message/finalize handlers, real OPENAI_API_KEY, real
   Redis) against a clearly-marked test session, verifies behavior, then
   deletes the test session. Not public: requires the admin token AND an
   explicit run=1 flag. Remove this file after testing.

   Never exposes secrets. Returns a structured PASS/FAIL report. */
const store = require('../../lib/discovery/store');
const messageHandler = require('./message');
const finalizeHandler = require('./finalize');

const TEST_EMAIL = 'test-gabi-live@example.com';
const MSGS = [
  'Tengo varios negocios: glamping, terrenos y recicladora. También estoy viendo si incluir hangares. Me llegan preguntas por WhatsApp e Instagram y quiero ordenar mejor los leads.',
  'El canal más importante ahora mismo es WhatsApp. Quiero empezar con glamping y terrenos. Mi email es ' + TEST_EMAIL + '.',
  'No tengo más preguntas, podemos cerrar.',
];
const PRICE_RE = /(\$|usd|mxn|eur|€|£)\s?\d|[\d.,]\s?(usd|mxn|eur|pesos|d[oó]lares|dollars)|\/\s?mes|al mes|per month|setup fee/i;

function authed(req) {
  const want = process.env.DISCOVERY_ADMIN_TOKEN;
  if (!want) return false;
  const got = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || (req.query && req.query.key) || '';
  return got && got === want;
}
function mockRes() { const r = { code: 0, body: null }; r.setHeader = () => {}; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; }

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'method_not_allowed' }); }
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!(req.query && req.query.run === '1')) return res.status(400).json({ error: 'add run=1 to execute the live test' });
  if (!process.env.OPENAI_API_KEY) return res.status(502).json({ error: 'no_openai_key' });

  const rd = store.ready();
  if (!rd.ok) return res.status(503).json({ error: 'durable_storage_unconfigured' });

  let token = null;
  const replies = [];
  try {
    // start a fresh session directly (skip the start handler greeting noise)
    const s = store.newSession('gabi');
    s.transcript.push({ role: 'assistant', content: '[livetest greeting]', ts: new Date().toISOString() });
    await store.save(s);
    token = s.sessionToken;

    // run real model turns through the real message handler
    for (const m of MSGS) {
      const r = mockRes();
      await messageHandler({ method: 'POST', headers: {}, query: {}, body: { sessionToken: token, message: m } }, r);
      if (r.code !== 200) return res.status(200).json({ ok: false, stage: 'message', code: r.code, body: r.body, replies });
      replies.push((r.body && r.body.reply) || '');
    }

    // confirm Redis persistence mid-flight
    const mid = await store.get(token);
    const persisted = !!(mid && mid.transcript && mid.transcript.filter((x) => x.role === 'user').length === MSGS.length);

    // finalize through the real handler (real compile pass)
    const rf = mockRes();
    await finalizeHandler({ method: 'POST', headers: {}, query: {}, body: { sessionToken: token } }, rf);

    const done = await store.get(token);
    const a = (done && done.artifacts) || {};
    const brain = a.brain || {}; const proposal = a.proposal || {};
    const email = brain.client_contact && brain.client_contact.email;
    const anyPrice = replies.some((t) => PRICE_RE.test(t));
    const mentionsEmail = replies.some((t) => /email|correo|propuesta|proposal/i.test(t));

    const checks = {
      model_responses_relevant: replies.every((t) => t && t.length > 15) && replies.length === MSGS.length,
      redis_persisted: persisted,
      email_captured: email === TEST_EMAIL,
      no_final_price_in_chat: !anyPrice,
      mentions_proposal_by_email: mentionsEmail,
      finalize_ok: rf.code === 200 && rf.body && rf.body.ok === true,
      business_brain_exists: !!a.brain,
      scope_score_exists: !!a.score,
      agent_blueprint_exists: !!a.blueprint,
      proposal_draft_exists: !!a.proposal,
      human_review_required: proposal.human_review_required === true,
      delivery_method_email: proposal.delivery_method === 'email',
      price_gate_passed: proposal.price_gate_passed === true,
    };
    const allPass = Object.values(checks).every(Boolean);

    // cleanup: delete the test session (no test pollution)
    let cleaned = false;
    try { await store.del(token); cleaned = (await store.get(token)) === null; } catch {}

    return res.status(200).json({
      ok: allPass,
      model_exercised: true,
      mode: rd.mode,
      checks,
      scope_class: a.score && a.score.classification,
      finalize: rf.body,
      sample_replies: replies.map((t) => (t || '').slice(0, 180)),
      test_session_deleted: cleaned,
    });
  } catch (err) {
    if (token) { try { await store.del(token); } catch {} }
    return res.status(502).json({ ok: false, error: (err && err.code) || 'error', message: err && err.message, replies });
  }
};
