/* ============================================================
   Smoke test del agente de WhatsApp en Vercel (api/wa/*).

   Corre offline: Redis en memoria, OpenAI y Graph simulados. Ejercita
   enrutado multi-tenant, firma de Meta, dedupe, memoria, tools, folio,
   escalado, límite de audios y panel. Además verifica que las rutas que
   ya existían del sitio siguen cargando.

       node scripts/wa-smoke.js
   ============================================================ */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { Readable } = require('stream');

const ROOT = path.join(__dirname, '..');

/* ---------- Redis en memoria (subconjunto usado por lib/wa/store) -------- */
const mem = { kv: new Map(), lists: new Map() };
const fakeRedis = {
  isOpen: true,
  async connect() {},
  on() {},
  async ping() { return 'PONG'; },
  async get(k) { return mem.kv.has(k) ? mem.kv.get(k) : null; },
  async set(k, v, opts = {}) {
    if (opts.NX && mem.kv.has(k)) return null;
    mem.kv.set(k, v);
    return 'OK';
  },
  async del(k) { mem.kv.delete(k); mem.lists.delete(k); },
  async incr(k) {
    const n = Number(mem.kv.get(k) || 0) + 1;
    mem.kv.set(k, String(n));
    return n;
  },
  async expire() { return 1; },
  async lPush(k, v) {
    const l = mem.lists.get(k) || [];
    l.unshift(v);
    mem.lists.set(k, l);
    return l.length;
  },
  async lTrim(k, a, b) {
    const l = mem.lists.get(k) || [];
    mem.lists.set(k, l.slice(a, b + 1));
  },
  async lRange(k, a, b) {
    const l = mem.lists.get(k) || [];
    return l.slice(a, b === -1 ? undefined : b + 1);
  },
};
require.cache[require.resolve('redis')] = {
  id: require.resolve('redis'),
  filename: require.resolve('redis'),
  loaded: true,
  exports: { createClient: () => fakeRedis },
};

/* ---------- entorno ------------------------------------------------------ */
const APP_SECRET = 'app-secret-de-prueba';
process.env.REDIS_URL = 'redis://fake';
process.env.OPENAI_API_KEY = 'sk-test';
process.env.WHATSAPP_TOKEN = 'graph-token-test';
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-token-largo-de-prueba';
process.env.META_APP_SECRET = APP_SECRET;
process.env.PANEL_TOKEN = 'panel-token-de-prueba';
process.env.VERCEL_ENV = 'development'; // producción exigiría firma válida siempre

/* ---------- fetch simulado (OpenAI + Graph) ------------------------------ */
const SENT = [];      // mensajes que saldrían por Graph
const TOOLS_USED = []; // tools que pidió el modelo
let guion = [];        // respuestas encoladas de OpenAI

const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);

  if (u.includes('/chat/completions')) {
    const body = JSON.parse(opts.body);
    const next = guion.shift();
    const msg = typeof next === 'function' ? next(body.messages) : next;
    return { ok: true, status: 200, async json() { return { choices: [{ message: msg }] }; } };
  }

  if (u.includes('/audio/transcriptions')) {
    return {
      ok: true, status: 200,
      async json() { return { text: 'Hola, ¿a qué hora abren mañana?', duration: 4.2 }; },
    };
  }

  if (u.includes('/messages')) { // Graph: envío de mensaje
    const body = JSON.parse(opts.body);
    SENT.push({ to: body.to, text: body.text.body });
    return { ok: true, status: 200, async text() { return '{}'; } };
  }

  if (u.includes('graph.facebook.com')) { // Graph: media
    if (u.includes('/media-')) {
      return { ok: true, status: 200, async json() { return { url: 'https://cdn.test/a.ogg', mime_type: 'audio/ogg', file_size: 2048 }; } };
    }
    return { ok: true, status: 200, async json() { return { url: 'https://cdn.test/a.ogg', mime_type: 'audio/ogg', file_size: 2048 }; } };
  }

  if (u.startsWith('https://cdn.test/')) {
    return { ok: true, status: 200, async arrayBuffer() { return new ArrayBuffer(2048); } };
  }

  throw new Error('fetch no simulado: ' + u);
};

