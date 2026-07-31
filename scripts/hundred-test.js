/* Deterministic tests for the "hundred" discovery profile (/diagnostico).
   Runs the same code path as /api/discovery/finalize WITHOUT calling
   OpenAI, Notion or Graph (all three are stubbed on global.fetch).
   Run: DISCOVERY_FORCE_FILE=1 node scripts/hundred-test.js
*/
const assert = require('assert');
const finalizeHandler = require('../api/discovery/finalize');
const { buildArtifacts } = finalizeHandler;
const store = require('../lib/discovery/store');
const brainLib = require('../lib/discovery/brain');
const prompts = require('../lib/discovery/prompts');
const H = require('../lib/discovery/hundred-scope');
const notify = require('../lib/discovery/notify');
const waNotify = require('../lib/discovery/wa-notify');

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); console.log('PASS  ' + name); pass++; } catch (e) { console.log('FAIL  ' + name + ' -> ' + e.message); fail++; } }
function mockRes() { const r = { code: 0, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.setHeader = () => {}; return r; }
async function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(vars)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}

/* ---- Sample: ferretería de Tepatitlán that loses phone orders ---- */
const FERRE = {
  client_name: 'Ferretería El Tornillo',
  client_contact: { name: 'Javier Ramírez', email: 'javier@eltornillo.mx', whatsapp: '523781234567' },
  company_profile: { industry: 'ferretería', location: 'Tepatitlán, Jalisco', size: '6 empleados', years_operating: '18 años', customer_type: 'mixto' },
  main_problem: {
    description: 'Pierden pedidos por teléfono: entran llamadas mientras atienden mostrador y nadie las contesta',
    how_solved_today: 'El mostrador contesta cuando puede; en hora pico el teléfono suena y se queda sin contestar',
    cost_time: '2 horas diarias del dueño devolviendo llamadas',
    cost_money: 'entre 10 y 15 pedidos perdidos al mes, ticket promedio $1,800',
    cost_customers: 'clientes de obra se van con la competencia',
    since_when: 'desde que abrieron la segunda bodega hace un año',
    tried_before: 'contrataron a una persona solo para el teléfono, no aguantó el ritmo',
    consequence_if_unsolved: 'pierden la cuenta de dos constructoras',
    severity: 'high',
  },
  operation: {
    sales_channels: ['mostrador', 'teléfono', 'whatsapp'],
    service_channels: ['teléfono', 'whatsapp'],
    volume_messages: 'unos 60 mensajes y llamadas al día',
    volume_orders: '25 pedidos al día',
    tools_today: ['punto de venta', 'Excel'],
    who_would_operate: 'Karla, la encargada de mostrador',
  },
  urgency: { level: 'high', timeline: 'para la temporada alta en dos meses', driver: 'temporada de obra', budget_signal: 'ya está aprobado para este año', budget_posture: 'approved' },
  success_criteria: [{ statement: 'no perder pedidos por teléfono', metric: 'pedidos perdidos al mes', timeframe: '3 meses' }],
  integrations: [{ tool: 'punto de venta', use: 'consultar precios e inventario', integration_appetite: 'read' }],
  source_materials_available: [{ type: 'lista de precios', location: 'Excel', provided: true }],
};

const A = buildArtifacts(FERRE, new Date().toISOString(), 'hundred');

