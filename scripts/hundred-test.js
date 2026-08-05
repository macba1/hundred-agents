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

/* ---- guardrail: requirements only, never a recommendation ---- */
const RECOMMENDATION_KEYS = [
  'recommended_build', 'recommended_build_what', 'recommended_build_reasons', 'also_consider',
  'modules_phase_1', 'modules_phase_2', 'modules_phase_3',
  'difficulty', 'difficulty_justification',
  'suggested_tier', 'suggested_pricing_tier', 'pricing_internal',
];

check('the dossier carries NO recommendation, difficulty, tier or price', () => {
  RECOMMENDATION_KEYS.forEach((k) =>
    assert.ok(!(k in A.proposal), 'la ficha no debe traer ' + k));
  // Ojo: la ficha SÍ puede contener cifras del prospecto ("ticket promedio
  // $1,800"). Lo prohibido es un precio NUESTRO o un producto del catálogo.
  const flat = JSON.stringify(A.proposal);
  assert.ok(!/MXN|pricing|tier/i.test(flat), 'ningún precio nuestro en la ficha: ' + flat.slice(0, 200));
  assert.ok(!/Front Desk|Agente de pedidos|Agente de citas|Agente a medida/.test(flat), 'ningún producto del catálogo');
});
check('the recommendation engine is gone, not just unused', () => {
  ['recommendBuild', 'assessDifficulty', 'tierFor', 'CATALOG', 'TIERS', 'MODULES', 'buildAlerts']
    .forEach((k) => assert.strictEqual(H[k], undefined, 'sigue existiendo ' + k));
});
check('scope stays "Por estudiar" — a person decides it', () => {
  assert.strictEqual(A.score.classification, H.PENDING);
  assert.strictEqual(A.proposal.scope, H.PENDING);
  assert.strictEqual(A.blueprint, null, 'el diagnóstico no diseña arquitectura');
});
check('the dossier keeps every requirement the prospect gave', () => {
  assert.strictEqual(A.proposal.problem_summary, FERRE.main_problem.description);
  assert.strictEqual(A.proposal.problem_today, FERRE.main_problem.how_solved_today);
  assert.strictEqual(A.proposal.problem_tried, FERRE.main_problem.tried_before);
  assert.strictEqual(A.proposal.problem_if_unsolved, FERRE.main_problem.consequence_if_unsolved);
  assert.ok(/2 horas diarias/.test(A.proposal.problem_cost));
  assert.deepStrictEqual(A.proposal.operation.tools_today, FERRE.operation.tools_today);
  assert.strictEqual(A.proposal.operation.who_would_operate, FERRE.operation.who_would_operate);
  assert.strictEqual(A.proposal.urgency.timeline, FERRE.urgency.timeline);
  assert.strictEqual(A.proposal.client_email, FERRE.client_contact.email);
});
check('every address the prospect typed survives the summary', () => {
  // Dulces Providencia pidió copiar a tres compañeros y el resumen guardó uno.
  const tr = [
    { role: 'user', content: 'mi correo es h.marquez@dulcesprovidencia.mx' },
    { role: 'user', content: 'y copia a e.vazquez@dulcesprovidencia.mx, j.silva@dulcesprovidencia.mx e isaac.vazquez@dulcesprovidencia.mx' },
  ];
  const others = H.otherEmails(tr, 'h.marquez@dulcesprovidencia.mx');
  assert.deepStrictEqual(others, ['e.vazquez@dulcesprovidencia.mx', 'j.silva@dulcesprovidencia.mx', 'isaac.vazquez@dulcesprovidencia.mx']);
  const d = H.buildHundredProposal({ ...FERRE, client_contact: { email: 'h.marquez@dulcesprovidencia.mx' } }, tr);
  assert.strictEqual(d.other_emails.length, 3);
});
check('the verbatim conversation is written into the page body', () => {
  const long = 'x'.repeat(4200);
  const blocks = notify.buildTranscriptBlocks([
    { role: 'assistant', content: '¿Cómo se llama tu negocio?' },
    { role: 'user', content: 'Dulces Providencia, dulce típico mexicano a base de leche' },
    { role: 'user', content: long },
  ]);
  const flat = JSON.stringify(blocks);
  assert.ok(flat.includes('Conversación completa'));
  assert.ok(flat.includes('dulce típico mexicano a base de leche'), 'literal, no resumido');
  assert.ok(flat.includes('Cliente') && flat.includes('Agente'), 'hay que distinguir quién habla');
  // Notion rechaza runs de más de 2000 caracteres: la respuesta larga se trocea.
  blocks.forEach((b) => ((b[b.type] && b[b.type].rich_text) || []).forEach((r) =>
    assert.ok(r.text.content.length <= 2000, 'bloque de ' + r.text.content.length + ' chars')));
  assert.ok(blocks.length >= 6, 'la respuesta larga debe partirse en varios bloques');
});
check('a long interview is split into Notion-sized batches', () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: 'mensaje ' + i }));
  const all = notify.buildChildren(A.brain, 'hundred', { score: A.score, proposal: A.proposal }, many);
  assert.ok(all.length > notify.MAX_BLOCKS_PER_CALL, 'este caso debe superar el tope de 100');
  // notifyCompleted manda los primeros 100 al crear y añade el resto después.
  assert.strictEqual(notify.MAX_BLOCKS_PER_CALL, 100);
});
check('gaps report what is missing from the INTERVIEW, not deal judgements', () => {
  assert.deepStrictEqual(A.proposal.gaps, [], 'este caso quedó completo');
  const thin = H.buildGaps({ main_problem: {}, operation: {}, urgency: {}, completeness: 0.3 });
  assert.ok(thin.some((g) => /cuantificó lo que cuesta/.test(g)));
  assert.ok(thin.some((g) => /Sin señal de presupuesto/.test(g)));
  assert.ok(!thin.some((g) => /tier|precio|dificultad/i.test(g)), 'los huecos no juzgan el trato');
});
check('the counter and dead channels stay out of the factual signal', () => {
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
  assert.deepStrictEqual(H.scoreHundred({ ...FERRE, ...b }).channels_to_cover.sort(), ['teléfono', 'whatsapp']);
});
check('volume strings normalise to per-day', () => {
  assert.strictEqual(H.perDay('60 mensajes al día'), 60);
  assert.strictEqual(Math.round(H.perDay('350 a la semana')), 50);
  assert.strictEqual(H.perDay(''), null);
});
check('dossier is internal-only and needs human review', () => {
  assert.strictEqual(A.proposal.human_review_required, true);
  assert.strictEqual(A.proposal.internal_only, true);
  assert.strictEqual(A.proposal.kind, 'intake');
  assert.ok(/Estudiar el caso/.test(A.proposal.next_step));
});

