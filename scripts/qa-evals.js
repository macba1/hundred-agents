/* ============================================================
   Gabi Discovery Agent — QA / Evals suite.
   Runs the 20 required scenarios against the REAL pipeline
   (brain -> score -> blueprint -> proposal, real handlers,
   file-backed store standing in for Redis). Structural +
   guardrail-presence assertions. Model-behavioral guardrails
   (price/ROI/legal/availability/auto-close) are enforced by the
   system prompt + do_not_say defaults; this suite asserts those
   are present and that finalized artifacts honor them. One live
   model run was verified separately (livetest, 13/13).
   Run: node scripts/qa-evals.js
   ============================================================ */
const assert = require('assert');
const { buildArtifacts } = require('../api/discovery/finalize');
const finalizeHandler = require('../api/discovery/finalize');
const adminHandler = require('../api/discovery/admin');
const brainLib = require('../lib/discovery/brain');
const store = require('../lib/discovery/store');
const { containsFinalPrice } = require('../lib/discovery/proposal');
const { SYSTEM, GREETING, FINAL_MESSAGE } = require('../lib/discovery/prompts');

const NOW = '2026-06-30T00:00:00.000Z';
const results = [];
function mockRes() { const r = { code: 0, body: null }; r.setHeader = () => {}; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; }

async function T(id, name, scenario, fn) {
  try { await fn(); results.push({ id, name, scenario, result: 'PASS', severity: '', fix: '' }); }
  catch (e) { results.push({ id, name, scenario, result: 'FAIL', severity: e.severity || 'high', fix: e.message }); }
}

// shared assertions on a finalized artifact set
function assertCommon(A) {
  assert.ok(brainLib.validate(A.brain).valid, 'Business Brain invalid');
  assert.strictEqual(A.proposal.human_review_required, true, 'human_review_required not true');
  assert.strictEqual(A.proposal.delivery_method, 'email', 'delivery_method not email');
  assert.strictEqual(A.proposal.price_gate_passed, true, 'price gate failed');
  assert.ok(/tier/i.test(A.proposal.suggested_pricing_tier), 'pricing tier is not a band label');
  assert.ok(!containsFinalPrice(A.proposal.executive_summary), 'final price in exec summary');
  const dns = A.brain.do_not_say_rules.map((r) => r.rule.toLowerCase()).join(' ');
  assert.ok(/price/.test(dns) && /availab/.test(dns) && /(land|terreno)/.test(dns) && /legal/.test(dns) && /close|cierr/.test(dns), 'do_not_say defaults incomplete');
}
function noSecrets(obj) {
  const s = JSON.stringify(obj);
  assert.ok(!/[a-f0-9]{64}/i.test(s), 'possible token/secret in output');
  assert.ok(!/OPENAI_API_KEY|NOTION_TOKEN|REDIS_URL|sk-[A-Za-z0-9]/.test(s), 'env secret in output');
}

const base = (extra) => Object.assign({
  client_name: 'Gabi',
  client_contact: { email: 'gabi@negocios.com' },
  business_lines: [{ name: 'Glamping', status: 'active' }],
}, extra);

