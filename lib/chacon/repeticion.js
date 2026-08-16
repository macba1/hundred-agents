/* ============================================================
   Repetir un pedido anterior.

   Regla que no se salta nunca: **un pedido repetido no se reenvía solo**.
   Se localiza, se copia a un carrito nuevo, se aplican los cambios que pida
   la tienda, se revalida contra el catálogo de hoy y se vuelve a enseñar
   para que la tienda confirme otra vez. El pedido resultante es nuevo, con
   identificador propio, y guarda una referencia al que copió.

   El precio que vale es el de hoy, no el del pedido antiguo. Si ha cambiado,
   se avisa: enterarse en la factura sería la peor forma de descubrirlo.
   ============================================================ */

const repo = require('./repo');
const catalogo = require('./catalogo');
const precios = require('./precios');
const ofertas = require('./ofertas');

/** Lo que se responde cuando la tienda pide repetir y no hay nada guardado. */
const MENSAJE_SIN_HISTORIAL =
  'Todavía no tengo registrado tu pedido anterior. Dime qué productos necesitas y '
  + 'guardaré este pedido para que puedas repetirlo fácilmente la próxima vez.';

/** Pedidos que la tienda puede repetir, del más reciente al más antiguo. */
async function historial(clienteId, { limite = 10 } = {}) {
  const pedidos = await repo.pedidosDeCliente(clienteId, { limite });
  return pedidos.filter((p) => p.estado !== 'cancelada');
}

/**
 * Aplica las modificaciones que pidió la tienda sobre las líneas copiadas.
 * Cada acción es explícita: el modelo no reescribe cantidades a mano.
 */
function aplicarModificaciones(lineas, modificaciones = []) {
  let out = lineas.map((l) => ({ ...l }));
  const aplicadas = [];
  const rechazadas = [];

  for (const m of modificaciones || []) {
    const accion = m.accion || m.tipo;

    if (accion === 'multiplicar') {
      const f = Number(m.factor);
      if (!Number.isFinite(f) || f <= 0) { rechazadas.push({ ...m, motivo: 'factor_no_valido' }); continue; }
      out = out.map((l) => ({ ...l, cantidad: precios.redondear(l.cantidad * f, 3) }));
      aplicadas.push(`todas las cantidades ×${f}`);

    } else if (accion === 'quitar') {
      const antes = out.length;
      out = out.filter((l) => l.producto_id !== m.producto_id && l.codigo !== m.codigo);
      if (out.length === antes) rechazadas.push({ ...m, motivo: 'linea_no_encontrada' });
      else aplicadas.push(`quitado ${m.codigo || m.producto_id}`);

    } else if (accion === 'cambiar') {
      const l = out.find((x) => x.producto_id === m.producto_id || x.codigo === m.codigo);
      const c = Number(m.cantidad);
      if (!l) { rechazadas.push({ ...m, motivo: 'linea_no_encontrada' }); continue; }
      if (!Number.isFinite(c) || c < 0) { rechazadas.push({ ...m, motivo: 'cantidad_no_valida' }); continue; }
      if (c === 0) { out = out.filter((x) => x !== l); aplicadas.push(`quitado ${l.codigo}`); continue; }
      l.cantidad = c;
      aplicadas.push(`${l.codigo} a ${c} ${l.unidad_pedido}`);

    } else if (accion === 'anadir') {
      const p = catalogo.porId(m.producto_id);
      const c = Number(m.cantidad);
      if (!p) { rechazadas.push({ ...m, motivo: 'producto_inexistente' }); continue; }
      if (!['caja', 'unidad', 'kg'].includes(m.unidad_pedido)) {
        rechazadas.push({ ...m, motivo: 'unidad_ambigua' }); continue;
      }
      if (!Number.isFinite(c) || c <= 0) { rechazadas.push({ ...m, motivo: 'cantidad_no_valida' }); continue; }
      // Si ya estaba, se suma en vez de duplicar la línea.
      const previa = out.find((l) => l.producto_id === p.id && l.unidad_pedido === m.unidad_pedido);
      if (previa) { previa.cantidad += c; aplicadas.push(`${p.codigo} +${c} ${m.unidad_pedido}`); }
      else {
        out.push({ producto_id: p.id, codigo: p.codigo, cantidad: c,
                   unidad_pedido: m.unidad_pedido, observaciones: m.observaciones || null });
        aplicadas.push(`añadido ${p.codigo} ${c} ${m.unidad_pedido}`);
      }

    } else {
      rechazadas.push({ ...m, motivo: 'accion_desconocida' });
    }
  }
  return { lineas: out, aplicadas, rechazadas };
}