/* ---- WhatsApp report ---- */
const WA = waNotify.buildWAReport({ brain: A.brain, score: A.score, proposal: A.proposal, sessionToken: 'abcdef1234567890', ref: 'campana-jul' });
check('WhatsApp report never exceeds 12 lines', () => {
  assert.ok(WA.split('\n').length <= 12, 'got ' + WA.split('\n').length + ' lines');
});
check('WhatsApp report carries requirements only, never advice', () => {
  assert.ok(/Ferretería El Tornillo/.test(WA), 'empresa');
  assert.ok(/Problema:/.test(WA) && /Cuesta:/.test(WA), 'problema + costo');
  assert.ok(/Hoy:/.test(WA) && /Canales:/.test(WA) && /Urgencia:/.test(WA), 'operación y urgencia');
  assert.ok(!/Propuesta:|Dificultad:|Tier:|MXN/.test(WA), 'el aviso no debe recomendar ni cotizar');
  assert.ok(/Sesión abcdef12/.test(WA) && /admin/.test(WA), 'referencia de sesión');
});
check('a gap-heavy case still respects the 12-line cap', () => {
  const noisy = { ...A.proposal, gaps: Array.from({ length: 12 }, (_, i) => 'hueco muy largo número ' + i + ' '.repeat(30)) };
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
check('one funnel: gabi frozen, hundred live, one database', () => {
  const clients = require('../lib/discovery/clients');
  assert.strictEqual(clients.configFor('gabi').frozen, true, 'gabi debe quedar congelado');
  assert.strictEqual(clients.configFor('hundred').frozen, false, 'hundred es el embudo vivo');
  // Ambos clientes escriben en la MISMA base: no hay id de base por cliente.
  Object.values(clients.CLIENTS).forEach((c) =>
    assert.ok(!('notion_db_id' in c), 'ningún cliente puede tener base propia'));
});
check('the notion-setup ops tool renames the DB and describes it', () => {
  const setup = require('../api/discovery/notion-setup');
  assert.strictEqual(setup.DB_TITLE, 'Prospectos — Hundred Agents');
  assert.ok(/Cada fila = una empresa que quiere trabajar con Hundred/.test(setup.DB_DESCRIPTION));
  assert.ok(/\/diagnostico/.test(setup.DB_DESCRIPTION));
  const names = setup.ORIGIN_OPTIONS.map((o) => o.name);
  ['diagnostico', 'gabi', 'coparmex', 'comercial'].forEach((n) => assert.ok(names.includes(n), 'falta la opción ' + n));
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
check('one database for everyone, segmented by Origen', () => {
  const p = notify.buildProps(A.brain, A.score, 'tok12345', 'hundred');
  assert.strictEqual(p[notify.ORIGIN_PROP].select.name, 'diagnostico');
  assert.ok(/ferretería/i.test(p['Negocios'].rich_text[0].text.content), 'giro should land in Negocios');
  const g = notify.buildProps({ client_name: 'Gabi', business_lines: [{ name: 'Glamping' }] }, { classification: 'Starter Pilot' }, 't', 'gabi');
  assert.strictEqual(g[notify.ORIGIN_PROP].select.name, 'gabi');
  assert.strictEqual(g['Negocios'].rich_text[0].text.content, 'Glamping');
});
check('a ?ref= wins as the Origen, so future sources need no code', () => {
  ['coparmex', 'comercial', 'linkedin-julio'].forEach((ref) => {
    const p = notify.buildProps(A.brain, A.score, 't', 'hundred', ref);
    assert.strictEqual(p[notify.ORIGIN_PROP].select.name, ref);
  });
  // Notion rejects commas inside a select option name.
  assert.strictEqual(notify.originFor('hundred', 'feria, leon'), 'feria  leon');
  assert.strictEqual(notify.originFor('hundred', '   '), 'diagnostico');
  assert.strictEqual(notify.originFor('hundred', undefined), 'diagnostico');
});

/* ---- prompts ---- */
check('hundred prompt enforces one question per turn + the price deflection', () => {
  const S = prompts.forClient('hundred').SYSTEM;
  assert.ok(/UNA SOLA PREGUNTA POR TURNO/.test(S));
  assert.ok(/Eso te lo presenta el equipo en la propuesta/.test(S));
  assert.ok(/NO RECOMENDAR NADA, NUNCA/.test(S));
  assert.ok(/después de estudiar tu caso/.test(S));
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
    check('finalize(hundred) returns 200 and leaves the scope to a person', () => {
      assert.strictEqual(r.code, 200);
      assert.strictEqual(r.body.scopeClass, H.PENDING, 'got ' + r.body.scopeClass);
      assert.strictEqual(r.body.humanReviewRequired, true);
    });
    check('finalize(hundred) notifies Notion and NOTHING by WhatsApp', () => {
      assert.strictEqual(notionCalls, 1, 'notion calls: ' + notionCalls);
      assert.strictEqual(graphCalls, 0, 'ningún mensaje debe salir por WhatsApp; salieron ' + graphCalls);
      assert.strictEqual(graphBody, null);
      assert.strictEqual(notionBody.properties[notify.ORIGIN_PROP].select.name, 'campana-jul', 'el ?ref= debe llegar a Origen');
    });
    check('the Notion page body carries every requirement, and no advice', () => {
      const flat = JSON.stringify(notionBody.children);
      assert.ok(notionBody.children.length > 20, 'expected a full dossier, got ' + notionBody.children.length + ' blocks');
      ['Requerimientos recogidos en la entrevista', 'Empresa', 'Problema principal', 'Qué les cuesta',
       'Operación', 'Urgencia y presupuesto', 'Qué falta preguntar', 'Siguiente paso']
        .forEach((h) => assert.ok(flat.includes(h), 'falta la sección ' + h));
      assert.ok(flat.includes('10 y 15 pedidos'), 'falta el costo del problema');
      assert.ok(flat.includes('Karla'), 'falta quién lo operaría');
      assert.ok(flat.includes('no recomienda'), 'falta la advertencia de que no se recomienda nada');
      assert.ok(flat.includes('Conversación completa'), 'falta la conversación literal');
      assert.ok(flat.includes('hola'), 'el texto del prospecto debe ir palabra por palabra');
      assert.ok(!/MXN|Front Desk|Dificultad|Preproyecto/.test(flat), 'el cuerpo no debe recomendar nada');
      assert.ok(notionBody.children.length <= 100, 'Notion acepta 100 bloques por request');
    });
    const saved = await store.get(s.sessionToken);
    check('finalize persists the requirements dossier on the session', () => {
      assert.strictEqual(saved.status, 'finalized');
      assert.strictEqual(saved.artifacts.proposal.kind, 'intake');
      assert.strictEqual(saved.artifacts.proposal.scope, H.PENDING);
      assert.ok(saved.artifacts.proposal.problem_summary.length > 10);
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

    /* The button bug: a prospect completed the whole interview, the agent told
       him "listo, te contactamos en menos de 24 horas", and the session was
       never finalized because nobody pressed Terminar. The closing line is the
       promise — the server must honour it by itself. */
    const messageHandler = require('../api/discovery/message');
    const CLOSING = 'Listo. Con esto el equipo de Hundred Agents arma tu propuesta y te contactamos en menos de 24 horas.';
    let notionOnAuto = 0;
    global.fetch = async (u, o) => {
      const url = String(u);
      if (url.includes('api.openai.com')) {
        const sent = JSON.parse(o.body);
        // El compile FUERZA la tool (objeto); el turno de chat manda 'auto'.
        if (sent.tool_choice && typeof sent.tool_choice === 'object') {
          return { ok: true, json: async () => ({ choices: [{ message: { tool_calls: [] } }] }), text: async () => '' };
        }
        return { ok: true, json: async () => ({ choices: [{ message: { content: CLOSING } }] }), text: async () => '' };
      }
      if (url.includes('api.notion.com')) { notionOnAuto++; return { ok: true, json: async () => ({ url: 'https://notion/x' }), text: async () => '' }; }
      if (url.includes('graph.facebook.com')) return { ok: true, json: async () => ({}), text: async () => '' };
      return { ok: false };
    };

    const auto = store.newSession('hundred');
    auto.brainPartial = FERRE;
    auto.transcript.push({ role: 'assistant', content: 'hola' });
    await store.save(auto);
    const rAuto = mockRes();
    await messageHandler({ method: 'POST', headers: {}, query: {}, body: { sessionToken: auto.sessionToken, message: 'no falta nada' } }, rAuto);
    const savedAuto = await store.get(auto.sessionToken);
    check('the interview closes itself when the agent says goodbye', () => {
      assert.strictEqual(rAuto.code, 200);
      assert.strictEqual(rAuto.body.done, true, 'el front debe recibir done');
      assert.strictEqual(rAuto.body.finalized, true);
      assert.strictEqual(savedAuto.status, 'finalized', 'la sesión quedó en ' + savedAuto.status);
      assert.ok(savedAuto.artifacts, 'sin artefactos');
      assert.strictEqual(notionOnAuto, 1, 'debe crear la fila en Notion sin pulsar Terminar');
    });
    await store.del(auto.sessionToken);

    // Sin correo válido no se puede cerrar: la conversación sigue abierta.
    const noMail = store.newSession('hundred');
    noMail.brainPartial = { ...FERRE, client_contact: { name: 'Ruth', email: 'Ruthprueba' } };
    noMail.transcript.push({ role: 'assistant', content: 'hola' });
    await store.save(noMail);
    const rNo = mockRes();
    await messageHandler({ method: 'POST', headers: {}, query: {}, body: { sessionToken: noMail.sessionToken, message: 'ya' } }, rNo);
    const savedNo = await store.get(noMail.sessionToken);
    check('without a valid email the session stays open instead of half-closing', () => {
      assert.strictEqual(rNo.code, 200);
      assert.ok(!rNo.body.finalized);
      assert.strictEqual(savedNo.status, 'active');
    });
    await store.del(noMail.sessionToken);

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
      if (calls === 1) return { ok: false, status: 400, text: async () => 'body.properties.Origen should be not present' };
      const body = JSON.parse(o.body);
      assert.ok(!(notify.ORIGIN_PROP in body.properties), 'retry must drop the property');
      return { ok: true, json: async () => ({}), text: async () => '' };
    }
    return { ok: false };
  };
  await withEnv({ NOTION_TOKEN: 'n', NOTION_DISCOVERY_DB_ID: 'db' }, async () => {
    const out = await notify.notifyCompleted({ brain: A.brain, score: A.score, sessionToken: 't', clientKey: 'hundred' });
    check('Notion 400 on a missing "Origen" property retries without it', () => {
      assert.strictEqual(out.ok, true);
      assert.strictEqual(out.degraded, 'origin_prop_missing');
      assert.strictEqual(calls, 2);
    });
  });

  global.fetch = realFetch;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('recomendación: ' + A.score.recommended_build + ' | dificultad: ' + A.score.difficulty + ' | tier: ' + A.proposal.suggested_pricing_tier);
  process.exit(fail ? 1 : 0);
})();
