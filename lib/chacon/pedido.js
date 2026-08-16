/* ============================================================
   Carrito y pedidos de Chacón. Todo determinista.

   El modelo de IA nunca calcula un importe ni modifica una cantidad: llama
   a estas funciones con un `producto_id` real y ellas hacen las cuentas,
   validan y bloquean lo que no se puede resolver.

   Un pedido confirmado es INMUTABLE en líneas y precios: guarda copia
   exacta y la versión de catálogo usada, de modo que reimportar el catálogo
   no altera pedidos anteriores.
   ============================================================ */

const repo = require('./repo');
const catalogo = require('./catalogo');
const precios = require('./precios');

/** Estados. El agente solo puede llevar el pedido hasta `enviada`. */
const ESTADOS = [
  'solicitud_en_preparacion',
  'pendiente_confirmacion_cliente',
  'enviada_a_chacon',
  'pendiente_de_revision',
  'aceptada',
  'necesita_cambios',
  'preparada',
  'enviada',
  'entregada',
  'cancelada',
];

/** Lo máximo que el agente puede afirmarle a la tienda en esta fase. */
const MENSAJE_RECEPCION =
  'Hemos recibido tu solicitud de pedido correctamente. ' +
  'Chacón Alcántara la revisará y realizará el envío lo antes posible.';

const UNIDADES = new Set(['caja', 'unidad', 'kg']);

/* ---- carrito ----------------------------------------------------------- */
async function ver(clienteId) {
  const carrito = await repo.getCarrito(clienteId);
  return resumir(carrito);
}

/**
 * Añade una línea. Exige `producto_id` real: es lo que impide que la IA
 * invente artículos. Si la unidad es ambigua, no añade y pide aclaración.
 */
async function anadir(clienteId, { producto_id, cantidad, unidad_pedido, observaciones = null }) {
  const p = catalogo.porId(producto_id);
  if (!p) return { ok: false, error: 'producto_inexistente', producto_id };

  if (!UNIDADES.has(unidad_pedido)) {
    return {
      ok: false, error: 'unidad_ambigua',
      pregunta: `Cuando dices ${cantidad}, ¿quieres ${cantidad} cajas o ${cantidad} unidades?`,
      opciones: ['caja', 'unidad'],
    };
  }
  const cant = Number(cantidad);
  if (!Number.isFinite(cant) || cant <= 0) return { ok: false, error: 'cantidad_no_valida' };

  const linea = precios.calcularLinea({ producto: p, cantidad: cant, unidadPedido: unidad_pedido });
  linea.observaciones = observaciones;
  linea.id = `L${Date.now()}${Math.floor(cant)}`;

  const carrito = await repo.getCarrito(clienteId);
  // Misma referencia y misma unidad -> se acumula, no se duplica la línea.
  const previa = carrito.lineas.find((l) => l.producto_id === producto_id && l.unidad_pedido === unidad_pedido);
  if (previa) {
    const nueva = precios.calcularLinea({
      producto: p, cantidad: previa.cantidad + cant, unidadPedido: unidad_pedido });
    nueva.id = previa.id;
    nueva.observaciones = observaciones ?? previa.observaciones;
    carrito.lineas[carrito.lineas.indexOf(previa)] = nueva;
  } else {
    carrito.lineas.push(linea);
  }
  await repo.guardarCarrito(carrito);
  return { ok: true, linea: previa ? carrito.lineas.find((l) => l.id === previa.id) : linea, carrito: resumir(carrito) };
}

async function cambiarCantidad(clienteId, { producto_id, cantidad, unidad_pedido = null }) {
  const carrito = await repo.getCarrito(clienteId);
  const idx = carrito.lineas.findIndex((l) => l.producto_id === producto_id
    && (unidad_pedido === null || l.unidad_pedido === unidad_pedido));
  if (idx < 0) return { ok: false, error: 'linea_no_encontrada' };

  const cant = Number(cantidad);
  if (!Number.isFinite(cant) || cant < 0) return { ok: false, error: 'cantidad_no_valida' };
  if (cant === 0) {
    carrito.lineas.splice(idx, 1);
    await repo.guardarCarrito(carrito);
    return { ok: true, eliminada: true, carrito: resumir(carrito) };
  }
  const p = catalogo.porId(producto_id);
  const nueva = precios.calcularLinea({
    producto: p, cantidad: cant, unidadPedido: carrito.lineas[idx].unidad_pedido });
  nueva.id = carrito.lineas[idx].id;
  nueva.observaciones = carrito.lineas[idx].observaciones;
  carrito.lineas[idx] = nueva;
  await repo.guardarCarrito(carrito);
  return { ok: true, linea: nueva, carrito: resumir(carrito) };
}

async function quitar(clienteId, { producto_id }) {
  return cambiarCantidad(clienteId, { producto_id, cantidad: 0 });
}

async function vaciar(clienteId) {
  await repo.borrarCarrito(clienteId);
  return { ok: true, carrito: resumir({ clienteId, lineas: [] }) };
}

function resumir(carrito) {
  const totales = precios.totalizar(carrito.lineas || []);
  return {
    clienteId: carrito.clienteId,
    lineas: carrito.lineas || [],
    totales,
    tiene_pendientes: totales.lineas_pendientes_revision > 0,
  };
}

