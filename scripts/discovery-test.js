/* Basic end-to-end test of the deterministic discovery pipeline.
   Simulates a completed short discovery (the structured facts the
   agent would have collected) and runs the same code path that
   /api/discovery/finalize uses — WITHOUT calling OpenAI.
   Run: node scripts/discovery-test.js
*/
const assert = require('assert');
const { buildArtifacts } = require('../api/discovery/finalize');
const store = require('../lib/discovery/store');
const { containsFinalPrice } = require('../lib/discovery/proposal');

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); console.log('PASS  ' + name); pass++; } catch (e) { console.log('FAIL  ' + name + ' -> ' + e.message); fail++; } }

// --- sample "collected" brain (multi-business, realistic) ---
const partial = {
  client_name: 'Gabi',
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

// --- storage roundtrip (file fallback, no KV needed) ---
(async () => {
  check('store: session create + save + get roundtrip', () => {});
  const s = store.newSession('gabi');
  s.brainPartial = partial;
  await store.save(s);
  const got = await store.get(s.sessionToken);
  check('store roundtrip returns same token', () => assert.strictEqual(got.sessionToken, s.sessionToken));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('scope class: ' + A.score.classification + ' | completeness: ' + A.brain.completeness);
  console.log('blueprint phases: ' + A.blueprint.components.map(c => c.component + '=P' + c.phase).join(', '));
  process.exit(fail ? 1 : 0);
})();