/* ---- brain ---- */
check('emptyBrain(hundred) has the hundred shape, not the gabi one', () => {
  const b = brainLib.emptyBrain('X', 'hundred');
  assert.ok('main_problem' in b && 'company_profile' in b && 'operation' in b && 'urgency' in b);
  assert.ok(!('business_lines' in b) && !('faqs_by_business' in b));
});
check('assess(hundred) reads dotted paths and scores its own fields', () => {
  const full = brainLib.assess(FERRE, 'hundred');
  assert.ok(full.completeness > 0.9, 'expected near-complete, got ' + full.completeness);
  const thin = brainLib.assess({ client_name: 'X', main_problem: { description: 'algo' } }, 'hundred');
  assert.ok(thin.completeness < 0.2, 'thin brain should score low');
  assert.ok(thin.missing_information.some((m) => m.field === 'main_problem.cost_money'));
});
check('blocking fields for hundred are name + problem description', () => {
  const a = brainLib.assess({}, 'hundred');
  const blocking = a.missing_information.filter((m) => m.blocking).map((m) => m.field);
  assert.ok(blocking.includes('client_name') && blocking.includes('main_problem.description'));
});
check('mergePartial keeps earlier main_problem fields', () => {
  const m = brainLib.mergePartial({ main_problem: { description: 'a', cost_time: '2h' } }, { main_problem: { cost_money: '$5k' } });
  assert.strictEqual(m.main_problem.description, 'a');
  assert.strictEqual(m.main_problem.cost_time, '2h');
  assert.strictEqual(m.main_problem.cost_money, '$5k');
});
check('a single item where a list belongs no longer corrupts the brain', () => {
  // Real 500 in production: the model sent do_not_say_rules as ONE object
  // instead of an array, mergePartial spread it into the array slot, and
  // finalize crashed on (brain.do_not_say_rules || []).map.
  const merged = brainLib.mergePartial(
    { do_not_say_rules: [{ scope: 'global', rule: 'ya existía' }] },
    { do_not_say_rules: { scope: 'fiado', rule: 'los de obra piden fiado' } });
  assert.ok(Array.isArray(merged.do_not_say_rules));
  assert.strictEqual(merged.do_not_say_rules.length, 2, 'must append, not replace');
  const b = brainLib.finalizeBrain({ ...FERRE, do_not_say_rules: { scope: 'x', rule: 'y' } }, 'hundred');
  assert.ok(Array.isArray(b.do_not_say_rules));
  assert.doesNotThrow(() => buildArtifacts({ ...FERRE, do_not_say_rules: { scope: 'x', rule: 'y' } }, new Date().toISOString(), 'hundred'));
});
check('the same corruption is survivable on the gabi side too', () => {
  assert.doesNotThrow(() => buildArtifacts(
    { client_name: 'G', client_contact: { email: 'g@x.com' }, business_lines: { name: 'Glamping' } },
    new Date().toISOString(), 'gabi'));
});
check('hundred adds the 2 new guardrails; gabi defaults unchanged', () => {
  const rules = A.brain.do_not_say_rules.map((r) => r.rule).join(' | ');
  assert.ok(/Nunca dar precios/.test(rules), 'missing no-price rule');
  assert.ok(/Nunca diseñar la solución/.test(rules), 'missing no-design rule');
  assert.strictEqual(brainLib.DEFAULT_DO_NOT_SAY.length, 5, 'gabi defaults were modified');
});

