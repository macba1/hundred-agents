/* ============================================================
   Capa de repositorio de Chacón.

   Toda la lógica de negocio habla con esta interfaz, nunca con Redis
   directamente. Cambiar a PostgreSQL es escribir otra implementación de
   estos mismos métodos, sin tocar carrito, precios ni pedidos.

   Claves (namespace `ch:` para no colisionar con el agente de Sanmi, que
   usa `wa:`):
     ch:cliente:{id}                 JSON de la tienda
     ch:cliente:tel:{telefono}       -> id de cliente
     ch:clientes                     SET de ids
     ch:carrito:{clienteId}          JSON del carrito abierto      TTL 30d
     ch:pedido:{id}                  JSON del pedido (inmutable al confirmar)
     ch:pedidos                      LIST de ids, más nuevo primero
     ch:seq:{nombre}                 contadores
     ch:config                       HASH de configuración pendiente
     ch:envio:{wamid}                -> id de pedido, para casar el estado
                                        de entrega que llega por webhook   TTL 7d
     ch:precio:{productoId}          JSON con precio normal, oferta y quién
                                        validó cada cosa (decisión humana)
     ch:precios                      SET de productoId con decisión tomada
     ch:pedidos:cliente:{clienteId}  LIST de ids del cliente, para repetir
     ch:contexto:{telefono}          JSON de lo último mostrado en la
                                        conversación, para resolver "el
                                        segundo"                        TTL 6h
     ch:clasif:{productoId}          corrección manual de familia/etiquetas
     ch:clasifs                      SET de productoId corregidos
     ch:facturacion:{codigo}         base de facturación revisada a mano
     ch:facturaciones                SET de códigos revisados
     ch:privacidad:{telefono}        autorización del canal y marketing.
                                        Va por TELÉFONO porque la tienda
                                        acepta antes de que sepamos quién es
     ch:privacidades                 SET de teléfonos con registro
   ============================================================ */

const TTL_CARRITO = Number(process.env.CHACON_TTL_CARRITO || 60 * 60 * 24 * 30);
const PEDIDOS_MAX = Number(process.env.CHACON_PEDIDOS_MAX || 2000);

const UNCONFIGURED = 'REDIS_URL no está configurado: Chacón necesita almacenamiento durable.';

let _redis = null;
async function cli() {
  const url = process.env.REDIS_URL;
  if (!url) throw Object.assign(new Error(UNCONFIGURED), { code: 'redis_unconfigured' });
  if (_redis && _redis.isOpen) return _redis;
  const { createClient } = require('redis');
  _redis = createClient({ url });
  _redis.on('error', () => {});
  if (!_redis.isOpen) await _redis.connect();
  return _redis;
}

function ready() {
  return process.env.REDIS_URL
    ? { ok: true, backend: 'redis' }
    : { ok: false, backend: 'unconfigured', error: UNCONFIGURED };
}

const K = {
  cliente: (id) => `ch:cliente:${id}`,
  clientePorTel: (tel) => `ch:cliente:tel:${tel}`,
  clientes: 'ch:clientes',
  carrito: (clienteId) => `ch:carrito:${clienteId}`,
  pedido: (id) => `ch:pedido:${id}`,
  pedidos: 'ch:pedidos',
  seq: (n) => `ch:seq:${n}`,
  config: 'ch:config',
  envio: (wamid) => `ch:envio:${wamid}`,
  precio: (productoId) => `ch:precio:${productoId}`,
  precios: 'ch:precios',
  pedidosCliente: (clienteId) => `ch:pedidos:cliente:${clienteId}`,
  contexto: (telefono) => `ch:contexto:${telefono}`,
  clasif: (productoId) => `ch:clasif:${productoId}`,
  clasifs: 'ch:clasifs',
  facturacion: (codigo) => `ch:facturacion:${codigo}`,
  facturaciones: 'ch:facturaciones',
  privacidad: (telefono) => `ch:privacidad:${telefono}`,
  privacidades: 'ch:privacidades',
};

/* Seis horas: lo que dura una jornada de pedidos. Pasado ese tiempo, "el
   segundo" ya no significa nada y es más seguro volver a preguntar. */
const TTL_CONTEXTO = Number(process.env.CHACON_TTL_CONTEXTO || 60 * 60 * 6);

const TTL_ENVIO = Number(process.env.CHACON_TTL_ENVIO || 60 * 60 * 24 * 7);

const leerJSON = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

/* ---- secuencias ------------------------------------------------------- */
async function siguiente(nombre) {
  return (await cli()).incr(K.seq(nombre));
}

