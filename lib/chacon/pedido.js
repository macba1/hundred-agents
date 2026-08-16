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
const ofertas = require('./ofertas');

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
  'Chacón Alcántara la revisará, confirmará el importe final ' +
  'y realizará el envío lo antes posible.';

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

  const vig = await ofertas.precioVigente(p, { cantidad: cant, unidad: unidad_pedido });
  const aplicado = vig.precio_kg !== null
    ? { precio_kg: vig.precio_kg, es_oferta: vig.es_oferta, origen: vig.origen } : null;
  const linea = precios.calcularLinea({ producto: p, cantidad: cant,
    unidadPedido: unidad_pedido, precioAplicado: aplicado });
  linea.observaciones = observaciones;
  linea.id = `L${Date.now()}${Math.floor(cant)}`;

  const carrito = await repo.getCarrito(clienteId);
  // Misma referencia y misma unidad -> se acumula, no se duplica la línea.
  const previa = carrito.lineas.find((l) => l.producto_id === producto_id && l.unidad_pedido === unidad_pedido);
  if (previa) {
    // El precio se revisa con la cantidad TOTAL: una oferta puede tener
    // cantidad mínima, y sumar puede hacer que ahora sí se cumpla.
    const total = previa.cantidad + cant;
    const vigT = await ofertas.precioVigente(p, { cantidad: total, unidad: unidad_pedido });
    const nueva = precios.calcularLinea({
      producto: p, cantidad: total, unidadPedido: unidad_pedido,
      precioAplicado: vigT.precio_kg !== null
        ? { precio_kg: vigT.precio_kg, es_oferta: vigT.es_oferta, origen: vigT.origen } : null });
    nueva.id = previa.id;
    nueva.observaciones = observaciones ?? previa.observaciones;
    carrito.lineas[carrito.lineas.indexOf(previa)] = nueva;
  } else {
    carrito.lineas.push(linea);
  }
  await repo.guardarCarrito(carrito);
  const guardada = previa ? carrito.lineas.find((l) => l.id === previa.id) : linea;
  return { ok: true, linea: lineaVisible(guardada), carrito: resumirParaCliente(carrito) };
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
  const unidadLinea = carrito.lineas[idx].unidad_pedido;
  const vigC = await ofertas.precioVigente(p, { cantidad: cant, unidad: unidadLinea });
  const nueva = precios.calcularLinea({
    producto: p, cantidad: cant, unidadPedido: unidadLinea,
    precioAplicado: vigC.precio_kg !== null
      ? { precio_kg: vigC.precio_kg, es_oferta: vigC.es_oferta, origen: vigC.origen } : null });
  nueva.id = carrito.lineas[idx].id;
  nueva.observaciones = carrito.lineas[idx].observaciones;
  carrito.lineas[idx] = nueva;
  await repo.guardarCarrito(carrito);
  return { ok: true, linea: lineaVisible(nueva), carrito: resumirParaCliente(carrito) };
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
 * Vista que ve el modelo. Lleva el precio de Tarifa 1 cuando se puede
 * afirmar, y marca claramente lo que está pendiente de confirmar. Nunca
 * lleva un total definitivo: el peso real puede cambiar.
 */
function lineaVisible(l) {
  return {
    codigo: l.codigo,
    producto_id: l.producto_id,
    descripcion: l.descripcion,
    marca: l.marca || null,
    cantidad: l.cantidad,
    unidad_pedido: l.unidad_pedido,
    und_caja: l.und_caja ?? null,
    precio_kg_sin_iva: l.precio_kg_sin_iva,
    es_oferta: !!l.es_oferta,
    precio_pendiente_de_confirmacion: !!l.precio_pendiente_de_confirmacion,
    peso_estimado_kg: l.peso_estimado_kg,
    importe_estimado_sin_iva: l.importe_estimado_sin_iva,
    observaciones: l.observaciones || null,
  };
}

