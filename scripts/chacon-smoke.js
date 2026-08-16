/* ============================================================
   Pruebas del agente de pedidos de Chacón Alcántara.

   Offline: Redis en memoria, OpenAI y Graph simulados.

   Cubre las comprobaciones obligatorias del encargo, las nueve del MVP
   simplificado (una solicitud de pedido sin una sola cifra económica) y el
   aislamiento entre tenants.

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
  async sRem(k, v) { const st = mem.sets.get(k); return st && st.delete(v) ? 1 : 0; },
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
process.env.CHACON_PHONE_NUMBER_ID = '999000111';   // = PNID, definido más abajo
process.env.VERCEL_ENV = 'development';

/* ---------- fetch simulado ---------------------------------------------- */
const SENT = [];
let guion = [];
let fallarEnvios = false;   // para probar el reintento desde el panel
let TRANSCRIPCION = { text: 'hola', duration: 3 };
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/chat/completions')) {
    const body = JSON.parse(opts.body);
    const next = guion.shift();
    const msg = typeof next === 'function' ? next(body.messages) : next;
    return { ok: true, status: 200, async json() { return { choices: [{ message: msg }] }; } };
  }
  if (u.includes('/audio/transcriptions')) {
    return { ok: true, status: 200, async json() { return TRANSCRIPCION; } };
  }
  if (/graph\.facebook\.com\/v[\d.]+\/MEDIA/.test(u)) {
    return { ok: true, status: 200, async json() {
      return { url: 'https://lookaside.fbsbx.com/fake', mime_type: 'audio/ogg', file_size: 1234 }; } };
  }
  if (u.includes('lookaside.fbsbx.com')) {
    return { ok: true, status: 200, headers: { get: () => 'audio/ogg' },
             async arrayBuffer() { return new ArrayBuffer(1234); } };
  }
  if (u.includes('/messages')) {
    if (fallarEnvios) {
      return { ok: false, status: 400, async text() { return '{"error":{"code":131047}}'; } };
    }
    const b = JSON.parse(opts.body);
    SENT.push({ to: b.to, text: b.text.body });
    const wamid = `wamid.OUT${SENT.length}`;
    return { ok: true, status: 200,
      async text() { return '{}'; },
      async json() { return { messages: [{ id: wamid }] }; } };
  }
  throw new Error('fetch no simulado: ' + u);
};

/* ---------- módulos ------------------------------------------------------ */
const repo = require(path.join(ROOT, 'lib/chacon/repo'));
const catalogo = require(path.join(ROOT, 'lib/chacon/catalogo'));
const precios = require(path.join(ROOT, 'lib/chacon/precios'));
const pedidoLib = require(path.join(ROOT, 'lib/chacon/pedido'));
const ofertas = require(path.join(ROOT, 'lib/chacon/ofertas'));
const consultas = require(path.join(ROOT, 'lib/chacon/consultas'));
const repeticion = require(path.join(ROOT, 'lib/chacon/repeticion'));
const categoriasLib = require(path.join(ROOT, 'lib/chacon/categorias'));
const navegacion = require(path.join(ROOT, 'lib/chacon/navegacion'));
const imagenesLib = require(path.join(ROOT, 'lib/chacon/imagenes'));
const formato = require(path.join(ROOT, 'lib/chacon/wa-formato'));
const carritoNativo = require(path.join(ROOT, 'lib/chacon/carrito-nativo'));
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
const audioMsg = (from, id = null) => ({ id: id || `wamid.A${++mid}`, from, type: 'audio',
  audio: { id: 'MEDIA' + (++mid), mime_type: 'audio/ogg', voice: true } });
/** Mensaje `order`: lo que manda WhatsApp al pulsar "Realizar pedido". */
const orderMsg = (from, items, id = null) => ({ id: id || `wamid.O${++mid}`, from,
  type: 'order',
  order: { catalog_id: 'CAT_CHACON_TEST', text: '',
           product_items: items.map((i) => ({ product_retailer_id: i.cod, quantity: i.n,
             item_price: i.precio ?? 0, currency: 'EUR' })) } });
