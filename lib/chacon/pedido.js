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
const mvp = require('./mvp');

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
  return resumirParaCliente(carrito);
}

/** Vista completa con lo económico. No se le entrega nunca al modelo. */
async function verInterno(clienteId) {
  return resumir(await repo.getCarrito(clienteId));
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
  const guardada = previa ? carrito.lineas.find((l) => l.id === previa.id) : linea;
  return { ok: true, linea: mvp.lineaVisible(guardada), carrito: resumirParaCliente(carrito) };
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
    return { ok: true, eliminada: true, carrito: resumirParaCliente(carrito) };
  }
  const p = catalogo.porId(producto_id);
  const nueva = precios.calcularLinea({
    producto: p, cantidad: cant, unidadPedido: carrito.lineas[idx].unidad_pedido });
  nueva.id = carrito.lineas[idx].id;
  nueva.observaciones = carrito.lineas[idx].observaciones;
  carrito.lineas[idx] = nueva;
  await repo.guardarCarrito(carrito);
  return { ok: true, linea: mvp.lineaVisible(nueva), carrito: resumirParaCliente(carrito) };
}

async function quitar(clienteId, { producto_id }) {
  return cambiarCantidad(clienteId, { producto_id, cantidad: 0 });
}

async function vaciar(clienteId) {
  await repo.borrarCarrito(clienteId);
  return { ok: true, carrito: resumirParaCliente({ clienteId, lineas: [] }) };
}

/**
 * Vista interna completa: incluye lo económico calculado, que se guarda pero
 * en el MVP no sale al cliente. La usan el panel y las pruebas.
 */
function resumir(carrito) {
  const totales = precios.totalizar(carrito.lineas || []);
  return {
    clienteId: carrito.clienteId,
    lineas: carrito.lineas || [],
    totales,
    tiene_pendientes: totales.lineas_pendientes_revision > 0,
  };
}

/**
 * Vista que ven el modelo y la tienda. Sin precios, sin tarifas, sin totales.
 * En el MVP un artículo con precios repetidos o sin peso se pide igual: eso
 * solo bloqueaba el cálculo, y en esta fase no se calcula nada.
 */
function resumirParaCliente(carrito) {
  return {
    lineas: (carrito.lineas || []).map(mvp.lineaVisible),
    numero_de_lineas: (carrito.lineas || []).length,
    nota: 'Solicitud de pedido: no lleva precios ni importes en esta versión.',
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
/**
 * Cantidad en palabras. Se distingue siempre caja de unidad: es la única
 * ambigüedad que sí bloquea el pedido, así que nunca se escribe un número
 * suelto.
 */
function textoCantidad(l) {
  if (l.unidad_pedido === 'caja') return `${l.cantidad} caja${l.cantidad === 1 ? '' : 's'}`;
  if (l.unidad_pedido === 'kg') return `${l.cantidad} kg`;
  return `${l.cantidad} unidad${l.cantidad === 1 ? '' : 'es'}`;
}

/** Una línea del resumen: solo lo confirmado del catálogo y lo que pidió la tienda. */
function textoLinea(l) {
  let s = `• [${l.codigo}] ${l.descripcion}`;
  if (l.marca) s += ` ${l.marca}`;
  s += ` — ${textoCantidad(l)}`;
  if (l.unidad_pedido === 'caja' && Number.isFinite(l.und_caja) && l.und_caja > 0) {
    s += ` (${l.und_caja} uds/caja)`;
  }
  if (l.observaciones) s += `\n  ${l.observaciones}`;
  return s;
}

/**
 * Resumen que ve la tienda antes de confirmar. Sin una sola cifra económica:
 * esto es una solicitud de pedido, no un presupuesto.
 */
function textoResumen(carrito, cliente, { observaciones = null } = {}) {
  const L = ['SOLICITUD DE PEDIDO', ''];
  L.push(`Tienda: ${cliente?.nombre || '(tienda sin nombre)'}`);
  L.push('');
  for (const l of carrito.lineas || []) L.push(textoLinea(l));
  L.push('');
  if (observaciones) { L.push(`Observaciones: ${observaciones}`); L.push(''); }
  L.push('Responde CONFIRMAR para enviar la solicitud o MODIFICAR para realizar cambios.');
  return L.join('\n');
}

module.exports = {
  ESTADOS, MENSAJE_RECEPCION,
  ver, verInterno, anadir, cambiarCantidad, quitar, vaciar, resumir, resumirParaCliente,
  validarParaConfirmar, confirmar, textoResumen, textoLinea, textoCantidad,
};
