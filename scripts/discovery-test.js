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
const healthHandler = require('../api/discovery/health');
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

// UX: finalize processing feedback + success/error copy
check('Terminar shows immediate processing copy', () => {
  assert.ok(HTML.includes('Estamos enviando tus respuestas al equipo de Hundred Agents.'), 'missing processing line 1');
  assert.ok(HTML.includes('te enviaremos por email una propuesta de implantación y comercial con precios cuando esté lista.'), 'missing processing line 2');
  assert.ok(HTML.includes('Esto puede tardar unos segundos. Por favor, no cierres esta página todavía.'), 'missing secondary note');
});
check('final success copy is the email-proposal message', () => {
  assert.ok(HTML.includes('Hemos recibido tus respuestas. El equipo de Hundred Agents las revisará'), 'missing success copy');
});
check('finalize failure shows friendly error copy', () => {
  assert.ok(HTML.includes('No hemos podido completar el envío.') && /info@thehagentic\.com/.test(HTML), 'missing friendly error');
});
check('finish() no longer shows infinite typing indicator', () => {
  const fn = HTML.slice(HTML.indexOf('async function finish('), HTML.indexOf('function finishUI('));
  assert.ok(!/typing\(true\)/.test(fn), 'finish still calls typing(true)');
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

  // ---------- storage mode selection (env-aware, durable enforcement) ----------
  function withEnv(env, fn) {
    const snap = {}; Object.keys(env).forEach((k) => { snap[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; });
    try { return fn(); } finally { Object.keys(snap).forEach((k) => { if (snap[k] === undefined) delete process.env[k]; else process.env[k] = snap[k]; }); }
  }
  async function withEnvAsync(env, fn) {
    const snap = {}; Object.keys(env).forEach((k) => { snap[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; });
    try { return await fn(); } finally { Object.keys(snap).forEach((k) => { if (snap[k] === undefined) delete process.env[k]; else process.env[k] = snap[k]; }); }
  }
  check('mode = file locally (no VERCEL_ENV, no durable env)', () => withEnv({ VERCEL_ENV: undefined, REDIS_URL: undefined, KV_REST_API_URL: undefined, KV_REST_API_TOKEN: undefined, DISCOVERY_FORCE_FILE: undefined }, () => {
    const r = store.ready(); assert.strictEqual(r.mode, 'file'); assert.strictEqual(r.ok, true);
  }));
  check('preview/prod WITHOUT durable backend fails safely (unconfigured + clear message)', () => withEnv({ VERCEL_ENV: 'preview', REDIS_URL: undefined, KV_REST_API_URL: undefined, KV_REST_API_TOKEN: undefined, DISCOVERY_FORCE_FILE: undefined }, () => {
    const r = store.ready();
    assert.strictEqual(r.ok, false); assert.strictEqual(r.mode, 'unconfigured');
    assert.ok(/REDIS_URL/.test(r.error) && /KV_REST_API_URL/.test(r.error));
    assert.throws(() => store.assertReady(), (e) => e.code === 'durable_storage_unconfigured');
  }));
  check('REDIS_URL detected in preview/prod selects durable redis mode', () => withEnv({ VERCEL_ENV: 'production', REDIS_URL: 'redis://example:6379', KV_REST_API_URL: undefined, KV_REST_API_TOKEN: undefined }, () => {
    const r = store.ready(); assert.strictEqual(r.mode, 'redis'); assert.strictEqual(r.ok, true);
  }));
  check('production WITH KV (no REDIS_URL) still selects kv mode', () => withEnv({ VERCEL_ENV: 'production', REDIS_URL: undefined, KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 'tok' }, () => {
    assert.strictEqual(store.ready().mode, 'kv');
  }));
  check('REDIS_URL takes priority over KV when both present', () => withEnv({ VERCEL_ENV: 'production', REDIS_URL: 'redis://example:6379', KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 'tok' }, () => {
    assert.strictEqual(store.ready().mode, 'redis');
  }));

  // ---------- durable persistence roundtrip (file backend stands in for KV) ----------
  const dsess = store.newSession('gabi');
  dsess.transcript.push({ role: 'assistant', content: 'hola', ts: '2026-06-30T00:00:00.000Z' });
  dsess.brainPartial = { client_name: 'Gabi', client_contact: { email: 'gabi@negocios.com' }, business_lines: [{ name: 'Glamping', status: 'active' }] };
  await store.save(dsess);

  const resumed = await store.get(dsess.sessionToken);
  check('resume token returns the saved session + transcript', () => { assert.ok(resumed); assert.strictEqual(resumed.transcript.length, 1); });

  resumed.artifacts = buildArtifacts(resumed.brainPartial, '2026-06-30T00:00:00.000Z');
  resumed.status = 'finalized';
  await store.save(resumed);
  const done = await store.get(dsess.sessionToken);
  check('finalized Business Brain persists', () => assert.ok(done.artifacts.brain && done.artifacts.brain.client_name === 'Gabi'));
  check('Proposal Draft persists (human_review_required)', () => assert.strictEqual(done.artifacts.proposal.human_review_required, true));
  check('client_contact.email persists', () => assert.strictEqual(done.artifacts.brain.client_contact.email, 'gabi@negocios.com'));

  // admin retrieval of the completed discovery
  function mockRes2() { const r = { code: 0, body: null }; r.setHeader = () => {}; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; }
  await withEnvAsync({ DISCOVERY_ADMIN_TOKEN: 'secret' }, async () => {
    const adminHandler = require('../api/discovery/admin');
    let ra = mockRes2(); await adminHandler({ method: 'GET', headers: { authorization: 'Bearer secret' }, query: { s: dsess.sessionToken } }, ra);
    check('admin endpoint retrieves completed discovery', () => { assert.strictEqual(ra.code, 200); assert.strictEqual(ra.body.sessionToken, dsess.sessionToken); assert.ok(ra.body.artifacts.brain.client_contact.email === 'gabi@negocios.com'); });
    let ru = mockRes2(); await adminHandler({ method: 'GET', headers: {}, query: {} }, ru);
    check('admin endpoint rejects without token (401)', () => assert.strictEqual(ru.code, 401));

    // storage health check (file backend here; same code path KV uses in prod)
    let rh = mockRes2(); await healthHandler({ method: 'GET', headers: { authorization: 'Bearer secret' }, query: {} }, rh);
    check('storage health check passes (write/read/update/persist/admin/delete)', () => {
      assert.strictEqual(rh.code, 200); assert.strictEqual(rh.body.ok, true);
      ['write', 'read', 'update', 'persist_artifacts', 'admin_read', 'delete'].forEach((k) => assert.strictEqual(rh.body.steps[k], true, k));
    });
  });

  // ---------- rate limiting ----------
  const rl = require('../lib/discovery/ratelimit');
  const startHandler = require('../api/discovery/start');
  // direct helper: ok up to limit, then not ok
  let rlOk = 0;
  const unitIp = 'ip-unit-' + Date.now();
  for (let i = 0; i < 5; i++) { const r = await rl.check('unit', unitIp, 3); if (r.ok) rlOk++; }
  check('rate helper blocks after limit (3)', () => assert.strictEqual(rlOk, 3));
  // start handler 429 after start_per_ip_hour for one IP
  const ip = 'ip-start-' + Date.now();
  let codes = [];
  for (let i = 0; i < rl.LIMITS.start_per_ip_hour + 1; i++) {
    const r = mockRes2();
    await startHandler({ method: 'POST', headers: { 'x-forwarded-for': ip }, body: { clientKey: 'gabi' } }, r);
    codes.push(r.code);
  }
  check('start handler 200 within limit then 429', () => {
    assert.ok(codes.slice(0, rl.LIMITS.start_per_ip_hour).every((c) => c === 200), 'should allow up to limit');
    assert.strictEqual(codes[codes.length - 1], 429, 'should 429 over limit');
  });
  const rlResp = mockRes2();
  await startHandler({ method: 'POST', headers: { 'x-forwarded-for': ip }, body: { clientKey: 'gabi' } }, rlResp);
  check('rate-limit failure is graceful (rate_limited + friendly message)', () => {
    assert.strictEqual(rlResp.body.error, 'rate_limited'); assert.ok(/info@thehagentic\.com/.test(rlResp.body.message));
  });
  // resume (sessionToken) should bypass the start rate limit even when blocked
  const liveSess = store.newSession('gabi'); await store.save(liveSess);
  const resumeResp = mockRes2();
  await startHandler({ method: 'POST', headers: { 'x-forwarded-for': ip }, body: { clientKey: 'gabi', sessionToken: liveSess.sessionToken } }, resumeResp);
  check('resume bypasses start rate limit', () => { assert.strictEqual(resumeResp.code, 200); assert.strictEqual(resumeResp.body.resumed, true); });
  await store.del(liveSess.sessionToken);

  // ---------- test-session marking / exclusion ----------
  const sadmin = require('./session-admin');
  const adminH = require('../api/discovery/admin');

  const REAL_EMAIL = 'gabi-real@negocios.com';
  // real completed: finalized + email + not test
  const realS = store.newSession('gabi'); realS.status = 'finalized'; realS.brainPartial = { client_name: 'Gabi', client_contact: { email: REAL_EMAIL }, business_lines: [{ name: 'Glamping', status: 'active' }] }; realS.artifacts = buildArtifacts(realS.brainPartial, '2026-07-01T00:00:00.000Z'); await store.save(realS);
  // incomplete: active, no email
  const incS = store.newSession('gabi'); incS.transcript.push({ role: 'user', content: 'hola' }); await store.save(incS);
  // test: is_test (simulating the marked prod sessions incl. the two smoke emails)
  const testS = store.newSession('gabi'); testS.status = 'finalized'; testS.brainPartial = { client_name: 'Ruth', client_contact: { email: 'gabriela@gmail.com' }, business_lines: [{ name: 'Glamping', status: 'active' }] };
  testS.metadata = { is_test: true, test_reason: 'Internal test by Ruth', marked_by: 'Tony', marked_at: '2026-07-01T00:00:00.000Z' };
  await store.save(testS);
  const testProd = store.newSession('gabi'); testProd.status = 'finalized'; testProd.brainPartial = { client_contact: { email: 'test-gabi-prod@example.com' } }; testProd.metadata = { is_test: true, test_reason: 'Production smoke test', marked_by: 'Tony' }; await store.save(testProd);

  const roundtrip = await store.get(testS.sessionToken);
  check('metadata.is_test persists in store', () => assert.strictEqual(roundtrip.metadata.is_test, true));

  await withEnvAsync({ DISCOVERY_ADMIN_TOKEN: 'qa2' }, async () => {
    const r = mockRes2(); await adminH({ method: 'GET', headers: { authorization: 'Bearer qa2' }, query: {} }, r);
    const b = r.body;
    const inReal = (tok) => b.sessions.some((x) => x.sessionToken === tok);
    const inInc = (tok) => b.incompleteSessions.some((x) => x.sessionToken === tok);
    const inTest = (tok) => b.testSessions.some((x) => x.sessionToken === tok);
    check('real completed = finalized + email + not test', () => { assert.ok(inReal(realS.sessionToken)); assert.ok(!inInc(realS.sessionToken) && !inTest(realS.sessionToken)); });
    check('active/no-email session -> incomplete (not real)', () => { assert.ok(inInc(incS.sessionToken)); assert.ok(!inReal(incS.sessionToken)); });
    check('marked test sessions -> test group (not real)', () => { assert.ok(inTest(testS.sessionToken) && inTest(testProd.sessionToken)); assert.ok(!inReal(testS.sessionToken) && !inReal(testProd.sessionToken)); });
    check('review default (sessions) excludes test AND incomplete', () => { assert.ok(!inReal(testS.sessionToken) && !inReal(testProd.sessionToken) && !inReal(incS.sessionToken)); });
    check('counts present and consistent', () => {
      assert.ok(b.counts && typeof b.counts.realCompleted === 'number');
      assert.strictEqual(b.counts.realCompleted, b.sessions.length);
      assert.strictEqual(b.counts.incompleteAbandoned, b.incompleteSessions.length);
      assert.strictEqual(b.counts.testInternal, b.testSessions.length);
    });
    check('test group carries reason', () => { const t = b.testSessions.find((x) => x.sessionToken === testS.sessionToken); assert.ok(t && /Ruth/.test(t.testReason || '')); });
  });

  check('selectForPurge: only is_test + exact match, never real/incomplete', () => {
    const all = [realS, incS, testS, testProd];
    assert.deepStrictEqual(sadmin.selectForPurge(all, { email: 'gabriela@gmail.com' }).map((s) => s.sessionToken), [testS.sessionToken]);
    assert.deepStrictEqual(sadmin.selectForPurge(all, { email: 'test-gabi-prod@example.com' }).map((s) => s.sessionToken), [testProd.sessionToken]);
    assert.strictEqual(sadmin.selectForPurge(all, { email: REAL_EMAIL }).length, 0, 'must not select a real session');
    assert.strictEqual(sadmin.selectForPurge(all, { token: incS.sessionToken }).length, 0, 'must not select an incomplete session');
    assert.strictEqual(sadmin.selectForPurge(all, {}).length, 0, 'no filter must select nothing');
  });
  await store.del(incS.sessionToken); await store.del(testProd.sessionToken);

  const ADMIN_HTML = fs.readFileSync(path.join(__dirname, '..', 'discovery', 'admin.html'), 'utf8');
  check('admin.html shows badges + 3-group separation + counts', () => {
    assert.ok(/Internal test/.test(ADMIN_HTML) && /testbadge/.test(ADMIN_HTML), 'no test badge');
    assert.ok(/Real completed sessions/.test(ADMIN_HTML) && /Incomplete \/ abandoned/.test(ADMIN_HTML) && /Test \/ internal sessions/.test(ADMIN_HTML), 'missing 3-group separation');
    assert.ok(/do not use for proposal/.test(ADMIN_HTML) && /excluded from client review/.test(ADMIN_HTML), 'missing group banners');
    assert.ok(/Real completed:/.test(ADMIN_HTML) && /counts/.test(ADMIN_HTML), 'missing counts');
  });

  await store.del(realS.sessionToken); await store.del(testS.sessionToken);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('scope class: ' + A.score.classification + ' | completeness: ' + A.brain.completeness);
  console.log('blueprint phases: ' + A.blueprint.components.map(c => c.component + '=P' + c.phase).join(', '));
  process.exit(fail ? 1 : 0);
})();
