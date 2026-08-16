/* ============================================================
   Consulta de precios de Tarifa 1.

   La búsqueda entiende lenguaje natural, erratas y nombres aproximados —de
   eso se encarga `catalogo.buscar`—, pero **el precio que sale de aquí
   procede siempre de un registro real del catálogo o de una decisión
   guardada de un administrador**. El modelo recibe la frase ya redactada y
   la repite; no compone importes.

   El importe de una caja o de una unidad solo se estima si hay un peso
   fiable, y siempre se etiqueta como estimación: se cobra por kilo, así que
   el importe final depende del peso real preparado.
   ============================================================ */

const catalogo = require('./catalogo');
const precios = require('./precios');
const ofertas = require('./ofertas');

/** Formato español: coma decimal. 3.972 -> "3,972". */
function eur(n, decimales = null) {
  if (n === null || n === undefined) return null;
  const d = decimales === null ? (Number.isInteger(n) ? 2 : String(n).split('.')[1]?.length || 2) : decimales;
  return n.toFixed(Math.min(d, 3)).replace('.', ',');
}

/** El peso solo es fiable si consta y es mayor que cero. */
const pesoFiable = (p) => Number.isFinite(p.peso_und_kg) && p.peso_und_kg > 0;

/**
 * Frase exacta para un producto cuyo precio no se puede afirmar.
 * Es literal a propósito: es la respuesta acordada con el cliente.
 */
const MENSAJE_PRECIO_SIN_RESOLVER =
  'Tengo dos precios registrados para este producto y necesito que Chacón Alcántara '
  + 'confirme cuál está vigente. Puedo añadirlo a tu solicitud y Fernando revisará el precio.';

const MENSAJE_PROMOCION_SIN_CONDICIONES =
  'Este artículo está registrado como promocional, pero sus condiciones todavía no están '
  + 'definidas por Chacón Alcántara. No puedo confirmarte precio ni añadirlo hasta que lo revisen.';

const MENSAJE_SIN_OFERTAS =
  'Ahora mismo no tengo ninguna oferta activa registrada. Si quieres, puedo preparar tu '
  + 'pedido o consultar el precio de cualquier producto.';

/**
 * Consulta el precio de un producto.
 *
 * @param {object} producto  ficha del catálogo
 * @param {object} opts      cantidad y unidad si el cliente preguntó por
 *                           "una caja" o "una unidad"
 */
async function precioDe(producto, { cantidad = null, unidad = null } = {}) {
  const vig = await ofertas.precioVigente(producto, { cantidad, unidad });

  const ficha = {
    producto_id: producto.id,
    codigo: producto.codigo,
    descripcion: producto.descripcion,
    marca: producto.marca || null,
    und_caja: Number.isFinite(producto.und_caja) && producto.und_caja > 0 ? producto.und_caja : null,
    peso_und_kg: pesoFiable(producto) ? producto.peso_und_kg : null,
  };

  if (vig.precio_kg === null) {
    const promo = vig.motivo === 'promocion_requiere_validacion';
    return {
      ...ficha,
      precio_disponible: false,
      motivo: vig.motivo,
      puede_pedirse: !promo,       // la promoción sin condiciones no se pide
      respuesta_exacta: promo ? MENSAJE_PROMOCION_SIN_CONDICIONES : MENSAJE_PRECIO_SIN_RESOLVER,
      nota: 'Responde EXACTAMENTE esa frase. No enseñes los dos precios ni dejes elegir.',
    };
  }

  const L = [];
  if (vig.es_oferta) {
    L.push(`${producto.descripcion} está de oferta a ${eur(vig.precio_kg)} €/kg, sin IVA.`);
    if (vig.precio_normal_kg !== null && vig.precio_normal_kg !== undefined) {
      L.push(`Su precio habitual de Tarifa 1 es ${eur(vig.precio_normal_kg)} €/kg.`);
    }
    if (vig.condiciones) L.push(`Condiciones: ${vig.condiciones}`);
    if (vig.vigencia?.hasta) L.push(`Válida hasta el ${vig.vigencia.hasta}.`);
  } else {
    L.push(`El precio de Tarifa 1 de ${producto.descripcion} es ${eur(vig.precio_kg)} €/kg, sin IVA.`);
  }

  const detalles = [`Código ${producto.codigo}`];
  if (producto.marca) detalles.push(`marca ${producto.marca}`);
  if (ficha.und_caja) detalles.push(`${ficha.und_caja} uds/caja`);
  if (ficha.peso_und_kg) detalles.push(`${eur(ficha.peso_und_kg, 3)} kg por unidad`);
  L.push(detalles.join(' · ') + '.');

  const est = estimar(producto, vig.precio_kg, { cantidad, unidad });
  if (est.texto) L.push(est.texto);

  return {
    ...ficha,
    precio_disponible: true,
    precio_kg_sin_iva: vig.precio_kg,
    es_oferta: !!vig.es_oferta,
    origen_precio: vig.origen,
    estimacion: est.datos,
    puede_pedirse: true,
    respuesta_exacta: L.join(' '),
    nota: 'Precio por kilo y sin IVA. Responde con esa información y no calcules nada tú.',
  };
}

