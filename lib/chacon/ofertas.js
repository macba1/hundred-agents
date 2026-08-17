/* ============================================================
   Ofertas y resolución de precios de Chacón.

   Dos decisiones que solo puede tomar una persona, nunca el importador ni
   el modelo:

   1. **Resolver un precio repetido.** 19 códigos del PDF traen dos precios.
      El PDF no permite saber cuál es el vigente: no hay etiqueta `OF` ni
      "oferta", el orden de aparición no lo indica, el precio más bajo no es
      necesariamente una oferta y la primera aparición no es necesariamente
      el precio normal. Se comprobó y no se sostiene. Así que un
      administrador dice cuál es el normal y, si procede, cuál es la oferta.

   2. **Dar de alta una oferta.** Un precio bajo NO es una promoción. Una
      oferta solo existe si alguien la marca como tal.

   Una oferta solo se enseña si se cumplen las cinco condiciones a la vez:
   marcada como oferta · validada por un administrador · activa · dentro de
   fechas · condiciones cumplidas cuando las haya.

   Todo esto vive en Redis, no en el catálogo: el catálogo es lo que dice el
   PDF y no debe reescribirse con decisiones comerciales.
   ============================================================ */

const repo = require('./repo');
const tarifas = require('./tarifas');
const facturacion = require('./facturacion');

/** Campos del modelo de precios y ofertas por producto. */
const CAMPOS = [
  'standard_price_per_kg',
  'offer_price_per_kg',
  'offer_active',
  'offer_start_date',
  'offer_end_date',
  'offer_min_quantity',
  'offer_unit',
  'offer_conditions',
  'offer_source',
  'offer_validated_by',
  'offer_validated_at',
];

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** Registro vacío: todo null, nada asumido. */
function vacio(productoId) {
  const r = { producto_id: productoId };
  for (const c of CAMPOS) r[c] = null;
  r.offer_active = false;
  r.historial = [];
  return r;
}

async function get(productoId) {
  return (await repo.getPrecio(productoId)) || vacio(productoId);
}

/**
 * Guarda la decisión de un administrador. Siempre deja rastro de quién y
 * cuándo: el encargo pide saber quién validó cada precio.
 */
async function guardar(productoId, cambios, { por = 'administrador', nota = null } = {}) {
  const actual = await get(productoId);
  const antes = {};
  for (const c of CAMPOS) if (c in cambios) antes[c] = actual[c];

  const nuevo = { ...actual, producto_id: productoId };
  for (const c of CAMPOS) {
    if (!(c in cambios)) continue;
    if (c === 'standard_price_per_kg' || c === 'offer_price_per_kg' || c === 'offer_min_quantity') {
      nuevo[c] = num(cambios[c]);
    } else if (c === 'offer_active') {
      nuevo[c] = cambios[c] === true || cambios[c] === 'true' || cambios[c] === 'on' || cambios[c] === '1';
    } else {
      nuevo[c] = cambios[c] === '' ? null : cambios[c];
    }
  }

  // Marcar una oferta como activa es un acto de validación: queda firmado.
  if ('offer_price_per_kg' in cambios || 'offer_active' in cambios) {
    nuevo.offer_validated_by = cambios.offer_validated_by || por;
    nuevo.offer_validated_at = new Date().toISOString();
  }

  nuevo.historial = [...(actual.historial || []), {
    ts: new Date().toISOString(), por, nota, antes,
    despues: Object.fromEntries(Object.keys(antes).map((k) => [k, nuevo[k]])),
  }].slice(-50);

  await repo.guardarPrecio(nuevo);
  return nuevo;
}

/**
 * ¿Esta oferta se puede enseñar hoy? Devuelve el motivo exacto por el que
 * no, para que el panel lo explique en vez de fallar en silencio.
 */
function estadoOferta(reg, { ahora = new Date(), cantidad = null, unidad = null } = {}) {
  if (!reg || reg.offer_price_per_kg === null) {
    return { visible: false, motivo: 'sin_oferta_registrada' };
  }
  if (!reg.offer_validated_by || !reg.offer_validated_at) {
    return { visible: false, motivo: 'sin_validar_por_administrador' };
  }
  if (!reg.offer_active) return { visible: false, motivo: 'desactivada' };

  const t = ahora.getTime();
  if (reg.offer_start_date && t < Date.parse(reg.offer_start_date)) {
    return { visible: false, motivo: 'aun_no_vigente' };
  }
  // La fecha de fin se interpreta inclusiva: vale hasta el final de ese día.
  if (reg.offer_end_date) {
    const fin = Date.parse(reg.offer_end_date);
    const finDia = Number.isFinite(fin) ? fin + (reg.offer_end_date.length <= 10 ? 86399999 : 0) : NaN;
    if (Number.isFinite(finDia) && t > finDia) return { visible: false, motivo: 'caducada' };
  }

  // Condición comprobable: cantidad mínima. Las condiciones en texto libre
  // no se evalúan solas — se le enseñan al cliente tal cual.
  if (reg.offer_min_quantity !== null && cantidad !== null) {
    const mismaUnidad = !reg.offer_unit || reg.offer_unit === unidad;
    if (mismaUnidad && cantidad < reg.offer_min_quantity) {
      return { visible: false, motivo: 'no_llega_a_la_cantidad_minima',
               falta: `mínimo ${reg.offer_min_quantity} ${reg.offer_unit || ''}`.trim() };
    }
    if (!mismaUnidad) {
      return { visible: false, motivo: 'unidad_distinta_a_la_de_la_oferta',
               falta: `la oferta se aplica por ${reg.offer_unit}` };
    }
  }
  return { visible: true, motivo: null };
}