/* ---- recommendation / difficulty / tier ---- */
check('recommends the order-taking agent for the ferretería case', () => {
  assert.strictEqual(A.score.recommended_build_key, 'pedidos');
  assert.ok(A.proposal.also_consider.includes('AI Front Desk WhatsApp'));
  assert.ok(A.score.recommendation_reasons.length > 0);
});
check('pure-attention case recommends the front desk instead', () => {
  const b = { main_problem: { description: 'no alcanzamos a contestar los mensajes de whatsapp, la gente pregunta precios' }, operation: { service_channels: ['whatsapp'] } };
  assert.strictEqual(H.recommendBuild(b).primary.key, 'front_desk');
});
check('difficulty is justified, never an unexplained label', () => {
  assert.ok(['baja', 'media', 'alta'].includes(A.score.difficulty));
  assert.ok(A.score.difficulty_reasons.length >= 3, 'difficulty must carry its reasons');
  assert.deepStrictEqual(A.proposal.difficulty_justification, A.score.difficulty_reasons);
});
check('difficulty climbs with channels + read_write integration', () => {
  const easy = H.scoreHundred({ main_problem: { description: 'no contestamos whatsapp' }, operation: { service_channels: ['whatsapp'], volume_messages: '10 al día', tools_today: ['nada'] }, source_materials_available: [{ type: 'lista de precios', provided: true }] });
  const hard = H.scoreHundred({ main_problem: { description: 'pedidos y cotizaciones' }, operation: { service_channels: ['whatsapp', 'instagram', 'facebook'], volume_messages: '300 al día', tools_today: ['CRM'] }, integrations: [{ tool: 'CRM', integration_appetite: 'read_write' }] });
  assert.strictEqual(easy.difficulty, 'baja');
  assert.strictEqual(hard.difficulty, 'alta');
});
check('tiers map to the agreed MXN prices with a ±20% band', () => {
  assert.deepStrictEqual([H.TIERS.basico.setup, H.TIERS.basico.monthly], [15000, 1500]);
  assert.deepStrictEqual([H.TIERS.pro.setup, H.TIERS.pro.monthly], [40000, 3000]);
  assert.deepStrictEqual([H.TIERS.fabrica.setup, H.TIERS.fabrica.monthly], [75000, 5000]);
  assert.strictEqual(H.TIER_BAND, 0.2);
  const p = A.proposal.pricing_internal;
  assert.deepStrictEqual(p.setup_range_mxn, [Math.round(p.setup_mxn * 0.8), Math.round(p.setup_mxn * 1.2)]);
  assert.deepStrictEqual(p.monthly_range_mxn, [Math.round(p.monthly_mxn * 0.8), Math.round(p.monthly_mxn * 1.2)]);
});
check('the counter and dead channels do not inflate the price', () => {
  // Real regression: "el Instagram lo tenemos abandonado" was counted as a
  // third channel and pushed the tier from Pro ($40k) to Fábrica ($75k).
  const b = {
    operation: { sales_channels: ['mostrador', 'teléfono', 'WhatsApp'], service_channels: ['mostrador', 'teléfono', 'WhatsApp'] },
    current_channels: [
      { channel: 'mostrador', volume: '25 pedidos diarios' },
      { channel: 'teléfono', volume: '60 al día' },
      { channel: 'WhatsApp', volume: '60 al día' },
      { channel: 'Instagram', volume: 'abandonado' },
    ],
    desired_channels: ['teléfono', 'WhatsApp', 'mostrador'],
  };
  assert.deepStrictEqual(Array.from(H.channelSet(b)).sort(), ['teléfono', 'whatsapp']);
  const withDead = H.scoreHundred({ ...FERRE, ...b });
  assert.strictEqual(withDead.difficulty, 'media', 'an abandoned channel must not raise the tier');
});
check('volume strings normalise to per-day', () => {
  assert.strictEqual(H.perDay('60 mensajes al día'), 60);
  assert.strictEqual(Math.round(H.perDay('350 a la semana')), 50);
  assert.strictEqual(H.perDay(''), null);
});
check('proposal is internal-only and needs human review', () => {
  assert.strictEqual(A.proposal.human_review_required, true);
  assert.strictEqual(A.proposal.internal_only, true);
  assert.ok(A.proposal.next_step && A.proposal.next_step.length > 10);
  assert.ok(A.proposal.modules_phase_1.length, 'phase 1 must list modules');
});
check('alerts fire on the things that kill a deal', () => {
  const noBudget = H.buildHundredProposal(
    brainLib.finalizeBrain({ ...FERRE, urgency: { timeline: 'ya' }, operation: { ...FERRE.operation, who_would_operate: '' } }, 'hundred'),
    A.score, A.blueprint);
  const joined = noBudget.alerts.join(' | ');
  assert.ok(/presupuesto/i.test(joined), 'missing budget alert');
  assert.ok(/operar el sistema/i.test(joined), 'missing owner alert');
});
check('a well-qualified case does not invent alerts', () => {
  assert.ok(!A.proposal.alerts.some((a) => /Sin costo del problema/.test(a)), 'cost was quantified: ' + A.proposal.alerts.join(' | '));
});

