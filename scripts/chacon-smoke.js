/* ============================================================
   Pruebas del agente de pedidos de Chacón Alcántara.

   Offline: Redis en memoria, OpenAI y Graph simulados. Cubre las 13
   comprobaciones obligatorias del encargo más el aislamiento entre tenants.

       node scripts/chacon-smoke.js
   ============================================================ */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { Readable } = require('stream');

const ROOT = path.join(__dirname, '..');

/* ---------- Redis en memoria -------------------------------------------- */
const mem = { kv: new Map(), lists: new Map(), sets: new Map(), hashes: new Map() };
const fake = {
  isOpen: true, async connect() {}, on() {},
  async ping() { return 'PONG'; },
  async get(k) { return mem.kv.has(k) ? mem.kv.get(k) : null; },
  async set(k, v, o = {}) { if (o.NX && mem.kv.has(k)) return null; mem.kv.set(k, v); return 'OK'; },
  async del(k) { const n = (mem.kv.delete(k) ? 1 : 0) + (mem.lists.delete(k) ? 1 : 0); return n ? 1 : 0; },
  async incr(k) { const n = Number(mem.kv.get(k) || 0) + 1; mem.kv.set(k, String(n)); return n; },
  async expire() { return 1; },
  async lPush(k, v) { const l = mem.lists.get(k) || []; l.unshift(v); mem.lists.set(k, l); return l.length; },
  async lTrim(k, a, b) { const l = mem.lists.get(k) || []; mem.lists.set(k, l.slice(a, b === -1 ? undefined : b + 1)); },
  async lRange(k, a, b) { const l = mem.lists.get(k) || []; return l.slice(a, b === -1 ? undefined : b + 1); },
  async sAdd(k, v) { const s = mem.sets.get(k) || new Set(); s.add(v); mem.sets.set(k, s); return 1; },
  async sMembers(k) { return [...(mem.sets.get(k) || new Set())]; },
  async hGet(k, f) { return (mem.hashes.get(k) || new Map()).get(f) ?? null; },
  async hSet(k, f, v) { const h = mem.hashes.get(k) || new Map(); h.set(f, v); mem.hashes.set(k, h); return 1; },
  async hGetAll(k) { return Object.fromEntries(mem.hashes.get(k) || new Map()); },
};
require.cache[require.resolve('redis')] = {
  id: require.resolve('redis'), filename: require.resolve('redis'), loaded: true,
  exports: { createClient: () => fake },
};

/* ---------- entorno ------------------------------------------------------ */
const APP_SECRET = 'secreto-de-prueba';
process.env.REDIS_URL = 'redis://fake';
process.env.OPENAI_API_KEY = 'sk-test';
process.env.WHATSAPP_TOKEN = 'token-test';
process.env.META_APP_SECRET = APP_SECRET;
process.env.PANEL_TOKEN = 'panel-chacon-test';
process.env.CHACON_VERIFY_TOKEN = 'verify-chacon-test';
process.env.VERCEL_ENV = 'development';

/* ---------- fetch simulado ---------------------------------------------- */
const SENT = [];
let guion = [];
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/chat/completions')) {
    const body = JSON.parse(opts.body);
    const next = guion.shift();
    const msg = typeof next === 'function' ? next(body.messages) : next;
    return { ok: true, status: 200, async json() { return { choices: [{ message: msg }] }; } };
  }
  if (u.includes('/messages')) {
    const b = JSON.parse(opts.body);
    SENT.push({ to: b.to, text: b.text.body });
    return { ok: true, status: 200, async text() { return '{}'; } };
  }
  throw new Error('fetch no simulado: ' + u);
};

/* ---------- módulos ------------------------------------------------------ */
const repo = require(path.join(ROOT, 'lib/chacon/repo'));
const catalogo = require(path.join(ROOT, 'lib/chacon/catalogo'));
const precios = require(path.join(ROOT, 'lib/chacon/precios'));
const pedidoLib = require(path.join(ROOT, 'lib/chacon/pedido'));
const fabrica = require(path.join(ROOT, 'lib/chacon/fabrica'));
const agente = require(path.join(ROOT, 'lib/chacon/agente'));
const webhook = require(path.join(ROOT, 'api/chacon/webhook'));
const panel = require(path.join(ROOT, 'api/chacon/panel'));

