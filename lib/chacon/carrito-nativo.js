/* ============================================================
   Recepción del carrito nativo de WhatsApp.

   Cuando la tienda pulsa "Realizar pedido" en el catálogo de Meta, llega un
   mensaje `order` con los códigos y las cantidades. Ese mensaje entra por la
   MISMA puerta que un pedido escrito o dictado: mismo catálogo, mismo
   carrito interno, mismas validaciones, mismo envío a Fernando.

   Dos reglas que no se negocian:

   1. **Del carrito solo se cree el código y la cantidad.** El nombre, el
      precio y la descripción que manda Meta vienen de un feed que pudo
      quedarse desfasado. El precio SIEMPRE se recalcula contra nuestro
      catálogo; si no coincide con lo que traía el mensaje, manda el nuestro.

   2. **Cajas o unidades no se adivina.** El carrito nativo manda un número
      pelado. Si el artículo puede pedirse de las dos formas, se pregunta.
      Un pedido ambiguo no llega a Fernando.
   ============================================================ */

const repo = require('./repo');
const catalogo = require('./catalogo');
const ofertas = require('./ofertas');
const precios = require('./precios');

/**
 * Qué modalidades admite un artículo.
 *
 * Con `und_caja = 1` la caja y la unidad son la misma cosa, así que no hay
 * ambigüedad que resolver y preguntarlo solo molestaría. Con más de una
 * unidad por caja, "3" puede ser 3 cajas o 3 piezas: eso sí se pregunta.
 */
function modalidades(producto) {
  const n = producto.und_caja;
  if (!Number.isFinite(n) || n <= 0) {
    return { opciones: ['caja', 'unidad'], ambiguo: true, motivo: 'unidades_por_caja_desconocidas' };
  }
  if (n === 1) return { opciones: ['caja'], ambiguo: false, motivo: 'la caja trae una sola unidad' };
  return { opciones: ['caja', 'unidad'], ambiguo: true, motivo: `la caja trae ${n} unidades` };
}

/**
 * Convierte el mensaje `order` en líneas validadas contra NUESTRO catálogo.
 * No toca el carrito todavía: primero hay que saber si algo quedó ambiguo.
 */
async function interpretar(order = {}) {
  const items = Array.isArray(order.product_items) ? order.product_items : [];
  const lineas = [];
  const rechazadas = [];

  for (const it of items) {
    const rid = String(it.product_retailer_id || '').trim();
    const cantidad = Number(it.quantity);

    // El `product_retailer_id` es nuestro código de Chacón. Si no existe en
    // el catálogo, el feed y la base se han desincronizado: no se inventa.
    const candidatos = catalogo.todos().filter((p) => p.codigo === rid);
    if (!rid || !candidatos.length) {
      rechazadas.push({ product_retailer_id: rid, cantidad,
                        motivo: 'codigo_no_esta_en_el_catalogo' });
      continue;
    }
    if (!Number.isFinite(cantidad) || cantidad <= 0 || !Number.isInteger(cantidad)) {
      rechazadas.push({ product_retailer_id: rid, cantidad,
                        motivo: 'cantidad_no_valida' });
      continue;
    }

    const producto = candidatos[0];
    const modos = modalidades(producto);
    const vig = await ofertas.precioVigente(producto);

    lineas.push({
      producto_id: producto.id,
      codigo: producto.codigo,
      descripcion: producto.descripcion,      // la NUESTRA, no la del mensaje
      marca: producto.marca || null,
      und_caja: producto.und_caja ?? null,
      cantidad,
      unidad_pedido: modos.ambiguo ? null : modos.opciones[0],
      necesita_aclaracion: modos.ambiguo,
      motivo_aclaracion: modos.ambiguo ? modos.motivo : null,
      // Se guarda lo que dijo Meta solo como traza; no se usa para nada.
      precio_recibido_de_meta: it.item_price ?? null,
      moneda_recibida: it.currency || null,
      precio_kg_sin_iva: vig.precio_kg,
      precio_pendiente_de_confirmacion: vig.precio_kg === null,
    });
  }

  return {
    catalog_id: order.catalog_id || null,
    texto_cliente: order.text || null,
    lineas,
    rechazadas,
    ambiguas: lineas.filter((l) => l.necesita_aclaracion),
  };
}

/** Todas las líneas ambiguas comparten cantidad y modalidad posible. */
function preguntaDeModalidad(ambiguas) {
  if (!ambiguas.length) return null;
  if (ambiguas.length === 1) {
    const l = ambiguas[0];
    return `Para ${l.descripcion}, ¿${l.cantidad} cajas o ${l.cantidad} unidades?`;
  }
  const lista = ambiguas.map((l) => `• [${l.codigo}] ${l.descripcion} — ${l.cantidad}`).join('\n');
  return `¿Estas cantidades corresponden a cajas o unidades?\n${lista}`;
}

/**
 * Vuelca el carrito de WhatsApp en el carrito interno de Chacón.
 *
 * Idempotente por `wamid`: reenviar el mismo carrito —o que Meta repita el
 * webhook— no duplica líneas. Las ambiguas se guardan pendientes, sin
 * unidad, para que no puedan llegar a un pedido sin resolverse.
 */
