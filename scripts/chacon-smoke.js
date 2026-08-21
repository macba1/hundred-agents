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
/* La suite corre con el motor de tarifas ENCENDIDO, que es como va producción.
   Probar solo el camino apagado dejaría sin cubrir justo lo que se sirve. */
process.env.CHACON_TARIFAS_V2 = process.env.CHACON_TARIFAS_V2 || '1';

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
    /* Graph recibe texto, imágenes e interactivos. El mock guarda el texto
       legible de cualquiera de los tres para que las pruebas puedan mirarlo
       igual que lo vería el cliente. */
    const legible = b.text ? b.text.body
      : b.image ? b.image.caption
        : b.interactive ? formato.aTexto({ type: 'interactive', interactive: b.interactive })
          : JSON.stringify(b);
    SENT.push({ to: b.to, text: legible, tipo: b.type || 'text' });
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
/* El motor sobre los datos reales del repo: las pruebas comparan contra la
   tarifa activa de verdad, no contra números escritos a mano que se quedan
   desfasados en la siguiente importación. */
const tarifasReal = require(path.join(ROOT, 'lib/chacon/tarifas'));
const privLib = require(path.join(ROOT, 'lib/chacon/privacidad'));
const agenda = require(path.join(ROOT, 'lib/chacon/clientes'));

/* Las pruebas de flujo dan por hecho que la tienda ya autorizó el canal, que
   es lo normal a partir de su segunda conversación. El aviso en sí se prueba
   aparte, en la sección de privacidad. */
const conPrivacidad = (tel) => privLib.registrarDecision(
  tel, privLib.ESTADOS.ACEPTADO, { accepted_action: 'suite', source: 'suite' });
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
/* La suite corre con el motor de tarifas ENCENDIDO, que es como va producción.
   Probar solo el camino apagado dejaría sin cubrir justo lo que se sirve. */
