/* ============================================================
   Modelo de tarifas y cálculo de importes de Chacón.

   Reglas confirmadas por el cliente:
     - Los precios son POR KILO y SIN IVA.
     - Existen 8 niveles de tarifa que dependen de la CANTIDAD pedida,
       no del cliente. Todos los clientes usan las mismas reglas.
     - T1 fracción de caja · T2 media caja · T3 caja completa ·
       T4 más de una caja · T5-T8 sin definir.

   Reglas NO confirmadas (por eso nada se decide aquí a ciegas):
     - qué es exactamente "fracción de caja";
     - cómo se calcula "media caja" con un número impar de unidades;
     - a partir de cuántas cajas aplica T4;
     - qué son T5-T8;
     - la tabla de precios por producto y nivel (el PDF solo trae UNA cifra).

   **La tarifa la elige código determinista, nunca el modelo.** Y mientras
   falten los umbrales, la selección devuelve `indeterminada` en vez de
   adivinar. El precio del PDF se trata como un único tramo sin nivel
   conocido, no como "Tarifa 1", porque eso tampoco está demostrado.
   ============================================================ */

const NIVELES = [
  { nivel: 1, clave: 'fraccion_caja', descripcion: 'Fracción de caja', definido: true },
  { nivel: 2, clave: 'media_caja', descripcion: 'Media caja (independiente de las piezas)', definido: true },
  { nivel: 3, clave: 'caja_completa', descripcion: 'Caja completa', definido: true },
  { nivel: 4, clave: 'mas_de_una_caja', descripcion: 'Más de una caja', definido: true },
  { nivel: 5, clave: 'sin_definir_5', descripcion: 'Sin definir', definido: false },
  { nivel: 6, clave: 'sin_definir_6', descripcion: 'Sin definir', definido: false },
  { nivel: 7, clave: 'sin_definir_7', descripcion: 'Sin definir', definido: false },
  { nivel: 8, clave: 'sin_definir_8', descripcion: 'Sin definir', definido: false },
];

/**
 * Un tramo de precio. El modelo admite la tabla completa de 8 tarifas en
 * cuanto Chacón la entregue, sin cambiar la lógica de negocio.
 *
 * @typedef {object} Tramo
 * @property {string} codigo            código de artículo (texto)
 * @property {number|null} nivel        1..8, o null si no se conoce
 * @property {number|null} cantidad_min tramo desde (en `unidad_tramo`)
 * @property {number|null} cantidad_max tramo hasta, o null si abierto
 * @property {string} unidad_tramo      'caja' | 'unidad' | 'kg'
 * @property {number} precio_kg         euros por kilo, SIN IVA
 * @property {string|null} vigente_desde
 * @property {string} version_catalogo
 * @property {'activo'|'pendiente'|'bloqueado'} estado
 */

/** Construye los tramos a partir del catálogo importado del PDF. */
function tramosDesdeCatalogo(catalogo) {
  const tramos = [];
  for (const p of catalogo.productos) {
    if (p.tarifa === null || p.tarifa === undefined) continue;
    const bloqueado = !!p.bloqueado_para_calculo_precio;
    tramos.push({
      codigo: p.codigo,
      producto_id: p.id,
      // El PDF no demuestra a qué nivel corresponde este precio (ver el
      // informe de importación): dejarlo en null es lo honesto.
      nivel: null,
      cantidad_min: null,
      cantidad_max: null,
      unidad_tramo: 'kg',
      precio_kg: p.tarifa,
      iva_pct: null,                       // PENDIENTE: sin tabla de IVA aprobada
      vigente_desde: null,
      version_catalogo: catalogo.version.pdf_sha256,
      estado: bloqueado ? 'bloqueado' : 'pendiente',
      motivo_bloqueo: bloqueado ? (p.estado === 'promotion_requires_validation'
        ? 'promocion_requiere_validacion' : 'varios_precios_sin_nivel_identificado') : null,
    });
  }
  return tramos;
}

/**
 * Convierte lo que pide el cliente a unidades y kilos.
 * Devuelve `null` en cualquier magnitud que no pueda calcularse con certeza.
 */
function convertir({ cantidad, unidadPedido, und_caja, peso_und_kg }) {
  const out = {
    cajas: null, unidades: null, peso_estimado_kg: null,
    avisos: [],
  };
  if (!Number.isFinite(cantidad) || cantidad <= 0) {
    out.avisos.push('cantidad_no_valida');
    return out;
  }

  if (unidadPedido === 'caja') {
    out.cajas = cantidad;
    if (Number.isFinite(und_caja) && und_caja > 0) out.unidades = cantidad * und_caja;
    else out.avisos.push('sin_unidades_por_caja');
  } else if (unidadPedido === 'unidad') {
    out.unidades = cantidad;
    if (Number.isFinite(und_caja) && und_caja > 0) out.cajas = cantidad / und_caja;
  } else if (unidadPedido === 'kg') {
    out.peso_estimado_kg = cantidad;
  } else {
    out.avisos.push('unidad_de_pedido_desconocida');
    return out;
  }

  if (out.peso_estimado_kg === null) {
    if (Number.isFinite(peso_und_kg) && peso_und_kg > 0 && out.unidades !== null) {
      out.peso_estimado_kg = redondear(out.unidades * peso_und_kg, 3);
    } else {
      out.avisos.push('peso_por_unidad_desconocido_o_cero');
    }
  }
  return out;
}