async function volcar(clienteId, telefono, interpretado, { wamid = null } = {}) {
  const ctx = await repo.getContexto(telefono);
  if (wamid && ctx.ultimo_carrito_wamid === wamid) {
    return { ok: true, idempotente: true, lineas: 0,
             nota: 'Este carrito ya se había recibido: no se duplica.' };
  }

  const carrito = await repo.getCarrito(clienteId);
  carrito.lineas = carrito.lineas || [];
  let añadidas = 0;

  for (const l of interpretado.lineas) {
    if (l.necesita_aclaracion) continue;      // sin unidad no entra al carrito
    const producto = catalogo.porId(l.producto_id);
    const vig = await ofertas.precioVigente(producto,
      { cantidad: l.cantidad, unidad: l.unidad_pedido });
    const linea = precios.calcularLinea({
      producto, cantidad: l.cantidad, unidadPedido: l.unidad_pedido,
      precioAplicado: vig.precio_kg !== null
        ? { precio_kg: vig.precio_kg, es_oferta: vig.es_oferta, origen: vig.origen } : null,
    });
    linea.id = `L${Date.now()}${añadidas}`;
    linea.origen = 'carrito_whatsapp';

    const previa = carrito.lineas.find((x) => x.producto_id === linea.producto_id
      && x.unidad_pedido === linea.unidad_pedido);
    if (previa) carrito.lineas[carrito.lineas.indexOf(previa)] = linea;
    else carrito.lineas.push(linea);
    añadidas += 1;
  }

  // El carrito original se conserva tal cual llegó: es la prueba de qué pidió
  // la tienda antes de que nadie interpretara nada.
  carrito.carrito_whatsapp = {
    wamid, catalog_id: interpretado.catalog_id,
    recibido: new Date().toISOString(),
    lineas: interpretado.lineas.map((l) => ({
      product_retailer_id: l.codigo, cantidad: l.cantidad,
      precio_recibido_de_meta: l.precio_recibido_de_meta, moneda: l.moneda_recibida })),
    rechazadas: interpretado.rechazadas,
  };
  await repo.guardarCarrito(carrito);

  ctx.ultimo_carrito_wamid = wamid;
  ctx.pendientes_de_modalidad = interpretado.ambiguas.map((l) => ({
    producto_id: l.producto_id, codigo: l.codigo,
    descripcion: l.descripcion, cantidad: l.cantidad }));
  await repo.guardarContexto(ctx);

  return {
    ok: true,
    lineas_añadidas: añadidas,
    pendientes_de_modalidad: interpretado.ambiguas.length,
    rechazadas: interpretado.rechazadas,
    pregunta: preguntaDeModalidad(interpretado.ambiguas),
  };
}

/**
 * Resuelve las líneas que quedaron sin modalidad. `unidad` puede aplicarse a
 * todas de golpe, o a un código concreto.
 */
async function resolverModalidad(clienteId, telefono, unidad, { codigo = null } = {}) {
  if (!['caja', 'unidad'].includes(unidad)) {
    return { ok: false, error: 'unidad_no_valida' };
  }
  const ctx = await repo.getContexto(telefono);
  const pendientes = ctx.pendientes_de_modalidad || [];
  if (!pendientes.length) return { ok: false, error: 'nada_pendiente' };

  const objetivo = codigo ? pendientes.filter((p) => p.codigo === codigo) : pendientes;
  if (!objetivo.length) return { ok: false, error: 'codigo_no_pendiente', codigo };

  const carrito = await repo.getCarrito(clienteId);
  carrito.lineas = carrito.lineas || [];

  for (const p of objetivo) {
    const producto = catalogo.porId(p.producto_id);
    const vig = await ofertas.precioVigente(producto, { cantidad: p.cantidad, unidad });
    const linea = precios.calcularLinea({
      producto, cantidad: p.cantidad, unidadPedido: unidad,
      precioAplicado: vig.precio_kg !== null
        ? { precio_kg: vig.precio_kg, es_oferta: vig.es_oferta, origen: vig.origen } : null,
    });
    linea.id = `L${Date.now()}${p.codigo}`;
    linea.origen = 'carrito_whatsapp';
    const previa = carrito.lineas.find((x) => x.producto_id === linea.producto_id
      && x.unidad_pedido === unidad);
    if (previa) carrito.lineas[carrito.lineas.indexOf(previa)] = linea;
    else carrito.lineas.push(linea);
  }
  await repo.guardarCarrito(carrito);

  ctx.pendientes_de_modalidad = pendientes.filter((p) => !objetivo.includes(p));
  await repo.guardarContexto(ctx);

  return { ok: true, resueltas: objetivo.length,
           quedan_pendientes: ctx.pendientes_de_modalidad.length,
           pregunta: preguntaDeModalidad(ctx.pendientes_de_modalidad.map(
             (p) => ({ ...p, descripcion: p.descripcion }))) };
}

module.exports = { interpretar, volcar, resolverModalidad, modalidades, preguntaDeModalidad };
