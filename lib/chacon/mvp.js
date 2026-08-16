/* ============================================================
   Alcance del MVP de Chacón.

   El objetivo de esta primera versión NO es cotizar: es que una tienda
   prepare y envíe una solicitud de pedido estructurada.

   Toda la maquinaria de tarifas, precios, pesos e IVA sigue construida y
   probada (`precios.js`), pero **no interviene en el flujo comercial**:
   se calcula y se guarda internamente, y se recorta antes de que la vea el
   modelo o el cliente. Si el modelo no recibe una cifra, no puede
   enseñarla ni inventar un total a partir de ella.

   Poner CHACON_MOSTRAR_PRECIOS=1 reactiva lo económico en una fase
   posterior, sin tocar la lógica de negocio.
   ============================================================ */

const MOSTRAR_PRECIOS = process.env.CHACON_MOSTRAR_PRECIOS === '1';

/** Campos económicos que en el MVP no salen del servidor. */
const CAMPOS_ECONOMICOS = [
  'precio_kg_sin_iva', 'importe_estimado_sin_iva', 'importe_final_sin_iva',
  'iva_pct', 'nivel_tarifa', 'nivel_determinado', 'motivo_nivel',
  'base_estimada_sin_iva', 'iva', 'total_con_iva', 'precio_bloqueado',
  'motivo_precio_bloqueado', 'tarifa',
];

/** Quita del objeto todo lo económico, salvo que el modo esté activado. */
function sinEconomia(obj) {
  if (MOSTRAR_PRECIOS || obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sinEconomia);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (CAMPOS_ECONOMICOS.includes(k)) continue;
    out[k] = (v && typeof v === 'object') ? sinEconomia(v) : v;
  }
  return out;
}

/**
 * Línea tal como la ven el modelo y la tienda. Solo lo confirmado del
 * catálogo y lo que la tienda pidió.
 */
function lineaVisible(l) {
  const v = {
    codigo: l.codigo,
    producto_id: l.producto_id,
    descripcion: l.descripcion,
    marca: l.marca || null,
    cantidad: l.cantidad,
    unidad_pedido: l.unidad_pedido,
    und_caja: l.und_caja ?? null,
    observaciones: l.observaciones || null,
  };
  if (MOSTRAR_PRECIOS) {
    v.precio_kg_sin_iva = l.precio_kg_sin_iva;
    v.importe_estimado_sin_iva = l.importe_estimado_sin_iva;
    v.peso_estimado_kg = l.peso_estimado_kg;
  }
  return v;
}

/**
 * Producto tal como lo ve el modelo al buscar. Sin precio ni tarifa, y sin
 * afirmar disponibilidad: no hay fuente de stock.
 */
function productoVisible(p) {
  const v = {
    producto_id: p.id,
    codigo: p.codigo,
    descripcion: p.descripcion,
    marca: p.marca || null,
    und_caja: p.und_caja ?? null,
    gluten: p.gluten,      // true / false / null — null es "no consta"
    lactosa: p.lactosa,
    observaciones: p.observaciones || null,
    disponibilidad: 'pendiente_de_revision',
  };
  if (MOSTRAR_PRECIOS) {
    v.precio_kg_sin_iva = p.bloqueado_para_calculo_precio ? null : p.tarifa;
    v.precio_bloqueado = !!p.bloqueado_para_calculo_precio;
  }
  return v;
}

module.exports = { MOSTRAR_PRECIOS, sinEconomia, lineaVisible, productoVisible, CAMPOS_ECONOMICOS };