const redondear = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Elige el nivel de tarifa aplicable. Determinista y conservador.
 *
 * Con los umbrales sin confirmar, devuelve `indeterminada` salvo en el caso
 * en que la regla verbal del cliente basta por sí sola. Nunca inventa el
 * corte de T4 ni el redondeo de "media caja".
 */
function elegirNivel({ cajas, unidades, und_caja, reglas = null }) {
  if (reglas && reglas.umbrales) return aplicarUmbrales({ cajas, unidades, und_caja }, reglas);

  const falta = [
    'definicion_de_fraccion_de_caja',
    'calculo_de_media_caja_con_piezas_impares',
    'umbral_de_cajas_para_tarifa_4',
    'definicion_de_tarifas_5_a_8',
    'tabla_de_precios_por_nivel',
  ];

  // Único caso sin ambigüedad posible con lo confirmado hasta ahora:
  // "más de una caja" es T4 cuando hay más de una caja completa.
  if (Number.isFinite(cajas) && cajas > 1 && Number.isInteger(cajas)) {
    return { nivel: 4, clave: 'mas_de_una_caja', determinado: true,
             motivo: 'más de una caja completa', falta };
  }
  if (Number.isFinite(cajas) && cajas === 1) {
    return { nivel: 3, clave: 'caja_completa', determinado: true,
             motivo: 'una caja completa', falta };
  }
  return {
    nivel: null, clave: null, determinado: false,
    motivo: 'los umbrales de fracción y media caja no están definidos',
    falta,
  };
}

function aplicarUmbrales({ cajas, unidades, und_caja }, reglas) {
  for (const u of reglas.umbrales) {
    const v = u.unidad === 'caja' ? cajas : unidades;
    if (v === null || v === undefined) continue;
    const min = u.cantidad_min ?? -Infinity;
    const max = u.cantidad_max ?? Infinity;
    if (v >= min && v <= max) {
      return { nivel: u.nivel, clave: u.clave || null, determinado: true,
               motivo: `regla configurada ${u.nivel}: ${min}-${max} ${u.unidad}`, falta: [] };
    }
  }
  return { nivel: null, clave: null, determinado: false,
           motivo: 'ningún tramo configurado cubre esta cantidad', falta: [] };
}

/**
 * Calcula la línea. Devuelve importe SOLO si todo es seguro:
 * precio no bloqueado, peso conocido y nivel de tarifa determinado.
 */
function calcularLinea({ producto, cantidad, unidadPedido, reglas = null }) {
  const conv = convertir({
    cantidad, unidadPedido,
    und_caja: producto.und_caja, peso_und_kg: producto.peso_und_kg,
  });
  const nivel = elegirNivel({ cajas: conv.cajas, unidades: conv.unidades,
                              und_caja: producto.und_caja, reglas });

  const bloqueos = [];
  if (producto.bloqueado_para_calculo_precio) {
    bloqueos.push(producto.estado === 'promotion_requires_validation'
      ? 'promocion_requiere_validacion'
      : 'varios_precios_sin_nivel_identificado');
  }
  if (conv.peso_estimado_kg === null) bloqueos.push('peso_desconocido');
  if (!nivel.determinado) bloqueos.push('nivel_de_tarifa_indeterminado');
  if (producto.tarifa === null || producto.tarifa === undefined) bloqueos.push('sin_precio');

  const puedeCalcular = bloqueos.length === 0;
  const precio_kg = puedeCalcular ? producto.tarifa : null;
  const importe = puedeCalcular ? redondear(conv.peso_estimado_kg * precio_kg, 2) : null;

  return {
    codigo: producto.codigo,
    producto_id: producto.id,
    descripcion: producto.descripcion,
    marca: producto.marca,
    cantidad,
    unidad_pedido: unidadPedido,
    und_caja: producto.und_caja,
    cajas: conv.cajas,
    unidades: conv.unidades,
    peso_und_kg: producto.peso_und_kg,
    peso_estimado_kg: conv.peso_estimado_kg,
    peso_real_kg: null,                 // lo fija Chacón al preparar
    nivel_tarifa: nivel.nivel,
    nivel_determinado: nivel.determinado,
    precio_kg_sin_iva: precio_kg,
    importe_estimado_sin_iva: importe,
    importe_final_sin_iva: null,        // se ajusta al peso real
    iva_pct: null,                      // PENDIENTE
    estado_linea: puedeCalcular ? 'estimado' : 'pendiente_revision',
    bloqueos,
    avisos: [...conv.avisos],
    motivo_nivel: nivel.motivo,
  };
}

/** Totaliza sin inventar: separa lo estimable de lo que necesita revisión. */
function totalizar(lineas) {
  const estimables = lineas.filter((l) => l.importe_estimado_sin_iva !== null);
  const pendientes = lineas.filter((l) => l.importe_estimado_sin_iva === null);
  const base = redondear(estimables.reduce((s, l) => s + l.importe_estimado_sin_iva, 0), 2);
  const peso = redondear(
    lineas.reduce((s, l) => s + (l.peso_estimado_kg || 0), 0), 3);
  return {
    lineas_estimadas: estimables.length,
    lineas_pendientes_revision: pendientes.length,
    peso_estimado_kg: peso || null,
    base_estimada_sin_iva: estimables.length ? base : null,
    iva: null,                 // PENDIENTE: sin tabla de IVA aprobada
    total_con_iva: null,       // nunca se inventa
    nota: 'Importes sin IVA. El importe final se ajustará al peso real preparado por Chacón Alcántara.',
  };
}

module.exports = { NIVELES, tramosDesdeCatalogo, convertir, elegirNivel, calcularLinea, totalizar, redondear };