const clicMsg = (from, botonId, id = null) => ({ id: id || `wamid.I${++mid}`, from,
  type: 'interactive',
  interactive: { type: 'button_reply', button_reply: { id: botonId, title: botonId } } });
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

  console.log('\n=== 2) Estructura técnica de precios (existe, pero fuera del flujo) ===');
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
    assert.strictEqual(l.precio_kg_sin_iva, null);
    assert.strictEqual(l.importe_estimado_sin_iva, null);
    assert.strictEqual(l.precio_pendiente_de_confirmacion, true);
    assert(l.bloqueos.includes('varios_precios_sin_nivel_identificado'));
    assert.strictEqual(l.estado_linea, 'pendiente_revision');
  });
  await check('pero SÍ se puede buscar y pedir con revisión', async () => {
    const p = catalogo.buscar('6302').candidatos[0];
    assert.strictEqual(p.buscable, true);
    assert.strictEqual(p.permite_solicitud_con_revision, true);
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
  await check('el MVP usa siempre la Tarifa 1 y no elige tramo', async () => {
    const p = catalogo.todos().find((x) => x.codigo === '0003');
    for (const cant of [0.5, 1, 3, 7]) {
      const l = precios.calcularLinea({ producto: p, cantidad: cant, unidadPedido: 'caja' });
      assert.strictEqual(l.nivel_tarifa, precios.TARIFA_MVP);
      assert.strictEqual(l.nivel_tarifa, 1);
      assert(!l.bloqueos.includes('nivel_de_tarifa_indeterminado'),
        'el tramo ya no puede bloquear: el PDF es la Tarifa 1');
    }
  });
  await check('las tarifas 2-8 siguen modeladas para más adelante', async () => {
    assert.strictEqual(precios.NIVELES.length, 8);
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
    assert(/NUEVA SOLICITUD DE PEDIDO/.test(r.texto));
    assert(/Productos con precio confirmado/.test(r.texto));
  });
  await check('la solicitud interna NUNCA se manda al teléfono de la tienda', async () => {
    process.env.FACTORY_WHATSAPP_NUMBER = pedidoRef.cliente.telefonos[0];
    const r = await fabrica.enviar(pedidoRef);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'destino_igual_al_telefono_del_cliente');
    delete process.env.FACTORY_WHATSAPP_NUMBER;
  });
  await check('si el destino es el propio número emisor, no se intenta y se avisa', async () => {
    process.env.CHACON_WHATSAPP_SENDER_NUMBER = '34999000111';
    process.env.FACTORY_WHATSAPP_NUMBER = '+34 999 000 111';   // mismo número, otro formato
    const antes = SENT.length;
    const r = await fabrica.enviar(pedidoRef);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'destino_igual_al_numero_emisor');
    assert(/no puede enviarse mensajes a sí mismo/i.test(r.aviso_configuracion), r.aviso_configuracion);
    assert.strictEqual(SENT.length, antes, 'no debía intentarse el envío');
    const guardado = await repo.getPedido(pedidoRef.id);
    assert.strictEqual(guardado.envio_interno.estado, 'bloqueado_por_configuracion');
    delete process.env.FACTORY_WHATSAPP_NUMBER;
    delete process.env.CHACON_WHATSAPP_SENDER_NUMBER;
  });
  await check('el destinatario se configura por entorno, nunca en el código', async () => {
    const fuente = require('fs').readFileSync(path.join(ROOT, 'lib/chacon/fabrica.js'), 'utf8');
    assert(!/\d{9,}/.test(fuente), 'hay un número de teléfono escrito en fabrica.js');
    assert(fuente.includes('FACTORY_WHATSAPP_NUMBER'));
    const ejemplo = require('fs').readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    assert(/^FACTORY_WHATSAPP_NUMBER=$/m.test(ejemplo), '.env.example no debe llevar el número real');
    assert(/^FACTORY_CONTACT_NAME=$/m.test(ejemplo));
    assert(!/\d{9,}/.test(ejemplo), 'hay un teléfono real en .env.example');
  });
  await check('un 200 del proveedor NO marca la solicitud como recibida', async () => {
    process.env.FACTORY_WHATSAPP_NUMBER = '34600000999';
    const r = await fabrica.enviar(pedidoRef);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.entregado, false, 'aceptado no es entregado');
    const tras200 = await repo.getPedido(pedidoRef.id);
    assert.strictEqual(tras200.envio_interno.entregado, false);
    assert.strictEqual(tras200.envio_interno.estado, 'aceptado_por_proveedor');

    // Solo el estado del proveedor puede marcarla como entregada.
    await fabrica.confirmarEntrega(r.wamid, 'delivered');
    const trasWebhook = await repo.getPedido(pedidoRef.id);
    assert.strictEqual(trasWebhook.envio_interno.entregado, true);
    delete process.env.FACTORY_WHATSAPP_NUMBER;
  });
  await check('un envío fallido conserva el pedido y se puede reintentar', async () => {
    process.env.FACTORY_WHATSAPP_NUMBER = '34600000998';
    fallarEnvios = true;
    const r = await fabrica.enviar(pedidoRef);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'envio_fallido');
    assert(await repo.getPedido(pedidoRef.id), 'el pedido no puede perderse');
    const tras = await repo.getPedido(pedidoRef.id);
    assert.strictEqual(tras.envio_interno.estado, 'fallido');
    assert(tras.envio_interno.intentos.length >= fabrica.MAX_INTENTOS);

    fallarEnvios = false;
    const re = await fabrica.reintentar(pedidoRef.id);
    assert.strictEqual(re.ok, true);
    delete process.env.FACTORY_WHATSAPP_NUMBER;
  });

  console.log('\n=== 6) Webhook: firma, dedupe e idempotencia ===');
  await check('GET devuelve el challenge', async () => {
    const r = makeRes();
    await webhook({ method: 'GET', headers: {}, query: {
      'hub.mode': 'subscribe', 'hub.verify_token': process.env.CHACON_VERIFY_TOKEN, 'hub.challenge': 'RETO' } }, r);
    assert.strictEqual(r.body, 'RETO');
  });
  await check('no contesta por un phone_number_id que no es el suyo', async () => {
    const TEL = '34600000077';
    const otro = JSON.parse(JSON.stringify(wh(textMsg(TEL, 'hola', 'wamid.OTRONUM'))));
    otro.entry[0].changes[0].value.metadata.phone_number_id = '000-de-otro-negocio';
    const antes = SENT.length;
    guion = [texto('no debería llegar aquí')];
    const r = makeRes();
    await webhook(postReq(otro), r);
    assert.strictEqual(r.statusCode, 200, 'a Meta siempre se le responde 200');
    assert.strictEqual(SENT.length, antes, 'no puede contestar por otro número');
    assert.strictEqual(await repo.clientePorTelefono(TEL), null, 'ni dar de alta la tienda');
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
  await check('el saludo se identifica como Chacón y es literal', async () => {
    // Sin esto el modelo redacta un "¿en qué puedo ayudarte?" genérico y la
    // tienda no sabe con quién habla.
    const sys = agente.systemPrompt({ cliente: null });
    assert(/responde EXACTAMENTE esto/.test(sys), 'el saludo no puede quedar al criterio del modelo');
    assert(/Soy el asistente de pedidos de Chacón Alcántara/.test(sys), sys.slice(0, 400));
    assert(/1\. Repetir último pedido/.test(sys));
    assert(/2\. Ver catálogo/.test(sys));
    assert(/3\. Precios y ofertas/.test(sys));
    assert(/sáltate el saludo/.test(sys), 'no debe saludar si ya traen pedido');
    assert(/atajos, no un menú obligatorio/i.test(sys),
      'los accesos son ayudas: el cliente puede escribir o mandar audio cuando quiera');

    // Con la tienda ya identificada, la saluda por su nombre.
    const conTienda = agente.systemPrompt({ cliente: { nombre: 'Carnicería Pepe' } });
    assert(/Hola, Carnicería Pepe\. ¿Qué necesitas hoy\?/.test(conTienda), conTienda.slice(0, 500));
  });
  await check('el prompt fija Tarifa 1, prohíbe stock y prohíbe inventar cifras', async () => {
    const sys = agente.systemPrompt({ cliente: null });
    assert(/no tenemos datos de stock/i.test(sys));
    assert(/\*\*solo con la Tarifa 1\*\*/i.test(sys), 'el prompt debe fijar la Tarifa 1');
    assert(/por kilo y sin/i.test(sys));
    assert(/Escribir una cifra que no venga de una herramienta/i.test(sys));
    assert(/Dar un total definitivo/i.test(sys));
    assert(/Prometer una fecha de entrega/i.test(sys));
    assert(/Repetir último pedido/i.test(sys), 'faltan los accesos rápidos del saludo');
    assert(/Un precio bajo \*\*no es una oferta\*\*/i.test(sys));
    assert(/CONFIRMAR para enviar la solicitud/i.test(sys));
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

  console.log('\n=== 9) Consulta de precios de Tarifa 1 ===');

  const PIEL = catalogo.todos().find((x) => x.codigo === '0003');       // 3,972 €/kg · 5 kg/ud · 1 ud/caja
  const DUP = catalogo.buscar('6302').candidatos[0];                    // dos precios en el PDF
  const OF3900 = catalogo.todos().find((x) => x.codigo === 'OF3900');
  const SINPESO = catalogo.todos().find((x) => x.bloqueado_para_calculo_peso && !x.bloqueado_para_calculo_precio);

  await check('01· consulta de precio por código', async () => {
    const r = await consultas.consultarPrecio('0003');
    assert.strictEqual(r.encontrado, true);
    assert.strictEqual(r.precio_disponible, true);
    assert.strictEqual(r.codigo, '0003');
    assert.strictEqual(r.precio_kg_sin_iva, 3.972);
    assert(/^El precio de Tarifa 1 de .+ es 3,972 €\/kg, sin IVA\./.test(r.respuesta_exacta), r.respuesta_exacta);
  });

  await check('02· consulta por nombre aproximado', async () => {
    const r = await consultas.consultarPrecio('piel de pollo');
    assert.strictEqual(r.encontrado, true);
    // O responde el precio, o pregunta cuál es: nunca elige a ciegas.
    if (r.requiere_aclaracion) assert(r.candidatos.length > 1);
    else assert.strictEqual(r.precio_disponible, true);
    const conErrata = await consultas.consultarPrecio('piel de poyo');
    assert.strictEqual(conErrata.encontrado, true, 'debe tolerar erratas');
  });

  await check('03· el precio se da en €/kg y sin IVA, con su ficha', async () => {
    const r = await consultas.consultarPrecio('0003');
    assert(/€\/kg/.test(r.respuesta_exacta));
    assert(/sin IVA/.test(r.respuesta_exacta));
    assert(!/con IVA|IVA incluido/i.test(r.respuesta_exacta));
    assert(new RegExp(`Código ${PIEL.codigo}`).test(r.respuesta_exacta), r.respuesta_exacta);
    assert(/uds\/caja/.test(r.respuesta_exacta));
    assert(/kg por unidad/.test(r.respuesta_exacta));
  });

  await check('04· importe aproximado de una unidad', async () => {
    const r = await consultas.consultarPrecio('0003', { cantidad: 1, unidad: 'unidad' });
    assert.strictEqual(r.estimacion.calculable, true);
    assert.strictEqual(r.estimacion.peso_estimado_kg, PIEL.peso_und_kg);
    assert.strictEqual(r.estimacion.importe_estimado_sin_iva,
      precios.redondear(PIEL.peso_und_kg * PIEL.tarifa, 2));
    assert(/importe estimado/i.test(r.respuesta_exacta));
    assert(/se ajustará al peso real/i.test(r.respuesta_exacta), 'falta la advertencia del peso real');
  });

  await check('05· importe aproximado de una caja', async () => {
    const conCaja = catalogo.todos().find((x) => x.und_caja > 1 && x.peso_und_kg > 0
      && !x.bloqueado_para_calculo_precio);
    const r = await consultas.precioDe(conCaja, { cantidad: 1, unidad: 'caja' });
    assert.strictEqual(r.estimacion.calculable, true);
    assert.strictEqual(r.estimacion.unidades, conCaja.und_caja);
    assert.strictEqual(r.estimacion.importe_estimado_sin_iva,
      precios.redondear(conCaja.und_caja * conCaja.peso_und_kg * conCaja.tarifa, 2));
    assert(/Cada caja contiene/.test(r.respuesta_exacta), r.respuesta_exacta);
    assert(/sin IVA/.test(r.respuesta_exacta));
  });

  await check('06· sin peso fiable NO se estima el importe', async () => {
    assert(SINPESO, 'hace falta un artículo con precio y sin peso');
    const r = await consultas.precioDe(SINPESO, { cantidad: 1, unidad: 'caja' });
    assert.strictEqual(r.precio_disponible, true, 'el precio sí se conoce');
    assert.strictEqual(r.estimacion.calculable, false);
    assert.strictEqual(r.estimacion.motivo, 'peso_desconocido');
    assert(/no puedo estimarte el importe/i.test(r.respuesta_exacta), r.respuesta_exacta);
    assert(!/importe estimado de/i.test(r.respuesta_exacta), 'no puede colarse una estimación');
  });

  await check('07· un precio repetido sin clasificar no se enseña', async () => {
    const r = await consultas.precioDe(DUP);
    assert.strictEqual(r.precio_disponible, false);
    assert.strictEqual(r.respuesta_exacta, consultas.MENSAJE_PRECIO_SIN_RESOLVER);
    assert(/necesito que Chacón Alcántara confirme cuál está vigente/.test(r.respuesta_exacta));
    // No puede filtrarse ninguno de los dos precios del PDF.
    const json = JSON.stringify(r);
    for (const p of catalogo.todos().filter((x) => x.codigo === DUP.codigo)) {
      assert(!json.includes(String(p.tarifa)), `se filtró el precio ${p.tarifa}`);
    }
    assert.strictEqual(r.puede_pedirse, true, 'debe poder pedirse igualmente');
  });

  await check('07b· toda consulta de precio devuelve SIEMPRE una frase', async () => {
    // Un `respuesta_exacta` undefined hace que el agente conteste
    // literalmente "undefined". Pasó de verdad con el código 6302: la
    // comprobación usaba un nombre de tipo de búsqueda que no existe.
    for (const q of ['6302', '0003', 'piel de pollo', 'queso', 'OF3900',
                     'chorizo', 'lomo', '30201', 'xyz-no-existe']) {
      const r = await consultas.consultarPrecio(q);
      if (!r.encontrado) { assert(r.nota, `"${q}" sin nota`); continue; }
      assert(typeof r.respuesta_exacta === 'string' && r.respuesta_exacta.length > 10,
        `"${q}" devolvió respuesta_exacta = ${r.respuesta_exacta}`);
      assert(!/undefined|null|NaN/.test(r.respuesta_exacta), `"${q}": ${r.respuesta_exacta}`);
    }
  });

  console.log('\n=== 10) Ofertas ===');

  await check('08· una oferta sin validar NUNCA se muestra', async () => {
    // Precio de oferta cargado, pero sin firma de administrador.
    await repo.guardarPrecio({ ...ofertas.vacio(PIEL.id),
      standard_price_per_kg: 3.972, offer_price_per_kg: 2.5, offer_active: true });
    const est = ofertas.estadoOferta(await ofertas.get(PIEL.id));
    assert.strictEqual(est.visible, false);
    assert.strictEqual(est.motivo, 'sin_validar_por_administrador');
    assert.strictEqual((await ofertas.activas()).length, 0);
    const r = await consultas.precioDe(PIEL);
    assert.strictEqual(r.precio_kg_sin_iva, 3.972, 'debe seguir el precio normal');
    assert.strictEqual(r.es_oferta, false);

    // Validada pero desactivada: tampoco.
    await ofertas.guardar(PIEL.id, { offer_active: false }, { por: 'Fernando' });
    assert.strictEqual(ofertas.estadoOferta(await ofertas.get(PIEL.id)).motivo, 'desactivada');

    // Validada, activa, pero caducada: tampoco.
    await ofertas.guardar(PIEL.id, { offer_active: true, offer_end_date: '2020-01-01' }, { por: 'Fernando' });
    assert.strictEqual(ofertas.estadoOferta(await ofertas.get(PIEL.id)).motivo, 'caducada');
  });

  await check('09· OF3900 no se presenta como oferta activa', async () => {
    assert.strictEqual(OF3900.estado, 'promotion_requires_validation');
    // Aunque alguien le cargue una oferta válida, sigue fuera del listado:
    // sus condiciones no están definidas.
    await ofertas.guardar(OF3900.id, { offer_price_per_kg: 0.001, offer_active: true }, { por: 'Fernando' });
    assert(!(await ofertas.activas()).some((o) => o.codigo === 'OF3900'));
    const r = await consultas.precioDe(OF3900);
    assert.strictEqual(r.precio_disponible, false);
    assert.strictEqual(r.respuesta_exacta, consultas.MENSAJE_PROMOCION_SIN_CONDICIONES);
    assert.strictEqual(r.puede_pedirse, false, 'no puede pedirse hasta que definan condiciones');
  });

  await check('10· sin ofertas activas responde la frase acordada', async () => {
    await ofertas.guardar(PIEL.id, { offer_active: false }, { por: 'Fernando' });
    const r = await consultas.consultarOfertas();
    assert.strictEqual(r.hay_ofertas, false);
    assert.strictEqual(r.respuesta_exacta, consultas.MENSAJE_SIN_OFERTAS);
    assert(/no tengo ninguna oferta activa registrada/.test(r.respuesta_exacta));
  });

  await check('11· con ofertas activas se listan solo esas', async () => {
    await ofertas.guardar(PIEL.id, {
      standard_price_per_kg: 3.972, offer_price_per_kg: 2.5, offer_active: true,
      offer_start_date: '2020-01-01', offer_end_date: '2099-12-31',
      offer_conditions: 'Hasta fin de existencias',
    }, { por: 'Fernando' });

    const r = await consultas.consultarOfertas();
    assert.strictEqual(r.hay_ofertas, true);
    assert.strictEqual(r.total, 1, 'solo la que está validada y activa');
    assert.strictEqual(r.ofertas[0].codigo, '0003');
    assert(/2,5 €\/kg sin IVA/.test(r.respuesta_exacta), r.respuesta_exacta);
    assert(/habitual 3,972/.test(r.respuesta_exacta));
    assert(/Hasta fin de existencias/.test(r.respuesta_exacta));

    // Y el precio del producto pasa a ser el de oferta, con su firma.
    const pr = await consultas.precioDe(PIEL);
    assert.strictEqual(pr.precio_kg_sin_iva, 2.5);
    assert.strictEqual(pr.es_oferta, true);
    assert.strictEqual((await ofertas.get(PIEL.id)).offer_validated_by, 'Fernando');

    // Y llega al carrito como oferta.
    const ofCli = await repo.crearCliente({ nombre: 'Tienda Oferta', telefono: '34600000020' });
    const a = await pedidoLib.anadir(ofCli.id, { producto_id: PIEL.id, cantidad: 1, unidad_pedido: 'caja' });
    assert.strictEqual(a.linea.precio_kg_sin_iva, 2.5);
    assert.strictEqual(a.linea.es_oferta, true);
  });

  await check('11b· una oferta con cantidad mínima no se aplica por debajo', async () => {
    await ofertas.guardar(PIEL.id, { offer_min_quantity: 5, offer_unit: 'caja' }, { por: 'Fernando' });
    const poco = await ofertas.precioVigente(PIEL, { cantidad: 2, unidad: 'caja' });
    assert.strictEqual(poco.es_oferta, false);
    assert.strictEqual(poco.precio_kg, 3.972);
    const bastante = await ofertas.precioVigente(PIEL, { cantidad: 5, unidad: 'caja' });
    assert.strictEqual(bastante.es_oferta, true);
    assert.strictEqual(bastante.precio_kg, 2.5);
    await ofertas.guardar(PIEL.id, { offer_min_quantity: '', offer_unit: '' }, { por: 'Fernando' });
  });

  await check('11c· resolver un precio repetido lo desbloquea', async () => {
    let l = precios.calcularLinea({ producto: DUP, cantidad: 1, unidadPedido: 'caja' });
    assert.strictEqual(l.precio_kg_sin_iva, null);

    await ofertas.guardar(DUP.id, { standard_price_per_kg: 21 }, { por: 'Fernando', nota: 'vigente según Chacón' });
    const vig = await ofertas.precioVigente(DUP);
    assert.strictEqual(vig.precio_kg, 21);
    assert.strictEqual(vig.origen, 'tarifa_1_resuelta_por_administrador');

    const r = await consultas.precioDe(DUP);
    assert.strictEqual(r.precio_disponible, true);
    assert(/21,00 €\/kg, sin IVA/.test(r.respuesta_exacta), r.respuesta_exacta);

    l = precios.calcularLinea({ producto: DUP, cantidad: 1, unidadPedido: 'caja',
      precioAplicado: { precio_kg: 21, es_oferta: false, origen: vig.origen } });
    assert.strictEqual(l.precio_kg_sin_iva, 21);
    assert.strictEqual(l.precio_pendiente_de_confirmacion, false);
    // Y queda rastro de quién lo decidió y cuándo.
    const regDup = await ofertas.get(DUP.id);
    assert(regDup.historial.length >= 1, 'debe quedar historial de la decisión');
    assert.strictEqual(regDup.historial[0].por, 'Fernando');
    assert.strictEqual(regDup.historial[0].nota, 'vigente según Chacón');
  });

  console.log('\n=== 11) Repetir un pedido anterior ===');

  const repCli = await repo.crearCliente({ nombre: 'Carnicería Repite', telefono: '34600000030' });

  await check('12· sin historial se responde la frase acordada, sin inventar nada', async () => {
    const r = await repeticion.preparar(repCli.id, {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'sin_historial');
    assert.strictEqual(r.respuesta_exacta, repeticion.MENSAJE_SIN_HISTORIAL);
    assert(/Todavía no tengo registrado tu pedido anterior/.test(r.respuesta_exacta));
  });

  let pedidoPrevio = null;
  let OTRO = null;
  await check('13· se repite el último pedido con su fecha e identificador', async () => {
    // El pedido previo se hace con la oferta APAGADA, para que en la prueba 15
    // se pueda comprobar el aviso de cambio de precio.
    await ofertas.guardar(PIEL.id, { offer_active: false }, { por: 'Fernando' });
    OTRO = catalogo.todos().find((x) => x.codigo !== PIEL.codigo
      && !x.bloqueado_para_calculo_precio && x.peso_und_kg > 0);

    await pedidoLib.anadir(repCli.id, { producto_id: PIEL.id, cantidad: 2, unidad_pedido: 'caja' });
    await pedidoLib.anadir(repCli.id, { producto_id: OTRO.id, cantidad: 1, unidad_pedido: 'caja' });
    const conf = await pedidoLib.confirmar(repCli.id, { clave_idempotencia: 'wamid.REP1' });
    pedidoPrevio = conf.pedido;
    assert.strictEqual(pedidoPrevio.lineas.length, 2);
    assert.strictEqual(pedidoPrevio.lineas[0].precio_kg_sin_iva, 3.972, 'sin oferta activa');

    const r = await repeticion.preparar(repCli.id, {});
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.pedido_origen.id, pedidoPrevio.id);
    assert(r.pedido_origen.fecha, 'hay que poder decirle al cliente de cuándo era');
    const c = await pedidoLib.ver(repCli.id);
    assert.strictEqual(c.lineas.length, 2);
    assert.strictEqual(c.repite_pedido, pedidoPrevio.id);
  });

  await check('14· repetición con modificaciones: doble, quitar y añadir', async () => {
    const doble = await repeticion.preparar(repCli.id, {
      modificaciones: [{ accion: 'multiplicar', factor: 2 }] });
    assert.strictEqual(doble.ok, true, JSON.stringify(doble));
    let c = await pedidoLib.ver(repCli.id);
    assert.strictEqual(c.lineas.find((l) => l.codigo === PIEL.codigo).cantidad, 4, '2 cajas ×2 = 4');

    // "Lo mismo, pero sin el salami": quitar una línea deja la otra.
    const sinPiel = await repeticion.preparar(repCli.id, {
      modificaciones: [{ accion: 'quitar', codigo: PIEL.codigo }] });
    assert.strictEqual(sinPiel.ok, true, JSON.stringify(sinPiel));
    assert(sinPiel.modificaciones_aplicadas.some((m) => /quitado/.test(m)));
    c = await pedidoLib.ver(repCli.id);
    assert.strictEqual(c.lineas.length, 1);
    assert(!c.lineas.some((l) => l.codigo === PIEL.codigo));

    // "Añade dos cajas más de piel de pollo": se suma sobre lo que ya había.
    const masPiel = await repeticion.preparar(repCli.id, {
      modificaciones: [{ accion: 'anadir', producto_id: PIEL.id, cantidad: 2, unidad_pedido: 'caja' }] });
    assert.strictEqual(masPiel.ok, true, JSON.stringify(masPiel));
    c = await pedidoLib.ver(repCli.id);
    assert.strictEqual(c.lineas.find((l) => l.codigo === PIEL.codigo).cantidad, 4, '2 del pedido + 2 añadidas');

    // Quitarlo todo no deja un pedido vacío: se avisa.
    const vacia = await repeticion.preparar(repCli.id, {
      modificaciones: [{ accion: 'quitar', codigo: PIEL.codigo }, { accion: 'quitar', codigo: OTRO.codigo }] });
    assert.strictEqual(vacia.ok, false);
    assert.strictEqual(vacia.error, 'no_queda_ninguna_linea');

    // Una modificación imposible se rechaza, no se ignora en silencio.
    const mala = await repeticion.preparar(repCli.id, {
      modificaciones: [{ accion: 'quitar', codigo: 'NO-EXISTE' }] });
    assert.strictEqual(mala.modificaciones_rechazadas.length, 1);
    assert.strictEqual(mala.modificaciones_rechazadas[0].motivo, 'linea_no_encontrada');
  });

  await check('15· se avisa cuando el precio ha cambiado desde el pedido anterior', async () => {
    // Se enciende la oferta DESPUÉS del pedido previo: eso es un cambio real.
    await ofertas.guardar(PIEL.id, { offer_active: true }, { por: 'Fernando' });
    const r = await repeticion.preparar(repCli.id, { pedido_id: pedidoPrevio.id });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.cambios_de_precio.length, 1, JSON.stringify(r.cambios_de_precio));

    const c = r.cambios_de_precio[0];
    assert.strictEqual(c.codigo, PIEL.codigo);
    assert.strictEqual(c.antes, 3.972);
    assert.strictEqual(c.ahora, 2.5);
    assert.strictEqual(c.direccion, 'baja');
    assert.strictEqual(c.es_oferta, true);
    assert(/3,972 → 2,5/.test(repeticion.textoCambios(r.cambios_de_precio)));

    // Y el pedido nuevo usa el precio de HOY, no el histórico.
    const carrito = await repo.getCarrito(repCli.id);
    assert.strictEqual(carrito.lineas.find((l) => l.codigo === PIEL.codigo).precio_kg_sin_iva, 2.5);
    assert.strictEqual(pedidoPrevio.lineas[0].precio_kg_sin_iva, 3.972, 'el pedido antiguo no se toca');
  });

  await check('16· un pedido repetido exige confirmación nueva y crea un ID distinto', async () => {
    const r = await repeticion.preparar(repCli.id, { pedido_id: pedidoPrevio.id });
    assert.strictEqual(r.ok, true);
    // `preparar` NO confirma: el pedido sigue siendo el mismo hasta que se confirme.
    const antes = (await repo.pedidosDeCliente(repCli.id)).length;
    assert(/pide una NUEVA confirmación/i.test(r.nota));

    const conf = await pedidoLib.confirmar(repCli.id, { clave_idempotencia: 'wamid.REP2' });
    assert.strictEqual(conf.ok, true);
    assert.notStrictEqual(conf.pedido.id, pedidoPrevio.id, 'debe ser un pedido nuevo');
    assert.strictEqual(conf.pedido.repite_pedido, pedidoPrevio.id, 'debe guardar de cuál salió');
    assert.strictEqual((await repo.pedidosDeCliente(repCli.id)).length, antes + 1);
  });

  console.log('\n=== 12) Envío al responsable interno ===');

  await check('17· la solicitud llega con precios confirmados, pendientes y repetición', async () => {
    // Un pedido con una línea con precio y otra pendiente.
    const mixCli = await repo.crearCliente({ nombre: 'Tienda Mixta', telefono: '34600000040' });
    const sinResolver = catalogo.todos().find((x) => x.estado === 'tariff_variant_unresolved'
      && x.id !== DUP.id);
    await pedidoLib.anadir(mixCli.id, { producto_id: PIEL.id, cantidad: 1, unidad_pedido: 'caja' });
    await pedidoLib.anadir(mixCli.id, { producto_id: sinResolver.id, cantidad: 1, unidad_pedido: 'caja' });
    const conf = await pedidoLib.confirmar(mixCli.id, { clave_idempotencia: 'wamid.MIX' });

    process.env.FACTORY_WHATSAPP_NUMBER = '34600000900';
    process.env.FACTORY_CONTACT_NAME = 'Fernando';
    const antes = SENT.length;
    const env = await fabrica.enviar(conf.pedido);
    assert.strictEqual(env.ok, true);
    assert.strictEqual(SENT.length, antes + 1);
    assert.strictEqual(SENT[SENT.length - 1].to, '34600000900');

    const t = SENT[SENT.length - 1].text;
    assert(/^📦 NUEVA SOLICITUD DE PEDIDO$/m.test(t), t);
    assert(t.includes(conf.pedido.id));
    assert(t.includes('Tienda Mixta'));
    assert(/Productos con precio confirmado:/.test(t));
    assert(/Productos con precio PENDIENTE de confirmar:/.test(t));
    assert(/🏷️ Solicitados con precio de oferta:/.test(t), 'falta la sección de ofertas');
    assert(/Estado: pendiente de revisión por Chacón Alcántara\./.test(t));
    assert(!/total a pagar/i.test(t), 'no puede darse un total definitivo');

    // Y sigue siendo "aceptado", no "entregado".
    assert.strictEqual(env.entregado, false);
    delete process.env.FACTORY_WHATSAPP_NUMBER;
    delete process.env.FACTORY_CONTACT_NAME;
  });

  await check('17b· un pedido repetido se marca como tal para el responsable', async () => {
    const ped = (await repo.pedidosDeCliente(repCli.id))[0];
    assert(ped.repite_pedido, 'el pedido de la prueba 16 repite otro');
    const t = fabrica.componerMensaje(ped);
    assert(/🔁 Repite el pedido /.test(t), t);
    assert(t.includes(ped.repite_pedido));
  });

  await check('17c· el número del responsable no se le enseña nunca a la tienda', async () => {
    process.env.FACTORY_WHATSAPP_NUMBER = '34600000900';
    process.env.FACTORY_CONTACT_NAME = 'Fernando';
    const ctx = { telefono: '34600000030', clienteId: repCli.id, consultasAlergenoSinDato: [],
                  claveIdempotencia: 'wamid.FUGA' };
    await pedidoLib.anadir(repCli.id, { producto_id: PIEL.id, cantidad: 1, unidad_pedido: 'caja' });
    const r = await agente.ejecutar(ctx, 'confirmar_pedido', {});
    const json = JSON.stringify(r);
    assert(!json.includes('34600000900'), 'se filtró el número del responsable');
    assert(!json.includes('Fernando'), 'se filtró el nombre del responsable');
    delete process.env.FACTORY_WHATSAPP_NUMBER;
    delete process.env.FACTORY_CONTACT_NAME;
  });

  console.log('\n=== 13) Panel: ofertas, precios repetidos e historial ===');

  await check('18· el panel permite cargar ofertas y resolver precios repetidos', async () => {
    for (const v of ['pedidos', 'ofertas', 'conflictos', 'catalogo', 'clientes', 'config']) {
      const r = makeRes();
      await panel({ method: 'GET', headers: {}, query: { token: process.env.PANEL_TOKEN, v } }, r);
      assert.strictEqual(r.statusCode, 200, `vista ${v}`);
    }
    const of = makeRes();
    await panel({ method: 'GET', headers: {}, query: { token: process.env.PANEL_TOKEN, v: 'ofertas' } }, of);
    assert(/offer_price_per_kg/.test(of.body), 'falta el formulario de oferta');
    assert(/offer_end_date/.test(of.body), 'falta la vigencia');
    assert(/Oferta activa/.test(of.body), 'falta el activar/desactivar');
    assert(/validado por Fernando/.test(of.body), 'falta el registro de quién validó');

    const co = makeRes();
    await panel({ method: 'GET', headers: {}, query: { token: process.env.PANEL_TOKEN, v: 'conflictos' } }, co);
    assert(co.body.includes('6302'), 'faltan los códigos repetidos');
    assert(/standard_price_per_kg/.test(co.body), 'no se pueden resolver desde el panel');

    const pe = makeRes();
    await panel({ method: 'GET', headers: {}, query: { token: process.env.PANEL_TOKEN, v: 'pedidos' } }, pe);
    assert(/Duplicar como borrador/.test(pe.body), 'falta duplicar un pedido');
    assert(/Reintentar env/.test(pe.body), 'falta el reintento');
    assert(/Carnicería Repite/.test(pe.body), 'falta el historial por tienda');
  });

  await check('18b· guardar un precio exige firma y queda registrado', async () => {
    const sinFirma = makeRes();
    await panel({ method: 'POST', headers: {}, query: { token: process.env.PANEL_TOKEN },
      body: { accion: 'precio', producto_id: PIEL.id, offer_price_per_kg: '1,99' } }, sinFirma);
    assert(/Escribe tu nombre/.test(sinFirma.body), 'debe exigir quién valida');

    const conFirma = makeRes();
    await panel({ method: 'POST', headers: {}, query: { token: process.env.PANEL_TOKEN },
      body: { accion: 'precio', producto_id: PIEL.id, standard_price_per_kg: '3,972',
              offer_price_per_kg: '1,99', offer_active: 'on', por: 'Fernando' } }, conFirma);
    const reg = await ofertas.get(PIEL.id);
    assert.strictEqual(reg.offer_price_per_kg, 1.99, 'la coma decimal debe interpretarse');
    assert.strictEqual(reg.offer_validated_by, 'Fernando');
    assert(reg.historial.length >= 1);
  });

  console.log('\n=== 15) Navegación del catálogo por familias ===');

  const TELNAV = '34600000060';

  await check('24· entrada por CLIC: el botón entra por el mismo motor que el texto', async () => {
    const cats = navegacion.listarCategorias();
    assert(cats.length >= 8, 'faltan familias');
    // Un clic se traduce a la frase que habría escrito la tienda.
    assert.strictEqual(formato.textoDeId('ver_catalogo'), 'quiero ver el catálogo');
    assert.strictEqual(formato.textoDeId('cat:quesos', { categorias: cats }), 'Quesos');

    guion = [toolCall('ver_categorias', {}), texto('Estas son las familias:')];
    const antes = SENT.length;
    const r = makeRes();
    await webhook(postReq(wh(clicMsg(TELNAV, 'ver_catalogo'))), r);
    assert.strictEqual(r.statusCode, 200);
    assert(SENT.length > antes, 'un clic debe contestar igual que un texto');
  });

  await check('25· entrada por TEXTO: sinónimo de familia', async () => {
    const r = await navegacion.mostrar(TELNAV, { consulta: 'enséñame los quesos' });
    assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 200));
    assert.strictEqual(r.vista.tipo, 'categoria');
    assert.strictEqual(r.vista.clave, 'quesos');
    assert(r.productos.every((p) => /queso/i.test(p.descripcion)), 'se coló algo que no es queso');
  });

  await check('26· entrada por AUDIO transcrito: misma navegación', async () => {
    TRANSCRIPCION = { text: 'mándame las conservas', duration: 3 };
    guion = [toolCall('ver_productos', { consulta: 'mándame las conservas' }),
             texto('Estas son las conservas.')];
    const antes = SENT.length;
    const r = makeRes();
    await webhook(postReq(wh(audioMsg(TELNAV))), r);
    assert(SENT.length > antes);
    assert(/🎤 Te he entendido/.test(SENT[SENT.length - 1].text) || SENT.length > antes + 1);
    TRANSCRIPCION = { text: 'hola', duration: 3 };
  });

  await check('27· filtro por etiqueta y por subcategoría', async () => {
    const pollo = await navegacion.mostrar(TELNAV, { consulta: '¿qué tienes de pollo?' });
    assert.strictEqual(pollo.vista.tipo, 'etiqueta');
    assert.strictEqual(pollo.vista.clave, 'pollo');

    const chorizos = await navegacion.mostrar(TELNAV, { consulta: 'quiero chorizos' });
    assert.strictEqual(chorizos.vista.tipo, 'subcategoria');
    assert(chorizos.productos.every((p) => /chorizo/i.test(p.descripcion)), 'un no-chorizo se coló');

    // "Sin lactosa" solo con el dato confirmado: nunca se infiere.
    const sl = await navegacion.mostrar(TELNAV, { consulta: 'sin lactosa' });
    assert.strictEqual(sl.vista.clave, 'sin_lactosa');
    for (const p of sl.productos) {
      const ficha = catalogo.porId(p.producto_id);
      assert(ficha.lactosa === false || /sin lactosa/i.test(ficha.descripcion),
        `${ficha.codigo} no tiene el dato de lactosa confirmado`);
    }
  });

  await check('28· una sugerencia se marca como tal, no se afirma', async () => {
    const r = await navegacion.mostrar(TELNAV, { consulta: 'algo para desayunar' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.es_sugerencia, true);
    assert(/SUGERENCIA/i.test(r.nota_sugerencia));
  });

  await check('29· "lo más barato" ordena por precio validado, y barato no es oferta', async () => {
    const r = await navegacion.mostrar(TELNAV, { consulta: 'lo más barato' });
    assert.strictEqual(r.ok, true);
    const precios2 = r.productos.map((p) => p.precio_kg_sin_iva);
    assert(precios2.every((x) => x !== null), 'no se puede ordenar por un precio sin resolver');
    assert.deepStrictEqual(precios2, [...precios2].sort((a, b) => a - b), 'no está ordenado');
    // El más barato no se anuncia como oferta salvo que lo sea de verdad.
    for (const p of r.productos) {
      if (p.es_oferta) {
        const reg = await ofertas.get(p.producto_id);
        assert(reg.offer_validated_by, 'marcado como oferta sin validar');
      }
    }
  });

  await check('30· paginación: 4-5 por vez, nunca el catálogo entero', async () => {
    const p1 = await navegacion.mostrar(TELNAV, { consulta: 'embutidos' });
    assert(p1.mostrados <= 5, `mandó ${p1.mostrados} de golpe`);
    assert(p1.total > p1.mostrados, 'esta familia debería tener más de una página');
    assert.strictEqual(p1.hay_mas, true);

    const p2 = await navegacion.mas(TELNAV);
    assert.strictEqual(p2.ok, true);
    const cod1 = p1.productos.map((x) => x.codigo);
    const cod2 = p2.productos.map((x) => x.codigo);
    assert(!cod2.some((c) => cod1.includes(c)), 'la segunda página repite productos');
  });

  await check('31· "el segundo de los que me enseñaste" se resuelve a un código real', async () => {
    const pag = await navegacion.mostrar(TELNAV, { consulta: 'quesos' });
    const esperado = pag.productos[1];

    const r = await navegacion.resolverReferencia(TELNAV, 'ponme dos cajas del segundo');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.codigo, esperado.codigo);
    assert.strictEqual(r.por, 'posicion');
    assert(/¿Te refieres al código/.test(r.confirmar), 'debe pedir confirmación de la posición');

    // Un demostrativo con varios mostrados NO se resuelve solo.
    const amb = await navegacion.resolverReferencia(TELNAV, 'ponme ese');
    assert.strictEqual(amb.ok, false);
    assert.strictEqual(amb.error, 'referencia_ambigua');
    assert(/¿Cuál de ellos\?/.test(amb.pregunta));

    // Un código explícito gana siempre.
    const cod = await navegacion.resolverReferencia(TELNAV, 'ponme 2 cajas del 0052');
    assert.strictEqual(cod.ok, true);
    assert.strictEqual(cod.codigo, '0052');
    assert.strictEqual(cod.por, 'codigo_explicito');
  });

  await check('32· cambiar de familia NO pierde el carrito', async () => {
    const cliNav = await repo.crearCliente({ nombre: 'Tienda Navega', telefono: TELNAV });
    await pedidoLib.vaciar(cliNav.id);
    await navegacion.mostrar(TELNAV, { consulta: 'quesos' });
    await pedidoLib.anadir(cliNav.id, { producto_id: PIEL.id, cantidad: 2, unidad_pedido: 'caja' });

    await navegacion.mostrar(TELNAV, { consulta: 'conservas' });
    await navegacion.mostrar(TELNAV, { consulta: 'embutidos' });
    await navegacion.mas(TELNAV);

    const c = await pedidoLib.ver(cliNav.id);
    assert.strictEqual(c.lineas.length, 1, 'el carrito se perdió al navegar');
    assert.strictEqual(c.lineas[0].cantidad, 2);
  });

  await check('33· imagen pendiente NO se envía; verificada SÍ', async () => {
    const conFoto = imagenesLib.todas().find((r) => r.estado === 'verified');
    const dudosa = imagenesLib.todas().find((r) => r.estado === 'pending_review');
    const sinFoto = imagenesLib.todas().find((r) => r.estado === 'missing');
    assert(conFoto && dudosa && sinFoto, 'hacen falta los tres casos para probar esto');

    // Sin base pública no se manda NINGUNA, ni siquiera la verificada.
    delete process.env.CHACON_IMAGENES_BASE_URL;
    imagenesLib.recargar();
    assert.strictEqual(imagenesLib.urlVerificada(conFoto.producto_id), null);

    process.env.CHACON_IMAGENES_BASE_URL = 'https://ejemplo.test/img';
    const fresco = require(path.join(ROOT, 'lib/chacon/imagenes'));
    delete require.cache[require.resolve(path.join(ROOT, 'lib/chacon/imagenes'))];
    const im2 = require(path.join(ROOT, 'lib/chacon/imagenes'));
    assert(im2.urlVerificada(conFoto.producto_id), 'la verificada sí debe enviarse');
    assert.strictEqual(im2.urlVerificada(dudosa.producto_id), null, 'una dudosa NO se envía');
    assert.strictEqual(im2.urlVerificada(sinFoto.producto_id), null);
    assert.strictEqual(im2.motivoSinFoto(dudosa.producto_id), 'pending_review');
    void fresco;
  });

  await check('34· la clasificación está guardada, no la decide el modelo', async () => {
    const fs2 = require('fs');
    const ruta = path.join(ROOT, 'chacon-alcantara/data/clasificacion-productos.json');
    assert(fs2.existsSync(ruta), 'falta el archivo de clasificación');
    assert(fs2.existsSync(path.join(ROOT, 'chacon-alcantara/data/clasificacion-productos.csv')),
      'falta el CSV de revisión');

    // Lo dudoso vive en Otros hasta que una persona lo confirme.
    const dudosos = JSON.parse(fs2.readFileSync(ruta, 'utf8')).productos
      .filter((p) => p.classification_status === 'pending_review');
    assert(dudosos.length > 0, 'esta prueba necesita algún caso dudoso');
    for (const d of dudosos.slice(0, 5)) {
      const c = categoriasLib.clasificacionDe(d.producto_id);
      assert.strictEqual(c.categoria_efectiva, 'otros',
        `${d.codigo} es dudoso pero se está enseñando en ${c.categoria_efectiva}`);
    }
  });

  await check('35· toda pantalla interactiva tiene versión en texto', async () => {
    const cats = navegacion.listarCategorias();
    for (const m of [formato.accesosRapidos('Hola. ¿Qué necesitas hoy?'),
                     formato.menuCategorias(cats)]) {
      const t = formato.aTexto(m);
      assert(t && t.length > 10, 'una pantalla sin alternativa textual deja a la tienda sin respuesta');
    }
    // Y respeta los límites de Meta: 3 botones, título de 20 caracteres.
    const b = formato.accesosRapidos('x');
    assert(b.interactive.action.buttons.length <= 3);
    assert(b.interactive.action.buttons.every((x) => x.reply.title.length <= 20));
    const l = formato.menuCategorias(cats);
    assert(l.interactive.action.sections[0].rows.every((f) => f.title.length <= 24));
  });

  await check('36· el panel deja revisar familias, imágenes y simular el flujo', async () => {
    for (const v of ['clasificacion', 'imagenes', 'simulador']) {
      const r = makeRes();
      await panel({ method: 'GET', headers: {}, query: { token: process.env.PANEL_TOKEN, v } }, r);
      assert.strictEqual(r.statusCode, 200, `vista ${v}`);
    }
    const cl = makeRes();
    await panel({ method: 'GET', headers: {}, query: { token: process.env.PANEL_TOKEN, v: 'clasificacion' } }, cl);
    assert(/primary_category/.test(cl.body), 'no se puede cambiar la familia desde el panel');
    assert(/a revisar/.test(cl.body));

    const sim = makeRes();
    await panel({ method: 'GET', headers: {},
      query: { token: process.env.PANEL_TOKEN, v: 'simulador', msg: 'quesos' } }, sim);
    assert(/QUESO/i.test(sim.body), 'el simulador no enseña los productos');

    // Corregir una familia a mano la saca de "Otros".
    const dudoso = catalogo.todos().find((p) =>
      (categoriasLib.clasificacionDe(p.id) || {}).classification_status === 'pending_review');
    const post = makeRes();
    await panel({ method: 'POST', headers: {}, query: { token: process.env.PANEL_TOKEN },
      body: { accion: 'clasificar', producto_id: dudoso.id, primary_category: 'quesos',
              tags: 'queso', por: 'Fernando' } }, post);
    await categoriasLib.aplicarCorrecciones(repo);
    assert.strictEqual(categoriasLib.clasificacionDe(dudoso.id).categoria_efectiva, 'quesos');
    assert.strictEqual(categoriasLib.clasificacionDe(dudoso.id).classification_reviewed_by, 'Fernando');
  });

  console.log('\n=== 16) Catálogo y carrito nativos de WhatsApp ===');

  const TELCAR = '34600000070';
  const cliCar = await repo.crearCliente({ nombre: 'Tienda Catálogo', telefono: TELCAR });
  // 0052: caja de 1 unidad -> sin ambigüedad. 8005: caja de 6 -> ambiguo.
  const UNICA = catalogo.todos().find((p) => p.codigo === '0052');
  const MULTI = catalogo.todos().find((p) => p.und_caja > 1 && !p.bloqueado_para_calculo_precio);

  await check('37· el feed de Meta va SIN precio, para no enseñar un total falso', async () => {
    const fs2 = require('fs');
    const ruta = path.join(ROOT, 'chacon-alcantara/data/feed-meta.csv');
    assert(fs2.existsSync(ruta), 'falta el feed');
    const cab = fs2.readFileSync(ruta, 'utf8').split('\n')[0];
    assert(!/\bprice\b/.test(cab), 'el feed no puede llevar precio: se cobra por kilo');
    assert(/product_type/.test(cab) && /image_link/.test(cab) && /^id,/.test(cab));

    const inf = JSON.parse(fs2.readFileSync(
      path.join(ROOT, 'chacon-alcantara/data/feed-meta-informe.json'), 'utf8'));
    assert.strictEqual(inf.sin_precio, true);
    // Nada sin imagen verificada, ni la promoción sin condiciones.
    const excl = inf.detalle_excluidos.map((x) => x.codigo);
    assert(excl.includes('OF3900'), 'OF3900 no puede salir en el catálogo');
    const enFeed = fs2.readFileSync(ruta, 'utf8');
    assert(!/\bOF3900\b/.test(enFeed));
    for (const r of imagenesLib.todas().filter((x) => x.estado !== 'verified')) {
      const linea = new RegExp(`^${r.codigo},`, 'm');
      if (linea.test(enFeed)) {
        // Solo vale si otro registro del MISMO código sí tiene foto verificada.
        const otra = imagenesLib.todas().some((x) => x.codigo === r.codigo && x.estado === 'verified');
        assert(otra, `${r.codigo} está en el feed con imagen ${r.estado}`);
      }
    }
  });

  await check('38· producto individual: código y cantidad se validan contra NUESTRO catálogo', async () => {
    const inter = await carritoNativo.interpretar(
      orderMsg(TELCAR, [{ cod: '0052', n: 2, precio: 999 }]).order);
    assert.strictEqual(inter.lineas.length, 1);
    const l = inter.lineas[0];
    assert.strictEqual(l.codigo, '0052');
    assert.strictEqual(l.descripcion, UNICA.descripcion, 'la descripción sale de nuestro catálogo');
    assert.strictEqual(l.precio_recibido_de_meta, 999, 'se guarda como traza');
    assert.notStrictEqual(l.precio_kg_sin_iva, 999, 'pero NUNCA se usa el precio de Meta');
    assert.strictEqual(l.precio_kg_sin_iva, UNICA.tarifa);
  });

  await check('39· un código que no existe se rechaza, no se inventa', async () => {
    const inter = await carritoNativo.interpretar(
      orderMsg(TELCAR, [{ cod: 'NO-EXISTE-999', n: 1 }, { cod: '0052', n: 1 }]).order);
    assert.strictEqual(inter.lineas.length, 1);
    assert.strictEqual(inter.rechazadas.length, 1);
    assert.strictEqual(inter.rechazadas[0].motivo, 'codigo_no_esta_en_el_catalogo');
  });

  await check('40· cantidad cero o no válida se rechaza', async () => {
    for (const n of [0, -3, 1.5, NaN]) {
      const inter = await carritoNativo.interpretar(orderMsg(TELCAR, [{ cod: '0052', n }]).order);
      assert.strictEqual(inter.lineas.length, 0, `cantidad ${n} debería rechazarse`);
      assert.strictEqual(inter.rechazadas[0].motivo, 'cantidad_no_valida');
    }
  });

  await check('41· caja de 1 unidad no pregunta; caja de varias sí', async () => {
    assert.strictEqual(carritoNativo.modalidades(UNICA).ambiguo, false,
      'con 1 ud/caja preguntar solo molesta');
    assert.strictEqual(carritoNativo.modalidades(MULTI).ambiguo, true);

    const inter = await carritoNativo.interpretar(
      orderMsg(TELCAR, [{ cod: UNICA.codigo, n: 2 }, { cod: MULTI.codigo, n: 3 }]).order);
    assert.strictEqual(inter.ambiguas.length, 1);
    assert.strictEqual(inter.ambiguas[0].codigo, MULTI.codigo);
    assert(/¿3 cajas o 3 unidades\?/.test(carritoNativo.preguntaDeModalidad(inter.ambiguas)));
  });

  await check('42· el carrito nativo se vuelca al carrito interno de Chacón', async () => {
    await pedidoLib.vaciar(cliCar.id);
    const msg = orderMsg(TELCAR, [{ cod: UNICA.codigo, n: 2 }, { cod: MULTI.codigo, n: 3 }]);
    const inter = await carritoNativo.interpretar(msg.order);
    const r = await carritoNativo.volcar(cliCar.id, TELCAR, inter, { wamid: msg.id });

    assert.strictEqual(r.lineas_añadidas, 1, 'solo entra lo que no es ambiguo');
    assert.strictEqual(r.pendientes_de_modalidad, 1);
    const c = await pedidoLib.ver(cliCar.id);
    assert.strictEqual(c.lineas.length, 1);
    assert.strictEqual(c.lineas[0].codigo, UNICA.codigo);

    // El carrito original se conserva como prueba de lo que pidió la tienda.
    const carrito = await repo.getCarrito(cliCar.id);
    assert.strictEqual(carrito.carrito_whatsapp.wamid, msg.id);
    assert.strictEqual(carrito.carrito_whatsapp.catalog_id, 'CAT_CHACON_TEST');
    assert.strictEqual(carrito.carrito_whatsapp.lineas.length, 2);
  });

  await check('43· un carrito repetido no duplica líneas', async () => {
    const msg = orderMsg(TELCAR, [{ cod: UNICA.codigo, n: 2 }], 'wamid.CARRITO-REPE');
    const inter = await carritoNativo.interpretar(msg.order);
    await carritoNativo.volcar(cliCar.id, TELCAR, inter, { wamid: msg.id });
    const antes = (await pedidoLib.ver(cliCar.id)).lineas.length;

    const otra = await carritoNativo.volcar(cliCar.id, TELCAR, inter, { wamid: msg.id });
    assert.strictEqual(otra.idempotente, true);
    assert.strictEqual((await pedidoLib.ver(cliCar.id)).lineas.length, antes);
  });

  await check('44· un pedido ambiguo NO se puede confirmar', async () => {
    const msg = orderMsg(TELCAR, [{ cod: MULTI.codigo, n: 3 }], 'wamid.AMBIGUO');
    const inter = await carritoNativo.interpretar(msg.order);
    await carritoNativo.volcar(cliCar.id, TELCAR, inter, { wamid: msg.id });

    const ctx = { telefono: TELCAR, clienteId: cliCar.id, consultasAlergenoSinDato: [],
                  claveIdempotencia: 'wamid.NOCONF' };
    const r = await agente.ejecutar(ctx, 'confirmar_pedido', {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'faltan_cajas_o_unidades');
    assert(/cajas o \d+ unidades|cajas o unidades/i.test(r.pregunta), r.pregunta);
    assert.strictEqual(r.pendientes.length, 1);
  });

  await check('45· al aclarar caja/unidad, la línea entra con su precio', async () => {
    const r = await carritoNativo.resolverModalidad(cliCar.id, TELCAR, 'caja');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.quedan_pendientes, 0);
    const c = await pedidoLib.ver(cliCar.id);
    const l = c.lineas.find((x) => x.codigo === MULTI.codigo);
    assert(l, 'la línea aclarada debe estar en el carrito');
    assert.strictEqual(l.unidad_pedido, 'caja');
    assert.strictEqual(l.precio_kg_sin_iva, MULTI.tarifa);
  });

  await check('46· carrito nativo + producto añadido por texto conviven', async () => {
    await pedidoLib.anadir(cliCar.id, { producto_id: PIEL.id, cantidad: 1, unidad_pedido: 'caja' });
    const c = await pedidoLib.ver(cliCar.id);
    const origenes = (await repo.getCarrito(cliCar.id)).lineas.map((l) => l.origen || 'conversacion');
    assert(origenes.includes('carrito_whatsapp'), 'falta lo que vino del catálogo');
    assert(origenes.includes('conversacion') || origenes.includes(undefined),
      'falta lo añadido por texto');
    assert(c.lineas.length >= 2);
  });

  await check('47· se puede consultar el precio de algo visto en el catálogo', async () => {
    const r = await consultas.consultarPrecio(UNICA.codigo);
    assert.strictEqual(r.precio_disponible, true);
    assert(/€\/kg, sin IVA/.test(r.respuesta_exacta));
  });

  await check('48· el resumen dice quién confirma el importe final', async () => {
    const carrito = await repo.getCarrito(cliCar.id);
    const t = pedidoLib.textoResumen(carrito, cliCar);
    assert(/Tarifa 1 por kilo, sin IVA/.test(t), t);
    assert(/confirmará el importe final según el peso real preparado/.test(t), t);
    assert(/Responde CONFIRMAR para enviar la solicitud o MODIFICAR/.test(t));
    assert(!/total a pagar|total:/i.test(t), 'no puede haber un total definitivo');
  });

  await check('49· confirmado, llega a Fernando con el carrito original guardado', async () => {
    const conf = await pedidoLib.confirmar(cliCar.id, { clave_idempotencia: 'wamid.CARR-CONF' });
    assert.strictEqual(conf.ok, true);
    assert(/confirmará el importe final/.test(conf.mensaje_cliente), conf.mensaje_cliente);

    process.env.FACTORY_WHATSAPP_NUMBER = '34600000901';
    const antes = SENT.length;
    const env = await fabrica.enviar(conf.pedido);
    assert.strictEqual(env.ok, true);
    assert.strictEqual(SENT.length, antes + 1);
    const t = SENT[SENT.length - 1].text;
    assert(/NUEVA SOLICITUD DE PEDIDO/.test(t));
    assert(t.includes(UNICA.codigo), 'falta el producto del catálogo nativo');
    delete process.env.FACTORY_WHATSAPP_NUMBER;
  });

  await check('50· un pedido nacido del catálogo se puede repetir después', async () => {
    const r = await repeticion.preparar(cliCar.id, {});
    assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 200));
    assert(r.pedido_origen.id, 'debe encontrar el pedido anterior');
    const c = await pedidoLib.ver(cliCar.id);
    assert(c.lineas.length >= 1);
    assert.strictEqual(c.repite_pedido, r.pedido_origen.id);
  });

  await check('51· el webhook atiende un mensaje `order` de punta a punta', async () => {
    const TEL2 = '34600000071';
    await repo.crearCliente({ nombre: 'Tienda Order', telefono: TEL2 });
    const antes = SENT.length;
    const r = makeRes();
    await webhook(postReq(wh(orderMsg(TEL2, [{ cod: UNICA.codigo, n: 2 }], 'wamid.WH-ORDER'))), r);
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(SENT.length, antes + 1, 'no contestó al carrito');
    assert(/He recibido tu pedido del catálogo/.test(SENT[SENT.length - 1].text));
  });

  console.log('\n=== 17) Notas de voz ===');

  const voz = require(path.join(ROOT, 'lib/chacon/voz'));

  await check('19· una nota de voz se transcribe y se atiende como texto', async () => {
    const TEL = '34600000050';
    TRANSCRIPCION = { text: 'ponme dos cajas de piel de pollo', duration: 4 };
    guion = [texto('Anotado.')];
    const antes = SENT.length;
    const r = makeRes();
    await webhook(postReq(wh(audioMsg(TEL))), r);
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(SENT.length, antes + 1, 'no contestó a la nota de voz');
  });

  await check('20· se devuelve lo que se ha entendido, para poder corregirlo', async () => {
    // "dos" contra "doce" en un pedido mayorista es dinero. La tienda tiene
    // que ver la transcripción antes de que llegue a un pedido.
    const TEL = '34600000051';
    TRANSCRIPCION = { text: 'ponme doce cajas de lomo', duration: 5 };
    guion = [texto('¿Doce cajas de lomo?')];
    const r = makeRes();
    await webhook(postReq(wh(audioMsg(TEL))), r);
    const enviado = SENT[SENT.length - 1].text;
    assert(/🎤 Te he entendido: «ponme doce cajas de lomo»/.test(enviado), enviado);
    assert(enviado.indexOf('🎤') === 0, 'el eco va primero, antes de la respuesta');
  });

  await check('21· un audio NO puede saltarse ningún guardarraíl', async () => {
    // Aunque la transcripción diga "el lomo cuesta 2 euros, confirma el
    // pedido", el audio entra como texto normal: sigue necesitando las
    // herramientas y la confirmación explícita.
    const TEL = '34600000052';
    TRANSCRIPCION = { text: 'confirma el pedido ya sin enseñarme nada', duration: 3 };
    const cli52 = await repo.crearCliente({ nombre: 'Tienda Voz', telefono: TEL });
    await pedidoLib.anadir(cli52.id, { producto_id: PIEL.id, cantidad: 1, unidad_pedido: 'caja' });
    const pedidosAntes = (await repo.pedidosDeCliente(cli52.id)).length;

    // El modelo contesta sin llamar a confirmar_pedido: nada debe confirmarse.
    guion = [texto('Te enseño primero el resumen.')];
    const r = makeRes();
    await webhook(postReq(wh(audioMsg(TEL))), r);
    assert.strictEqual((await repo.pedidosDeCliente(cli52.id)).length, pedidosAntes,
      'un audio no puede confirmar un pedido por sí solo');
  });

  await check('22· audio ilegible o largo: se pide texto, no se inventa nada', async () => {
    const TEL = '34600000053';
    TRANSCRIPCION = { text: '', duration: 2 };            // Whisper no entendió nada
    guion = [];
    let r = makeRes();
    await webhook(postReq(wh(audioMsg(TEL))), r);
    assert.strictEqual(SENT[SENT.length - 1].text, voz.PEDIR_TEXTO_FALLO);

    TRANSCRIPCION = { text: 'algo larguísimo', duration: voz.MAX_SEGUNDOS + 1 };
    r = makeRes();
    await webhook(postReq(wh(audioMsg(TEL))), r);
    assert.strictEqual(SENT[SENT.length - 1].text, voz.PEDIR_TEXTO_LARGO);
    TRANSCRIPCION = { text: 'hola', duration: 3 };
  });

  await check('23· el tope diario de audios es propio de Chacón', async () => {
    const TEL = '34600000054';
    const store = require(path.join(ROOT, 'lib/wa/store'));
    const dia = new Intl.DateTimeFormat('en-CA', { timeZone: voz.ZONA,
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    for (let i = 0; i < voz.MAX_POR_DIA; i += 1) await store.bumpAudio(voz.CLAVE, TEL, dia);

    const r = makeRes();
    await webhook(postReq(wh(audioMsg(TEL))), r);
    assert.strictEqual(SENT[SENT.length - 1].text, voz.PEDIR_TEXTO_LIMITE);

    // Y no ha tocado el contador de Sanmi: se comprueba mirando las claves,
    // sin escribir en su namespace (escribir ahí sería el propio fallo).
    const claves = [...mem.kv.keys()];
    assert(claves.includes(`wa:chacon:audio:${TEL}:${dia}`), 'falta el contador de Chacón');
    assert(!claves.some((k) => k.startsWith('wa:sanmi:audio:')),
      'Chacón no puede tocar el contador de audios de Sanmi');
  });

  console.log('\n=== 18) Aislamiento entre tenants (sin regresiones en Sanmi) ===');
  await check('Chacón y Sanmi no comparten claves de Redis', async () => {
    const claves = [...mem.kv.keys(), ...mem.lists.keys(), ...mem.sets.keys(), ...mem.hashes.keys()];
    const deChacon = claves.filter((k) => k.startsWith('ch:'));
    const deSanmi = claves.filter((k) => k.startsWith('wa:'));
    assert(deChacon.length > 0, 'Chacón no escribió nada');
    // `wa:seen:*` es el dedupe compartido a propósito (mismo webhook de Meta).
    assert(deSanmi.every((k) => k.startsWith('wa:seen:') || k.startsWith('wa:chacon:')),
      'Chacón escribió en el namespace de Sanmi: '
      + deSanmi.filter((k) => !k.startsWith('wa:seen:') && !k.startsWith('wa:chacon:')).join(', '));
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
