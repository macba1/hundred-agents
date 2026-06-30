/* Basic end-to-end test of the deterministic discovery pipeline.
   Simulates a completed short discovery (the structured facts the
   agent would have collected) and runs the same code path that
   /api/discovery/finalize uses — WITHOUT calling OpenAI.
   Run: node scripts/discovery-test.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const finalizeHandler = require('../api/discovery/finalize');
const { buildArtifacts } = finalizeHandler;
const store = require('../lib/discovery/store');
const { containsFinalPrice } = require('../lib/discovery/proposal');
const { GREETING, FINAL_MESSAGE } = require('../lib/discovery/prompts');

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); console.log('PASS  ' + name); pass++; } catch (e) { console.log('FAIL  ' + name + ' -> ' + e.message); fail++; } }

// --- sample "collected" brain (multi-business, realistic) ---
const partial = {
  client_name: 'Gabi',
  client_contact: { name: 'Gabi', email: 'gabi@negocios.com', phone: '4491234567', preferred_contact_method: 'email' },
  business_lines: [
    { name: 'Glamping', status: 'active', one_line: 'Cabañas/tiendas premium' , customer_type: 'turistas' },
    { name: 'Terrenos', status: 'active', one_line: 'Venta de lotes' , customer_type: 'inversionistas' },
    { name: 'Recicladora', status: 'active' },
    { name: 'Hangares', status: 'seasonal' },
  ],
  priority_businesses: [
    { name: 'Glamping', rank: 1, reason: 'mayor ingreso y más mensajes' },
    { name: 'Terrenos', rank: 2, reason: 'tickets altos' },
  ],
  current_channels: [
    { channel: 'whatsapp', volume: 'high', owner_today: 'Gabi', response_time_today: 'horas' },
    { channel: 'instagram', volume: 'medium', owner_today: 'asistente' },
    { channel: 'facebook', volume: 'low' },
  ],
  desired_channels: ['whatsapp', 'instagram', 'facebook', 'web'],
  pain_points: [{ description: 'Se pierden mensajes de noche', business: 'Glamping', severity: 'high' }],
  business_unit_details: [
    { business: 'Glamping', sells: 'estancias', what_ai_should_answer: ['precios rango', 'qué incluye'], what_ai_must_not_answer: ['confirmar disponibilidad'], knowledge_readiness: 'scattered' },
    { business: 'Terrenos', sells: 'lotes', knowledge_readiness: 'none' },
  ],
  faqs_by_business: [{ business: 'Glamping', faqs: [{ question: '¿Qué incluye?', answer_known: true }] }],
  lead_capture_fields_by_business: [
    { business: 'Glamping', fields: [{ field: 'nombre', required: true }, { field: 'fechas', required: true }, { field: 'personas', required: true }, { field: 'presupuesto', required: false }, { field: 'teléfono', required: true }], qualification_signals: ['fechas concretas'], lead_destination_today: 'WhatsApp' },
    { business: 'Terrenos', fields: [{ field: 'nombre', required: true }, { field: 'teléfono', required: true }] },
  ],
  escalation_rules: [
    { business: 'Glamping', trigger: 'quiere reservar', handoff_to: 'Gabi', channel: 'whatsapp', hours: '9-18' },
    { business: 'Terrenos', trigger: 'pide precio o legal', handoff_to: 'vendedor', channel: 'whatsapp', hours: '24/7' },
  ],
  do_not_say_rules: [{ scope: 'business', business: 'Terrenos', rule: 'No prometer retornos de inversión en terrenos' }],
  integrations: [{ tool: 'WhatsApp Business', use: 'mensajes', access_owner: 'Gabi', integration_appetite: 'read_write' }],
  source_materials_available: [{ type: 'price_list', business: 'Glamping', provided: false }],
  success_criteria: [{ statement: 'responder 24/7 y no perder leads', metric: 'leads por semana', timeframe: '90 días' }],
  phasing_preference: { appetite: 'start_small', timeline: '1-2 meses', budget_posture: 'moderate', content_owner: 'Gabi' },
};

const A = buildArtifacts(partial, '2026-06-30T00:00:00.000Z');

check('Business Brain is valid', () => assert.ok(A.brain && A.brain.client_name === 'Gabi'));
check('do-not-say defaults injected (price/availability/land)', () => {
  const txt = A.brain.do_not_say_rules.map(r => r.rule.toLowerCase()).join(' ');
  assert.ok(/price/.test(txt) && /availab/.test(txt) && /(land|terreno)/.test(txt));
});
check('completeness computed (0..1)', () => assert.ok(A.brain.completeness > 0 && A.brain.completeness <= 1));
check('Scope Score has 8 dimensions', () => assert.strictEqual(Object.keys(A.score.dimensions).length, 8));
check('Scope Score classification present', () => assert.ok(['Starter Pilot','Multi-Business MVP','Full Agentic Desk'].includes(A.score.classification)));
check('risk override fires for terrenos/land', () => assert.ok(A.score.dimensions.risk === 5));
check('4 business lines -> Full Agentic Desk (override)', () => assert.strictEqual(A.score.classification, 'Full Agentic Desk'));
check('Agent Blueprint NOT all phase 1', () => {
  const phases = new Set(A.blueprint.components.map(c => c.phase));
  assert.ok(phases.size > 1, 'expected multiple phases, got ' + [...phases]);
});
check('Blueprint includes Terrenos Agent with risk note', () => {
  const t = A.blueprint.components.find(c => /Terrenos/.test(c.component));
  assert.ok(t && /invest|legal/i.test(t.risk_notes || ''));
});
check('Blueprint includes Human Escalation Agent in phase 1', () => {
  const h = A.blueprint.components.find(c => c.component === 'Human Escalation Agent');
  assert.ok(h && h.phase === 1);
});
check('Proposal Draft has all required sections', () => {
  ['executive_summary','recommended_phase_1','recommended_phase_2','recommended_phase_3','included','not_included','required_materials_from_gabi','open_questions','suggested_pricing_tier','monthly_maintenance_recommendation','risks_and_dependencies','human_review_required']
    .forEach(k => assert.ok(k in A.proposal, 'missing ' + k));
});
check('Proposal: human_review_required is true', () => assert.strictEqual(A.proposal.human_review_required, true));
check('Proposal: NO final price sent (gate passed, tier is a band label)', () => {
  assert.strictEqual(A.proposal.price_gate_passed, true);
  assert.ok(/tier/i.test(A.proposal.suggested_pricing_tier));
  assert.ok(!containsFinalPrice(A.proposal.executive_summary));
});
check('price detector catches a real amount', () => {
  assert.ok(containsFinalPrice('Costará $5,000 USD'));
  assert.ok(containsFinalPrice('45000 MXN al mes'));
  assert.ok(!containsFinalPrice('Starter Pilot tier'));
});

// --- email capture / delivery ---
check('email captured into Business Brain (client_contact.email)', () => {
  assert.strictEqual(A.brain.client_contact.email, 'gabi@negocios.com');
});
check('Proposal includes email delivery', () => {
  assert.strictEqual(A.proposal.client_email, 'gabi@negocios.com');
  assert.strictEqual(A.proposal.delivery_method, 'email');
  assert.ok(/review/i.test(A.proposal.final_pricing_note));
});
check('missing_information flags email when absent', () => {
  const noEmail = buildArtifacts({ client_name: 'X', business_lines: [{ name: 'A', status: 'active' }] }, '2026-06-30T00:00:00.000Z');
  assert.ok(noEmail.brain.missing_information.some((m) => m.field === 'client_contact.email' && m.blocking === true));
});

// --- client-facing copy: positive framing, no defensive wording, no prices ---
const HTML = fs.readFileSync(path.join(__dirname, '..', 'discovery', 'gabi', 'index.html'), 'utf8');
const DEFENSIVE = /(no se env[ií]an precios|sin precios autom[aá]ticos|no automatic prices|won'?t show.*price|sin precios|no price)/i;
check('final message says proposal is sent by email', () => {
  assert.ok(/email/i.test(FINAL_MESSAGE) && /propuesta/i.test(FINAL_MESSAGE));
});
check('greeting frames email proposal positively', () => {
  assert.ok(/email/i.test(GREETING) && /propuesta/i.test(GREETING));
});
check('client-facing copy has NO defensive "no prices" wording (HTML)', () => {
  assert.ok(!DEFENSIVE.test(HTML), 'defensive wording found in index.html');
});
check('client-facing copy has NO defensive wording (greeting/final)', () => {
  assert.ok(!DEFENSIVE.test(GREETING + ' ' + FINAL_MESSAGE));
});
check('client-facing copy shows no final price ($/amount)', () => {
  assert.ok(!containsFinalPrice(HTML + ' ' + GREETING + ' ' + FINAL_MESSAGE));
});

// --- storage roundtrip (file fallback, no KV needed) ---
(async () => {
  check('store: session create + save + get roundtrip', () => {});
  const s = store.newSession('gabi');
  s.brainPartial = partial;
  await store.save(s);
  const got = await store.get(s.sessionToken);
  check('store roundtrip returns same token', () => assert.strictEqual(got.sessionToken, s.sessionToken));

  // finalize handler: blocked when email missing, succeeds when present (no OpenAI key -> compile skipped)
  function mockRes() { const r = { code: 0, body: null }; r.setHeader = () => {}; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; }
  delete process.env.OPENAI_API_KEY; // force deterministic, no compile

  const sNo = store.newSession('gabi'); sNo.brainPartial = { client_name: 'Gabi', business_lines: [{ name: 'Glamping', status: 'active' }] }; await store.save(sNo);
  let r1 = mockRes(); await finalizeHandler({ method: 'POST', body: { sessionToken: sNo.sessionToken } }, r1);
  check('finalize BLOCKED when email missing (400 email_required)', () => { assert.strictEqual(r1.code, 400); assert.strictEqual(r1.body.error, 'email_required'); });

  const sYes = store.newSession('gabi'); sYes.brainPartial = { client_name: 'Gabi', client_contact: { email: 'gabi@negocios.com' }, business_lines: [{ name: 'Glamping', status: 'active' }] }; await store.save(sYes);
  let r2 = mockRes(); await finalizeHandler({ method: 'POST', body: { sessionToken: sYes.sessionToken } }, r2);
  check('finalize SUCCEEDS with email (200, no price, human review)', () => {
    assert.strictEqual(r2.code, 200);
    assert.strictEqual(r2.body.ok, true);
    assert.strictEqual(r2.body.humanReviewRequired, true);
    assert.strictEqual(r2.body.priceGatePassed, true);
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('scope class: ' + A.score.classification + ' | completeness: ' + A.brain.completeness);
  console.log('blueprint phases: ' + A.blueprint.components.map(c => c.component + '=P' + c.phase).join(', '));
  process.exit(fail ? 1 : 0);
})();