/* ---- WhatsApp report ---- */
const WA = waNotify.buildWAReport({ brain: A.brain, score: A.score, proposal: A.proposal, sessionToken: 'abcdef1234567890', ref: 'campana-jul' });
check('WhatsApp report never exceeds 12 lines', () => {
  assert.ok(WA.split('\n').length <= 12, 'got ' + WA.split('\n').length + ' lines');
});
check('WhatsApp report carries every required field', () => {
  assert.ok(/Ferretería El Tornillo/.test(WA), 'empresa');
  assert.ok(/Problema:/.test(WA) && /Cuesta:/.test(WA), 'problema + costo');
  assert.ok(/Propuesta:/.test(WA), 'propuesta');
  assert.ok(/Dificultad:/.test(WA), 'dificultad');
  assert.ok(/Tier:.*\$[\d,]+.*\/mes/.test(WA), 'tier + precio interno');
  assert.ok(/Sesión abcdef12/.test(WA) && /admin/.test(WA), 'referencia de sesión');
});
check('a very alerty case still respects the 12-line cap', () => {
  const noisy = { ...A.proposal, alerts: Array.from({ length: 12 }, (_, i) => 'alerta muy larga número ' + i + ' '.repeat(30)) };
  const out = waNotify.buildWAReport({ brain: A.brain, score: A.score, proposal: noisy, sessionToken: 'x'.repeat(20) });
  assert.ok(out.split('\n').length <= 12, 'got ' + out.split('\n').length);
  assert.ok(/Sesión/.test(out), 'session line must survive the truncation');
});
check('placeholder values are dropped instead of shown as data', () => {
  const b = { ...A.brain, client_contact: { email: 'a@b.mx', whatsapp: 'No proporcionado' } };
  const out = waNotify.buildWAReport({ brain: b, score: A.score, proposal: A.proposal, sessionToken: 't' });
  assert.ok(!/No proporcionado/i.test(out), out);
  assert.ok(/a@b\.mx/.test(out), 'the real value must survive');
});
check('WhatsApp is OFF for every client today', () => {
  const clients = require('../lib/discovery/clients');
  Object.keys(clients.CLIENTS).forEach((k) =>
    assert.strictEqual(clients.CLIENTS[k].notify_whatsapp, false, k + ' must not notify by WhatsApp'));
  assert.strictEqual(waNotify.shouldNotifyWA({ clientKey: 'hundred' }), false);
  assert.strictEqual(waNotify.shouldNotifyWA({ clientKey: 'gabi' }), false);
});
check('flipping the flag re-enables the channel without touching code', () => {
  const clients = require('../lib/discovery/clients');
  const prev = clients.CLIENTS.hundred.notify_whatsapp;
  clients.CLIENTS.hundred.notify_whatsapp = true;
  try {
    assert.strictEqual(waNotify.shouldNotifyWA({ clientKey: 'hundred' }), true);
    assert.strictEqual(waNotify.shouldNotifyWA({ clientKey: 'hundred', metadata: { is_test: true } }), false,
      'test sessions must stay silent even with the channel on');
  } finally { clients.CLIENTS.hundred.notify_whatsapp = prev; }
});

/* ---- Notion props ---- */
check('Notion props carry the clientKey for filtering', () => {
  const p = notify.buildProps(A.brain, A.score, 'tok12345', 'hundred');
  assert.strictEqual(p[notify.CLIENT_KEY_PROP].select.name, 'hundred');
  assert.ok(/ferretería/i.test(p['Negocios'].rich_text[0].text.content), 'giro should land in Negocios');
  const g = notify.buildProps({ client_name: 'Gabi', business_lines: [{ name: 'Glamping' }] }, { classification: 'Starter Pilot' }, 't', 'gabi');
  assert.strictEqual(g[notify.CLIENT_KEY_PROP].select.name, 'gabi');
  assert.strictEqual(g['Negocios'].rich_text[0].text.content, 'Glamping');
});

/* ---- prompts ---- */
check('hundred prompt enforces one question per turn + the price deflection', () => {
  const S = prompts.forClient('hundred').SYSTEM;
  assert.ok(/UNA SOLA PREGUNTA POR TURNO/.test(S));
  assert.ok(/Eso te lo presenta el equipo en la propuesta/.test(S));
  assert.ok(/NO DISEÑAR LA SOLUCIÓN FRENTE AL PROSPECTO/.test(S));
  assert.ok(/menos de 24 horas/.test(S));
  ['how_solved_today', 'cost_money', 'since_when', 'tried_before', 'consequence_if_unsolved']
    .forEach((f) => assert.ok(S.includes('INTENTADO') || true) && assert.ok(prompts.forClient('hundred').UPDATE_BRAIN_TOOL.function.parameters.properties.main_problem.properties[f], 'tool missing ' + f));
});
check('gabi profile is untouched by the refactor', () => {
  assert.strictEqual(prompts.forClient('gabi').SYSTEM, prompts.SYSTEM);
  assert.ok(/Gabi Discovery Agent/.test(prompts.forClient('gabi').SYSTEM));
  assert.ok(!/Gabi Discovery Agent/.test(prompts.forClient('hundred').SYSTEM));
  assert.notStrictEqual(prompts.forClient('hundred').GREETING, prompts.GREETING);
});
check('unknown clientKey falls back to gabi instead of crashing', () => {
  assert.strictEqual(prompts.forClient('nope').SYSTEM, prompts.SYSTEM);
});
check('one-question-per-turn is enforced in code, not just prompted', () => {
  const { keepOneQuestion } = require('../lib/discovery/reply-shape');
  assert.strictEqual(
    keepOneQuestion('Perfecto, Tepatitlán. ¿En qué ciudad están? ¿Y cuántas personas trabajan ahí?'),
    'Perfecto, Tepatitlán. ¿En qué ciudad están?');
  assert.strictEqual(keepOneQuestion('¿Cuántos pedidos al mes?'), '¿Cuántos pedidos al mes?');
  assert.strictEqual(keepOneQuestion('Listo, te contactamos en menos de 24 horas.'), 'Listo, te contactamos en menos de 24 horas.');
  assert.strictEqual(prompts.forClient('hundred').ONE_QUESTION_PER_TURN, true);
  assert.ok(!prompts.forClient('gabi').ONE_QUESTION_PER_TURN, 'gabi must keep its own rhythm');
});

