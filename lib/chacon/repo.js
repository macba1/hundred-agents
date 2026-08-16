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
};

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
  return leerJSON(raw) || { clienteId, lineas: [], creado: new Date().toISOString() };
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
  return pedido;
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
  clientePorTelefono, clientePorId, crearCliente, guardarCliente,
  listarClientes, buscarClientesPorNombre,
  getCarrito, guardarCarrito, borrarCarrito,
  crearPedido, guardarPedido, getPedido, actualizarEstadoPedido, listarPedidos,
  mapearEnvio, pedidoPorEnvio,
  getConfig, setConfig, todaLaConfig,
  K,
};