process.env.CHACON_TARIFAS_V2 = process.env.CHACON_TARIFAS_V2 || '1';
  });
  await check('un mensaje repetido no duplica línea ni pedido', async () => {
    const TEL = '34600000004';
    await repo.crearCliente({ nombre: 'Ultramarinos Sur', telefono: TEL });
    await conPrivacidad(TEL);
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
    // Se nombra el tramo cuando hay tarifa activa: sin cantidad, la PIEZA.
    const esperado = tarifasReal.disponible()
      ? /^El precio de Tarifa 1 \(pieza\) de .+ es 3,972 €\/kg, sin IVA\./
      : /^El precio de Tarifa 1 de .+ es 3,972 €\/kg, sin IVA\./;
    assert(esperado.test(r.respuesta_exacta), r.respuesta_exacta);
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

  await check('04· importe aproximado de una unidad, al precio de su tramo', async () => {
    const r = await consultas.consultarPrecio('0003', { cantidad: 1, unidad: 'unidad' });
    assert.strictEqual(r.estimacion.calculable, true);
    assert.strictEqual(r.estimacion.peso_estimado_kg, PIEL.peso_und_kg);
    // 1 unidad de una caja de 1 -> tramo 3 (una caja completa). El importe se
    // calcula con el precio de ESE tramo, no con un precio plano.
    assert.strictEqual(r.estimacion.importe_estimado_sin_iva,
      precios.redondear(PIEL.peso_und_kg * r.precio_kg_sin_iva, 2));
    assert(/importe estimado/i.test(r.respuesta_exacta));
    assert(/se ajustará al peso real/i.test(r.respuesta_exacta), 'falta la advertencia del peso real');
  });

  await check('05· importe aproximado de una caja', async () => {
    const conCaja = catalogo.todos().find((x) => x.und_caja > 1 && x.peso_und_kg > 0
      && !x.bloqueado_para_calculo_precio);
    const r = await consultas.precioDe(conCaja, { cantidad: 1, unidad: 'caja' });
    assert.strictEqual(r.estimacion.calculable, true);
    assert.strictEqual(r.estimacion.unidades, conCaja.und_caja);
    // Una caja completa es tramo 3: más barato que la pieza suelta.
    assert.strictEqual(r.estimacion.importe_estimado_sin_iva,
      precios.redondear(conCaja.und_caja * conCaja.peso_und_kg * r.precio_kg_sin_iva, 2));
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

  await check('07· un precio repetido del PDF: la tarifa lo resuelve, o se pregunta', async () => {
    const r = await consultas.precioDe(DUP);
    if (tarifasReal.disponible()) {
      /* Con el Excel cargado ya NO está bloqueado: la tarifa dice cuál es el
         precio vigente, que era justo lo que faltaba. */
      assert.strictEqual(r.precio_disponible, true,
        'con tarifa válida no puede seguir bloqueado por el duplicado del PDF');
      const t1 = tarifasReal.precioDe(DUP.codigo, '1');
      assert.strictEqual(r.precio_kg_sin_iva, t1.aplicado_e4 / 10000);
      assert(/sin IVA/.test(r.respuesta_exacta));
    } else {
      assert.strictEqual(r.precio_disponible, false);
      assert.strictEqual(r.respuesta_exacta, consultas.MENSAJE_PRECIO_SIN_RESOLVER);
      const json = JSON.stringify(r);
      for (const p of catalogo.todos().filter((x) => x.codigo === DUP.codigo)) {
        assert(!json.includes(String(p.tarifa)), `se filtró el precio ${p.tarifa}`);
      }
    }
    assert.strictEqual(r.puede_pedirse, true, 'debe poder pedirse en cualquier caso');
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

  /* Algunas comprobaciones dependen de qué motor de precios esté activo. Se
     marcan en vez de fallar: un rojo que solo significa "el flag está al otro
     lado" enseña a ignorar los rojos, y entonces los de verdad pasan
     desapercibidos. */
  const V2 = tarifasReal.disponible();
  const soloV2 = (label, fn) => (V2 ? check(label, fn)
    : (console.log('  ⏭️ ', label, '— motor de tarifas apagado'), Promise.resolve()));

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

  await soloV2('11· con ofertas activas se listan solo esas', async () => {
    await ofertas.guardar(PIEL.id, {
      standard_price_per_kg: 3.972, offer_price_per_kg: 2.5, offer_active: true,
      offer_start_date: '2020-01-01', offer_end_date: '2099-12-31',
      offer_conditions: 'Hasta fin de existencias',
    }, { por: 'Fernando' });

    const r = await consultas.consultarOfertas();
    assert.strictEqual(r.hay_ofertas, true);
    assert.strictEqual(r.total, 1, 'la del panel: es la que vive en Redis');
    assert.strictEqual(r.ofertas[0].codigo, '0003');
    assert(/2,5 €\/kg sin IVA/.test(r.respuesta_exacta), r.respuesta_exacta);
    assert(/habitual 3,972/.test(r.respuesta_exacta));
    assert(/Hasta fin de existencias/.test(r.respuesta_exacta));

    /* Con el motor de tarifas encendido el PRECIO lo manda la versión, no el
       panel: `0003` no tiene fila OF, así que se cobra su tramo. El panel
       sirve para suprimir una oferta de la tarifa, no para inventar una que
       la versión aprobada no tiene. */
    const pr = await consultas.precioDe(PIEL, { cantidad: 1, unidad: 'caja' });
    assert.strictEqual(pr.es_oferta, false, 'una oferta de panel no puede pisar la tarifa');
    const t3 = tarifasReal.precioDe(PIEL.codigo, '3');
    assert.strictEqual(pr.precio_kg_sin_iva, t3.aplicado_e4 / 10000);
  });

  await soloV2('11b· la oferta de la tarifa se aplica sola, y el panel puede suprimirla', async () => {
    // `6305` sí tiene fila OF en los cuatro tramos.
    const conOferta = catalogo.todos().find((p) => p.codigo === '6305');
    assert(conOferta, 'hace falta 6305 en el catálogo');

    const t3 = tarifasReal.precioDe('6305', '3');
    const auto = await ofertas.precioVigente(conOferta, { cantidad: 1, unidad: 'caja' });
    assert.strictEqual(auto.es_oferta, true, 'la oferta de la tarifa se aplica sola');
    assert.strictEqual(auto.precio_kg, t3.oferta_e4 / 10000);
    assert.strictEqual(auto.precio_normal_kg, t3.normal_e4 / 10000,
      'hay que poder decir también el precio habitual');

    // Un administrador la suprime desde el panel: se respeta y se registra.
    await ofertas.guardar(conOferta.id, { offer_active: false }, { por: 'Fernando' });
    const suprimida = await ofertas.precioVigente(conOferta, { cantidad: 1, unidad: 'caja' });
    assert.strictEqual(suprimida.es_oferta, false, 'una supresión del panel debe respetarse');
    assert.strictEqual(suprimida.precio_kg, t3.normal_e4 / 10000, 'se cobra el precio normal');
    assert.strictEqual(suprimida.oferta_suprimida_por_administrador, 'Fernando');

    // Y se puede volver a activar.
    await ofertas.guardar(conOferta.id, { offer_active: true }, { por: 'Fernando' });
    assert.strictEqual((await ofertas.precioVigente(conOferta,
      { cantidad: 1, unidad: 'caja' })).es_oferta, true);
  });

  await check('11c· resolver un precio repetido lo desbloquea', async () => {
    // Sin tarifa activa, el cálculo directo sigue bloqueado por el duplicado.
    const l = precios.calcularLinea({ producto: DUP, cantidad: 1, unidadPedido: 'caja' });
    assert.strictEqual(l.precio_kg_sin_iva, null,
      'calcularLinea sin precio inyectado no puede resolver el duplicado sola');

    await ofertas.guardar(DUP.id, { standard_price_per_kg: 21 },
      { por: 'Fernando', nota: 'vigente según Chacón' });
    const vig = await ofertas.precioVigente(DUP);
    assert.strictEqual(vig.precio_kg !== null, true, 'tiene que haber un precio que afirmar');
    if (!tarifasReal.disponible()) {
      assert.strictEqual(vig.precio_kg, 21);
      assert.strictEqual(vig.origen, 'tarifa_1_resuelta_por_administrador');
    }
    const r = await consultas.precioDe(DUP);
    assert.strictEqual(r.precio_disponible, true);
    assert(/€\/kg, sin IVA/.test(r.respuesta_exacta), r.respuesta_exacta);

    const l2 = precios.calcularLinea({ producto: DUP, cantidad: 1, unidadPedido: 'caja',
      precioAplicado: { precio_kg: 21, es_oferta: false, origen: 'resuelto' } });
    assert.strictEqual(l2.precio_kg_sin_iva, 21);
    assert.strictEqual(l2.precio_pendiente_de_confirmacion, false);
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
  await soloV2('13· se repite el último pedido con su fecha e identificador', async () => {
    OTRO = catalogo.todos().find((x) => x.codigo !== PIEL.codigo
      && !x.bloqueado_para_calculo_precio && x.peso_und_kg > 0);

    await pedidoLib.anadir(repCli.id, { producto_id: PIEL.id, cantidad: 2, unidad_pedido: 'caja' });
    await pedidoLib.anadir(repCli.id, { producto_id: OTRO.id, cantidad: 1, unidad_pedido: 'caja' });
    const conf = await pedidoLib.confirmar(repCli.id, { clave_idempotencia: 'wamid.REP1' });
    pedidoPrevio = conf.pedido;
    assert.strictEqual(pedidoPrevio.lineas.length, 2);
    // 2 cajas -> tramo 4. Es el precio que queda congelado en el pedido.
    const t4 = tarifasReal.precioDe(PIEL.codigo, '4');
    assert.strictEqual(pedidoPrevio.lineas[0].precio_kg_sin_iva, t4.aplicado_e4 / 10000);

    const r = await repeticion.preparar(repCli.id, {});
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.pedido_origen.id, pedidoPrevio.id);
    assert(r.pedido_origen.fecha, 'hay que poder decirle al cliente de cuándo era');
    const c = await pedidoLib.ver(repCli.id);
    assert.strictEqual(c.lineas.length, 2);
    assert.strictEqual(c.repite_pedido, pedidoPrevio.id);
  });

  await soloV2('14· repetición con modificaciones: doble, quitar y añadir', async () => {
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

  await soloV2('15· se avisa cuando el precio ha cambiado desde el pedido anterior', async () => {
    /* El precio del pedido previo se manipula a mano para simular que la
       tarifa cambió: es lo que pasaría con una reimportación aprobada. */
    const congelado = pedidoPrevio.lineas[0].precio_kg_sin_iva;
    const guardado = await repo.getPedido(pedidoPrevio.id);
    guardado.lineas[0].precio_kg_sin_iva = congelado + 1;
    await repo.guardarPedido(guardado);

    const r = await repeticion.preparar(repCli.id, { pedido_id: pedidoPrevio.id });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.cambios_de_precio.length, 1, JSON.stringify(r.cambios_de_precio));
    const c = r.cambios_de_precio[0];
    assert.strictEqual(c.codigo, PIEL.codigo);
    assert.strictEqual(c.antes, congelado + 1);
    assert.strictEqual(c.ahora, congelado);
    assert.strictEqual(c.direccion, 'baja');
    assert(repeticion.textoCambios(r.cambios_de_precio).includes('€/kg'));

    // El pedido nuevo usa el precio de HOY.
    const carrito = await repo.getCarrito(repCli.id);
    assert.strictEqual(carrito.lineas.find((l) => l.codigo === PIEL.codigo)
      .precio_kg_sin_iva, congelado);
  });

  await soloV2('16· un pedido repetido exige confirmación nueva y crea un ID distinto', async () => {
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
    // Un artículo promocional nunca tiene precio que afirmar: sirve de caso
    // "pendiente" tanto con el motor de tarifas encendido como apagado.
    const sinResolver = catalogo.todos().find((x) => x.codigo === 'OF3900');
    assert(sinResolver, 'hace falta OF3900 para el caso de precio pendiente');
    await pedidoLib.anadir(mixCli.id, { producto_id: PIEL.id, cantidad: 1, unidad_pedido: 'caja' });
    await pedidoLib.anadir(mixCli.id, { producto_id: sinResolver.id, cantidad: 1, unidad_pedido: 'caja' });
    // Y uno con oferta de verdad, para que aparezca la sección de ofertas.
    const conOf = catalogo.todos().find((x) => x.codigo === '6305')
      || catalogo.todos().find((x) => x.codigo === '6304');
    if (conOf) {
      await ofertas.guardar(conOf.id, { offer_active: true }, { por: 'Fernando' });
      await pedidoLib.anadir(mixCli.id, { producto_id: conOf.id, cantidad: 1, unidad_pedido: 'caja' });
    }
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
    if (conOf && V2) assert(/🏷️ Solicitados con precio de oferta:/.test(t),
      'falta la sección de ofertas');
    assert(/Estado: pendiente de revisión por Chacón Alcántara\./.test(t));
    assert(!/total a pagar/i.test(t), 'no puede darse un total definitivo');

    // Y sigue siendo "aceptado", no "entregado".
    assert.strictEqual(env.entregado, false);
    delete process.env.FACTORY_WHATSAPP_NUMBER;
    delete process.env.FACTORY_CONTACT_NAME;
  });

  await soloV2('17b· un pedido repetido se marca como tal para el responsable', async () => {
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
  await conPrivacidad(TELNAV);

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
    // Con tienda ya identificada: si no, el flujo pide el nombre, que es
    // justo lo que debe hacer y se comprueba aparte.
    if (!(await repo.clientePorTelefono(TELNAV))) {
      await repo.crearCliente({ nombre: 'Tienda Navegación', telefono: TELNAV });
    }
    // Y sin identificación a medias: con el slot abierto, TODO es un nombre
    // de negocio, incluido "mándame las conservas". Eso está probado aparte.
    await require(path.join(ROOT, 'lib/chacon/estados')).reiniciar(TELNAV);
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
    const cliNav = await repo.crearCliente({ nombre: 'Tienda Navega', telefono: TELNAV }); await conPrivacidad(TELNAV);
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
  await conPrivacidad(TELCAR);
  const cliCar = await repo.crearCliente({ nombre: 'Tienda Catálogo', telefono: TELCAR }); await conPrivacidad(TELCAR);
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
    // 3 cajas -> tramo 4. El precio sale de la tarifa activa, no de un plano.
    const esperado = tarifasReal.disponible()
      ? tarifasReal.precioDe(MULTI.codigo, '4').aplicado_e4 / 10000
      : MULTI.tarifa;
    assert.strictEqual(l.precio_kg_sin_iva, esperado);
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
    await conPrivacidad(TEL2);
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
    const TEL = '34600000050'; await conPrivacidad(TEL);
    TRANSCRIPCION = { text: 'ponme dos cajas de piel de pollo', duration: 4 };
    guion = [texto('Anotado.')];
    const antes = SENT.length;
    const r = makeRes();
    await webhook(postReq(wh(audioMsg(TEL))), r);
    assert.strictEqual(r.statusCode, 200);
    assert(SENT.length > antes, 'no contestó a la nota de voz');
  });

  await check('20· la transcripción solo se enseña cuando hay que desambiguar', async () => {
    /* Repetir "te he entendido X" en cada audio ensucia la conversación. Se
       enseña cuando hay varias opciones —ahí sí importa que la tienda vea si
       se entendió "dos" o "doce"— y se calla cuando el producto es claro. */
    const TEL = '34600000051'; await conPrivacidad(TEL);
    TRANSCRIPCION = { text: 'ponme doce cajas de lomo', duration: 5 };
    guion = [texto('¿Doce cajas de lomo?')];
    const antes = SENT.length;
    const r = makeRes();
    await webhook(postReq(wh(audioMsg(TEL))), r);
    const todos = SENT.slice(antes).map((x) => x.text).join('\n');
    const ambiguo = /¿Cuál|varias opciones/i.test(todos);
    if (ambiguo) {
      assert(/🎤 Te he entendido/.test(todos),
        'con varias opciones hay que enseñar qué se entendió: ' + todos.slice(0, 120));
    }
    assert(SENT.length > antes, 'no contestó al audio');
  });

  await check('21· un audio NO puede saltarse ningún guardarraíl', async () => {
    // Aunque la transcripción diga "el lomo cuesta 2 euros, confirma el
    // pedido", el audio entra como texto normal: sigue necesitando las
    // herramientas y la confirmación explícita.
    const TEL = '34600000052'; await conPrivacidad(TEL);
    TRANSCRIPCION = { text: 'confirma el pedido ya sin enseñarme nada', duration: 3 };
    const cli52 = await repo.crearCliente({ nombre: 'Tienda Voz', telefono: TEL }); await conPrivacidad(TEL);
    await conPrivacidad(TEL);
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
    const TEL = '34600000053'; await conPrivacidad(TEL);
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
    const TEL = '34600000054'; await conPrivacidad(TEL);
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

  console.log('\n=== 19) Tarifas: ocho tramos, ofertas y versionado ===');

  /* La versión importada queda PENDIENTE a propósito. Para probar el motor se
     hace una copia aprobada en un directorio temporal: así se demuestra que
     funciona sin activar nada en producción. */
  const os = require('os');
  const fsT = require('fs');
  const DIR_T = fsT.mkdtempSync(path.join(os.tmpdir(), 'chacon-tarifas-'));
  const V1 = path.join(ROOT, 'chacon-alcantara/data/tarifas/version-1.json');

  let tarifas = null; let tramos = null; let facturacion = null;
  const conMotor = fsT.existsSync(V1);
  if (conMotor) {
    const doc = JSON.parse(fsT.readFileSync(V1, 'utf8'));
    for (const f of doc.filas) {
      f.approved = true;
      f.active = !['ALI', 'COO', 'OFC', 'S'].includes(f.tariff_code);
    }
    doc.approved = true; doc.approved_by = 'suite';
    fsT.writeFileSync(path.join(DIR_T, 'version-1.json'), JSON.stringify(doc));
    fsT.writeFileSync(path.join(DIR_T, 'estado.json'), JSON.stringify({
      version_activa: 1, versiones: [{ version: 1, approved: true, registros: doc.registros }] }));
    process.env.CHACON_TARIFAS_DIR = DIR_T;
    process.env.CHACON_TARIFAS_V2 = '1';
    tarifas = require(path.join(ROOT, 'lib/chacon/tarifas'));
    tramos = require(path.join(ROOT, 'lib/chacon/tramos'));
    facturacion = require(path.join(ROOT, 'lib/chacon/facturacion'));
    tarifas.recargar();
  }

  const siMotor = (label, fn) => conMotor
    ? check(label, fn)
    : check(label + ' [SIN version-1.json: importa las tarifas primero]',
            async () => { throw new Error('falta chacon-alcantara/data/tarifas/version-1.json'); });

  await siMotor('51b· la fuente oficial de precios es el Excel, no el PDF', async () => {
    const fs3 = require('fs');
    const dirReal = path.join(ROOT, 'chacon-alcantara/data/tarifas');
    const est = JSON.parse(fs3.readFileSync(path.join(dirReal, 'estado.json'), 'utf8'));
    const activa = JSON.parse(fs3.readFileSync(
      path.join(dirReal, `version-${est.version_activa}.json`), 'utf8'));
    assert(/\.xlsx$/i.test(activa.source_file),
      `la versión activa viene de ${activa.source_file}: el Excel es la fuente oficial`);
    assert.strictEqual(activa.registros, 649);
    assert.deepStrictEqual(activa.invariantes_fallidos, []);
    // Y el precio del PDF del catálogo NO se usa para cotizar.
    const enTarifa = activa.filas.filter((f) => f.tariff_code === '1')
      .map((f) => f.product_code);
    for (const cod of ['6302', '6304', '6305', '5000']) {
      assert(enTarifa.includes(cod), `${cod} tiene que estar en la tarifa`);
    }
  });

  await siMotor('52· importa 649 registros y las 12 tarifas', async () => {
    const r = tarifas.resumen();
    assert.strictEqual(r.registros, 649);
    assert.deepStrictEqual(r.invariantes_fallidos, [], 'una versión con invariantes rotos no vale');
    const t = r.resumen_por_tarifa;
    for (const k of ['1', '2', '3', '4']) assert.strictEqual(t[k], 133, `tarifa ${k}`);
    for (const k of ['1OF', '2OF', '3OF', '4OF']) assert.strictEqual(t[k], 19, `tarifa ${k}`);
    assert.strictEqual(t.ALI, 8); assert.strictEqual(t.COO, 20);
    assert.strictEqual(t.OFC, 6); assert.strictEqual(t.S, 7);
  });

  await siMotor('53· los ceros iniciales sobreviven, y el dinero es entero', async () => {
    for (const cod of ['0001', '0003', '0052', '0000641', '0005825']) {
      const p = tarifas.precioDe(cod, '1');
      assert.strictEqual(p.encontrado, true, `${cod} debería estar en la tarifa 1`);
      assert.strictEqual(p.product_code, cod, 'el código perdió sus ceros');
      assert.strictEqual(typeof p.aplicado_e4, 'number');
      assert(Number.isInteger(p.aplicado_e4), 'el dinero no puede ser fraccionario');
    }
    // 0,0001 € sobrevive: con float se habría perdido.
    const cuatro = tarifas.precioDe('10000', '1');
    assert.strictEqual(cuatro.aplicado_e4, 1, '0,0001 € = 1 diezmilésima');
    assert.strictEqual(tarifas.mostrar(1), '0,0001');
    assert.strictEqual(tarifas.mostrar(138890), '13,889');
  });

  await siMotor('54· los 19 códigos con oferta son exactamente los del PDF', async () => {
    const ESPERADOS = ['2003', '21446', '2503', '30101', '30201', '30301', '30501',
      '30701', '3502', '5100', '5102', '6304', '6305', '6703', '6803', '7001',
      '8003', 'M6304', 'M6305'].sort();
    assert.deepStrictEqual(tarifas.codigosConOferta(), ESPERADOS);
    // Y cada uno tiene oferta en los CUATRO tramos.
    for (const cod of ESPERADOS) {
      for (const t of ['1', '2', '3', '4']) {
        const p = tarifas.precioDe(cod, t);
        assert.strictEqual(p.es_oferta, true, `${cod} sin oferta en el tramo ${t}`);
        assert(p.oferta_e4 < p.normal_e4, `${cod} tramo ${t}: la oferta no es más baja`);
      }
    }
  });

  await siMotor('55· la oferta se aplica sola en cada tramo, y se informa del normal', async () => {
    const t3 = tarifas.precioDe('6305', '3');
    assert.strictEqual(t3.es_oferta, true);
    assert.strictEqual(t3.tier_label, '1 CAJA OFERTA');
    assert.strictEqual(t3.aplicado_e4, t3.oferta_e4);
    assert(t3.normal_e4 !== null, 'hay que poder decir el precio habitual');
    // Los precios de 6305 por tramo, tal cual salen del PDF:
    //   T1 PIEZA 13,889 / oferta 12,5   ·   T3 1 CAJA 12,5 / oferta 11,25
    // El par 13,889 / 12,5 es el de PIEZA, no el de "1 caja".
    assert.strictEqual(tarifas.mostrar(t3.normal_e4), '12,5');
    assert.strictEqual(tarifas.mostrar(t3.oferta_e4), '11,25');
    const t1 = tarifas.precioDe('6305', '1');
    assert.strictEqual(tarifas.mostrar(t1.normal_e4), '13,889');
    assert.strictEqual(tarifas.mostrar(t1.oferta_e4), '12,5');

    // Un producto sin oferta aplica su normal, sin inventarse ninguna.
    const sinOferta = tarifas.precioDe('0052', '3');
    assert.strictEqual(sinOferta.es_oferta, false);
    assert.strictEqual(sinOferta.oferta_e4, null);
    assert.strictEqual(sinOferta.aplicado_e4, sinOferta.normal_e4);
  });

  await siMotor('56· el tramo se elige por unidades y por cajas, no por el modelo', async () => {
    const T = (cantidad, unidadPedido, unidadesPorCaja) =>
      tramos.elegirTramo({ cantidad, unidadPedido, unidadesPorCaja }).tier;
    assert.strictEqual(T(3, 'unidad', 12), '1');       // menos de media
    assert.strictEqual(T(6, 'unidad', 12), '2');       // media exacta
    assert.strictEqual(T(12, 'unidad', 12), '3');      // una caja
    assert.strictEqual(T(18, 'unidad', 12), '4');      // más de una
    assert.strictEqual(T(1, 'caja', 12), '3');
    assert.strictEqual(T(2, 'caja', 12), '4');
    assert.strictEqual(T(5, 'caja', 12), '4');
  });

  await siMotor('57· media caja con caja par e impar', async () => {
    const T = (c, u) => tramos.elegirTramo({ cantidad: c, unidadPedido: 'unidad', unidadesPorCaja: u });
    // Par: 6 de 12 es media exacta -> T2.
    assert.strictEqual(T(6, 12).tier, '2');
    assert.strictEqual(T(5, 12).tier, '1');
    // Impar: 15 unidades. 7 se queda por debajo de media, 8 la pasa.
    assert.strictEqual(T(7, 15).tier, '1');
    assert.strictEqual(T(8, 15).tier, '2');
    // Y no se redondea a caja completa por error.
    assert.strictEqual(T(14, 15).tier, '2');
    assert.strictEqual(T(15, 15).tier, '3');
  });

  await siMotor('58· cantidades por encima de una caja van a la tarifa 4', async () => {
    for (const [c, u] of [[13, 12], [24, 12], [16, 15], [100, 12]]) {
      assert.strictEqual(tramos.elegirTramo({ cantidad: c, unidadPedido: 'unidad',
        unidadesPorCaja: u }).tier, '4', `${c} de ${u}`);
    }
    // La discrepancia del PDF queda registrada, no tapada.
    const a = tramos.ADVERTENCIA_TARIFA_4;
    assert.strictEqual(a.etiqueta_pdf, '+ 2 CAJAS');
    assert.strictEqual(a.instruccion_comercial, 'más de una caja');
    assert.strictEqual(a.aplicado_en_el_mvp, 'más de una caja');
    assert.strictEqual(a.pendiente_de, 'Fernando');
  });

  await siMotor('59· sin tramo determinable se pregunta, no se aproxima', async () => {
    // Sin unidades por caja no hay proporción posible.
    const r = tarifas.precioParaCantidad('0052', { cantidad: 6, unidadPedido: 'unidad',
      unidadesPorCaja: null });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'tramo_indeterminado');
    assert(/cajas o.*unidades/i.test(r.pregunta), r.pregunta);
    // En kilos tampoco: el tramo va por cajas.
    const k = tarifas.precioParaCantidad('0052', { cantidad: 3, unidadPedido: 'kg',
      unidadesPorCaja: 12 });
    assert.strictEqual(k.ok, false);
  });

  await siMotor('60· consultar el precio no toca el carrito', async () => {
    const cliT = await repo.crearCliente({ nombre: 'Tienda Tarifas', telefono: '34600000080' });
    await pedidoLib.vaciar(cliT.id);
    const antes = (await pedidoLib.ver(cliT.id)).lineas.length;
    const t = tarifas.tramosDe('6305');
    assert.strictEqual(Object.keys(t).length, 4, 'los cuatro tramos consultables');
    assert.strictEqual((await pedidoLib.ver(cliT.id)).lineas.length, antes);
  });

  await siMotor('61· las ofertas se listan solo desde la versión aprobada', async () => {
    const ofs = tarifas.ofertasActivas({ tier: '3' });
    assert.strictEqual(ofs.length, 19);
    for (const o of ofs) {
      assert.strictEqual(o.tier, '3');
      assert.strictEqual(o.tier_label, '1 CAJA OFERTA');
      assert(o.oferta_e4 < o.normal_e4);
      assert.strictEqual(o.catalog_version, 1);
    }
  });

  await siMotor('62· al cambiar la cantidad, cambia el tramo y el precio', async () => {
    const conCaja = tarifas.precioDe('6304', '1');
    assert(conCaja.encontrado);
    const p1 = tarifas.precioParaCantidad('6304', { cantidad: 1, unidadPedido: 'caja', unidadesPorCaja: 2 });
    const p4 = tarifas.precioParaCantidad('6304', { cantidad: 4, unidadPedido: 'caja', unidadesPorCaja: 2 });
    assert.strictEqual(p1.tramo.tier, '3');
    assert.strictEqual(p4.tramo.tier, '4');
    assert.notStrictEqual(p1.precio.aplicado_e4, p4.precio.aplicado_e4,
      'pedir más cajas tiene que cambiar el precio de tarifa');
  });

  await siMotor('63· el pedido confirmado congela su precio y su versión', async () => {
    const cliS = await repo.crearCliente({ nombre: 'Tienda Snapshot', telefono: '34600000081' });
    await pedidoLib.anadir(cliS.id, { producto_id: PIEL.id, cantidad: 1, unidad_pedido: 'caja' });
    const conf = await pedidoLib.confirmar(cliS.id, { clave_idempotencia: 'wamid.SNAP-TAR' });
    assert.strictEqual(conf.ok, true);
    const congelado = conf.pedido.lineas[0].precio_kg_sin_iva;
    assert(conf.pedido.version_catalogo, 'el pedido guarda la versión que usó');

    // Se "reimporta": la copia temporal cambia de precio.
    const doc = JSON.parse(fsT.readFileSync(path.join(DIR_T, 'version-1.json'), 'utf8'));
    for (const f of doc.filas) if (f.product_code === PIEL.codigo) f.price_e4 = 999999;
    fsT.writeFileSync(path.join(DIR_T, 'version-1.json'), JSON.stringify(doc));
    tarifas.recargar();

    const guardado = await repo.getPedido(conf.pedido.id);
    assert.strictEqual(guardado.lineas[0].precio_kg_sin_iva, congelado,
      'una reimportación no puede cambiar un pedido de ayer');
    // Se deja como estaba para las pruebas siguientes.
    for (const f of doc.filas) if (f.product_code === PIEL.codigo) f.price_e4 = 39720;
    fsT.writeFileSync(path.join(DIR_T, 'version-1.json'), JSON.stringify(doc));
    tarifas.recargar();
  });

  await siMotor('64· los 6 precios antiguos sin correspondencia quedan inactivos', async () => {
    const ESPERADOS = { 5000: '0,633', 6302: '21', 6303: '21',
                        6304: '7,81', 6305: '7,81', 6803: '1,257' };
    const huerfanos = tarifas.legadoSinCorrespondencia();
    assert.strictEqual(huerfanos.length, 6, JSON.stringify(huerfanos.map((h) => h.product_code)));
    for (const h of huerfanos) {
      assert.strictEqual(h.estado, 'legacy_unmatched');
      assert.strictEqual(h.active, false);
      assert.strictEqual(h.requires_review, true);
      assert.strictEqual(h.price_display, ESPERADOS[h.product_code],
        `${h.product_code}: ${h.price_display}`);
    }
    // Y ninguno se puede cobrar: no es un precio de tarifa.
    for (const cod of Object.keys(ESPERADOS)) {
      for (const t of ['1', '2', '3', '4']) {
        const p = tarifas.precioDe(cod, t);
        if (p.encontrado) {
          assert.notStrictEqual(tarifas.mostrar(p.aplicado_e4), ESPERADOS[cod],
            `${cod} está cobrando el precio huérfano`);
        }
      }
    }
  });

  await siMotor('65· un código OFxxxx no es una tarifa xOF', async () => {
    // Las tablas de oferta son 1OF-4OF; OF3900/OF6804/OF6812 son artículos.
    for (const cod of ['OF3900', 'OF6804', 'OF6812']) {
      const p = tarifas.precioDe(cod, '1');
      assert.strictEqual(p.encontrado, true, `${cod} debería existir como artículo`);
      assert.strictEqual(p.es_oferta, false, `${cod} NO es una oferta por empezar por OF`);
      assert.strictEqual(p.promotion_rule_required, true,
        `${cod} tiene que exigir que Fernando defina sus condiciones`);
      assert(!tarifas.codigosConOferta().includes(cod),
        `${cod} no puede aparecer en la lista de ofertas`);
    }
    // Y no se pueden facturar solos: 0,001 € no es un precio comercial.
    const internos = tarifas.articulosInternos().map((x) => x.product_code);
    for (const cod of ['OF3900', 'OF6804', 'OF6812']) assert(internos.includes(cod));
    for (const cod of ['OF3900', 'OF6804', 'OF6812']) {
      assert.strictEqual(facturacion.baseDe(cod).billing_unit, 'unknown');
      assert.strictEqual(facturacion.baseDe(cod).approved, false);
    }
  });

  await siMotor('66· las tarifas especiales quedan fuera del flujo público', async () => {
    const esp = tarifas.tarifasEspeciales();
    assert.strictEqual(esp.length, 8 + 20 + 6 + 7, 'ALI+COO+OFC+S');
    for (const e of esp) assert.strictEqual(e.activa_en_flujo_publico, false);
    // Un precio especial nunca se devuelve por el camino normal.
    for (const e of esp.slice(0, 12)) {
      const p = tarifas.precioDe(e.product_code, '1');
      if (p.encontrado) {
        assert(!['ALI', 'COO', 'OFC', 'S'].includes(p.tariff_code),
          `${e.product_code} devolvió la tarifa especial ${p.tariff_code}`);
      }
    }
  });

  await siMotor('67· base de facturación desconocida: precio sí, subtotal no', async () => {
    const nuevo = tarifas.codigosNuevosPendientesDeRevision()
      .find((c) => facturacion.baseDe(c).billing_unit === 'unknown');
    assert(nuevo, 'hacen falta códigos nuevos sin base confirmada');

    const p = tarifas.precioDe(nuevo, '1');
    assert.strictEqual(p.encontrado, true, 'el precio de tarifa SÍ se puede decir');

    const imp = facturacion.importe(p.aplicado_e4, 'unknown', { unidades: 3, cajas: 1, peso_kg: 2 });
    assert.strictEqual(imp.calculable, false);
    assert.strictEqual(imp.centimos, null, 'sin base confirmada no hay subtotal');
    assert.strictEqual(imp.motivo, 'base_de_facturacion_sin_confirmar');

    // Con base kg sí, y siempre con el aviso del peso real.
    const kg = facturacion.importe(p.aplicado_e4, 'kg', { peso_kg: 2 });
    assert.strictEqual(kg.calculable, true);
    assert(/peso real/i.test(kg.aviso));
    // Redondeo a céntimos solo al final: 0,0001 €/kg × 2 kg = 0 céntimos.
    assert.strictEqual(facturacion.importe(1, 'kg', { peso_kg: 2 }).centimos, 0);
    assert.strictEqual(facturacion.importe(138890, 'unit', { unidades: 3 }).centimos, 4167);
  });

  await siMotor('68b· el panel enseña versiones, ofertas, huérfanos y base de facturación', async () => {
    for (const v of ['tarifas', 'facturacion']) {
      const r = makeRes();
      await panel({ method: 'GET', headers: {}, query: { token: process.env.PANEL_TOKEN, v } }, r);
      assert.strictEqual(r.statusCode, 200, `vista ${v}`);
    }
    const t = makeRes();
    await panel({ method: 'GET', headers: {}, query: { token: process.env.PANEL_TOKEN, v: 'tarifas' } }, t);
    assert(/Umbral de la tarifa 4/.test(t.body), 'falta la advertencia del umbral');
    assert(/\+ 2 CAJAS/.test(t.body) && /más de una caja/.test(t.body),
      'las dos evidencias tienen que estar a la vista');
    assert(/legacy_unmatched/.test(t.body), 'faltan los precios huérfanos');
    assert(/FUERA del flujo público/.test(t.body), 'faltan las tarifas especiales');
    assert(/OF3900/.test(t.body), 'faltan los códigos OF marcados');

    const f = makeRes();
    await panel({ method: 'GET', headers: {}, query: { token: process.env.PANEL_TOKEN, v: 'facturacion' } }, f);
    assert(/billing_unit/.test(f.body), 'no se puede fijar la base desde el panel');
    assert(/no se deduce/.test(f.body));

    // Corregir una base a mano queda firmada y pisa el archivo.
    const cod = tarifas.codigosNuevosPendientesDeRevision()[0];
    const post = makeRes();
    await panel({ method: 'POST', headers: {}, query: { token: process.env.PANEL_TOKEN },
      body: { accion: 'facturacion', product_code: cod, billing_unit: 'unit', por: 'Fernando' } }, post);
    const ov = await repo.facturacionesRevisadas();
    assert.strictEqual(ov[cod].billing_unit, 'unit');
    assert.strictEqual(ov[cod].revisado_por, 'Fernando');
    assert(ov[cod].historial.length >= 1, 'falta la auditoría del cambio');
    assert.strictEqual(facturacion.baseDe(cod, ov).billing_unit, 'unit',
      'la corrección del panel debe pisar el archivo');
  });

  await siMotor('68· los 43 códigos nuevos no se publican solos', async () => {
    const nuevos = tarifas.codigosNuevosPendientesDeRevision();
    assert.strictEqual(nuevos.length, 43);
    const base = facturacion.todas();
    for (const c of nuevos) {
      assert.strictEqual(base[c].customer_visible, false, `${c} no puede publicarse solo`);
      assert(base[c].review_status, `${c} debe estar marcado para revisión`);
    }
  });

  console.log('\n=== 20) Descubrimiento de producto sin conocer el código ===');

  const desc = require(path.join(ROOT, 'lib/chacon/descubrimiento'));
  desc.invalidarIndice();

  await check('69· lenguaje natural: palabras vacías, plurales y erratas', async () => {
    // Cada uno de estos fallaba antes, y se comprobó cómo fallaba.
    const casos = [
      // consulta,                  tipo esperado,  comprobación
      ['que salchichones tienes', ['familia', 'varios'],
        (r) => (r.candidatos || []).every((p) => /salchich/i.test(p.descripcion))],
      ['el chorizo de Marcial', ['producto'],
        (r) => r.producto.codigo === '6305'],
      ['choriso cular', ['producto'],
        (r) => /CHORIZO CULAR/i.test(r.producto.descripcion)],
      ['chorizo iberico marcial', ['varios', 'producto'],
        (r) => /CHORIZO/i.test((r.producto || r.candidatos[0]).descripcion)],
      ['quiero chorizo', ['familia', 'varios'],
        (r) => (r.candidatos || []).every((p) => /chorizo/i.test(p.descripcion))],
      ['que jamones tienes', ['familia', 'varios'],
        (r) => (r.candidatos || []).length > 1],
    ];
    for (const [q, tipos, ok] of casos) {
      const r = desc.buscar(q);
      assert(tipos.includes(r.tipo), `"${q}" devolvió ${r.tipo}`);
      assert(ok(r), `"${q}" devolvió algo que no encaja: `
        + JSON.stringify((r.candidatos || [r.producto]).slice(0, 3).map((p) => p.descripcion)));
    }
  });

  await check('70· una familia nombrada abre la familia, no un producto suelto', async () => {
    const f = desc.buscar('embutidos');
    assert.strictEqual(f.tipo, 'familia');
    assert(f.total >= 15, `solo ${f.total} embutidos`);
    // Pero si además nombra el producto, mandan las palabras.
    const p = desc.buscar('embutido de pollo');
    assert.strictEqual(p.tipo, 'producto');
    assert.strictEqual(p.producto.codigo, '0449');
  });

  await check('71· los artículos no comerciales NO se pueden encontrar ni pedir', async () => {
    // Portes, palés, etiquetas, baterías, film y los códigos OF*.
    for (const q of ['PORTES', '9995', '4525', 'palet', 'bateria', 'OF3900', 'PORTADA']) {
      const r = desc.buscar(q);
      assert(['nada', 'no_comercial'].includes(r.tipo)
        || (r.candidatos || []).every((p) => desc.esComprable(p.codigo)),
        `"${q}" devolvió algo comprable que no debería: ${r.tipo}`);
    }
    assert.strictEqual(desc.esComprable('9995'), false, 'los portes no son un producto');
    assert.strictEqual(desc.esComprable('OF3900'), false);
    assert.strictEqual(desc.esComprable('0052'), true, 'un chorizo sí');
  });

  await check('72· solo se filtra por atributos que existen en el catálogo', async () => {
    const sl = desc.buscar('sin lactosa');
    assert.strictEqual(sl.tipo, 'varios');
    for (const p of sl.candidatos) {
      assert.strictEqual(p.lactosa, false,
        `${p.codigo} no tiene el dato de lactosa confirmado`);
    }
    // Un atributo que no existe no se inventa.
    const inventado = desc.buscar('sin conservantes');
    assert(['nada', 'varios', 'familia'].includes(inventado.tipo));
    assert.strictEqual(inventado.interpretacion.atributos.length, 0);
  });

  await check('73· el código sigue siendo un atajo válido, no un requisito', async () => {
    const porCodigo = desc.buscar('quiero el 6305');
    assert.strictEqual(porCodigo.tipo, 'producto');
    assert.strictEqual(porCodigo.por, 'codigo');
    // Y el mismo producto se alcanza sin saberlo.
    const porNombre = desc.buscar('chorizo cular');
    assert.strictEqual(porNombre.tipo, 'producto');
    assert.strictEqual(porNombre.por, 'nombre');
    assert.strictEqual(porNombre.producto.codigo, porCodigo.producto.codigo);
  });

  await check('74· los 19 duplicados salen una sola vez', async () => {
    const r = desc.buscar('chorizo');
    const codigos = (r.candidatos || []).map((p) => p.codigo);
    assert.strictEqual(new Set(codigos).size, codigos.length, 'hay códigos repetidos');
  });

  await check('75· los habituales salen del histórico, sin recomendador', async () => {
    const pedidos = [
      { lineas: [{ codigo: '0052' }, { codigo: '6305' }] },
      { lineas: [{ codigo: '0052' }] },
      { lineas: [{ codigo: '9995' }] },          // portes: no es producto
    ];
    const h = desc.habituales(pedidos, { limite: 5 });
    assert.strictEqual(h[0].producto.codigo, '0052', 'el más repetido va primero');
    assert.strictEqual(h[0].veces, 2);
    assert(!h.some((x) => x.producto.codigo === '9995'), 'los portes no son un habitual');
  });

  await check('76· el catálogo comercial es navegable sin escribir un código', async () => {
    /* La métrica que decide el MVP: cuántos productos se alcanzan escribiendo
       su nombre, sin saber la referencia. */
    const comerciales = [...desc.indice().values()];
    let alcanzables = 0;
    for (const e of comerciales) {
      const palabras = e.nombre.split(' ').filter((w) => w.length > 3).slice(0, 2).join(' ');
      if (!palabras) continue;
      const r = desc.buscar(palabras);
      const lista = r.tipo === 'producto' ? [r.producto] : (r.candidatos || []);
      if (lista.some((p) => p.codigo === e.codigo)) alcanzables += 1;
    }
    const pct = (100 * alcanzables) / comerciales.length;
    console.log(`     · ${alcanzables}/${comerciales.length} (${pct.toFixed(0)}%) alcanzables por nombre`);
    assert(pct >= 90, `solo el ${pct.toFixed(0)}% se alcanza sin código`);
  });

  console.log('\n=== 21) Compra guiada: cliente que NO conoce ninguna referencia ===');

  const router = require(path.join(ROOT, 'lib/chacon/router'));
  const estadosLib = require(path.join(ROOT, 'lib/chacon/estados'));
  const flujoLib = require(path.join(ROOT, 'lib/chacon/flujo'));

  await check('77· la máquina de estados rechaza transiciones imposibles', async () => {
    const TEL = '34600999010';
    await estadosLib.reiniciar(TEL); await conPrivacidad(TEL);
    // De HOME no se puede saltar a confirmar un pedido.
    const m = await estadosLib.mover(TEL, 'CONFIRMATION', {}, { motivo: 'prueba' });
    assert.strictEqual(m.estado, 'HOME', 'un salto imposible no puede mover el estado');
    const ok = await estadosLib.mover(TEL, 'PRODUCT_DISCOVERY', {}, { motivo: 'prueba' });
    assert.strictEqual(ok.estado, 'PRODUCT_DISCOVERY');
  });

  await check('78· PRUEBA DE ACEPTACIÓN: pedido completo sin escribir un código', async () => {
    const TEL = '34600999011';
    const cli = await repo.crearCliente({ nombre: 'Carnicería Sin Códigos', telefono: TEL }); await conPrivacidad(TEL);
    await pedidoLib.vaciar(cli.id);
    await estadosLib.reiniciar(TEL); await conPrivacidad(TEL);

    const dicho = [];
    const paso = async (tipo, valor) => {
      dicho.push(valor);
      const p = await router.manejar({ telefono: TEL, cliente: cli, tipo, valor });
      assert(p && p.length, `sin respuesta a ${tipo} "${valor}"`);
      // En NINGÚN momento se le puede pedir una referencia.
      const t = p.map((x) => formato.aTexto(x)).join('\n');
      assert(!/dime el c[oó]digo|indica la referencia|n[uú]mero de referencia/i.test(t),
        `el bot pidió una referencia tras "${valor}": ${t.slice(0, 120)}`);
      return p;
    };

    await paso('texto', 'hola');
    await paso('clic', 'hacer_pedido');
    // 1. Encontrar un chorizo sin saber su código.
    const res = await paso('texto', 'quiero chorizo');
    const filas = res[0].interactive.action.sections[0].rows.filter((f) => f.id.startsWith('prod:'));
    assert(filas.length >= 2, 'tiene que enseñar varias opciones de chorizo');
    // 2. Elegir uno, ver precio y añadir una caja.
    const elegido = filas[0].id.slice(5);
    const ficha = await paso('clic', `prod:${elegido}`);
    const textoFicha = ficha.map((x) => formato.aTexto(x)).join('\n');
    assert(/€\/kg/.test(textoFicha), 'la ficha tiene que enseñar el precio');
    assert(!/Tarifa \d/.test(textoFicha), 'al cliente no se le enseña la tarifa interna');
    await paso('clic', `cant:${elegido}:1:caja`);

    // 3. Buscar un salchichón, también sin código.
    const sal = await paso('texto', 'ahora quiero salchichon');
    const filasSal = sal[0].interactive.action.sections[0].rows.filter((f) => f.id.startsWith('prod:'));
    assert(filasSal.length >= 1);
    const elegido2 = filasSal[0].id.slice(5);
    await paso('clic', `prod:${elegido2}`);
    await paso('clic', `cant:${elegido2}:2:caja`);

    // 4. Revisar, cambiar una cantidad y confirmar.
    const carritoPantalla = await paso('clic', 'ver_carrito');
    const tCarrito = carritoPantalla.map((x) => formato.aTexto(x)).join('\n');
    assert(/Tu pedido/.test(tCarrito));
    await paso('clic', 'modificar_carrito');
    await paso('clic', `edit:${elegido}`);
    await paso('clic', `cant:${elegido}:3:caja`);

    const carrito = await repo.getCarrito(cli.id);
    assert.strictEqual(carrito.lineas.length, 2, 'tienen que quedar los dos productos');
    const l1 = carrito.lineas.find((l) => l.codigo === elegido);
    assert.strictEqual(l1.cantidad, 3, 'la cantidad corregida no se guardó');
    assert.strictEqual(l1.unidad_pedido, 'caja');

    const conf = await pedidoLib.confirmar(cli.id, { clave_idempotencia: 'wamid.SINCOD' });
    assert.strictEqual(conf.ok, true, 'el pedido tiene que poder confirmarse');
    assert.strictEqual(conf.pedido.lineas.length, 2);

    // Y no se escribió ni un solo código en todo el recorrido.
    const escritos = dicho.filter((x) => typeof x === 'string' && !x.includes(':'));
    for (const frase of escritos) {
      assert(!/\b\d{4,}\b/.test(frase), `se escribió un código: "${frase}"`);
    }
  });

  await check('79· el flujo guiado no pide referencias en ningún camino', async () => {
    const TEL = '34600999012';
    const cli = await repo.crearCliente({ nombre: 'Tienda Caminos', telefono: TEL }); await conPrivacidad(TEL);
    for (const [tipo, valor] of [
      ['texto', 'hola'], ['clic', 'ver_familias'], ['clic', 'fam:quesos'],
      ['clic', 'ver_ofertas'], ['texto', 'que salchichones tienes'],
      ['texto', 'ofertas de chorizo'], ['clic', 'repetir_pedido'],
      ['texto', 'no se como se llama'], ['clic', 'hablar_fernando'],
    ]) {
      const p = await router.manejar({ telefono: TEL, cliente: cli, tipo, valor });
      if (!p) continue;
      const t = p.map((x) => formato.aTexto(x)).join('\n');
      assert(!/dime el c[oó]digo|indica la referencia/i.test(t), `"${valor}" pidió referencia`);
      assert(!/Tarifa \d|tramo|duplicado|parser|motor de/i.test(t),
        `"${valor}" enseñó jerga interna: ${t.slice(0, 100)}`);
    }
  });

  await check('80· tras dos intentos fallidos se ofrece hablar con Fernando', async () => {
    const TEL = '34600999013';
    const cli = await repo.crearCliente({ nombre: 'Tienda Perdida', telefono: TEL }); await conPrivacidad(TEL);
    await estadosLib.reiniciar(TEL); await conPrivacidad(TEL);
    await router.manejar({ telefono: TEL, cliente: cli, tipo: 'texto', valor: 'xyzabc' });
    const p = await router.manejar({ telefono: TEL, cliente: cli, tipo: 'texto', valor: 'qwerty' });
    const t = p.map((x) => formato.aTexto(x)).join('\n');
    assert(/Fernando/.test(t), 'a los dos intentos hay que ofrecer una persona');
    const { maquina } = await estadosLib.leer(TEL);
    assert.strictEqual(maquina.estado, 'HUMAN_HANDOFF');
  });

  console.log('\n=== 22) Identificación del cliente (bugs de producción) ===');

  const ident = require(path.join(ROOT, 'lib/chacon/identificacion'));

  await check('A· un nombre suelto NO se manda al buscador de productos', async () => {
    const TEL = '34600777001';
    await estadosLib.reiniciar(TEL); await conPrivacidad(TEL);
    await router.pedirIdentificacion(TEL);
    const { maquina } = await estadosLib.leer(TEL);
    assert.strictEqual(maquina.estado, 'CUSTOMER_IDENTIFICATION');
    assert.strictEqual(maquina.slot_pendiente, 'BUSINESS_NAME');

    const p = await router.manejar({ telefono: TEL, cliente: null,
      tipo: 'texto', valor: 'Tony Tienda' });
    const t = p.map((x) => formato.aTexto(x)).join('\n');
    // El bug: contestaba "No he encontrado «tony tienda»" y ofrecía familias.
    assert(!/No he encontrado/.test(t), 'lo trató como búsqueda de producto');
    assert(!/Embutidos curados|Quesos|Conservas/.test(t), 'ofreció familias');
    assert(/No encuentro «Tony Tienda»/.test(t), t.slice(0, 120));
  });

  await check('B· una frase natural se reduce al nombre del negocio', async () => {
    assert.strictEqual(ident.nombreDeNegocio('el nombre de mi tienda es Tony Tienda'),
      'Tony Tienda');
    assert.strictEqual(ident.nombreDeNegocio('mi tienda es Tony Tienda'), 'Tony Tienda');
    assert.strictEqual(ident.nombreDeNegocio('somos Carnicería Pepe'), 'Carnicería Pepe');
    assert.strictEqual(ident.nombreDeNegocio('Tony Tienda'), 'Tony Tienda');
    assert.strictEqual(ident.nombreDeNegocio('6305'), null, 'un código no es un negocio');

    const TEL = '34600777002';
    await estadosLib.reiniciar(TEL); await conPrivacidad(TEL);
    await router.pedirIdentificacion(TEL);
    const p = await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto',
      valor: 'el nombre de mi tienda es Tony Tienda' });
    const t = p.map((x) => formato.aTexto(x)).join('\n');
    assert(/«Tony Tienda»/.test(t), `no extrajo el nombre: ${t.slice(0, 120)}`);
    assert(!/el nombre de mi tienda/.test(t), 'usó la frase entera como nombre');
  });

  await check('C· negocio no encontrado: reintentar o Fernando, NUNCA familias', async () => {
    const TEL = '34600777003';
    await estadosLib.reiniciar(TEL); await conPrivacidad(TEL);
    await router.pedirIdentificacion(TEL);
    const p = await router.manejar({ telefono: TEL, cliente: null,
      tipo: 'texto', valor: 'Negocio Que No Existe SL' });
    const t = p.map((x) => formato.aTexto(x)).join('\n');
    assert(/otro nombre/i.test(t) || /Probar otro/i.test(t), t.slice(0, 200));
    assert(/Fernando/.test(t));
    // Los títulos de botón tienen que caber en los 20 caracteres de Meta:
    // si se cortan, el cliente lee "Probar otro nomb…".
    for (const m of p) {
      if (m.type !== 'interactive' || m.interactive.type !== 'button') continue;
      for (const b of m.interactive.action.buttons) {
        assert(!b.reply.title.endsWith('…'), `botón cortado: "${b.reply.title}"`);
      }
    }
    assert(!/[Ff]amilias/.test(t), 'ofreció familias durante la identificación');
    assert(!/ofertas/i.test(t), 'ofreció catálogo durante la identificación');
  });

  await check('D· «Ver familias» muestra familias, no productos', async () => {
    const TEL = '34600777004';
    await estadosLib.reiniciar(TEL); await conPrivacidad(TEL);
    const p = await router.manejar({ telefono: TEL, cliente: null, tipo: 'clic',
      valor: 'ver_familias' });
    const t = p.map((x) => formato.aTexto(x)).join('\n');
    assert(/Embutidos curados/.test(t), 'no salieron las familias');
    assert(!/Ref\. \d/.test(t), 'salieron productos en la pantalla de familias');
    const { maquina } = await estadosLib.leer(TEL);
    assert.strictEqual(maquina.estado, 'FAMILY_SELECTION');
  });

  await check('E· una búsqueda anterior NO contamina la pantalla de familias', async () => {
    const TEL = '34600777005';
    await estadosLib.reiniciar(TEL); await conPrivacidad(TEL);
    // Se busca salchichón: quedan resultados y familia en el estado.
    await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto', valor: 'salchichon' });
    const antes = (await estadosLib.leer(TEL)).maquina;
    assert(antes.datos.mostrados && antes.datos.mostrados.length, 'la búsqueda debe dejar rastro');

    const p = await router.manejar({ telefono: TEL, cliente: null, tipo: 'clic',
      valor: 'ver_familias' });
    const t = p.map((x) => formato.aTexto(x)).join('\n');
    assert(!/Salchichon Casero|Ref\. 4315/i.test(t), 'FUGA: se colaron los salchichones');
    assert(/Embutidos curados/.test(t));
    const { maquina } = await estadosLib.leer(TEL);
    assert.strictEqual(maquina.estado, 'FAMILY_SELECTION');
    for (const campo of estadosLib.CAMPOS_DE_BUSQUEDA) {
      assert(maquina.datos[campo] === undefined, `quedó ${campo} sin limpiar`);
    }
  });

  await check('F· identificar NO puede tocar el carrito', async () => {
    const TEL = '34600777006';
    const c = await repo.crearCliente({ nombre: 'Tienda Carrito Intacto', telefono: TEL }); await conPrivacidad(TEL);
    await pedidoLib.vaciar(c.id);
    const chorizo = catalogo.todos().find((x) => x.codigo === '0052');
    const salchichon = catalogo.todos().find((x) => x.codigo === '4315');
    await pedidoLib.anadir(c.id, { producto_id: chorizo.id, cantidad: 1, unidad_pedido: 'caja' });
    await pedidoLib.anadir(c.id, { producto_id: salchichon.id, cantidad: 2, unidad_pedido: 'unidad' });
    const antes = JSON.stringify((await repo.getCarrito(c.id)).lineas
      .map((l) => [l.codigo, l.cantidad, l.unidad_pedido, l.precio_kg_sin_iva]));

    await estadosLib.reiniciar(TEL); await conPrivacidad(TEL);
    await router.pedirIdentificacion(TEL);
    await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto', valor: 'Nombre Falso' });
    await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto',
      valor: 'Tienda Carrito Intacto' });

    const despues = JSON.stringify((await repo.getCarrito(c.id)).lineas
      .map((l) => [l.codigo, l.cantidad, l.unidad_pedido, l.precio_kg_sin_iva]));
    assert.strictEqual(despues, antes, 'la identificación cambió el carrito');
  });

  await check('G· tras identificar se vuelve al estado previo, no a HOME', async () => {
    for (const previo of ['CART', 'PRODUCT_SELECTION']) {
      const TEL = `3460077700${previo === 'CART' ? 7 : 8}`;
      const c = await repo.crearCliente({ nombre: `Tienda Vuelve ${previo}`, telefono: TEL }); await conPrivacidad(TEL);
      await estadosLib.reiniciar(TEL); await conPrivacidad(TEL);
      await estadosLib.mover(TEL, previo === 'CART' ? 'CART' : 'PRODUCT_SELECTION',
        previo === 'CART' ? {} : { mostrados: ['0052'] }, { motivo: 'preparar' });

      await router.pedirIdentificacion(TEL);
      assert.strictEqual((await estadosLib.leer(TEL)).maquina.estado_previo, previo);
      // Se confirma un cliente REAL de la agenda: el vínculo no se inventa.
      await router.manejar({ telefono: TEL, cliente: null, tipo: 'clic', valor: 'cliente_si:340' });
      assert.strictEqual((await estadosLib.leer(TEL)).maquina.estado, previo,
        `no volvió a ${previo}`);
    }
  });

  await check('H· un teléfono ya conocido no vuelve a preguntar el nombre', async () => {
    const TEL = '34600777009';
    await repo.crearCliente({ nombre: 'Tienda Conocida', telefono: TEL });
    const r = await ident.porTelefono(TEL);
    assert.strictEqual(r.estado, 'encontrado');
    assert.strictEqual(r.por, 'telefono');
    assert.strictEqual(r.cliente.nombre, 'Tienda Conocida');
    // Y con cliente conocido, un texto normal va al catálogo, no a identificar.
    await estadosLib.reiniciar(TEL); await conPrivacidad(TEL);
    const p = await router.manejar({ telefono: TEL, cliente: r.cliente,
      tipo: 'texto', valor: 'quiero chorizo' });
    const t = p.map((x) => formato.aTexto(x)).join('\n');
    assert(!/cómo se llama tu negocio/i.test(t), 'volvió a preguntar el nombre');
  });

  await check('I· con negocios parecidos se pregunta, no se elige', async () => {
    // "carniceria" sola casa con varios clientes reales de la agenda.
    const r = agenda.buscar('carniceria');
    assert.strictEqual(r.tipo, 'varios', `esperaba varios, salió ${r.tipo}`);
    assert(r.candidatos.length >= 2);

    const TEL = '34600777012';
    await estadosLib.reiniciar(TEL); await conPrivacidad(TEL);
    await router.pedirIdentificacion(TEL);
    const p = await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto',
      valor: 'carniceria' });
    const t = p.map((x) => formato.aTexto(x)).join('\n');
    assert(/clientes parecidos/i.test(t), t.slice(0, 140));
    assert.strictEqual((await estadosLib.leer(TEL)).maquina.estado, 'CUSTOMER_IDENTIFICATION');
    assert.strictEqual(await repo.clientePorTelefono(TEL), null, 'vinculó sin confirmar');
  });

  await check('J· pulsar una cantidad SIN tienda abre la identificación', async () => {
    /* El agujero del primer arreglo: la excepción `type !== interactive`
       dejaba el clic fuera, el estado se quedaba en QUANTITY_SELECTION y la
       respuesta al nombre caía otra vez en el buscador. */
    const TEL = '34600777020';
    await estadosLib.reiniciar(TEL); await conPrivacidad(TEL);
    await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto', valor: 'quiero chorizo' });
    const p = await router.manejar({ telefono: TEL, cliente: null, tipo: 'clic',
      valor: 'cant:0052:1:caja' });
    assert(p && p.length, 'un clic sin tienda no puede quedarse sin respuesta');
    const t = p.map((x) => formato.aTexto(x)).join('\n');
    assert(/cómo se llama tu negocio/i.test(t), t.slice(0, 120));
    const { maquina } = await estadosLib.leer(TEL);
    assert.strictEqual(maquina.estado, 'CUSTOMER_IDENTIFICATION');
    assert.strictEqual(maquina.slot_pendiente, 'BUSINESS_NAME');
    assert.strictEqual(maquina.datos.accion_pendiente, 'cant:0052:1:caja',
      'hay que recordar qué estaba haciendo para retomarlo');

    // Y la respuesta al nombre NO va al catálogo.
    const r = await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto',
      valor: 'tony tienda' });
    const t2 = r.map((x) => formato.aTexto(x)).join('\n');
    assert(!/No he encontrado|Embutidos curados/.test(t2),
      `la respuesta al nombre acabó en el buscador: ${t2.slice(0, 140)}`);
  });

  await check('K· fuera de la agenda no hay cliente, ni con el botón viejo', async () => {
    /* La agenda de Chacón decide quién es cliente. Ya no existe el alta
       libre: un negocio que no está no puede comprar, y forzar el botón de
       una conversación antigua tampoco lo crea. */
    const TEL = '34600777021';
    await estadosLib.reiniciar(TEL); await conPrivacidad(TEL);
    await router.pedirIdentificacion(TEL);
    const p = await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto',
      valor: 'Tienda Que No Existe SL' });
    const t = p.map((x) => formato.aTexto(x)).join('\n');
    assert(/No encuentro/.test(t), t.slice(0, 140));
    assert(!/[Ff]amilias|Embutidos|ofertas/i.test(t), 'no se ofrece catálogo identificando');
    assert(/Fernando/.test(t));
    assert.strictEqual(await repo.clientePorTelefono(TEL), null);

    const forzado = await router.manejar({ telefono: TEL, cliente: null, tipo: 'clic',
      valor: 'alta_negocio' });
    assert(!/Perfecto/.test(forzado.map((x) => formato.aTexto(x)).join('\n')));
    assert.strictEqual(await repo.clientePorTelefono(TEL), null,
      'el botón viejo no puede crear un cliente');
  });

  await check('L· el código de cliente de la agenda identifica sin ambigüedad', async () => {
    const TEL = '34600777031';
    await estadosLib.reiniciar(TEL); await conPrivacidad(TEL);
    await router.pedirIdentificacion(TEL);
    // 90014 es CARNICERIA EL CHINO en la agenda real.
    const p = await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto', valor: '90014' });
    const t = p.map((x) => formato.aTexto(x)).join('\n');
    assert(/CARNICERIA EL CHINO/.test(t), t.slice(0, 140));
    assert.strictEqual(agenda.buscar('90014').por, 'codigo');
  });

  console.log('\n=== 23) Privacidad, canal y marketing ===');

  const priv = require(path.join(ROOT, 'lib/chacon/privacidad'));
  const conCliente = async (tel) => repo.clientePorTelefono(tel);

  await check('P-A· un teléfono nuevo ve el aviso antes de nada', async () => {
    const TEL = '34600666001';
    await estadosLib.reiniciar(TEL);
    const p = await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto', valor: 'hola' });
    const t = p.map((x) => formato.aTexto(x)).join('\n');
    assert(/asistente de pedidos de \*Chacón Alcántara\*/.test(t), t.slice(0, 140));
    assert(/¿Quieres continuar/.test(t));
    assert(/Continuar/.test(t) && /Ahora no/.test(t));
    const { maquina } = await estadosLib.leer(TEL);
    assert.strictEqual(maquina.estado, 'PRIVACY_ONBOARDING');
    assert.strictEqual(maquina.slot_pendiente, 'PRIVACY_ACCEPT');
    // Y no se ha buscado producto ni creado cliente.
    assert(!/Embutidos|Ref\. /.test(t));
    assert.strictEqual(await conCliente(TEL), null);
  });

  await check('P-B· si dice que no, no se automatiza nada', async () => {
    const TEL = '34600666002';
    await estadosLib.reiniciar(TEL);
    await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto', valor: 'hola' });
    const p = await router.manejar({ telefono: TEL, cliente: null, tipo: 'clic',
      valor: 'privacidad_no' });
    const t = p.map((x) => formato.aTexto(x)).join('\n');
    assert(/No continuaremos/.test(t), t.slice(0, 120));
    assert(!/Embutidos|Hacer un pedido/.test(t), 'no puede seguir ofreciendo el catálogo');
    assert.strictEqual(await conCliente(TEL), null, 'no puede crear cliente');
    const r = await priv.registro(TEL);
    assert.strictEqual(r.status, 'rechazado');
    assert(r.declined_at);
    // Y al volver a escribir, se le vuelve a informar; no se cuela.
    const otra = await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto',
      valor: 'quiero chorizo' });
    assert(/¿Quieres continuar/.test(otra.map((x) => formato.aTexto(x)).join('\n')));
  });

  await check('P-C· aceptar deja constancia con versión, momento y acción', async () => {
    const TEL = '34600666003';
    await estadosLib.reiniciar(TEL);
    await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto', valor: 'hola' });
    await router.manejar({ telefono: TEL, cliente: null, tipo: 'clic', valor: 'privacidad_si' });
    const r = await priv.registro(TEL);
    assert.strictEqual(r.status, 'aceptado');
    assert.strictEqual(r.phone_number, TEL);
    assert.strictEqual(r.channel, 'whatsapp');
    assert.strictEqual(r.privacy_notice_version, priv.VERSION_AVISO);
    assert.strictEqual(r.accepted_action, 'boton_continuar');
    assert.strictEqual(r.source, 'whatsapp_conversation');
    assert(r.accepted_at, 'falta cuándo');
    assert(r.historial.length >= 1);
    // Aceptar el canal NO es aceptar marketing.
    assert.strictEqual(r.marketing_opt_in, false, 'no se puede dar marketing por aceptado');
  });

  await check('P-D· un teléfono con aviso vigente no lo repite', async () => {
    const TEL = '34600666004';
    await repo.crearCliente({ nombre: 'Tienda Ya Conocida', telefono: TEL });
    await priv.registrarDecision(TEL, priv.ESTADOS.ACEPTADO, { accepted_action: 'previo' });
    await estadosLib.reiniciar(TEL);
    const p = await router.manejar({ telefono: TEL, cliente: await conCliente(TEL),
      tipo: 'texto', valor: 'hola' });
    const t = p.map((x) => formato.aTexto(x)).join('\n');
    assert(!/¿Quieres continuar/.test(t), 'repitió el aviso a un cliente conocido');
    assert(/Hola, Tienda Ya Conocida/.test(t), t.slice(0, 120));
  });

  await check('P-E· tras aceptar, si no le conocemos, se identifica', async () => {
    const TEL = '34600666005';
    await estadosLib.reiniciar(TEL);
    await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto', valor: 'hola' });
    const p = await router.manejar({ telefono: TEL, cliente: null, tipo: 'clic',
      valor: 'privacidad_si' });
    assert(/cómo se llama tu negocio/i.test(p.map((x) => formato.aTexto(x)).join('\n')));
    assert.strictEqual((await estadosLib.leer(TEL)).maquina.estado, 'CUSTOMER_IDENTIFICATION');
  });

  await check('P-F· el nombre del negocio nunca va al buscador (regresión)', async () => {
    const TEL = '34600666006';
    await estadosLib.reiniciar(TEL);
    await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto', valor: 'hola' });
    await router.manejar({ telefono: TEL, cliente: null, tipo: 'clic', valor: 'privacidad_si' });
    const p = await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto',
      valor: 'el nombre de mi tienda es Tony Tienda' });
    const t = p.map((x) => formato.aTexto(x)).join('\n');
    assert(!/No he encontrado|Embutidos curados/.test(t), t.slice(0, 140));
    assert(/Tony Tienda/.test(t));
  });

  await check('P-G· tras aceptar, un negocio fuera de la agenda no crea ficha', async () => {
    const TEL = '34600666007';
    await estadosLib.reiniciar(TEL);
    await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto', valor: 'hola' });
    await router.manejar({ telefono: TEL, cliente: null, tipo: 'clic', valor: 'privacidad_si' });
    await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto', valor: 'Tienda Nueva P-G' });
    assert.strictEqual(await repo.clientePorTelefono(TEL), null,
      'aceptar privacidad no puede crear un cliente de Chacón');
    // Pero el registro de privacidad sí queda, para que Fernando lo revise.
    const r = await priv.registro(TEL);
    assert.strictEqual(r.status, 'aceptado');
    assert.strictEqual(r.customer_id, null, 'sin cliente todavía');
  });

  await check('P-H· el mismo teléfono no crea un segundo cliente', async () => {
    const TEL = '34600666008';
    const c1 = await repo.crearCliente({ nombre: 'Tienda Unica', telefono: TEL });
    await priv.registrarDecision(TEL, priv.ESTADOS.ACEPTADO, { accepted_action: 'previo' });
    await estadosLib.reiniciar(TEL);
    for (const v of ['hola', 'quiero chorizo', 'hola']) {
      await router.manejar({ telefono: TEL, cliente: await conCliente(TEL), tipo: 'texto', valor: v });
    }
    const todas = (await repo.listarClientes()).filter((x) => x.nombre === 'Tienda Unica');
    assert.strictEqual(todas.length, 1);
    assert.strictEqual((await conCliente(TEL)).id, c1.id);
  });

  await check('P-I· rechazar marketing NO impide comprar', async () => {
    const TEL = '34600666009';
    const c = await repo.crearCliente({ nombre: 'Tienda Sin Promos', telefono: TEL });
    await priv.registrarDecision(TEL, priv.ESTADOS.ACEPTADO, { accepted_action: 'previo' });
    await router.manejar({ telefono: TEL, cliente: c, tipo: 'clic', valor: 'marketing_no' });
    assert.strictEqual(await priv.quiereMarketing(TEL), false);

    await estadosLib.reiniciar(TEL);
    const p = await router.manejar({ telefono: TEL, cliente: c, tipo: 'texto', valor: 'quiero chorizo' });
    const t = p.map((x) => formato.aTexto(x)).join('\n');
    assert(/chorizo/i.test(t), 'sin marketing tiene que poder comprar igual');
    assert(!/¿Quieres continuar/.test(t));
  });

  await check('P-J· el sí a marketing se guarda aparte del canal', async () => {
    const TEL = '34600666010';
    const c = await repo.crearCliente({ nombre: 'Tienda Con Promos', telefono: TEL });
    await priv.registrarDecision(TEL, priv.ESTADOS.ACEPTADO, { accepted_action: 'previo' });
    const antes = await priv.registro(TEL);
    assert.strictEqual(antes.marketing_opt_in, false, 'no puede venir aceptado de serie');

    await router.manejar({ telefono: TEL, cliente: c, tipo: 'clic', valor: 'marketing_si' });
    const r = await priv.registro(TEL);
    assert.strictEqual(r.marketing_opt_in, true);
    assert(r.marketing_opt_in_at, 'falta cuándo');
    assert(r.marketing_opt_in_source, 'falta de dónde');
    assert.strictEqual(r.status, 'aceptado', 'el canal sigue igual');
  });

  await check('P-K· pedir la baja de ofertas funciona en cualquier momento', async () => {
    const TEL = '34600666011';
    const c = await repo.crearCliente({ nombre: 'Tienda Baja', telefono: TEL });
    await priv.registrarDecision(TEL, priv.ESTADOS.ACEPTADO, { accepted_action: 'previo' });
    await priv.fijarMarketing(TEL, true);

    for (const frase of ['no quiero más ofertas', 'dejar de recibir promociones',
                         'no me mandéis publicidad']) {
      await priv.fijarMarketing(TEL, true);
      const p = await router.manejar({ telefono: TEL, cliente: c, tipo: 'texto', valor: frase });
      const t = p.map((x) => formato.aTexto(x)).join('\n');
      assert(/no te mandaremos más ofertas/i.test(t), `"${frase}": ${t.slice(0, 100)}`);
      assert(/seguir haciendo pedidos/i.test(t), 'hay que dejar claro que puede seguir pidiendo');
      const r = await priv.registro(TEL);
      assert.strictEqual(r.marketing_opt_in, false);
      assert(r.marketing_opt_out_at);
      assert.strictEqual(r.status, 'aceptado', 'la baja de marketing no toca el canal');
    }
  });

  await check('P-L· el carrito sobrevive al aviso y a la identificación', async () => {
    process.env.CHACON_ALTA_LIBRE = '1';
    const TEL = '34600666012';
    const c = await repo.crearCliente({ nombre: 'Tienda Carrito Privacidad', telefono: TEL });
    await pedidoLib.vaciar(c.id);
    await pedidoLib.anadir(c.id, { producto_id: PIEL.id, cantidad: 1, unidad_pedido: 'caja' });
    await pedidoLib.anadir(c.id, { producto_id: catalogo.todos().find((x) => x.codigo === '4315').id,
      cantidad: 2, unidad_pedido: 'unidad' });
    const antes = JSON.stringify((await repo.getCarrito(c.id)).lineas
      .map((l) => [l.codigo, l.cantidad, l.unidad_pedido, l.precio_kg_sin_iva]));

    // Se fuerza un aviso nuevo (como si cambiara la versión) estando en CART.
    await estadosLib.reiniciar(TEL);
    await estadosLib.mover(TEL, 'CART', {}, { motivo: 'preparar' });
    await router.pedirPrivacidad(TEL);
    await router.manejar({ telefono: TEL, cliente: null, tipo: 'clic', valor: 'privacidad_si' });

    const despues = JSON.stringify((await repo.getCarrito(c.id)).lineas
      .map((l) => [l.codigo, l.cantidad, l.unidad_pedido, l.precio_kg_sin_iva]));
    assert.strictEqual(despues, antes, 'el onboarding cambió el carrito');
    assert.strictEqual((await estadosLib.leer(TEL)).maquina.estado, 'CART', 'no volvió al carrito');
    delete process.env.CHACON_ALTA_LIBRE;
  });

  await check('P-N· el panel separa canal y marketing, y deja verificar', async () => {
    const TEL = '34600666020';
    const c = await repo.crearCliente({ nombre: 'Tienda Panel Privacidad', telefono: TEL });
    await priv.registrarDecision(TEL, priv.ESTADOS.ACEPTADO, { accepted_action: 'previo' });
    await priv.fijarMarketing(TEL, true);

    const r = makeRes();
    await panel({ method: 'GET', headers: {}, query: { token: process.env.PANEL_TOKEN, v: 'clientes' } }, r);
    assert.strictEqual(r.statusCode, 200);
    assert(/Canal WhatsApp/.test(r.body) && /Ofertas/.test(r.body),
      'canal y marketing tienen que verse por separado');
    assert(!/>Consentimiento</.test(r.body), 'una sola casilla "consentimiento" sería ambigua');
    assert(/Tienda Panel Privacidad/.test(r.body));
    assert(new RegExp(priv.VERSION_AVISO).test(r.body), 'falta la versión del aviso');

    // Fernando verifica al cliente desde el panel, y queda firmado.
    const post = makeRes();
    await panel({ method: 'POST', headers: {}, query: { token: process.env.PANEL_TOKEN },
      body: { accion: 'cliente_estado', cliente_id: c.id, estado: 'verificado', por: 'Fernando' } }, post);
    const c2 = await repo.clientePorId(c.id);
    assert.strictEqual(c2.estado, 'verificado');
    assert.strictEqual(c2.verificado_por, 'Fernando');

    // Y puede quitar el marketing sin tocar la autorización del canal.
    const mk = makeRes();
    await panel({ method: 'POST', headers: {}, query: { token: process.env.PANEL_TOKEN },
      body: { accion: 'marketing', telefono: TEL, valor: '0', por: 'Fernando' } }, mk);
    const reg = await priv.registro(TEL);
    assert.strictEqual(reg.marketing_opt_in, false);
    assert.strictEqual(reg.status, 'aceptado', 'quitar marketing no puede revocar el canal');
  });

  await check('P-M· sin URL de política no se inventa un enlace', async () => {
    const guardada = process.env.CHACON_PRIVACIDAD_URL;
    delete process.env.CHACON_PRIVACIDAD_URL;
    const t = priv.textoAviso();
    assert(!/https?:\/\//.test(t), 'se inventó una URL');
    assert(/te la facilitará Chacón Alcántara/.test(t));

    process.env.CHACON_PRIVACIDAD_URL = 'https://ejemplo.test/privacidad';
    assert(/https:\/\/ejemplo\.test\/privacidad/.test(priv.textoAviso()));
    if (guardada) process.env.CHACON_PRIVACIDAD_URL = guardada;
    else delete process.env.CHACON_PRIVACIDAD_URL;
  });

  console.log('\n=== 24) Agenda de clientes de Chacón ===');

  const conAgenda = agenda.disponible();
  const siAgenda = (label, fn) => (conAgenda ? check(label, fn)
    : (console.log('  ⏭️ ', label, '— sin agenda importada'), Promise.resolve()));

  await siAgenda('AG-0· la agenda importa 207 clientes sin duplicados', async () => {
    const r = agenda.resumen();
    assert.strictEqual(r.filas_fuente, 230);
    assert.strictEqual(r.duplicados_exactos, 9);
    assert.strictEqual(r.clientes_unicos, 207, 'un código = un cliente');
    assert.strictEqual(r.multi_centro, 3);
    assert(r.aprobada, 'solo manda una versión aprobada');
    // Los ceros iniciales sobreviven: 01 nunca es 1.
    assert(r.centros_vistos.includes('01') && r.centros_vistos.includes('1'),
      '01 y 1 conviven y no son lo mismo');
    assert(r.centros_vistos.includes('03') && r.centros_vistos.includes('3'));
  });

  await siAgenda('AG-1· "Carniceria El Chino" resuelve al cliente real', async () => {
    const r = agenda.buscar('Carniceria El Chino');
    assert.strictEqual(r.tipo, 'exacto');
    assert.strictEqual(r.cliente.customer_code, '90014');
    assert.strictEqual(r.cliente.legal_name, 'CARNICERIA EL CHINO, S.L.');
    assert.strictEqual(agenda.centroDe(r.cliente).center, '2');
  });

  await siAgenda('AG-2· "Autoservicio Carrillo" resuelve, y sin centro', async () => {
    const r = agenda.buscar('Autoservicio Carrillo');
    assert.strictEqual(r.tipo, 'exacto');
    assert.strictEqual(r.cliente.customer_code, '340');
    const c = agenda.centroDe(r.cliente);
    assert.strictEqual(c.center, null);
    assert.strictEqual(c.estado, 'sin_centro', 'sin centro NO es centro "0"');
  });

  await siAgenda('AG-3· "Bollysur" no se duplica pese a tener dos filas', async () => {
    const r = agenda.buscar('Bollysur');
    assert.strictEqual(r.tipo, 'exacto');
    assert.strictEqual(r.cliente.customer_code, '50146');
    // Dos filas en el Excel (una sin centro, otra con 01) = UN cliente.
    const iguales = agenda.todos().filter((c) => c.customer_code === '50146');
    assert.strictEqual(iguales.length, 1);
    assert(r.cliente.centers.includes('01'), 'el centro 01 tiene que conservarse');
  });

  await siAgenda('AG-4· con varios centros NO se elige ninguno', async () => {
    const r = agenda.buscar('Alimentacion Peninsular');
    assert.strictEqual(r.tipo, 'exacto');
    assert.strictEqual(r.cliente.customer_code, '405001');
    const centros = r.cliente.centers.filter(Boolean);
    assert.deepStrictEqual(centros.sort(), ['01', '11', '16']);
    const c = agenda.centroDe(r.cliente);
    assert.strictEqual(c.center, null, 'no puede elegir centro por orden de aparición');
    assert.strictEqual(c.estado, 'sin_resolver');
    assert.deepStrictEqual(c.opciones.sort(), ['01', '11', '16']);
  });

  await siAgenda('AG-5· tildes y abreviaturas del fichero', async () => {
    // El fichero trae "CARNICERIA Mª DEL VALLE, S.L."
    const real = agenda.todos().find((c) => /CARNICERIA M. DEL VALLE|CARNICERIA Mª DEL VALLE/i
      .test(c.legal_name));
    assert(real, 'hace falta ese cliente para la prueba');
    const r = agenda.buscar('Carniceria Maria del Valle');
    assert(['exacto', 'probable', 'varios'].includes(r.tipo), r.tipo);
    const cands = r.cliente ? [r.cliente] : r.candidatos;
    assert(cands.some((c) => c.customer_code === real.customer_code),
      `no encontró ${real.legal_name}`);
  });

  await siAgenda('AG-6· el sufijo societario no hace falta escribirlo', async () => {
    for (const [q, code] of [['Carniceria El Chino', '90014'],
                             ['carniceria el chino s.l.', '90014'],
                             ['CARNICERIA EL CHINO, S.L.', '90014']]) {
      const r = agenda.buscar(q);
      assert(['exacto', 'probable'].includes(r.tipo), `"${q}" -> ${r.tipo}`);
      assert.strictEqual(r.cliente.customer_code, code);
    }
  });

  await siAgenda('AG-7· los duplicados exactos no salen dos veces', async () => {
    const r = agenda.buscar('Autoservicio Usagre');
    const cands = r.cliente ? [r.cliente] : (r.candidatos || []);
    const codigos = cands.map((c) => c.customer_code);
    assert.strictEqual(new Set(codigos).size, codigos.length);
    assert.strictEqual(agenda.todos().filter((c) => c.customer_code === '23').length, 1);
  });

  await siAgenda('AG-8· un negocio que no está NO se convierte en cliente', async () => {
    const r = agenda.buscar('Tony Tienda');
    assert.strictEqual(r.tipo, 'nada');

    const TEL = '34600555100';
    await estadosLib.reiniciar(TEL);
    await conPrivacidad(TEL);
    await router.pedirIdentificacion(TEL);
    const p = await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto',
      valor: 'Tony Tienda' });
    const t = p.map((x) => formato.aTexto(x)).join('\n');
    assert(/No encuentro «Tony Tienda»/.test(t), t.slice(0, 140));
    assert(/Fernando/.test(t));
    assert(!/Embutidos|familias/i.test(t), 'no se ofrece catálogo identificando');
    assert.strictEqual(await repo.clientePorTelefono(TEL), null,
      'no puede crearse un cliente de Chacón que no está en la agenda');
  });

  await siAgenda('AG-9· E2E: privacidad → agenda → confirmar → vínculo → 2ª vez', async () => {
    const TEL = '34600555101';
    await estadosLib.reiniciar(TEL);
    // Primera conversación, empezando ya con intención de pedido.
    const aviso = await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto',
      valor: 'Hola, quiero hacer un pedido' });
    assert(/¿Quieres continuar/.test(aviso.map((x) => formato.aTexto(x)).join('\n')));

    await router.manejar({ telefono: TEL, cliente: null, tipo: 'clic', valor: 'privacidad_si' });
    const prop = await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto',
      valor: 'Carnicería El Chino' });
    const tp = prop.map((x) => formato.aTexto(x)).join('\n');
    assert(/He encontrado/.test(tp) && /CARNICERIA EL CHINO/.test(tp), tp.slice(0, 140));
    assert(/¿Es tu negocio\?/.test(tp), 'hay que confirmar antes de vincular');
    // Todavía sin vincular.
    assert.strictEqual(await repo.clientePorTelefono(TEL), null, 'vinculó sin confirmar');

    await router.manejar({ telefono: TEL, cliente: null, tipo: 'clic', valor: 'cliente_si:90014' });
    const c = await repo.clientePorTelefono(TEL);
    assert(c, 'no se creó el vínculo');
    assert.strictEqual(c.customer_code, '90014');
    assert.strictEqual(c.customer_center, '2');
    assert.strictEqual(c.legal_name, 'CARNICERIA EL CHINO, S.L.');
    assert.strictEqual(c.link_status, 'confirmed');
    assert.strictEqual(c.link_source, 'whatsapp_self_identification');
    assert.strictEqual(c.estado, 'verificado');
    assert(c.linked_at && c.agenda_version);

    // Segunda conversación: NO vuelve a preguntar el nombre.
    await estadosLib.reiniciar(TEL);
    const seg = await router.manejar({ telefono: TEL, cliente: c, tipo: 'texto', valor: 'hola' });
    const ts = seg.map((x) => formato.aTexto(x)).join('\n');
    assert(!/cómo se llama tu negocio/i.test(ts), 'volvió a pedir el nombre');
    assert(!/¿Quieres continuar/.test(ts), 'repitió el aviso de privacidad');
    assert(/CARNICERIA EL CHINO/.test(ts), ts.slice(0, 120));
  });

  await siAgenda('AG-10· el vínculo va por código, no por fila del Excel', async () => {
    const TEL = '34600555102';
    await estadosLib.reiniciar(TEL);
    await conPrivacidad(TEL);
    await router.pedirIdentificacion(TEL);
    await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto', valor: 'Bollysur' });
    await router.manejar({ telefono: TEL, cliente: null, tipo: 'clic', valor: 'cliente_si:50146' });
    const c = await repo.clientePorTelefono(TEL);
    assert.strictEqual(c.customer_code, '50146');
    // Nada del vínculo depende del número de fila.
    const json = JSON.stringify(c);
    assert(!/source_row|row_index/.test(json), 'el vínculo no puede depender de la fila');
  });

  await siAgenda('AG-11· el carrito sobrevive a identificar contra la agenda', async () => {
    const TEL = '34600555103';
    await estadosLib.reiniciar(TEL);
    await conPrivacidad(TEL);
    // Se identifica primero para tener carrito.
    await router.pedirIdentificacion(TEL);
    await router.manejar({ telefono: TEL, cliente: null, tipo: 'texto', valor: 'Autoservicio Carrillo' });
    await router.manejar({ telefono: TEL, cliente: null, tipo: 'clic', valor: 'cliente_si:340' });
    const c = await repo.clientePorTelefono(TEL);
    await pedidoLib.anadir(c.id, { producto_id: PIEL.id, cantidad: 2, unidad_pedido: 'caja' });
    const antes = JSON.stringify((await repo.getCarrito(c.id)).lineas
      .map((l) => [l.codigo, l.cantidad, l.unidad_pedido, l.precio_kg_sin_iva]));

    // Se fuerza otra identificación y se vuelve a confirmar el mismo cliente.
    await router.pedirIdentificacion(TEL);
    await router.manejar({ telefono: TEL, cliente: null, tipo: 'clic', valor: 'cliente_si:340' });
    const despues = JSON.stringify((await repo.getCarrito(c.id)).lineas
      .map((l) => [l.codigo, l.cantidad, l.unidad_pedido, l.precio_kg_sin_iva]));
    assert.strictEqual(despues, antes, 'identificar cambió el carrito');
  });

  console.log('\n=== 25) Ciclo de vida del pedido (bugs de Fernando) ===');

  const intenciones = require(path.join(ROOT, 'lib/chacon/intenciones'));
  const descLib = require(path.join(ROOT, 'lib/chacon/descubrimiento'));

  await check('O-1· "pedido nuevo" NUNCA llega al buscador de productos', async () => {
    /* El bug: contestaba "no consigo dar con «Quiero hacer un pedido nuevo»".
       Se espía el buscador para demostrar que no se le llama. */
    const frases = ['Quiero hacer un pedido nuevo', 'nuevo pedido', 'quiero otro pedido',
      'empezar otro pedido', 'hacer otro pedido', 'quiero pedir de nuevo', 'empecemos otro'];
    for (const f of frases) {
      const i = intenciones.reconocer(f);
      assert(i, `"${f}" no se reconoce como intención`);
      assert.strictEqual(i.intent, 'START_NEW_ORDER', `"${f}" -> ${i.intent}`);
      assert.strictEqual(intenciones.pareceProducto(f), false,
        `"${f}" puede acabar en el buscador de productos`);
    }

    const TEL = '34600888100';
    const c = await repo.crearCliente({ nombre: 'Tienda Intents', telefono: TEL });
    await conPrivacidad(TEL);
    await estadosLib.reiniciar(TEL);

    const original = descLib.buscar;
    let llamadas = 0;
    descLib.buscar = (...a) => { llamadas += 1; return original(...a); };
    try {
      const p = await router.manejar({ telefono: TEL, cliente: c, tipo: 'texto',
        valor: 'Quiero hacer un pedido nuevo' });
      const t = p.map((x) => formato.aTexto(x)).join('\n');
      assert.strictEqual(llamadas, 0, 'se llamó al buscador de productos');
      assert(!/No consigo dar con|No he encontrado/.test(t), t.slice(0, 140));
      assert(/pedido nuevo/i.test(t), t.slice(0, 140));
    } finally { descLib.buscar = original; }
  });

  await check('O-2· E2E: pedido A completo, confirmado y cerrado', async () => {
    const TEL = '34600888101';
    const c = await repo.crearCliente({ nombre: 'Tienda Ciclo', telefono: TEL });
    await conPrivacidad(TEL); await estadosLib.reiniciar(TEL);
    await pedidoLib.vaciar(c.id);

    await router.manejar({ telefono: TEL, cliente: c, tipo: 'texto', valor: 'quiero hacer un pedido' });
    await router.manejar({ telefono: TEL, cliente: c, tipo: 'texto', valor: 'chorizo cular' });
    await router.manejar({ telefono: TEL, cliente: c, tipo: 'clic', valor: 'cant:6305:1:caja' });
    await router.manejar({ telefono: TEL, cliente: c, tipo: 'texto', valor: 'queso curado ocaña' });
    await router.manejar({ telefono: TEL, cliente: c, tipo: 'clic', valor: 'cant:7001:2:caja' });
    assert.strictEqual((await repo.getCarrito(c.id)).lineas.length, 2);

    // Terminar tiene que llevar al checkout, no a enseñar el carrito otra vez.
    const fin = await router.manejar({ telefono: TEL, cliente: c, tipo: 'texto',
      valor: 'terminar pedido' });
    assert.strictEqual((await estadosLib.leer(TEL)).maquina.estado, 'CHECKOUT');
    const tf = fin.map((x) => formato.aTexto(x)).join('\n');
    assert(/¿Confirmas el pedido\?/.test(tf), 'el resumen tiene que ofrecer confirmar');
    // Y con BOTONES: sin ellos no había forma de cerrar el pedido.
    assert(fin.some((x) => x.type === 'interactive' && x.interactive.type === 'button'),
      'el checkout sin botones deja al cliente sin poder confirmar');

    const conf = await router.manejar({ telefono: TEL, cliente: c, tipo: 'texto', valor: 'CONFIRMAR' });
    const tc = conf.map((x) => formato.aTexto(x)).join('\n');
    assert(/Pedido confirmado/.test(tc), tc.slice(0, 140));
    assert(/PED-/.test(tc), 'falta el número de pedido');
    assert.strictEqual((await estadosLib.leer(TEL)).maquina.estado, 'ORDER_COMPLETE');
    // El carrito deja de existir: un pedido confirmado no es carrito activo.
    assert.strictEqual((await repo.getCarrito(c.id)).lineas.length, 0);
    assert.strictEqual((await repo.pedidosDeCliente(c.id)).length, 1);
  });

  await check('O-3· confirmar dos veces NO crea dos pedidos', async () => {
    const TEL = '34600888102';
    const c = await repo.crearCliente({ nombre: 'Tienda Doble', telefono: TEL });
    await conPrivacidad(TEL); await estadosLib.reiniciar(TEL);
    await pedidoLib.vaciar(c.id);
    await pedidoLib.anadir(c.id, { producto_id: PIEL.id, cantidad: 1, unidad_pedido: 'caja' });
    await router.manejar({ telefono: TEL, cliente: c, tipo: 'clic', valor: 'terminar_pedido' });

    await router.manejar({ telefono: TEL, cliente: c, tipo: 'clic', valor: 'confirmar_pedido' });
    const antes = (await repo.pedidosDeCliente(c.id)).length;
    // Segunda pulsación / webhook repetido.
    await router.manejar({ telefono: TEL, cliente: c, tipo: 'clic', valor: 'confirmar_pedido' });
    assert.strictEqual((await repo.pedidosDeCliente(c.id)).length, antes,
      'se creó un pedido duplicado');
    assert.strictEqual(antes, 1);
  });

  await check('O-4· un pedido confirmado no reaparece como carrito', async () => {
    const TEL = '34600888103';
    const c = await repo.crearCliente({ nombre: 'Tienda Cerrada', telefono: TEL });
    await conPrivacidad(TEL); await estadosLib.reiniciar(TEL);
    await pedidoLib.vaciar(c.id);
    await pedidoLib.anadir(c.id, { producto_id: PIEL.id, cantidad: 1, unidad_pedido: 'caja' });
    await router.manejar({ telefono: TEL, cliente: c, tipo: 'clic', valor: 'terminar_pedido' });
    await router.manejar({ telefono: TEL, cliente: c, tipo: 'clic', valor: 'confirmar_pedido' });

    // Conversación nueva: no puede resucitar el pedido cerrado.
    await estadosLib.reiniciar(TEL);
    const p = await router.manejar({ telefono: TEL, cliente: c, tipo: 'texto',
      valor: 'Hola, quiero hacer un pedido' });
    const t = p.map((x) => formato.aTexto(x)).join('\n');
    assert(!/Tu pedido/.test(t), 'resucitó el pedido confirmado como carrito');
    assert.strictEqual((await repo.getCarrito(c.id)).lineas.length, 0);
  });

  await check('O-5· con borrador vivo se pregunta, no se pisa ni se enseña a secas', async () => {
    const TEL = '34600888104';
    const c = await repo.crearCliente({ nombre: 'Tienda Borrador', telefono: TEL });
    await conPrivacidad(TEL); await estadosLib.reiniciar(TEL);
    await pedidoLib.vaciar(c.id);
    await pedidoLib.anadir(c.id, { producto_id: PIEL.id, cantidad: 1, unidad_pedido: 'caja' });
    await pedidoLib.anadir(c.id, { producto_id: catalogo.todos().find((x) => x.codigo === '4315').id,
      cantidad: 2, unidad_pedido: 'caja' });

    // "quiero hacer un pedido" -> explica que hay uno en curso.
    const p = await router.manejar({ telefono: TEL, cliente: c, tipo: 'texto',
      valor: 'quiero hacer un pedido' });
    const t = p.map((x) => formato.aTexto(x)).join('\n');
    assert(/pedido en curso con 2 producto/i.test(t), t.slice(0, 140));
    assert(/Continuar/.test(t) && /nuevo/i.test(t));

    // "pedido nuevo" -> avisa antes de abandonarlo.
    const n = await router.manejar({ telefono: TEL, cliente: c, tipo: 'texto',
      valor: 'quiero hacer un pedido nuevo' });
    const tn = n.map((x) => formato.aTexto(x)).join('\n');
    assert(/sin confirmar/i.test(tn), tn.slice(0, 140));
    assert.strictEqual((await repo.getCarrito(c.id)).lineas.length, 2,
      'no puede vaciar el borrador sin preguntar');

    // Al confirmar, el viejo queda ABANDONED y el nuevo empieza vacío.
    await router.manejar({ telefono: TEL, cliente: c, tipo: 'clic', valor: 'nuevo_pedido_si' });
    assert.strictEqual((await repo.getCarrito(c.id)).lineas.length, 0);
    assert.strictEqual((await estadosLib.leer(TEL)).maquina.estado, 'PRODUCT_DISCOVERY');
  });

  await check('O-6· cancelar pide confirmación y deja el carrito vacío', async () => {
    const TEL = '34600888105';
    const c = await repo.crearCliente({ nombre: 'Tienda Cancela', telefono: TEL });
    await conPrivacidad(TEL); await estadosLib.reiniciar(TEL);
    await pedidoLib.vaciar(c.id);
    await pedidoLib.anadir(c.id, { producto_id: PIEL.id, cantidad: 1, unidad_pedido: 'caja' });

    const p = await router.manejar({ telefono: TEL, cliente: c, tipo: 'texto',
      valor: 'cancelar pedido' });
    assert(/¿Quieres cancelar/.test(p.map((x) => formato.aTexto(x)).join('\n')));
    assert.strictEqual((await repo.getCarrito(c.id)).lineas.length, 1, 'canceló sin preguntar');

    await router.manejar({ telefono: TEL, cliente: c, tipo: 'clic', valor: 'cancelar_si' });
    assert.strictEqual((await repo.getCarrito(c.id)).lineas.length, 0);
    assert.strictEqual((await repo.pedidosDeCliente(c.id)).length, 0, 'cancelar no crea pedido');
  });

  await check('O-7· el buscador no es el cajón de sastre', async () => {
    for (const f of ['vale', 'gracias', 'ok', 'sí', 'adiós', 'ver mi pedido', 'terminar pedido']) {
      assert.strictEqual(intenciones.pareceProducto(f), false,
        `"${f}" no puede acabar en el buscador`);
    }
    // Lo que sí es un producto sigue pasando.
    for (const f of ['chorizo cular', 'queso', 'jamón ibérico', '6305']) {
      assert.strictEqual(intenciones.pareceProducto(f), true, `"${f}" debería buscarse`);
    }
  });

  console.log('\n=== 26) Aislamiento entre tenants (sin regresiones en Sanmi) ===');
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