/* ---------- módulos bajo prueba ------------------------------------------ */
const clientsLib = require(path.join(ROOT, 'lib/wa/clients'));
const store = require(path.join(ROOT, 'lib/wa/store'));
const catalog = require(path.join(ROOT, 'lib/wa/catalog'));
const waLib = require(path.join(ROOT, 'lib/wa/whatsapp'));
const webhook = require(path.join(ROOT, 'api/wa/webhook'));
const leadsApi = require(path.join(ROOT, 'api/wa/leads'));
const healthApi = require(path.join(ROOT, 'api/wa/health'));

/* ---------- helpers req/res --------------------------------------------- */
function makeRes() {
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    send(s) { this.body = s; return this; },
  };
  return res;
}

function postReq(payload, { sign = true, secret = APP_SECRET } = {}) {
  const raw = Buffer.from(JSON.stringify(payload));
  const req = Readable.from([raw]);
  req.method = 'POST';
  req.query = {};
  req.headers = { 'content-type': 'application/json' };
  if (sign) {
    req.headers['x-hub-signature-256'] =
      'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  }
  return req;
}

const SANMI = clientsLib.get('sanmi');
const PNID = SANMI.phone_number_id;

function wh(msg, pnid = PNID) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messaging_product: 'whatsapp', metadata: { phone_number_id: pnid }, messages: [msg] } }] }],
  };
}

let mid = 0;
let FOLIO = null;
function textMsg(from, body) {
  mid += 1;
  return { id: `wamid.T${mid}`, from, type: 'text', text: { body } };
}