/**
 * Importe aproximado de una caja o de una unidad. Solo con peso fiable:
 * sin peso no hay estimación, y decirlo es mejor que aproximar a ciegas.
 */
function estimar(producto, precioKg, { cantidad = null, unidad = null } = {}) {
  if (!unidad || !['caja', 'unidad', 'kg'].includes(unidad)) return { texto: null, datos: null };
  const cant = Number.isFinite(cantidad) && cantidad > 0 ? cantidad : 1;

  const conv = precios.convertir({
    cantidad: cant, unidadPedido: unidad,
    und_caja: producto.und_caja, peso_und_kg: producto.peso_und_kg,
  });

  if (conv.peso_estimado_kg === null) {
    return {
      texto: 'No tengo registrado el peso de este artículo, así que no puedo estimarte el importe: '
        + 'se cobra por kilo y lo confirma Chacón Alcántara al prepararlo.',
      datos: { calculable: false, motivo: 'peso_desconocido' },
    };
  }

  const importe = precios.redondear(conv.peso_estimado_kg * precioKg, 2);
  const piezas = conv.unidades;
  const partes = [];
  if (unidad === 'caja' && piezas !== null && pesoFiable(producto)) {
    partes.push(`Cada caja contiene ${producto.und_caja} `
      + `${producto.und_caja === 1 ? 'pieza' : 'piezas'} de aproximadamente `
      + `${eur(producto.peso_und_kg, 3)} kg.`);
  }
  const que = unidad === 'caja' ? (cant === 1 ? 'la caja' : `${cant} cajas`)
    : unidad === 'unidad' ? (cant === 1 ? 'la unidad' : `${cant} unidades`)
      : `${cant} kg`;
  partes.push(`Con un precio de ${eur(precioKg)} €/kg, el importe estimado de ${que} sería `
    + `${eur(importe, 2)} € sin IVA.`);
  partes.push('El importe final se ajustará al peso real.');

  return {
    texto: partes.join(' '),
    datos: { calculable: true, cantidad: cant, unidad, unidades: piezas,
             peso_estimado_kg: conv.peso_estimado_kg, importe_estimado_sin_iva: importe },
  };
}

/**
 * Resuelve lo que el cliente ha nombrado. Devuelve el precio cuando hay un
 * único candidato claro; si hay varios, devuelve la lista para preguntar.
 */
async function consultarPrecio(consulta, { cantidad = null, unidad = null } = {}) {
  const r = catalogo.buscar(consulta || '');
  if (!r.candidatos.length) {
    return { encontrado: false, total: 0, sugerencias: r.sugerencias || [],
             nota: 'No hay ningún producto que corresponda. No inventes uno ni improvises el motivo.' };
  }
  // Un código o un EAN identifican sin ambigüedad; un nombre puede no hacerlo.
  const exacto = r.candidatos.length === 1 || ['codigo', 'ean'].includes(r.tipo);
  if (!exacto) {
    return {
      encontrado: true, requiere_aclaracion: true, tipo_busqueda: r.tipo, total: r.total,
      candidatos: r.candidatos.slice(0, 6).map((p) => ({
        producto_id: p.id, codigo: p.codigo, descripcion: p.descripcion, marca: p.marca || null })),
      nota: 'Hay varios productos posibles. Pregunta cuál es antes de dar un precio.',
    };
  }
  return { encontrado: true, tipo_busqueda: r.tipo, ...(await precioDe(r.candidatos[0], { cantidad, unidad })) };
}

/** Ofertas activas, ya redactadas. Si no hay, la frase acordada. */
async function consultarOfertas() {
  const activas = await ofertas.activas();
  if (!activas.length) {
    return { hay_ofertas: false, total: 0, respuesta_exacta: MENSAJE_SIN_OFERTAS,
             nota: 'Responde EXACTAMENTE esa frase. Un precio bajo NO es una oferta.' };
  }
  const L = ['Estas son las ofertas activas ahora mismo:'];
  for (const o of activas) {
    let t = `• [${o.codigo}] ${o.descripcion}`;
    if (o.marca) t += ` ${o.marca}`;
    t += ` — ${eur(o.precio_oferta_kg)} €/kg sin IVA`;
    if (o.precio_normal_kg !== null && o.precio_normal_kg !== undefined) {
      t += ` (habitual ${eur(o.precio_normal_kg)} €/kg)`;
    }
    if (o.cantidad_minima) t += ` · mínimo ${o.cantidad_minima} ${o.unidad_oferta || ''}`.trimEnd();
    if (o.condiciones) t += ` · ${o.condiciones}`;
    if (o.vigencia?.hasta) t += ` · hasta el ${o.vigencia.hasta}`;
    L.push(t);
  }
  return { hay_ofertas: true, total: activas.length, ofertas: activas,
           respuesta_exacta: L.join('\n'),
           nota: 'Solo estas. No presentes ningún otro producto como oferta.' };
}

module.exports = {
  consultarPrecio, consultarOfertas, precioDe, estimar, eur, pesoFiable,
  MENSAJE_PRECIO_SIN_RESOLVER, MENSAJE_PROMOCION_SIN_CONDICIONES, MENSAJE_SIN_OFERTAS,
};