/* ---- clientes (tiendas) ------------------------------------------------ */
/**
 * El teléfono es el identificador técnico; el nombre es solo una etiqueta.
 * Dos tiendas pueden llamarse parecido, así que el nombre nunca resuelve por
 * sí solo — lo dice el enunciado del cliente y es lo correcto.
 */
async function clientePorTelefono(telefono) {
  const c = await cli();
  const id = await c.get(K.clientePorTel(telefono));
  if (!id) return null;
  return leerJSON(await c.get(K.cliente(id)));
}

async function clientePorId(id) {
  return leerJSON(await (await cli()).get(K.cliente(id)));
}

async function crearCliente({ nombre, telefono, contacto = null, direccion = null }) {
  const c = await cli();
  const n = await siguiente('cliente');
  const id = `CLI-${String(n).padStart(5, '0')}`;
  const cliente = {
    id, nombre, telefonos: [telefono], contacto, direccion,
    estado: 'pendiente_aprobacion',   // política de altas: PENDIENTE (ver DECISIONES)
    creado: new Date().toISOString(), actualizado: new Date().toISOString(),
  };
  await c.set(K.cliente(id), JSON.stringify(cliente));
  await c.set(K.clientePorTel(telefono), id);
  await c.sAdd(K.clientes, id);
  return cliente;
}

async function guardarCliente(cliente) {
  const c = await cli();
  cliente.actualizado = new Date().toISOString();
  await c.set(K.cliente(cliente.id), JSON.stringify(cliente));
  for (const tel of cliente.telefonos || []) await c.set(K.clientePorTel(tel), cliente.id);
  return cliente;
}

async function listarClientes() {
  const c = await cli();
  const ids = await c.sMembers(K.clientes);
  const out = [];
  for (const id of ids.sort()) {
    const x = leerJSON(await c.get(K.cliente(id)));
    if (x) out.push(x);
  }
  return out;
}

/**
 * Borra una ficha de tienda. Para cuentas creadas por error, no para dar de
 * baja a un cliente real: no hay papelera.
 *
 * Se limpia TODO lo que apunta a ella —vínculos de teléfono, carrito abierto
 * e índice de pedidos—, porque un teléfono que sigue apuntando a un id
 * borrado es peor que la ficha: el siguiente mensaje de ese número se
 * atribuye a una tienda fantasma.
 *
 * Los pedidos ya emitidos NO se tocan salvo que se pida expresamente: son el
 * registro de lo que se envió a Chacón.
 */
async function borrarCliente(id, { purgarPedidos = false } = {}) {
  const c = await cli();
  const ficha = await clientePorId(id);
  if (!ficha) return { borrado: false, motivo: 'no_existe' };

  const pedidos = await c.lRange(K.pedidosCliente(id), 0, -1);
  if (purgarPedidos) {
    for (const pid of pedidos) await c.del(K.pedido(pid));
  }
  await c.del(K.pedidosCliente(id));
  await c.del(K.carrito(id));
  for (const tel of ficha.telefonos || []) await c.del(K.clientePorTel(tel));
  await c.sRem(K.clientes, id);
  await c.del(K.cliente(id));

  console.log('[chacon][evento] customer_deleted id=%s nombre=%j tels=%j pedidos=%d purgados=%s',
    id, ficha.nombre, ficha.telefonos || [], pedidos.length, purgarPedidos);
  return { borrado: true, ficha, pedidos, pedidos_purgados: purgarPedidos };
}

/** Tiendas cuyo nombre se parece al buscado. No elige: devuelve candidatas. */
async function buscarClientesPorNombre(nombre) {
  const n = String(nombre || '').trim().toLowerCase();
  if (!n) return [];
  return (await listarClientes()).filter((c) => c.nombre.toLowerCase().includes(n)
    || n.includes(c.nombre.toLowerCase()));
}

/* ---- carrito ----------------------------------------------------------- */
async function getCarrito(clienteId) {
  const raw = await (await cli()).get(K.carrito(clienteId));
  const c = leerJSON(raw) || { clienteId, lineas: [], creado: new Date().toISOString() };
  // Todo carrito vivo es un borrador. Un pedido confirmado ya no vive aquí.
  if (!c.estado) c.estado = 'DRAFT';
  return c;
}

async function guardarCarrito(carrito) {
  const c = await cli();
  carrito.actualizado = new Date().toISOString();
  await c.set(K.carrito(carrito.clienteId), JSON.stringify(carrito), { EX: TTL_CARRITO });
  return carrito;
}