function resumirParaCliente(carrito) {
  const lineas = (carrito.lineas || []).map(lineaVisible);
  const t = precios.totalizar(carrito.lineas || []);
  return {
    lineas,
    numero_de_lineas: lineas.length,
    repite_pedido: carrito.repite_pedido || null,
    importe_estimado_sin_iva: t.base_estimada_sin_iva,
    lineas_pendientes_de_precio: lineas.filter((l) => l.precio_pendiente_de_confirmacion).length,
    total_definitivo: null,
    nota: 'Precios de Tarifa 1, por kilo y sin IVA. El importe es una estimación: '
      + 'el final se ajusta al peso real. No des nunca un total definitivo.',
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
    // Un pedido repetido es un pedido NUEVO, con su propio identificador,
    // pero guarda de cuál salió y qué se cambió.
    repite_pedido: carrito.repite_pedido || null,
    modificaciones_aplicadas: carrito.modificaciones_aplicadas || null,
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

const eur = (n) => (n === null || n === undefined ? null : String(n).replace('.', ','));

/**
 * Una línea del resumen. Lleva el precio de Tarifa 1 cuando está validado y
 * el importe estimado cuando el peso permite calcularlo. Lo que no se puede
 * afirmar se dice, no se omite.
 */
function textoLinea(l) {
  let s = `• [${l.codigo}] ${l.descripcion}`;
  if (l.marca) s += ` ${l.marca}`;
  s += ` — ${textoCantidad(l)}`;
  if (l.unidad_pedido === 'caja' && Number.isFinite(l.und_caja) && l.und_caja > 0) {
    s += ` (${l.und_caja} uds/caja)`;
  }
  if (l.precio_pendiente_de_confirmacion) {
    s += '\n  Precio pendiente de que Chacón Alcántara lo confirme.';
  } else if (l.precio_kg_sin_iva !== null && l.precio_kg_sin_iva !== undefined) {
    s += `\n  ${eur(l.precio_kg_sin_iva)} €/kg sin IVA`;
    if (l.es_oferta) s += ' (oferta)';
    if (l.peso_estimado_kg !== null && l.peso_estimado_kg !== undefined) {
      s += ` · ~${eur(l.peso_estimado_kg)} kg`;
    }
    if (l.importe_estimado_sin_iva !== null && l.importe_estimado_sin_iva !== undefined) {
      s += ` · importe estimado ${eur(l.importe_estimado_sin_iva)} €`;
    } else {
      s += ' · sin peso registrado, no puedo estimar el importe';
    }
  }
  if (l.observaciones) s += `\n  ${l.observaciones}`;
  return s;
}

/**
 * Resumen que ve la tienda antes de confirmar.
 *
 * Nunca lleva un total definitivo: se cobra por kilo y el peso real lo fija
 * Chacón al preparar, así que un "total" sería una cifra que no se puede
 * sostener. Solo se da la suma cuando TODAS las líneas son estimables; si
 * alguna está pendiente, sumar las demás daría una impresión falsa.
 */
function textoResumen(carrito, cliente, { observaciones = null } = {}) {
  const lineas = carrito.lineas || [];
  const L = ['SOLICITUD DE PEDIDO', ''];
  L.push(`Tienda: ${cliente?.nombre || '(tienda sin nombre)'}`);
  if (carrito.repite_pedido) L.push(`Repite el pedido ${carrito.repite_pedido}.`);
  L.push('');
  for (const l of lineas) L.push(textoLinea(l));
  L.push('');

  const t = precios.totalizar(lineas);
  L.push('Los precios son de Tarifa 1 por kilo, sin IVA. Chacón Alcántara confirmará el '
    + 'importe final según el peso real preparado.');
  if (t.lineas_pendientes_revision === 0 && t.base_estimada_sin_iva !== null) {
    L.push(`Importe estimado sin IVA: ${eur(t.base_estimada_sin_iva)} €.`);
  } else if (t.lineas_pendientes_revision) {
    L.push(`${t.lineas_pendientes_revision} línea(s) sin importe estimado: `
      + 'Chacón Alcántara confirmará su precio o su peso. No te doy un total todavía.');
  }
  L.push('');
  if (observaciones) { L.push(`Observaciones: ${observaciones}`); L.push(''); }
  L.push('Responde CONFIRMAR para enviar la solicitud o MODIFICAR para realizar cambios.');
  return L.join('\n');
}

module.exports = {
  ESTADOS, MENSAJE_RECEPCION,
  ver, verInterno, anadir, cambiarCantidad, quitar, vaciar, resumir, resumirParaCliente,
  validarParaConfirmar, confirmar, textoResumen, textoLinea, textoCantidad, lineaVisible,
};