/**
 * Prepara la repetición: deja el carrito listo y devuelve lo que hay que
 * enseñarle a la tienda, incluidos los cambios de precio. **No confirma.**
 */
async function preparar(clienteId, { pedido_id = null, modificaciones = [] } = {}) {
  const previos = await historial(clienteId, { limite: 20 });
  if (!previos.length) {
    return { ok: false, error: 'sin_historial', respuesta_exacta: MENSAJE_SIN_HISTORIAL,
             nota: 'Responde EXACTAMENTE esa frase. No reconstruyas pedidos que no tienes.' };
  }

  const origen = pedido_id ? previos.find((p) => p.id === pedido_id) : previos[0];
  if (!origen) return { ok: false, error: 'pedido_no_encontrado', pedidos_disponibles: previos.map((p) => p.id) };

  const mod = aplicarModificaciones(origen.lineas || [], modificaciones);
  if (!mod.lineas.length) {
    return { ok: false, error: 'no_queda_ninguna_linea',
             nota: 'Los cambios dejan el pedido vacío. Pregunta qué quiere pedir.' };
  }

  // Se revalida contra el catálogo de HOY y se recalcula con el precio de hoy.
  const lineas = [];
  const retirados = [];
  const cambiosDePrecio = [];

  for (const l of mod.lineas) {
    const p = catalogo.porId(l.producto_id) || catalogo.porId(l.codigo);
    if (!p || p.activo === false) {
      retirados.push({ codigo: l.codigo, descripcion: l.descripcion || null, motivo: 'ya_no_disponible' });
      continue;
    }
    const vig = await ofertas.precioVigente(p, { cantidad: l.cantidad, unidad: l.unidad_pedido });
    const nueva = precios.calcularLinea({
      producto: p, cantidad: l.cantidad, unidadPedido: l.unidad_pedido,
      precioAplicado: vig.precio_kg !== null ? { precio_kg: vig.precio_kg, es_oferta: vig.es_oferta, origen: vig.origen } : null,
    });
    nueva.observaciones = l.observaciones || null;
    nueva.id = `L${Date.now()}${lineas.length}`;

    const antes = l.precio_kg_sin_iva ?? null;
    const ahora = nueva.precio_kg_sin_iva ?? null;
    if (antes !== null && ahora !== null && antes !== ahora) {
      cambiosDePrecio.push({
        codigo: p.codigo, descripcion: p.descripcion,
        antes, ahora, es_oferta: nueva.es_oferta,
        direccion: ahora > antes ? 'sube' : 'baja',
      });
    }
    lineas.push(nueva);
  }

  if (!lineas.length) {
    return { ok: false, error: 'ningun_producto_sigue_disponible', retirados };
  }

  const carrito = await repo.getCarrito(clienteId);
  carrito.lineas = lineas;
  carrito.repite_pedido = origen.id;
  carrito.modificaciones_aplicadas = mod.aplicadas;
  await repo.guardarCarrito(carrito);

  return {
    ok: true,
    pedido_origen: { id: origen.id, fecha: origen.creado, lineas: (origen.lineas || []).length },
    modificaciones_aplicadas: mod.aplicadas,
    modificaciones_rechazadas: mod.rechazadas,
    productos_retirados: retirados,
    cambios_de_precio: cambiosDePrecio,
    nota: 'Enseña el pedido encontrado con su fecha y su identificador, avisa de los cambios de '
      + 'precio y de los productos retirados, y pide una NUEVA confirmación. '
      + 'Nunca lo envíes sin que la tienda vuelva a confirmar.',
  };
}

/** Texto del aviso de cambios de precio, ya redactado. */
function textoCambios(cambios) {
  if (!cambios || !cambios.length) return null;
  const L = ['Ojo, ha cambiado el precio desde tu último pedido:'];
  for (const c of cambios) {
    const eur = (n) => String(n).replace('.', ',');
    L.push(`• ${c.descripcion}: ${eur(c.antes)} → ${eur(c.ahora)} €/kg`
      + (c.es_oferta ? ' (oferta)' : ''));
  }
  return L.join('\n');
}

module.exports = { historial, preparar, aplicarModificaciones, textoCambios, MENSAJE_SIN_HISTORIAL };