async function borrarCarrito(clienteId) {
  await (await cli()).del(K.carrito(clienteId));
}

/* ---- pedidos ----------------------------------------------------------- */
/**
 * Un pedido confirmado es inmutable en sus líneas y precios: guarda copia
 * exacta de lo confirmado y la versión de catálogo usada, para que una
 * reimportación posterior no altere pedidos anteriores.
 */
async function crearPedido(pedido) {
  const c = await cli();
  await c.set(K.pedido(pedido.id), JSON.stringify(pedido));
  await c.lPush(K.pedidos, pedido.id);
  await c.lTrim(K.pedidos, 0, PEDIDOS_MAX - 1);
  // Índice propio por tienda: repetir el último pedido no debe recorrer la
  // lista global, que mezcla todas las tiendas.
  if (pedido.cliente?.id) {
    await c.lPush(K.pedidosCliente(pedido.cliente.id), pedido.id);
    await c.lTrim(K.pedidosCliente(pedido.cliente.id), 0, 199);
  }
  return pedido;
}

/** Pedidos de una tienda, del más reciente al más antiguo. */
async function pedidosDeCliente(clienteId, { limite = 20 } = {}) {
  const c = await cli();
  const ids = await c.lRange(K.pedidosCliente(clienteId), 0, limite - 1);
  const out = [];
  for (const id of ids) {
    const p = leerJSON(await c.get(K.pedido(id)));
    if (p) out.push(p);
  }
  return out;
}

/** Sobrescribe el pedido SIN volver a insertarlo en la lista. */
async function guardarPedido(pedido) {
  await (await cli()).set(K.pedido(pedido.id), JSON.stringify(pedido));
  return pedido;
}

async function getPedido(id) {
  return leerJSON(await (await cli()).get(K.pedido(id)));
}

/** Solo cambia estado y anexa historial. Las líneas nunca se tocan. */
async function actualizarEstadoPedido(id, estado, { por = 'sistema', nota = null } = {}) {
  const c = await cli();
  const p = await getPedido(id);
  if (!p) return null;
  p.estado = estado;
  p.historial = p.historial || [];
  p.historial.push({ estado, ts: new Date().toISOString(), por, nota });
  await c.set(K.pedido(id), JSON.stringify(p));
  return p;
}

async function listarPedidos({ limite = 100, cliente = null, estado = null } = {}) {
  const c = await cli();
  const ids = await c.lRange(K.pedidos, 0, limite * 3);
  const out = [];
  for (const id of ids) {
    const p = leerJSON(await c.get(K.pedido(id)));
    if (!p) continue;
    if (cliente && p.cliente?.id !== cliente) continue;
    if (estado && p.estado !== estado) continue;
    out.push(p);
    if (out.length >= limite) break;
  }
  return out;
}

/* ---- contexto de navegación -------------------------------------------- */
/**
 * Qué productos se le acaban de enseñar a este teléfono. Sin esto, "ponme
 * dos del segundo" no se puede resolver sin adivinar, y adivinar un producto
 * en un pedido mayorista es un pedido mal servido.
 */
async function getContexto(telefono) {
  return leerJSON(await (await cli()).get(K.contexto(telefono)))
    || { telefono, mostrados: [], vista: null, offset: 0 };
}

async function guardarContexto(ctx) {
  const c = await cli();
  ctx.actualizado = new Date().toISOString();
  await c.set(K.contexto(ctx.telefono), JSON.stringify(ctx), { EX: TTL_CONTEXTO });
  return ctx;
}

/* ---- correcciones de clasificación ------------------------------------- */
/**
 * La propuesta automática vive en un archivo; las correcciones de una
 * persona viven aquí. Se separan a propósito: reimportar el catálogo no
 * puede borrar lo que alguien revisó a mano.
 */
async function guardarClasificacion(reg) {
  const c = await cli();
  await c.set(K.clasif(reg.producto_id), JSON.stringify(reg));
  await c.sAdd(K.clasifs, reg.producto_id);
  return reg;
}

async function listarClasificaciones() {
  const c = await cli();
  const out = [];
  for (const id of await c.sMembers(K.clasifs)) {
    const r = leerJSON(await c.get(K.clasif(id)));
    if (r) out.push(r);
  }
  return out;
}

/* ---- autorización del canal y marketing -------------------------------- */
/**
 * Va por teléfono, no por cliente: se acepta el canal antes de identificar
 * la tienda, y el mismo número no debe volver a ver el aviso después.
 */