function makeRes() {
  return { statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, send(s) { this.body = s; return this; } };
}
function postReq(payload, { secret = APP_SECRET } = {}) {
  const raw = Buffer.from(JSON.stringify(payload));
  const req = Readable.from([raw]);
  req.method = 'POST'; req.query = {};
  req.headers = { 'content-type': 'application/json',
    'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex') };
  return req;
}
const PNID = '999000111';
function wh(msg) {
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '34999000111', phone_number_id: PNID },
    messages: [msg] } }] }] };
}
let mid = 0;
const textMsg = (from, body, id = null) => ({ id: id || `wamid.C${++mid}`, from, type: 'text', text: { body } });
const texto = (t) => ({ role: 'assistant', content: t });
const toolCall = (nombre, args) => ({ role: 'assistant', content: null,
  tool_calls: [{ id: 'c_' + nombre + (++mid), type: 'function',
    function: { name: nombre, arguments: JSON.stringify(args) } }] });

/* ======================================================================== */
(async () => {
  const fallos = [];
  const check = async (label, fn) => {
    try { await fn(); console.log('  ✅', label); }
    catch (e) { fallos.push(label); console.log('  ❌', label, '→', e.message); }
  };

  console.log('\n=== 1) Importación: invariantes del catálogo ===');
  const P0052 = catalogo.buscar('0052').candidatos[0];

  await check('los ceros iniciales no se alteran', async () => {
    assert.strictEqual(P0052.codigo, '0052');
    assert(catalogo.todos().some((p) => p.codigo === '0001'));
    assert(catalogo.todos().some((p) => p.codigo === '025418'));
  });
  await check('la coma decimal se interpreta correctamente', async () => {
    const p = catalogo.todos().find((x) => x.codigo === '0001');
    assert.strictEqual(p.tarifa, 3.403);           // PDF: "3,403"
    assert.strictEqual(p._original.tarifa, '3,403'); // original conservado
  });
  await check('un alérgeno vacío NO se convierte en "NO"', async () => {
    const vacios = catalogo.todos().filter((p) => p.gluten === null);
    assert.strictEqual(vacios.length, 97);
    assert(!catalogo.todos().some((p) => p._original.gluten === '' && p.gluten === false));
    const t = catalogo.textoAlergeno(vacios[0], 'gluten');
    assert(/No tenemos registrada esa información/.test(t), t);
  });
  await check('un alérgeno informado sí se responde', async () => {
    const conSi = catalogo.todos().find((p) => p.gluten === true);
    assert(/Sí, contiene gluten/.test(catalogo.textoAlergeno(conSi, 'gluten')));
  });

  console.log('\n=== 2) Precios, tarifas y bloqueos ===');
  await check('no se puede vender un código inexistente', async () => {
    const c = await repo.crearCliente({ nombre: 'Tienda Test', telefono: '34600000001' });
    const r = await pedidoLib.anadir(c.id, { producto_id: 'NO-EXISTE#1.1', cantidad: 1, unidad_pedido: 'caja' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'producto_inexistente');
  });
  await check('un código con varios precios queda bloqueado para cálculo', async () => {
    const p = catalogo.buscar('6302').candidatos[0];
    assert.strictEqual(p.estado, 'tariff_variant_unresolved');
    assert.strictEqual(p.nivel_tarifa, 'unknown');
    const l = precios.calcularLinea({ producto: p, cantidad: 1, unidadPedido: 'caja' });
    assert.strictEqual(l.importe_estimado_sin_iva, null);
    assert(l.bloqueos.includes('varios_precios_sin_nivel_identificado'));
    assert.strictEqual(l.estado_linea, 'pendiente_revision');
  });
  await check('pero SÍ se puede buscar y pedir con revisión', async () => {
    const p = catalogo.buscar('6302').candidatos[0];
    assert.strictEqual(p.buscable, true);
    assert.strictEqual(p.permite_solicitud_con_revision, true);
    const v = catalogo.paraMostrar(p);
    assert.strictEqual(v.precio_kg_sin_iva, null);
    assert(v.motivo_precio_bloqueado);
  });
  await check('la promoción SIN CARGO no se vende a 0,001', async () => {
    const p = catalogo.todos().find((x) => x.codigo === 'OF3900');
    assert.strictEqual(p.estado, 'promotion_requires_validation');
    const l = precios.calcularLinea({ producto: p, cantidad: 1, unidadPedido: 'caja' });
    assert.strictEqual(l.importe_estimado_sin_iva, null);
  });
  await check('los 6 productos sin peso quedan bloqueados para peso e importe', async () => {
    const sinPeso = catalogo.todos().filter((p) => p.bloqueado_para_calculo_peso);
    assert.strictEqual(sinPeso.length, 6);
    const l = precios.calcularLinea({ producto: sinPeso[0], cantidad: 1, unidadPedido: 'caja' });
    assert.strictEqual(l.peso_estimado_kg, null);
    assert(l.bloqueos.includes('peso_desconocido'));
  });
  await check('el subtotal es determinista y por kilo', async () => {
    const p = catalogo.todos().find((x) => x.codigo === '0003');   // PIEL DE POLLO, 3,972 €/kg, 5 kg/ud, 1 ud/caja
    const l = precios.calcularLinea({ producto: p, cantidad: 3, unidadPedido: 'caja' });
    assert.strictEqual(l.unidades, 3);
    assert.strictEqual(l.peso_estimado_kg, 15);                    // 3 cajas × 1 ud × 5 kg
    assert.strictEqual(l.importe_estimado_sin_iva, precios.redondear(15 * 3.972, 2));
    assert.strictEqual(l.iva_pct, null);                           // IVA nunca inventado
  });
  await check('el nivel de tarifa lo decide código, y no se inventa', async () => {
    const p = catalogo.todos().find((x) => x.codigo === '0003');
    const una = precios.elegirNivel({ cajas: 1, unidades: 1, und_caja: 1 });
    assert.strictEqual(una.nivel, 3);                              // caja completa
    const varias = precios.elegirNivel({ cajas: 4, unidades: 4, und_caja: 1 });
    assert.strictEqual(varias.nivel, 4);                           // más de una caja
    const fraccion = precios.elegirNivel({ cajas: 0.5, unidades: 6, und_caja: 12 });
    assert.strictEqual(fraccion.determinado, false);               // umbrales sin definir
    assert(fraccion.falta.includes('definicion_de_fraccion_de_caja'));
  });
  await check('nunca se calcula un total con IVA', async () => {
    const p = catalogo.todos().find((x) => x.codigo === '0003');
    const t = precios.totalizar([precios.calcularLinea({ producto: p, cantidad: 1, unidadPedido: 'caja' })]);
    assert.strictEqual(t.iva, null);
    assert.strictEqual(t.total_con_iva, null);
    assert(/sin IVA/i.test(t.nota));
  });

  console.log('\n=== 3) Carrito ===');
  const cli = await repo.crearCliente({ nombre: 'Carnicería Pepe', telefono: '34600000002' });
  await check('el carrito conserva las modificaciones', async () => {
    const p = catalogo.todos().find((x) => x.codigo === '0003');
    await pedidoLib.anadir(cli.id, { producto_id: p.id, cantidad: 2, unidad_pedido: 'caja' });
    let c = await pedidoLib.ver(cli.id);
    assert.strictEqual(c.lineas.length, 1);
    assert.strictEqual(c.lineas[0].cantidad, 2);
    await pedidoLib.anadir(cli.id, { producto_id: p.id, cantidad: 3, unidad_pedido: 'caja' });
    c = await pedidoLib.ver(cli.id);
    assert.strictEqual(c.lineas.length, 1, 'debería acumular, no duplicar');
    assert.strictEqual(c.lineas[0].cantidad, 5);
    await pedidoLib.cambiarCantidad(cli.id, { producto_id: p.id, cantidad: 1 });
    c = await pedidoLib.ver(cli.id);
    assert.strictEqual(c.lineas[0].cantidad, 1);
    await pedidoLib.quitar(cli.id, { producto_id: p.id });
    c = await pedidoLib.ver(cli.id);
    assert.strictEqual(c.lineas.length, 0);
  });
  await check('una unidad ambigua no se añade: se pregunta', async () => {
    const p = catalogo.todos().find((x) => x.codigo === '0003');
    const r = await pedidoLib.anadir(cli.id, { producto_id: p.id, cantidad: 3, unidad_pedido: 'lo que sea' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'unidad_ambigua');
    assert(/3 cajas o 3 unidades/.test(r.pregunta), r.pregunta);
  });
  await check('caja y unidad se distinguen', async () => {
    const p = catalogo.todos().find((x) => x.und_caja > 1 && x.peso_und_kg > 0);
    const porCaja = precios.calcularLinea({ producto: p, cantidad: 1, unidadPedido: 'caja' });
    const porUnidad = precios.calcularLinea({ producto: p, cantidad: 1, unidadPedido: 'unidad' });
    assert.strictEqual(porCaja.unidades, p.und_caja);
    assert.strictEqual(porUnidad.unidades, 1);
    assert(porCaja.peso_estimado_kg > porUnidad.peso_estimado_kg);
  });

  console.log('\n=== 4) Confirmación de pedido ===');
  await check('no se puede confirmar un carrito vacío', async () => {
    const r = await pedidoLib.confirmar(cli.id, {});
    assert.strictEqual(r.ok, false);
    assert(r.problemas.includes('carrito_vacio'));
  });
  let pedidoRef = null;
  await check('un pedido válido se confirma y guarda copia exacta', async () => {
    const p = catalogo.todos().find((x) => x.codigo === '0003');
    await pedidoLib.anadir(cli.id, { producto_id: p.id, cantidad: 2, unidad_pedido: 'caja' });
    const r = await pedidoLib.confirmar(cli.id, { clave_idempotencia: 'wamid.UNO' });
    assert.strictEqual(r.ok, true);
    pedidoRef = r.pedido;
    assert.strictEqual(r.pedido.estado, 'enviada_a_chacon');
    assert.strictEqual(r.pedido.lineas.length, 1);
    assert(r.pedido.version_catalogo.sha256);
    assert.strictEqual(r.mensaje_cliente, pedidoLib.MENSAJE_RECEPCION);
    const c = await pedidoLib.ver(cli.id);
    assert.strictEqual(c.lineas.length, 0, 'el carrito debe vaciarse');
  });
  await check('no se puede confirmar dos veces el mismo pedido', async () => {
    const p = catalogo.todos().find((x) => x.codigo === '0003');
    await pedidoLib.anadir(cli.id, { producto_id: p.id, cantidad: 2, unidad_pedido: 'caja' });
    const r = await pedidoLib.confirmar(cli.id, { clave_idempotencia: 'wamid.UNO' });
    assert.strictEqual(r.idempotente, true);
    assert.strictEqual(r.pedido.id, pedidoRef.id);
  });
  await check('el pedido confirmado conserva su precio histórico', async () => {
    const antes = JSON.parse(JSON.stringify(pedidoRef.lineas));
    // Simula una reimportación que cambia el precio del catálogo en memoria.
    const p = catalogo.porId(antes[0].producto_id);
    const original = p.tarifa;
    p.tarifa = 999;
    const guardado = await repo.getPedido(pedidoRef.id);
    assert.strictEqual(guardado.lineas[0].precio_kg_sin_iva, antes[0].precio_kg_sin_iva);
    assert.notStrictEqual(guardado.lineas[0].precio_kg_sin_iva, 999);
    p.tarifa = original;
  });
  await check('el agente diferencia "enviada" de "aceptada"', async () => {
    assert.strictEqual(pedidoRef.estado, 'enviada_a_chacon');
    assert(!/acept|prepar|disponible/i.test(pedidoLib.MENSAJE_RECEPCION));
    assert(/Hemos recibido tu solicitud/.test(pedidoLib.MENSAJE_RECEPCION));
    assert(pedidoLib.ESTADOS.includes('aceptada') && pedidoLib.ESTADOS.includes('enviada_a_chacon'));
  });

  console.log('\n=== 5) Envío interno a fábrica ===');
  await check('sin destino configurado, el envío es simulado', async () => {
    delete process.env.FACTORY_WHATSAPP_NUMBER;
    const r = await fabrica.enviar(pedidoRef);
    assert.strictEqual(r.simulado, true);
    assert(/PEDIDO PED-/.test(r.texto));
    assert(/SIN IVA/.test(r.texto));
  });
  await check('el pedido interno NUNCA se manda al teléfono de la tienda', async () => {
    process.env.FACTORY_WHATSAPP_NUMBER = pedidoRef.cliente.telefonos[0];
    const r = await fabrica.enviar(pedidoRef);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'destino_igual_al_telefono_del_cliente');
    delete process.env.FACTORY_WHATSAPP_NUMBER;
  });
  await check('el mensaje interno lleva lo que fábrica necesita', async () => {
    const t = fabrica.componerMensaje(pedidoRef);
    for (const campo of [pedidoRef.id, pedidoRef.cliente.nombre, '0003', 'peso est.', '€/kg']) {
      assert(t.includes(campo), `falta "${campo}" en el mensaje interno`);
    }
  });

  console.log('\n=== 6) Webhook: firma, dedupe e idempotencia ===');
  await check('GET devuelve el challenge', async () => {
    const r = makeRes();
    await webhook({ method: 'GET', headers: {}, query: {
      'hub.mode': 'subscribe', 'hub.verify_token': process.env.CHACON_VERIFY_TOKEN, 'hub.challenge': 'RETO' } }, r);
    assert.strictEqual(r.body, 'RETO');
  });
  await check('firma inválida se rechaza en producción', async () => {
    process.env.VERCEL_ENV = 'production';
    const r = makeRes();
    await webhook(postReq(wh(textMsg('34600000003', 'hola')), { secret: 'otro' }), r);
    assert.strictEqual(r.statusCode, 401);
    process.env.VERCEL_ENV = 'development';
  });
  await check('un mensaje repetido no duplica línea ni pedido', async () => {
    const TEL = '34600000004';
    await repo.crearCliente({ nombre: 'Ultramarinos Sur', telefono: TEL });
    const p = catalogo.todos().find((x) => x.codigo === '0003');
    const msg = textMsg(TEL, 'ponme 2 cajas de piel de pollo', 'wamid.REPE');

    guion = [toolCall('anadir_al_carrito', { producto_id: p.id, cantidad: 2, unidad_pedido: 'caja' }),
             texto('Anotado: 2 cajas de piel de pollo.')];
    let r = makeRes(); await webhook(postReq(wh(msg)), r);
    const c1 = await pedidoLib.ver((await repo.clientePorTelefono(TEL)).id);

    guion = [toolCall('anadir_al_carrito', { producto_id: p.id, cantidad: 2, unidad_pedido: 'caja' }),
             texto('Anotado otra vez.')];
    r = makeRes(); await webhook(postReq(wh(msg)), r);   // MISMO wamid
    const c2 = await pedidoLib.ver((await repo.clientePorTelefono(TEL)).id);

    assert.strictEqual(c2.lineas.length, c1.lineas.length, 'el dedupe falló');
    assert.strictEqual(c2.lineas[0].cantidad, c1.lineas[0].cantidad, 'la línea se duplicó');
  });

  console.log('\n=== 7) Agente: no inventa, y no confirma lo ambiguo ===');
  await check('sin tienda identificada no se opera el carrito', async () => {
    const ctx = { telefono: '34600000099', clienteId: null, consultasAlergenoSinDato: [] };
    const r = await agente.ejecutar(ctx, 'ver_carrito', {});
    assert.strictEqual(r.error, 'tienda_no_identificada');
  });
  await check('tiendas con nombre parecido no se eligen solas', async () => {
    await repo.crearCliente({ nombre: 'Casa Manolo', telefono: '34600000005' });
    const ctx = { telefono: '34600000006', clienteId: null, consultasAlergenoSinDato: [] };
    const r = await agente.ejecutar(ctx, 'identificar_tienda', { nombre: 'Casa Manolo' });
    assert.strictEqual(r.requiere_aclaracion, true);
    assert(r.candidatas.length >= 1);
  });
  await check('la consulta de alérgenos sin dato se registra', async () => {
    const p = catalogo.todos().find((x) => x.gluten === null);
    const ctx = { telefono: '34600000007', clienteId: 'CLI-1', consultasAlergenoSinDato: [] };
    const r = await agente.ejecutar(ctx, 'consultar_alergenos', { producto_id: p.id, alergeno: 'gluten' });
    assert.strictEqual(r.dato_disponible, false);
    assert.strictEqual(ctx.consultasAlergenoSinDato.length, 1);
  });
  await check('el prompt prohíbe afirmar stock e inventar precios', async () => {
    const sys = agente.systemPrompt({ cliente: null });
    assert(/no tenemos datos de stock/i.test(sys));
    assert(/nunca muestres un total con iva/i.test(sys));
    assert(/por kilo/i.test(sys));
  });

  console.log('\n=== 8) Panel ===');
  await check('sin token → 403', async () => {
    const r = makeRes();
    await panel({ method: 'GET', headers: {}, query: {} }, r);
    assert.strictEqual(r.statusCode, 403);
  });
  await check('con token muestra pedidos, conflictos y config pendiente', async () => {
    for (const v of ['pedidos', 'conflictos', 'config', 'clientes', 'catalogo']) {
      const r = makeRes();
      await panel({ method: 'GET', headers: {}, query: { token: process.env.PANEL_TOKEN, v } }, r);
      assert.strictEqual(r.statusCode, 200, `vista ${v}`);
    }
    const r = makeRes();
    await panel({ method: 'GET', headers: {}, query: { token: process.env.PANEL_TOKEN, v: 'conflictos' } }, r);
    assert(r.body.includes('6302'), 'el panel no lista los conflictos de tarifa');
  });

  console.log('\n=== 9) Aislamiento entre tenants ===');
  await check('Chacón y Sanmi no comparten claves de Redis', async () => {
    const claves = [...mem.kv.keys(), ...mem.lists.keys(), ...mem.sets.keys(), ...mem.hashes.keys()];
    const deChacon = claves.filter((k) => k.startsWith('ch:'));
    const deSanmi = claves.filter((k) => k.startsWith('wa:'));
    assert(deChacon.length > 0, 'Chacón no escribió nada');
    // `wa:seen:*` es el dedupe compartido a propósito (mismo webhook de Meta).
    assert(deSanmi.every((k) => k.startsWith('wa:seen:') || k.startsWith('wa:chacon:')),
      'Chacón escribió en el namespace de Sanmi: ' + deSanmi.filter((k) => !k.startsWith('wa:seen:')).join(', '));
  });
  await check('el módulo de Chacón no modifica el de Sanmi', async () => {
    const agenteSanmi = require(path.join(ROOT, 'lib/wa/agent'));
    assert(typeof agenteSanmi.handleMessage === 'function');
    assert(!Object.keys(require(path.join(ROOT, 'lib/chacon/agente'))).includes('handleMessage'));
  });

  console.log('\n' + '='.repeat(64));
  if (fallos.length) {
    console.log('❌ Fallaron', fallos.length, 'comprobaciones:');
    fallos.forEach((f) => console.log('   -', f));
    process.exit(1);
  }
  console.log('✅ Chacón: todas las comprobaciones en verde.');
  console.log('='.repeat(64));
})().catch((e) => { console.error(e); process.exit(1); });