/* ---------- guion por defecto de OpenAI ---------------------------------- */
function toolCall(name, args) {
  return {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'call_' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}
function texto(t) { return { role: 'assistant', content: t }; }

/* ======================================================================== */
async function main() {
  const fails = [];
  const ok = (label) => console.log('  ✅', label);
  const check = async (label, fn) => {
    try { await fn(); ok(label); } catch (err) { fails.push(label); console.log('  ❌', label, '→', err.message); }
  };

  console.log('\n=== 1) Registro de clientes y enrutado ===');
  for (const c of clientsLib.all()) {
    console.log(`  - ${c.clave.padEnd(12)} activo=${String(c.activo).padEnd(5)} pnid=${c.phone_number_id} folio=${c.folio_prefix}- productos=${c.productos.length}`);
  }
  await check('sanmi activo, demo-dulces inactivo', async () => {
    assert(SANMI.activo && !clientsLib.get('demo-dulces').activo);
  });
  await check('el número demo enruta a sanmi', async () => {
    assert.strictEqual(clientsLib.resolve(PNID).clave, 'sanmi');
  });
  await check('phone_number_id desconocido → null (no contesta por nadie)', async () => {
    assert.strictEqual(clientsLib.resolve('999999'), null);
  });
  await check('prompt y catálogo empaquetados', async () => {
    assert(SANMI.prompt.length > 500, 'prompt vacío');
    assert.strictEqual(SANMI.productos.length, 96);
  });

  console.log('\n=== 2) Catálogo (paridad con la versión Python) ===');
  const casos = [
    ['pannini arrachera', 'Pannini Arrachera'],
    ['americano', 'Americano Sencillo'],
    ['cafés', 'Frappe Clásico (con café)'], // lleva "café" en el nombre: gana al sinónimo
    ['hamburguesa', 'Burger de Pollo asado'],
    ['pizza', 'Pizza Margarita'],
  ];
  for (const [q, esperado] of casos) {
    const r = catalog.buscar(SANMI, q);
    const primero = r.coincidencias[0] && r.coincidencias[0].nombre;
    console.log(`  ${JSON.stringify(q).padEnd(22)} total=${String(r.total_coincidencias).padStart(3)} → ${primero}`);
    await check(`"${q}" → ${esperado}`, async () => assert.strictEqual(primero, esperado));
  }
  await check('sin campos privados en la salida', async () => {
    const r = catalog.buscar(SANMI, 'cafe');
    for (const p of r.coincidencias) for (const k of Object.keys(p)) assert(!k.startsWith('_'), k);
  });
  await check('info del negocio viaja con el catálogo', async () => {
    const r = catalog.buscar(SANMI, 'americano');
    assert(r.horarios && r.direccion && r.tel_llamadas);
    assert.strictEqual(r.horarios.jueves, 'CERRADO — día de descanso');
  });

  console.log('\n=== 3) Firma X-Hub-Signature-256 ===');
  await check('firma válida se acepta', async () => {
    const raw = Buffer.from('{"a":1}');
    const sig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
    assert(waLib.verifySignature(raw, sig, APP_SECRET).ok);
  });
  await check('firma alterada se rechaza', async () => {
    const raw = Buffer.from('{"a":1}');
    const sig = 'sha256=' + crypto.createHmac('sha256', 'otro-secreto').update(raw).digest('hex');
    assert(!waLib.verifySignature(raw, sig, APP_SECRET).ok);
  });
  await check('sin header se rechaza', async () => {
    assert(!waLib.verifySignature(Buffer.from('{}'), null, APP_SECRET).ok);
  });

  console.log('\n=== 4) GET /api/wa/webhook (verificación de Meta) ===');
  await check('challenge correcto', async () => {
    const res = makeRes();
    await webhook({ method: 'GET', headers: {}, query: { 'hub.mode': 'subscribe', 'hub.verify_token': process.env.WHATSAPP_VERIFY_TOKEN, 'hub.challenge': 'RETO42' } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, 'RETO42');
  });
  await check('verify token malo → 403', async () => {
    const res = makeRes();
    await webhook({ method: 'GET', headers: {}, query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'malo', 'hub.challenge': 'x' } }, res);
    assert.strictEqual(res.statusCode, 403);
  });

  console.log('\n=== 5) POST /api/wa/webhook — pedido con folio ===');
  guion = [
    toolCall('buscar_catalogo', { consulta: 'pannini arrachera' }),
    (msgs) => {
      const tool = msgs.filter((m) => m.role === 'tool').pop();
      const data = JSON.parse(tool.content);
      TOOLS_USED.push(['buscar_catalogo', data.total_coincidencias]);
      assert(data.coincidencias[0].nombre === 'Pannini Arrachera', 'catálogo equivocado');
      return toolCall('registrar_pedido', { clasificacion: 'pedido', resumen: '1 Pannini Arrachera + 1 Americano, Javier Mina 27', total: 129 });
    },
    texto('☕ Pedido Sanmi Café — folio SNM-0001\nTotal: $129\n\n⚠️ Estamos en periodo de pruebas: este pedido es de práctica y no se preparará.'),
  ];
  const PED = '5215559990001';
  const payloadPedido = wh(textMsg(PED, 'un pannini de arrachera y un americano a Javier Mina 27'));
  let res = makeRes();
  await webhook(postReq(payloadPedido), res);
  await check('responde 200 a Meta', async () => assert.strictEqual(res.statusCode, 200));
  await check('contestó al cliente', async () => assert(SENT.some((s) => s.to === PED)));
  console.log('  📤', SENT[SENT.length - 1].text.split('\n')[0]);

  await check('lead con folio bien formado, total 129 y sin duplicar', async () => {
    const rows = await store.listLeads('sanmi', ['sanmi']);
    const ped = rows.find((r) => r.folio);
    assert(ped, 'no se registró folio');
    FOLIO = ped.folio;
    assert(/^SNM-\d{4}$/.test(FOLIO), 'formato de folio: ' + FOLIO);
    assert.strictEqual(ped.total, 129);
    assert.strictEqual(rows.filter((r) => r.folio === FOLIO).length, 1, 'el pedido se escribió duplicado');
    console.log('  📋', FOLIO, '· total', ped.total, '·', ped.resumen);
  });

  console.log('\n=== 6) Dedupe de reintentos de Meta ===');
  await check('mismo message_id no se reprocesa', async () => {
    const antes = SENT.length;
    const r2 = makeRes();
    await webhook(postReq(payloadPedido), r2);
    assert.strictEqual(SENT.length, antes, 'el dedupe falló');
  });

  console.log('\n=== 7) Firma inválida en producción ===');
  await check('VERCEL_ENV=production rechaza firma mala con 401', async () => {
    process.env.VERCEL_ENV = 'production';
    const r3 = makeRes();
    await webhook(postReq(wh(textMsg('5215559990009', 'hola')), { secret: 'secreto-equivocado' }), r3);
    assert.strictEqual(r3.statusCode, 401);
    process.env.VERCEL_ENV = 'development';
  });

  console.log('\n=== 8) Escalado ===');
  guion = [toolCall('escalar_humano', { motivo: 'El cliente pide factura' }), texto('Ya pasé tu solicitud al equipo.')];
  const ESC = '5215559990002';
  res = makeRes();
  await webhook(postReq(wh(textMsg(ESC, 'quiero factura'))), res);
  await check('aviso al equipo con formato y hora CDMX', async () => {
    const aviso = SENT.find((s) => SANMI.human_notify_wa.includes(s.to));
    assert(aviso, 'no salió aviso a human_notify_wa');
    console.log('  📲', aviso.text);
    assert(/^🔔 Sanmi Café — \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} \(CDMX\) — escalado de \+/.test(aviso.text), aviso.text);
  });
  await check('el aviso sale a TODOS los destinos configurados', async () => {
    // Con varios probadores del staff, un solo envío no basta.
    const avisos = SENT.filter((s) => SANMI.human_notify_wa.includes(s.to));
    assert.strictEqual(avisos.length, SANMI.human_notify_wa.length,
      `${avisos.length} avisos para ${SANMI.human_notify_wa.length} destinos`);
  });
  await check('escalado visible en leads', async () => {
    const rows = await store.listLeads('sanmi', ['sanmi']);
    assert(rows.some((r) => r.tipo === 'escalado' && r.phone === ESC));
  });

  console.log('\n=== 9) Memoria entre turnos (Redis) ===');
  guion = [texto('Claro que sí.')];
  res = makeRes();
  await webhook(postReq(wh(textMsg(PED, '¿y a qué hora lo tienen?'))), res);
  await check('el historial persiste por (cliente, teléfono)', async () => {
    const s = await store.getSession('sanmi', PED);
    assert(s.history.length >= 4, `historial corto: ${s.history.length}`);
    assert.strictEqual(s.turns, 2);
  });

  console.log('\n=== 10) Audio y límite diario ===');
  const AUD = '5215559990003';
  guion = [texto('Abrimos mañana a las 8:30.')];
  res = makeRes();
  await webhook(postReq(wh({ id: 'wamid.A1', from: AUD, type: 'audio', audio: { id: 'media-1', mime_type: 'audio/ogg' } })), res);
  await check('audio transcrito llega marcado al agente', async () => {
    const s = await store.getSession('sanmi', AUD);
    const user = s.history.find((h) => h.role === 'user');
    console.log('  📝', user.content);
    assert(user.content.startsWith('[Audio transcrito]:'));
  });
  await check('el 6º audio del día pide texto', async () => {
    for (let i = 2; i <= 6; i += 1) {
      guion = [texto('ok')];
      const r = makeRes();
      await webhook(postReq(wh({ id: `wamid.A${i}`, from: AUD, type: 'audio', audio: { id: `media-${i}` } })), r);
    }
    const last = SENT[SENT.length - 1];
    console.log('  📤', last.text);
    assert(/no puedo procesar más notas de voz/.test(last.text));
  });

  console.log('\n=== 11) Panel /api/wa/leads ===');
  await check('sin token → 403', async () => {
    const r = makeRes();
    await leadsApi({ method: 'GET', headers: {}, query: {} }, r);
    assert.strictEqual(r.statusCode, 403);
  });
  await check('token malo → 403', async () => {
    const r = makeRes();
    await leadsApi({ method: 'GET', headers: {}, query: { token: 'malo' } }, r);
    assert.strictEqual(r.statusCode, 403);
  });
  await check('token correcto → 200 con folio y filtro por cliente', async () => {
    const r = makeRes();
    await leadsApi({ method: 'GET', headers: {}, query: { token: process.env.PANEL_TOKEN, client: 'sanmi' } }, r);
    assert.strictEqual(r.statusCode, 200);
    assert(r.body.includes(FOLIO), 'no aparece el folio ' + FOLIO);
    assert(r.body.includes('Sanmi Café'), 'no aparece el cliente');
    assert(r.body.includes('token='), 'las pestañas perdieron el token');
  });

  console.log('\n=== 12) /api/wa/health ===');
  await check('reporta redis y clientes cargados', async () => {
    const r = makeRes();
    await healthApi({ method: 'GET', headers: {}, query: {} }, r);
    console.log('  status:', r.body.status, '· redis:', r.body.redis.ok, '· clientes_ok:', r.body.clientes_ok);
    assert.strictEqual(r.body.redis.ok, true);
    assert.strictEqual(r.body.clientes_ok, true);
    assert(r.body.clientes.find((c) => c.clave === 'sanmi').productos_catalogo === 96);
  });

  console.log('\n=== 13) Rutas existentes del sitio (no romper nada) ===');
  // Esta lista existe porque una rama creada desde un branch desactualizado
  // borró api/coparmex/* al desplegar. Si un archivo de producción falta, aquí
  // truena antes de llegar a Vercel.
  const existentes = [
    'api/chat.js', 'api/lead.js',
    'api/coparmex/lead.js', 'api/coparmex/leads.js', 'api/coparmex/sync-notion.js',
    'api/discovery/start.js', 'api/discovery/message.js', 'api/discovery/finalize.js',
    'api/discovery/state.js', 'api/discovery/admin.js', 'api/discovery/health.js',
    'api/discovery/recompile.js',
    'lib/notion.js', 'lib/coparmex.js', 'lib/discovery/store.js', 'middleware.js',
  ];
  for (const f of existentes) {
    await check(`carga ${f}`, async () => {
      const mod = require(path.join(ROOT, f));
      assert(mod, 'no exporta nada');
    });
  }
  await check('middleware sigue enrutando subdominios de cliente', async () => {
    const mw = require(path.join(ROOT, 'middleware.js'));
    assert.strictEqual(mw.resolveClientPath('sanmi.thehagentic.com', '/'), '/clientes/sanmi/');
    assert.strictEqual(mw.resolveClientPath('www.thehagentic.com', '/'), null);
  });
  await check('el matcher del middleware excluye /api', async () => {
    const mw = require(path.join(ROOT, 'middleware.js'));
    const re = new RegExp('^' + mw.config.matcher[0] + '$');
    assert(!re.test('/api/wa/webhook'), 'el middleware interceptaría /api/wa/webhook');
    assert(!re.test('/api/discovery/start'), 'el middleware interceptaría /api/discovery');
    assert(re.test('/'), 'el middleware dejó de cubrir la raíz');
  });
  await check('vercel.json declara maxDuration e includeFiles', async () => {
    const v = require(path.join(ROOT, 'vercel.json'));
    assert(v.functions['api/wa/webhook.js'].maxDuration >= 120, 'audio + tools necesita margen');
    assert(v.functions['api/wa/webhook.js'].includeFiles.includes('lib/wa/clients'));
  });
  await check('vercel.json conserva el header del PDF de coparmex', async () => {
    const v = require(path.join(ROOT, 'vercel.json'));
    const h = (v.headers || []).find((x) => x.source.includes('coparmex'));
    assert(h, 'se perdió el Content-Disposition del PDF de coparmex');
  });
  await check('la rama no borra nada que master tenga', async () => {
    const { execSync } = require('child_process');
    const out = execSync('git diff --name-status master...HEAD', { cwd: ROOT }).toString();
    const borrados = out.split('\n').filter((l) => l.startsWith('D\t'));
    assert.strictEqual(borrados.length, 0, 'borra: ' + borrados.join(', '));
  });

  /* ---------------------------------------------------------------- */
  console.log('\n' + '='.repeat(60));
  if (fails.length) {
    console.log('❌ Fallaron', fails.length, 'comprobaciones:');
    for (const f of fails) console.log('   -', f);
    process.exit(1);
  }
  console.log('✅ Smoke completo del agente en Vercel: todo verde.');
  console.log('='.repeat(60));
  global.fetch = realFetch;
}

main().catch((err) => { console.error(err); process.exit(1); });