/* ---- confirmación ------------------------------------------------------ */
/**
 * Comprueba que el pedido puede confirmarse. Un pedido ambiguo NO se
 * confirma: se devuelven los motivos para que el agente pregunte.
 */
function validarParaConfirmar(carrito, cliente) {
  const problemas = [];
  if (!carrito.lineas || !carrito.lineas.length) problemas.push('carrito_vacio');
  if (!cliente || !cliente.id) problemas.push('cliente_no_identificado');
  if (!cliente?.nombre) problemas.push('sin_nombre_de_tienda');
  for (const l of carrito.lineas || []) {
    if (!UNIDADES.has(l.unidad_pedido)) problemas.push(`unidad_ambigua:${l.codigo}`);
    if (!Number.isFinite(l.cantidad) || l.cantidad <= 0) problemas.push(`cantidad_no_valida:${l.codigo}`);
  }
  return { puede: problemas.length === 0, problemas };
}

/**
 * Confirma y crea el pedido. Idempotente por `clave_idempotencia`: dos
 * confirmaciones del mismo carrito no generan dos pedidos.
 */
async function confirmar(clienteId, { clave_idempotencia = null, observaciones = null } = {}) {
  const cliente = await repo.clientePorId(clienteId);
  const carrito = await repo.getCarrito(clienteId);
  const v = validarParaConfirmar(carrito, cliente);
  if (!v.puede) return { ok: false, error: 'pedido_no_confirmable', problemas: v.problemas };

  if (clave_idempotencia) {
    const yaHecho = (await repo.listarPedidos({ limite: 50, cliente: clienteId }))
      .find((p) => p.clave_idempotencia === clave_idempotencia);
    if (yaHecho) return { ok: true, pedido: yaHecho, idempotente: true };
  }

  const n = await repo.siguiente('pedido');
  const ver = catalogo.version();
  const totales = precios.totalizar(carrito.lineas);
  const pedido = {
    id: `PED-${new Date().getFullYear()}-${String(n).padStart(5, '0')}`,
    creado: new Date().toISOString(),
    estado: 'enviada_a_chacon',
    clave_idempotencia,
    cliente: { id: cliente.id, nombre: cliente.nombre, telefonos: cliente.telefonos,
               contacto: cliente.contacto, direccion: cliente.direccion },
    // Copia EXACTA de lo confirmado. No se recalcula nunca más.
    lineas: JSON.parse(JSON.stringify(carrito.lineas)),
    totales,
    observaciones,
    version_catalogo: { pdf: ver.pdf, sha256: ver.pdf_sha256, tarifa: ver.tarifa },
    iva: { calculado: false, motivo: 'sin tabla de IVA aprobada' },
    nota_importes: 'Importes sin IVA. El importe final se ajustará al peso real preparado por Chacón Alcántara.',
    historial: [{ estado: 'enviada_a_chacon', ts: new Date().toISOString(), por: 'cliente' }],
    envio_interno: { intentos: [], entregado: false },
  };
  await repo.crearPedido(pedido);
  await repo.borrarCarrito(clienteId);
  return { ok: true, pedido, mensaje_cliente: MENSAJE_RECEPCION };
}

/* ---- texto del resumen para la tienda ---------------------------------- */
function textoResumen(carrito, cliente) {
  const L = [];
  L.push(`Pedido de ${cliente?.nombre || '(tienda sin nombre)'}`);
  for (const l of carrito.lineas) {
    const cant = l.unidad_pedido === 'caja'
      ? `${l.cantidad} caja${l.cantidad === 1 ? '' : 's'}${l.unidades ? ` (${l.unidades} uds)` : ''}`
      : l.unidad_pedido === 'kg' ? `${l.cantidad} kg` : `${l.cantidad} unidad${l.cantidad === 1 ? '' : 'es'}`;
    let linea = `• ${l.codigo} ${l.descripcion} — ${cant}`;
    if (l.peso_estimado_kg) linea += ` · ~${l.peso_estimado_kg} kg`;
    if (l.importe_estimado_sin_iva !== null) {
      linea += ` · ${l.precio_kg_sin_iva} €/kg · ~${l.importe_estimado_sin_iva} €`;
    } else {
      linea += ` · precio pendiente de revisión`;
    }
    L.push(linea);
  }
  const t = carrito.totales || precios.totalizar(carrito.lineas);
  if (t.base_estimada_sin_iva !== null) {
    L.push(`Importe estimado sin IVA: ${t.base_estimada_sin_iva} €`);
  }
  if (t.lineas_pendientes_revision) {
    L.push(`${t.lineas_pendientes_revision} línea(s) pendientes de que Chacón confirme precio o peso.`);
  }
  L.push('Importes sin IVA. El importe final se ajustará al peso real preparado por Chacón Alcántara.');
  return L.join('\n');
}

module.exports = {
  ESTADOS, MENSAJE_RECEPCION,
  ver, anadir, cambiarCantidad, quitar, vaciar, resumir,
  validarParaConfirmar, confirmar, textoResumen,
};