(async () => {
  // 1
  await T('01', 'Four confirmed businesses', 'glamping+terrenos+recicladora+hangares', () => {
    const A = buildArtifacts(base({ business_lines: ['Glamping', 'Terrenos', 'Recicladora', 'Hangares'].map((n) => ({ name: n, status: 'active' })) }), NOW);
    assertCommon(A);
    assert.strictEqual(A.score.classification, 'Full Agentic Desk', 'expected Full Agentic Desk for 4 lines');
    ['Glamping Agent', 'Terrenos Agent', 'Recicladora Agent', 'Hangares Agent'].forEach((c) => assert.ok(A.blueprint.components.some((x) => x.component === c), 'missing ' + c));
  });

  // 2
  await T('02', 'Unknown additional business', 'Gabi reveals a new line not previously known', () => {
    const A = buildArtifacts(base({ business_lines: [{ name: 'Glamping', status: 'active' }, { name: 'Lavandería', status: 'active' }] }), NOW);
    assertCommon(A);
    assert.ok(A.brain.business_lines.some((b) => b.name === 'Lavandería'), 'new business not captured');
    assert.ok(A.blueprint.components.some((c) => /Lavander/.test(c.component)), 'no agent for new business');
  });

  // 3
  await T('03', 'Wants everything day one', 'all businesses + all channels immediately', () => {
    const A = buildArtifacts(base({
      business_lines: ['Glamping', 'Terrenos', 'Recicladora', 'Hangares'].map((n) => ({ name: n, status: 'active' })),
      desired_channels: ['whatsapp', 'instagram', 'facebook', 'web'],
      phasing_preference: { appetite: 'all_at_once' },
    }), NOW);
    assertCommon(A);
    const phases = new Set(A.blueprint.components.map((c) => c.phase));
    assert.ok(phases.size > 1, 'blueprint should still recommend phasing, not all phase 1');
    assert.ok((A.proposal.recommended_phase_2.components.length + A.proposal.recommended_phase_3.components.length) > 0, 'no later phases proposed');
  });

  // 4
  await T('04', 'Vague answers', '"I want AI to answer everything"', () => {
    const A = buildArtifacts({ client_name: 'Gabi', client_contact: { email: 'g@x.com' }, business_lines: [{ name: 'Glamping', status: 'unsure' }] }, NOW);
    assert.ok(A.brain.missing_information.length >= 3, 'vague input should leave missing_information');
    assert.ok(A.brain.completeness < 0.6, 'completeness should be low for vague input');
    // no invented specifics
    assert.ok(!(A.brain.business_unit_details || []).some((d) => /\d{2}:\d{2}|calle |\$\d/i.test(JSON.stringify(d))), 'invented specifics found');
    assert.ok(/progress|one topic|progressive|vague|missing|don't invent|never invent/i.test(SYSTEM), 'prompt lacks progressive/no-invent guidance');
  });

  // 5
  await T('05', 'Skips email', 'finalization blocked without email', async () => {
    const s = store.newSession('gabi'); s.brainPartial = { client_name: 'Gabi', business_lines: [{ name: 'Glamping', status: 'active' }] }; await store.save(s);
    delete process.env.OPENAI_API_KEY;
    const r = mockRes(); await finalizeHandler({ method: 'POST', headers: {}, query: {}, body: { sessionToken: s.sessionToken } }, r);
    assert.strictEqual(r.code, 400, 'finalize should block without email'); assert.strictEqual(r.body.error, 'email_required');
    const A = buildArtifacts(s.brainPartial, NOW);
    assert.ok(A.brain.missing_information.some((m) => m.field === 'client_contact.email' && m.blocking), 'email not flagged blocking');
    await store.del(s.sessionToken);
  });

  // 6
  await T('06', 'Provides email', 'email captured + finalize succeeds', async () => {
    const s = store.newSession('gabi'); s.brainPartial = base(); await store.save(s);
    delete process.env.OPENAI_API_KEY;
    const r = mockRes(); await finalizeHandler({ method: 'POST', headers: {}, query: {}, body: { sessionToken: s.sessionToken } }, r);
    assert.strictEqual(r.code, 200, 'finalize should succeed with email'); assert.strictEqual(r.body.ok, true);
    const done = await store.get(s.sessionToken);
    assert.strictEqual(done.artifacts.brain.client_contact.email, 'gabi@negocios.com');
    await store.del(s.sessionToken);
  });

  // 7
  await T('07', 'Asks the cost', 'no final price; says proposal by email', () => {
    const A = buildArtifacts(base(), NOW);
    assert.strictEqual(A.proposal.price_gate_passed, true);
    assert.ok(/PRICING/i.test(SYSTEM) && /do NOT state a final/i.test(SYSTEM), 'prompt lacks pricing guardrail');
    assert.ok(/email/i.test(FINAL_MESSAGE) && /propuesta/i.test(FINAL_MESSAGE), 'final message lacks email framing');
  });

  // 8
  await T('08', 'Asks about availability', 'never confirm availability w/o integration', () => {
    const A = buildArtifacts(base(), NOW);
    assert.ok(A.brain.do_not_say_rules.some((r) => /availab/i.test(r.rule)), 'no availability do-not-say');
    assert.ok(/AVAILABILITY/i.test(SYSTEM) && /cannot confirm/i.test(SYSTEM), 'prompt lacks availability guardrail');
  });

  // 9
  await T('09', 'No booking system connected', 'inform-only; cannot confirm bookings', () => {
    const A = buildArtifacts(base({ integrations: [{ tool: 'WhatsApp', integration_appetite: 'inform_only' }] }), NOW);
    assertCommon(A);
    assert.strictEqual(A.score.dimensions.integration, 1, 'inform-only should score integration low');
    assert.ok(A.brain.do_not_say_rules.some((r) => /availab/i.test(r.rule)));
  });

  // 10
  await T('10', 'Land ROI / appreciation', 'never promise ROI/appreciation/legal on land', () => {
    const A = buildArtifacts(base({ do_not_say_rules: [{ scope: 'business', business: 'Terrenos', rule: 'No prometer plusvalía' }] }), NOW);
    const dns = A.brain.do_not_say_rules.map((r) => r.rule.toLowerCase()).join(' ');
    assert.ok(/(roi|return|appreciat|invest)/.test(dns) && /(land|terreno)/.test(dns), 'land ROI guardrail missing');
    assert.ok(/LAND \/ TERRENOS/i.test(SYSTEM) && /appreciation, ROI/i.test(SYSTEM), 'prompt lacks land guardrail');
    assert.strictEqual(A.score.dimensions.risk, 5, 'land should score risk 5');
  });

  // 11
  await T('11', 'Prices change frequently', 'still no quote', () => {
    const A = buildArtifacts(base(), NOW);
    assert.ok(A.brain.do_not_say_rules.some((r) => /price/i.test(r.rule)));
    assert.ok(/prices change/i.test(SYSTEM), 'prompt lacks frequent-price-change note');
  });

  // 12
  await T('12', 'WhatsApp first only', 'single channel scope', () => {
    const A = buildArtifacts(base({ current_channels: [{ channel: 'whatsapp', volume: 'high' }], desired_channels: ['whatsapp'] }), NOW);
    assertCommon(A);
    assert.strictEqual(A.score.dimensions.channels, 1, 'single channel should score 1');
  });

  // 13
  await T('13', 'Instagram + Facebook first', 'multi-channel scope', () => {
    const A = buildArtifacts(base({ current_channels: [{ channel: 'instagram' }, { channel: 'facebook' }], desired_channels: ['instagram', 'facebook'] }), NOW);
    assertCommon(A);
    assert.ok(A.score.dimensions.channels >= 3, 'two+ channels should raise channel score');
  });

  // 14
  await T('14', 'No CRM', 'no invented CRM; integration low', () => {
    const A = buildArtifacts(base({ integrations: [] }), NOW);
    assertCommon(A);
    assert.strictEqual(A.score.dimensions.integration, 1);
    assert.strictEqual((A.brain.integrations || []).length, 0, 'should not invent a CRM');
  });

  // 15
  await T('15', 'Uses HighLevel CRM', 'integration captured, scores higher', () => {
    const A = buildArtifacts(base({ integrations: [{ tool: 'HighLevel', use: 'CRM', integration_appetite: 'read_write' }] }), NOW);
    assertCommon(A);
    assert.ok(A.brain.integrations.some((i) => /highlevel/i.test(i.tool)), 'CRM not captured');
    assert.strictEqual(A.score.dimensions.integration, 5, 'read_write CRM should score 5');
  });

  // 16
  await T('16', 'Abandon + resume', 'durable resume of partial session', async () => {
    const s = store.newSession('gabi');
    s.transcript.push({ role: 'user', content: 'tengo glamping' });
    s.brainPartial = { client_name: 'Gabi', business_lines: [{ name: 'Glamping', status: 'active' }] };
    await store.save(s);
    const resumed = await store.get(s.sessionToken);
    assert.ok(resumed && resumed.status === 'active' && resumed.transcript.length === 1, 'resume failed');
    assert.ok(resumed.brainPartial.business_lines.length === 1, 'partial brain not persisted');
    await store.del(s.sessionToken);
  });

  // 17
  await T('17', 'Conflicting information', 'pipeline stays valid; gaps tracked', () => {
    // conflict: priority says Glamping but only Terrenos detailed -> still valid, missing tracked
    const A = buildArtifacts(base({ priority_businesses: [{ name: 'Glamping', rank: 1 }], business_unit_details: [{ business: 'Terrenos' }] }), NOW);
    assert.ok(brainLib.validate(A.brain).valid);
    assert.ok(A.brain.missing_information.length >= 1, 'gaps from conflict not tracked');
    assert.ok(/never invent|don't invent/i.test(SYSTEM), 'prompt lacks no-invent rule for conflicts');
  });

  // 18
  await T('18', 'Auto-close sales', 'AI does not close sales automatically', () => {
    const A = buildArtifacts(base(), NOW);
    assert.ok(A.brain.do_not_say_rules.some((r) => /close|cierr/i.test(r.rule)), 'no auto-close guardrail');
    assert.ok(/AUTO-CLOSE/i.test(SYSTEM) && /human-approval/i.test(SYSTEM), 'prompt lacks auto-close guardrail');
  });

  // 19
  await T('19', 'Legal / contract questions', 'no legal advice; route to human', () => {
    const A = buildArtifacts(base(), NOW);
    assert.ok(A.brain.do_not_say_rules.some((r) => /legal/i.test(r.rule)), 'no legal guardrail');
    assert.ok(/LEGAL/i.test(SYSTEM) && /Route legal/i.test(SYSTEM), 'prompt lacks legal guardrail');
  });

  // 20
  await T('20', 'Full discovery completes', 'all internal outputs + admin access + no secrets', async () => {
    const s = store.newSession('gabi');
    s.brainPartial = base({
      business_lines: ['Glamping', 'Terrenos', 'Recicladora'].map((n) => ({ name: n, status: 'active' })),
      priority_businesses: [{ name: 'Glamping', rank: 1 }],
      current_channels: [{ channel: 'whatsapp', volume: 'high' }],
      success_criteria: [{ statement: 'no perder leads', metric: 'leads/semana' }],
    });
    await store.save(s);
    delete process.env.OPENAI_API_KEY;
    const rf = mockRes(); await finalizeHandler({ method: 'POST', headers: {}, query: {}, body: { sessionToken: s.sessionToken } }, rf);
    assert.strictEqual(rf.code, 200);
    const done = await store.get(s.sessionToken);
    const A = done.artifacts;
    assert.ok(A.brain && A.score && A.blueprint && A.proposal, 'missing an artifact');
    assertCommon(A);
    noSecrets(A);
    // admin accessible with token, rejected without
    process.env.DISCOVERY_ADMIN_TOKEN = 'qa-token';
    const ra = mockRes(); await adminHandler({ method: 'GET', headers: { authorization: 'Bearer qa-token' }, query: { s: s.sessionToken } }, ra);
    assert.strictEqual(ra.code, 200, 'admin should retrieve with token');
    assert.ok(ra.body.artifacts.proposal.human_review_required === true);
    noSecrets(ra.body);
    const ru = mockRes(); await adminHandler({ method: 'GET', headers: {}, query: {} }, ru);
    assert.strictEqual(ru.code, 401, 'admin should reject without token');
    await store.del(s.sessionToken);
  });

  // ---- report ----
  const pass = results.filter((r) => r.result === 'PASS').length;
  const fail = results.filter((r) => r.result === 'FAIL').length;
  console.log('\nID | Result | Scenario | (fix if failed)');
  console.log('---+--------+----------+----------------');
  results.forEach((r) => console.log(`${r.id} | ${r.result.padEnd(4)} | ${r.name}${r.result === 'FAIL' ? '  [' + r.severity + '] ' + r.fix : ''}`));
  console.log(`\n${pass}/${results.length} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
