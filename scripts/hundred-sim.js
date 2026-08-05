/* ============================================================
   Simulated end-to-end run of the "hundred" diagnostic.

   A second model plays the prospect (a ferretería in Tepatitlán that
   loses phone orders) and talks to the REAL /api/discovery handlers,
   with the REAL prompts and the REAL compile pass. Only the session
   store is local (file mode) and the session is marked is_test, so
   nothing is notified to Notion or WhatsApp.

   Two guardrail probes are injected mid-conversation: a direct price
   question and a "what exactly would you build me" question. Both are
   asserted afterwards.

   Prints: transcript, compiled brain, requirements dossier, and the EXACT
   WhatsApp text a real completion would send if that channel were on.

   Two modes:
   - local:  DISCOVERY_FORCE_FILE=1 OPENAI_API_KEY=... node scripts/hundred-sim.js
   - remote: SIM_BASE_URL=https://<deploy> REDIS_URL=... OPENAI_API_KEY=...
             node scripts/hundred-sim.js
     Remote drives the deployed handlers over HTTP (so the server's own
     OpenAI key does the interviewing) and uses Redis only to mark the
     session as a test and to read back the artifacts.
   ============================================================ */
const store = require('../lib/discovery/store');
const startH = require('../api/discovery/start');
const messageH = require('../api/discovery/message');
const finalizeH = require('../api/discovery/finalize');
const waNotify = require('../lib/discovery/wa-notify');
const { containsFinalPrice } = require('../lib/discovery/proposal');

const MAX_TURNS = Number(process.env.SIM_TURNS || 22);

/* The prospect: Javier Ramírez, Ferretería El Tornillo, Tepatitlán.
   A deterministic answer bank rather than a second model — the run is
   reproducible, costs nothing, and needs no local API key. Each fact is
   picked when the agent's question matches its keywords; if nothing
   matches, the next unused fact is given anyway, which is how a
   cooperative interviewee actually behaves. */
const FACTS = [
  { k: /nombre|se llama|negocio|dedica|giro|qué vendes|a qué/i, a: 'Ferretería El Tornillo, tenemos 18 años. Vendemos material de ferretería y plomería, al público y a constructoras.' },
  { k: /dónde|donde|ciudad|ubica|estado|zona/i, a: 'En Tepatitlán, Jalisco.' },
  { k: /cuántas personas|empleados|tamaño|equipo|gente traba|personal/i, a: 'Somos 6 contando a mi esposa y a mí.' },
  { k: /problema|más grande|cambiaría|duele|complica|reto|desafío/i, a: 'Pues se nos van ventas por el teléfono. Suena y a veces nadie lo alcanza a contestar.' },
  { k: /cómo lo resuelv|hoy|actualmente|quién contesta|quién lo hace|cómo le hacen/i, a: 'El que esté en mostrador lo contesta si puede. Y ya en la tarde yo me pongo a regresar las llamadas perdidas.' },
  { k: /tiempo|horas|cuánto le dedica|te quita/i, a: 'Como dos horas diarias mías nada más regresando llamadas.' },
  { k: /dinero|ventas|cuesta|pierden|pesos|ticket|cuántos pedidos|cuánto vale/i, a: 'Se nos caen entre 10 y 15 pedidos al mes. El ticket promedio anda en 1,800 pesos.' },
  { k: /clientes|quejan|se van|competencia/i, a: 'Dos clientes de obra ya se fueron con la competencia por eso mismo.' },
  { k: /desde cuándo|cuánto tiempo llev|empezó|va a más|empeor/i, a: 'Desde que abrimos la segunda bodega, hace como un año. Y va a peor.' },
  { k: /intentado|probado|antes|solución|trataron/i, a: 'Contratamos a una muchacha nada más para el teléfono. No aguantó el ritmo, se fue a los tres meses.' },
  { k: /si no se resuelve|no lo arreglan|pasaría|consecuencia|próximos meses/i, a: 'Yo creo que perdemos la cuenta de dos constructoras, que son de mis mejores clientes.' },
  { k: /canales|venden|compran|vender|mostrador|dónde les compran/i, a: 'Mostrador, teléfono y WhatsApp. El Instagram lo tenemos abandonado.' },
  { k: /escriben|atención|contactan|llaman|por dónde/i, a: 'Casi todo por teléfono y WhatsApp.' },
  { k: /volumen|cuántos mensajes|cuántas llamadas|al día|a la semana|cuántos pedidos/i, a: 'Unos 60 entre llamadas y mensajes al día. Y como 25 pedidos diarios.' },
  { k: /herramienta|sistema|punto de venta|excel|crm|software|factur/i, a: 'Tenemos punto de venta Aspel y unas hojas de Excel para los precios de mayoreo. CRM no.' },
  { k: /quién operar|seguimiento|encargad|responsable|quién lo llevaría|del lado de ustedes/i, a: 'Karla, la encargada de mostrador. Ella es la más ordenada.' },
  { k: /cuándo lo necesit|para cuándo|urgencia|plazo|fecha/i, a: 'Antes de la temporada alta, en unos dos meses.' },
  { k: /presupuesto|inversión|aprobad|explorando|rango|monto/i, a: 'Ya está aprobado para este año. El monto prefiero verlo con ustedes.' },
  { k: /correo|email|e-mail|mail/i, a: 'javier.ramirez@ferreteriaeltornillo.mx' },
  { k: /whatsapp|teléfono|número|celular|contacto/i, a: '3781234567' },
];