/**
 * Precio que se le puede afirmar al cliente para un producto, con su origen.
 * Nunca devuelve un precio que no se pueda defender.
 */
async function precioVigente(producto, { cantidad = null, unidad = null, ahora = new Date() } = {}) {
  /* Motor de tarifas v2: ocho tramos con sus ofertas, versionado y aprobado.
     Solo entra si CHACON_TARIFAS_V2=1 y hay una versión activa aprobada. Con
     el flag apagado sigue el camino de siempre, sin enterarse. */
  if (tarifas.disponible() && cantidad !== null && unidad !== null) {
    const r = tarifas.precioParaCantidad(producto.codigo,
      { cantidad, unidadPedido: unidad,
        unidadesPorCaja: facturacion.baseDe(producto.codigo).units_per_box
          ?? producto.und_caja ?? null });
    if (r.ok && !r.precio.promotion_rule_required) {
      const base = facturacion.baseDe(producto.codigo);
      return {
        precio_kg: r.precio.aplicado_e4 / tarifas.ESCALA,
        precio_e4: r.precio.aplicado_e4,
        es_oferta: r.precio.es_oferta,
        origen: `tarifa_${r.precio.tariff_code}_v${r.precio.catalog_version}`,
        precio_normal_kg: r.precio.normal_e4 !== null ? r.precio.normal_e4 / tarifas.ESCALA : null,
        tier: r.precio.tier,
        tier_label: r.precio.tier_label,
        tariff_code: r.precio.tariff_code,
        catalog_version: r.precio.catalog_version,
        billing_unit: base.billing_unit,
        motor: 'tarifas_v2',
      };
    }
    if (r.ok && r.precio.promotion_rule_required) {
      return { precio_kg: null, es_oferta: false, origen: null, bloqueado: true,
               motivo: 'promocion_requiere_validacion', motor: 'tarifas_v2' };
    }
    if (!r.ok && r.error === 'tramo_indeterminado') {
      return { precio_kg: null, es_oferta: false, origen: null, bloqueado: true,
               motivo: 'tramo_indeterminado', pregunta: r.pregunta, motor: 'tarifas_v2' };
    }
    // Si el código no está en la tarifa activa, se sigue por el camino viejo.
  }

  // Un artículo promocional sin condiciones definidas no tiene precio que
  // afirmar, y cargarle una oferta no lo arregla: seguimos sin saber qué hay
  // que comprar para recibirlo ni durante cuánto tiempo.
  if (producto.estado === 'promotion_requires_validation') {
    return { precio_kg: null, es_oferta: false, origen: null, bloqueado: true,
             motivo: 'promocion_requiere_validacion' };
  }

  const reg = await get(producto.id);
  const of = estadoOferta(reg, { ahora, cantidad, unidad });

  if (of.visible) {
    return {
      precio_kg: reg.offer_price_per_kg,
      es_oferta: true,
      origen: 'oferta_validada',
      precio_normal_kg: reg.standard_price_per_kg ?? (producto.bloqueado_para_calculo_precio ? null : producto.tarifa),
      condiciones: reg.offer_conditions || null,
      vigencia: { desde: reg.offer_start_date, hasta: reg.offer_end_date },
      validada_por: reg.offer_validated_by,
    };
  }

  // Precio normal fijado a mano por un administrador: resuelve los duplicados.
  if (reg.standard_price_per_kg !== null) {
    return { precio_kg: reg.standard_price_per_kg, es_oferta: false,
             origen: 'tarifa_1_resuelta_por_administrador',
             resuelto_por: reg.offer_validated_by || null,
             oferta_no_aplicable: of.motivo === 'sin_oferta_registrada' ? null : of };
  }

  // Sin decisión humana: manda el catálogo, con sus bloqueos.
  if (producto.bloqueado_para_calculo_precio) {
    return {
      precio_kg: null, es_oferta: false, origen: null,
      bloqueado: true,
      motivo: producto.estado === 'promotion_requires_validation'
        ? 'promocion_requiere_validacion' : 'varios_precios_sin_resolver',
    };
  }
  return { precio_kg: producto.tarifa ?? null, es_oferta: false, origen: 'tarifa_1_pdf' };
}

/** Ofertas que hoy se pueden enseñar. Si no hay ninguna, devuelve []. */
async function activas({ ahora = new Date() } = {}) {
  const catalogo = require('./catalogo');
  const out = [];
  for (const reg of await repo.listarPrecios()) {
    const p = catalogo.porId(reg.producto_id);
    if (!p || p.activo === false) continue;
    // Una promoción sin condiciones definidas nunca sale como oferta.
    if (p.estado === 'promotion_requires_validation') continue;
    if (!estadoOferta(reg, { ahora }).visible) continue;
    out.push({
      producto_id: p.id, codigo: p.codigo, descripcion: p.descripcion, marca: p.marca || null,
      und_caja: p.und_caja, peso_und_kg: p.peso_und_kg,
      precio_oferta_kg: reg.offer_price_per_kg,
      precio_normal_kg: reg.standard_price_per_kg ?? (p.bloqueado_para_calculo_precio ? null : p.tarifa),
      condiciones: reg.offer_conditions || null,
      cantidad_minima: reg.offer_min_quantity, unidad_oferta: reg.offer_unit,
      vigencia: { desde: reg.offer_start_date, hasta: reg.offer_end_date },
    });
  }
  return out;
}

module.exports = { CAMPOS, vacio, get, guardar, estadoOferta, precioVigente, activas };