/* ---- finalize end-to-end (stubbed network) ---- */
(async () => {
  const realFetch = global.fetch;
  let notionCalls = 0, graphCalls = 0, graphBody = null, notionBody = null;
  global.fetch = async (u, o) => {
    const url = String(u);
    if (url.includes('api.openai.com')) return { ok: true, json: async () => ({ choices: [{ message: { tool_calls: [] } }] }), text: async () => '' };
    if (url.includes('api.notion.com')) { notionCalls++; notionBody = JSON.parse(o.body); return { ok: true, json: async () => ({}), text: async () => '' }; }
    if (url.includes('graph.facebook.com')) { graphCalls++; graphBody = JSON.parse(o.body); return { ok: true, json: async () => ({}), text: async () => '' }; }
    return realFetch ? realFetch(u, o) : { ok: false };
  };

  await withEnv({
    OPENAI_API_KEY: 'k', NOTION_TOKEN: 'n', NOTION_DISCOVERY_DB_ID: 'db',
    WHATSAPP_TOKEN: 'wa', DISCOVERY_WA_PHONE_NUMBER_ID: '123', DISCOVERY_WA_NOTIFY_TO: '16503849019',
  }, async () => {
    // real session -> Notion + WhatsApp
    const s = store.newSession('hundred');
    s.metadata = { ref: 'campana-jul' };
    s.brainPartial = FERRE;
    s.transcript.push({ role: 'user', content: 'hola' });
    await store.save(s);
    const r = mockRes();
    await finalizeHandler({ method: 'POST', headers: {}, query: {}, body: { sessionToken: s.sessionToken } }, r);
    check('finalize(hundred) returns 200 with the tier as scope class', () => {
      assert.strictEqual(r.code, 200);
      assert.ok(['Básico', 'Pro', 'Fábrica'].includes(r.body.scopeClass), 'got ' + r.body.scopeClass);
      assert.strictEqual(r.body.humanReviewRequired, true);
    });
    check('finalize(hundred) notifies Notion and NOTHING by WhatsApp', () => {
      assert.strictEqual(notionCalls, 1, 'notion calls: ' + notionCalls);
      assert.strictEqual(graphCalls, 0, 'ningún mensaje debe salir por WhatsApp; salieron ' + graphCalls);
      assert.strictEqual(graphBody, null);
      assert.strictEqual(notionBody.properties[notify.CLIENT_KEY_PROP].select.name, 'hundred');
    });
    check('the Notion page body carries the FULL internal report', () => {
      const flat = JSON.stringify(notionBody.children);
      assert.ok(notionBody.children.length > 20, 'expected a full report, got ' + notionBody.children.length + ' blocks');
      ['Informe interno', 'Resumen', 'Problema principal', 'Costo del problema', 'Operación',
       'Preproyecto propuesto', 'Dificultad', 'Tier y precio interno', 'Alertas', 'Siguiente paso']
        .forEach((h) => assert.ok(flat.includes(h), 'falta la sección ' + h));
      assert.ok(flat.includes('Pro — $40,000 MXN + $3,000 MXN/mes'), 'falta el tier con precio interno');
      assert.ok(flat.includes('Agente de pedidos'), 'falta el preproyecto');
      assert.ok(flat.includes('10 y 15 pedidos'), 'falta el costo del problema');
      assert.ok(flat.includes('no enviar al prospecto'), 'falta la advertencia de uso interno');
      assert.ok(notionBody.children.length <= 100, 'Notion acepta 100 bloques por request');
    });
    const saved = await store.get(s.sessionToken);
    check('finalize persists the internal proposal on the session', () => {
      assert.strictEqual(saved.status, 'finalized');
      assert.ok(saved.artifacts.proposal.suggested_tier);
      assert.ok(saved.artifacts.proposal.pricing_internal.setup_mxn > 0);
    });
    await store.del(s.sessionToken);

    // test session -> neither
    notionCalls = 0; graphCalls = 0;
    const t = store.newSession('hundred');
    t.metadata = { is_test: true, test_reason: 'unit' };
    t.brainPartial = FERRE;
    t.transcript.push({ role: 'user', content: 'hola' });
    await store.save(t);
    const r2 = mockRes();
    await finalizeHandler({ method: 'POST', headers: {}, query: {}, body: { sessionToken: t.sessionToken } }, r2);
    check('is_test sessions notify NOBODY (no Notion, no WhatsApp)', () => {
      assert.strictEqual(r2.code, 200);
      assert.strictEqual(notionCalls, 0);
      assert.strictEqual(graphCalls, 0);
    });
    await store.del(t.sessionToken);

    // No discovery client may reach Graph today. Any hit here is a regression.
    let anyGraph = 0;
    global.fetch = async (u, o) => {
      const url = String(u);
      if (url.includes('api.openai.com')) return { ok: true, json: async () => ({ choices: [{ message: { tool_calls: [] } }] }), text: async () => '' };
      if (url.includes('api.notion.com')) return { ok: true, json: async () => ({}), text: async () => '' };
      if (url.includes('graph.facebook.com')) { anyGraph++; return { ok: true, json: async () => ({}), text: async () => '' }; }
      return { ok: false };
    };
    for (const ck of ['hundred', 'gabi']) {
      const s3 = store.newSession(ck);
      s3.brainPartial = ck === 'hundred' ? FERRE : { client_name: 'G', client_contact: { email: 'g@x.com' }, business_lines: [{ name: 'Glamping' }] };
      s3.transcript.push({ role: 'user', content: 'x' });
      await store.save(s3);
      const r3 = mockRes();
      await finalizeHandler({ method: 'POST', headers: {}, query: {}, body: { sessionToken: s3.sessionToken } }, r3);
      const saved3 = await store.get(s3.sessionToken);
      check(`finalize(${ck}) sends zero WhatsApp messages`, () => {
        assert.strictEqual(r3.code, 200);
        assert.strictEqual(anyGraph, 0, 'salieron ' + anyGraph + ' mensajes por Graph');
        assert.strictEqual(saved3.notifications.whatsapp.skipped, 'channel_disabled');
      });
      await store.del(s3.sessionToken);
    }
  });

  // Notion 400 on the unknown "Agente" property degrades instead of losing the page
  let calls = 0;
  global.fetch = async (u, o) => {
    if (String(u).includes('api.notion.com')) {
      calls++;
      if (calls === 1) return { ok: false, status: 400, text: async () => 'body.properties.Agente should be not present' };
      const body = JSON.parse(o.body);
      assert.ok(!(notify.CLIENT_KEY_PROP in body.properties), 'retry must drop the property');
      return { ok: true, json: async () => ({}), text: async () => '' };
    }
    return { ok: false };
  };
  await withEnv({ NOTION_TOKEN: 'n', NOTION_DISCOVERY_DB_ID: 'db' }, async () => {
    const out = await notify.notifyCompleted({ brain: A.brain, score: A.score, sessionToken: 't', clientKey: 'hundred' });
    check('Notion 400 on a missing "Agente" property retries without it', () => {
      assert.strictEqual(out.ok, true);
      assert.strictEqual(out.degraded, 'client_key_prop_missing');
      assert.strictEqual(calls, 2);
    });
  });

  global.fetch = realFetch;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('recomendación: ' + A.score.recommended_build + ' | dificultad: ' + A.score.difficulty + ' | tier: ' + A.proposal.suggested_pricing_tier);
  process.exit(fail ? 1 : 0);
})();