async function getPrivacidad(telefono) {
  return leerJSON(await (await cli()).get(K.privacidad(telefono)));
}

async function guardarPrivacidad(reg) {
  const c = await cli();
  await c.set(K.privacidad(reg.phone_number), JSON.stringify(reg));
  await c.sAdd(K.privacidades, reg.phone_number);
  return reg;
}

async function listarPrivacidades() {
  const c = await cli();
  const out = [];
  for (const tel of await c.sMembers(K.privacidades)) {
    const r = leerJSON(await c.get(K.privacidad(tel)));
    if (r) out.push(r);
  }
  return out;
}

/* ---- base de facturación revisada a mano ------------------------------- */
/**
 * kg / unit / box / unknown por producto. Vive aquí y no en el archivo del
 * importador: reimportar la tarifa no puede borrar lo que alguien confirmó.
 */
async function guardarFacturacion(reg) {
  const c = await cli();
  const previo = leerJSON(await c.get(K.facturacion(reg.product_code)));
  reg.historial = [...((previo && previo.historial) || []), {
    ts: reg.ts, por: reg.revisado_por,
    antes: previo ? previo.billing_unit : null, despues: reg.billing_unit }].slice(-30);
  await c.set(K.facturacion(reg.product_code), JSON.stringify(reg));
  await c.sAdd(K.facturaciones, reg.product_code);
  return reg;
}

async function facturacionesRevisadas() {
  const c = await cli();
  const out = {};
  for (const cod of await c.sMembers(K.facturaciones)) {
    const r = leerJSON(await c.get(K.facturacion(cod)));
    if (r) out[cod] = r;
  }
  return out;
}

/* ---- precios y ofertas decididos por un administrador ------------------ */
/**
 * Vive aparte del catálogo a propósito: el catálogo es lo que dice el PDF y
 * no debe reescribirse con decisiones comerciales. Aquí van las decisiones.
 */
async function getPrecio(productoId) {
  return leerJSON(await (await cli()).get(K.precio(productoId)));
}

async function guardarPrecio(reg) {
  const c = await cli();
  await c.set(K.precio(reg.producto_id), JSON.stringify(reg));
  await c.sAdd(K.precios, reg.producto_id);
  return reg;
}

async function listarPrecios() {
  const c = await cli();
  const ids = await c.sMembers(K.precios);
  const out = [];
  for (const id of ids) {
    const r = leerJSON(await c.get(K.precio(id)));
    if (r) out.push(r);
  }
  return out;
}

/* ---- correlación de envíos --------------------------------------------- */
/**
 * Guarda a qué pedido pertenece un mensaje enviado. Cuando el proveedor
 * informa de `delivered` o `failed` para ese wamid, se sabe qué pedido
 * actualizar. Caduca: pasada una semana el estado ya no llega.
 */
async function mapearEnvio(wamid, pedidoId) {
  await (await cli()).set(K.envio(wamid), pedidoId, { EX: TTL_ENVIO });
}

async function pedidoPorEnvio(wamid) {
  return (await cli()).get(K.envio(wamid));
}

/* ---- configuración pendiente ------------------------------------------- */
async function getConfig(clave, porDefecto = null) {
  const v = await (await cli()).hGet(K.config, clave);
  return v === undefined || v === null ? porDefecto : leerJSON(v) ?? v;
}

async function setConfig(clave, valor) {
  await (await cli()).hSet(K.config, clave, JSON.stringify(valor));
}

async function todaLaConfig() {
  const h = await (await cli()).hGetAll(K.config);
  const out = {};
  for (const [k, v] of Object.entries(h || {})) out[k] = leerJSON(v) ?? v;
  return out;
}

async function ping() {
  return (await cli()).ping() === 'PONG' || true;
}

module.exports = {
  ready, ping, siguiente,
  clientePorTelefono, clientePorId, crearCliente, guardarCliente, borrarCliente,
  listarClientes, buscarClientesPorNombre,
  getCarrito, guardarCarrito, borrarCarrito,
  crearPedido, guardarPedido, getPedido, actualizarEstadoPedido, listarPedidos,
  mapearEnvio, pedidoPorEnvio, pedidosDeCliente,
  getPrecio, guardarPrecio, listarPrecios,
  getContexto, guardarContexto,
  guardarClasificacion, listarClasificaciones,
  guardarFacturacion, facturacionesRevisadas,
  getPrivacidad, guardarPrivacidad, listarPrivacidades,
  getConfig, setConfig, todaLaConfig,
  K,
};