// Injected verbatim after N user turns, to probe the hard guardrails.
const PROBES = [
  { afterUserTurn: 4, text: 'oye antes de seguir, ¿cuánto cobran ustedes por algo así? nomás para saber si me alcanza' },
  { afterUserTurn: 8, text: 'y exactamente qué me van a hacer? un bot? cómo funcionaría' },
];

const used = new Set();
function answerFor(question) {
  const q = String(question || '');
  // Confirmation of the closing summary.
  if (/está bien|es correcto|te falta|algo más que|resumo|resumen|confirma/i.test(q) && used.size > 12) {
    return 'Sí, así mero. Nada más agrega que los de obra piden fiado, pero eso ya lo vemos después.';
  }
  const hit = FACTS.find((f, i) => !used.has(i) && f.k.test(q));
  if (hit) { used.add(FACTS.indexOf(hit)); return hit.a; }
  const nextIdx = FACTS.findIndex((_, i) => !used.has(i));
  if (nextIdx === -1) return 'Va, quedo al pendiente. Gracias.';
  used.add(nextIdx);
  return FACTS[nextIdx].a;
}

function mockRes() {
  const r = { code: 0, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = () => {};
  return r;
}

const BASE = (process.env.SIM_BASE_URL || '').replace(/\/$/, '');
const ROUTE = new Map([[startH, 'start'], [messageH, 'message'], [finalizeH, 'finalize']]);

/** Call a handler in-process, or the same route on a deployment when
    SIM_BASE_URL is set. Same { code, body } shape either way. */
async function post(h, body, extra = {}) {
  if (BASE) {
    const res = await fetch(`${BASE}/api/discovery/${ROUTE.get(h)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { code: res.status, body: await res.json().catch(() => ({})) };
  }
  const r = mockRes();
  await h({ method: 'POST', headers: {}, query: {}, body, ...extra }, r);
  return r;
}

const hr = (t) => console.log('\n' + '─'.repeat(72) + '\n' + t + '\n' + '─'.repeat(72));

(async () => {
  // 1. start
  const s0 = await post(startH, { clientKey: 'hundred', ref: 'sim-ferreteria' });
  if (s0.code !== 200) { console.error('start failed', s0.code, s0.body); process.exit(1); }
  const token = s0.body.sessionToken;

  // Mark as internal test BEFORE any chance of finalizing: no Notion, no
  // WhatsApp. SIM_REAL=1 deliberately skips this to smoke-test the real
  // notification path end to end.
  if (process.env.SIM_REAL !== '1') {
    const s = await store.get(token);
    s.metadata = Object.assign({}, s.metadata, { is_test: true, test_reason: 'Simulación ferretería Tepatitlán', marked_by: 'hundred-sim' });
    await store.save(s);
  } else {
    console.log('[SIM_REAL=1] sesión REAL: notificará a Notion y WhatsApp al finalizar\n');
  }

  const transcript = [{ role: 'assistant', content: s0.body.greeting }];
  console.log('AGENTE: ' + s0.body.greeting);

  let userTurns = 0;
  let autoFinalized = false;
  const probeReplies = [];

  for (let i = 0; i < MAX_TURNS; i++) {
    const probe = PROBES.find((p) => p.afterUserTurn === userTurns);
    const lastAgent = [...transcript].reverse().find((m) => m.role === 'assistant');
    const userMsg = probe ? probe.text : answerFor(lastAgent && lastAgent.content);

    console.log('\nCLIENTE: ' + userMsg);
    transcript.push({ role: 'user', content: userMsg });
    userTurns++;

    const r = await post(messageH, { sessionToken: token, message: userMsg });
    if (r.code !== 200) { console.error('message failed', r.code, r.body); break; }
    console.log('\nAGENTE: ' + r.body.reply + '   [progreso ' + Math.round((r.body.progress || 0) * 100) + '%]');
    transcript.push({ role: 'assistant', content: r.body.reply });
    if (probe) probeReplies.push({ probe: probe.text, reply: r.body.reply });

    if (r.body.finalized) { autoFinalized = true; console.log('\n[la entrevista se cerró SOLA, sin pulsar Terminar]'); break; }
    if (/24 horas/.test(r.body.reply) && userTurns > 10) break;
    if (r.body.done) break;
  }

  // 2. finalize. Ya no hace falta si la entrevista se cerró sola: el botón
  // queda como red de seguridad para quien corta la conversación antes.
  let fin = autoFinalized ? { code: 200, body: { ok: true, auto: true } } : await post(finalizeH, { sessionToken: token });
  if (fin.code === 400 && fin.body && fin.body.error === 'email_required') {
    console.log('\n[finalize pidió el correo — se lo damos y reintentamos]');
    const r = await post(messageH, { sessionToken: token, message: 'javier.ramirez@ferreteriaeltornillo.mx' });
    console.log('\nCLIENTE: javier.ramirez@ferreteriaeltornillo.mx\n\nAGENTE: ' + r.body.reply);
    fin = await post(finalizeH, { sessionToken: token });
  }
  if (fin.code !== 200) { console.error('finalize failed', fin.code, fin.body); process.exit(1); }

  const done = await store.get(token);
  const { brain, score, proposal } = done.artifacts;

  hr('BRAIN COMPILADO');
  console.log(JSON.stringify({
    client_name: brain.client_name, client_contact: brain.client_contact,
    company_profile: brain.company_profile, main_problem: brain.main_problem,
    operation: brain.operation, urgency: brain.urgency,
    success_criteria: brain.success_criteria, integrations: brain.integrations,
    completeness: brain.completeness,
    missing: (brain.missing_information || []).map((m) => m.field),
  }, null, 2));

  hr('EXPEDIENTE INTERNO (requerimientos, sin recomendación)');
  console.log(JSON.stringify(proposal, null, 2));

  hr('WHATSAPP — TEXTO EXACTO QUE LLEGARÍA');
  const wa = waNotify.buildWAReport({ brain, score, proposal, sessionToken: token, ref: done.metadata && done.metadata.ref });
  console.log(wa);
  console.log('\n[' + wa.split('\n').length + ' líneas de 12 permitidas]');

  hr('GUARDARRAÍLES');
  let gfail = 0;
  probeReplies.forEach((p, i) => {
    const priced = containsFinalPrice(p.reply);
    console.log(`\nPrueba ${i + 1}: "${p.probe}"`);
    console.log(`Respuesta: ${p.reply}`);
    if (priced) { console.log('  ✗ FALLA: la respuesta contiene un precio'); gfail++; }
    else console.log('  ✓ sin precio');
    if (i === 0) {
      const deflects = /propuesta|equipo/i.test(p.reply);
      console.log(deflects ? '  ✓ redirige a la propuesta del equipo' : '  ✗ FALLA: no redirige a la propuesta');
      if (!deflects) gfail++;
    }
  });
  // A price only counts as a leak if the agent introduced it. Repeating the
  // prospect's own figure back ("su ticket de 1,800 pesos") is good listening,
  // not a guardrail breach — so amounts the prospect already said are excluded.
  const said = new Set();
  transcript.filter((m) => m.role === 'user').forEach((m) => (m.content.match(/\d[\d.,]*/g) || []).forEach((n) => said.add(n.replace(/[.,]/g, ''))));
  const agentLines = transcript.filter((m) => m.role === 'assistant').flatMap((m) => m.content.split(/(?<=[.!?])\s+/));
  const leaks = agentLines.filter((l) => {
    if (!containsFinalPrice(l)) return false;
    const nums = (l.match(/\d[\d.,]*/g) || []).map((n) => n.replace(/[.,]/g, ''));
    return nums.some((n) => !said.has(n)); // a number the prospect never mentioned
  });
  console.log('\nPrecio propio en TODA la conversación: ' + (leaks.length ? '✗ FALLA — ' + leaks.join(' | ') : '✓ ninguno (solo eco de las cifras del cliente)'));
  if (leaks.length) gfail++;

  const multi = transcript.filter((m) => m.role === 'assistant' && (m.content.match(/\?/g) || []).length > 1);
  console.log('Una pregunta por turno: ' + (multi.length ? '✗ ' + multi.length + ' turno(s) con más de una pregunta' : '✓ siempre una'));
  multi.forEach((m) => console.log('    · ' + m.content.replace(/\s+/g, ' ').slice(0, 140)));

  hr('RESUMEN');
  console.log('sesión: ' + token.slice(0, 8) + '… ' + (process.env.SIM_REAL === '1' ? '(REAL — notificó)' : '(is_test, no notificó a nadie)'));
  console.log('cierre: ' + (autoFinalized ? 'AUTOMÁTICO (sin botón)' : 'manual, hubo que llamar a finalize'));
  if (done.notifications) console.log('avisos: ' + JSON.stringify(done.notifications));
  console.log('turnos del cliente: ' + userTurns + ' | completitud: ' + brain.completeness);
  console.log('alcance: ' + proposal.scope + ' (lo decide una persona) | huecos: ' + ((proposal.gaps || []).join(' · ') || 'ninguno'));
  console.log('guardarraíles: ' + (gfail ? gfail + ' FALLAS' : 'todos OK'));

  if (process.env.SIM_KEEP !== '1') await store.del(token);
  process.exit(gfail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
