/* ============================================================
   Base de facturación por producto: kg · unit · box · unknown.

   Las etiquetas del PDF —`PIEZA`, `1/2 CAJA`, `1 CAJA`, `+ 2 CAJAS`—
   identifican el **tramo de tarifa**, no la base de facturación. De "PIEZA"
   no se sigue que el precio sea por unidad, igual que de "1 CAJA" no se
   sigue que sea por caja. Deducirlo convertiría 133 artículos a €/kg de una
   sola vez y sin pruebas.

   Por eso:
     - la base se guarda por producto, aparte de la tarifa;
     - `unknown` es el valor por defecto de todo lo que nadie ha confirmado;
     - con `unknown` el agente **puede decir el precio de la tarifa**, pero no
       puede presentar un subtotal como definitivo.

   Lo único que se da por confirmado son los 90 códigos del catálogo
   anterior, y no por deducción: Chacón lo dijo por escrito ("los precios son
   por kilo, sin IVA"). Queda con `origen: instruccion_cliente`, revisable y
   revertible desde el panel como cualquier otra cosa.
   ============================================================ */

const fs = require('fs');
const path = require('path');

/* Perezoso por el mismo motivo que en `tarifas.js`: capturarlo al cargar
   impediría cambiarlo y recargar. */
const ruta = () => process.env.CHACON_BASE_FACTURACION
  || path.join(__dirname, '..', '..', 'chacon-alcantara', 'data', 'base-facturacion.json');

const BASES = ['kg', 'unit', 'box', 'unknown'];

let _cache = null;

function cargar() {
  if (_cache) return _cache;
  let datos = { productos: {} };
  try {
    datos = JSON.parse(fs.readFileSync(ruta(), 'utf8'));
  } catch {
    console.warn('[chacon] sin base-facturacion.json: todo queda como unknown');
  }
  _cache = datos;
  return _cache;
}

function recargar() { _cache = null; return cargar(); }

/**
 * Base de facturación de un código, con su procedencia.
 * Las correcciones del panel (Redis) pisan el archivo.
 */
function baseDe(codigo, overrides = null) {
  const o = overrides && overrides[String(codigo)];
  if (o && BASES.includes(o.billing_unit)) {
    return { billing_unit: o.billing_unit, approved: !!o.approved,
             origen: o.origen || 'panel', revisado_por: o.revisado_por || null };
  }
  const f = cargar().productos[String(codigo)];
  if (f && BASES.includes(f.billing_unit)) return { ...f };
  return { billing_unit: 'unknown', approved: false, origen: 'sin_confirmar',
           revisado_por: null };
}

/**
 * Importe de una línea, en céntimos, o null si no se puede afirmar.
 *
 * `unknown` no devuelve importe a propósito: es la diferencia entre "no lo
 * sé" y "es cero", y confundirlas factura mal.
 *
 * @param {number} precio_e4   precio de tarifa en diezmilésimas de euro
 * @param {object} m           magnitudes de la línea
 */
function importe(precio_e4, base, { unidades = null, cajas = null, peso_kg = null } = {}) {
  if (precio_e4 === null || precio_e4 === undefined) {
    return { centimos: null, calculable: false, motivo: 'sin_precio' };
  }
  if (base === 'kg') {
    if (!Number.isFinite(peso_kg) || peso_kg <= 0) {
      return { centimos: null, calculable: false, motivo: 'sin_peso_registrado' };
    }
    // El peso es teórico: la advertencia va siempre con el importe.
    return { centimos: Math.round((precio_e4 * peso_kg) / 100), calculable: true,
             base: 'kg', magnitud: peso_kg,
             aviso: 'Importe estimado sobre el peso teórico: se ajustará al peso real preparado.' };
  }
  if (base === 'unit') {
    if (!Number.isFinite(unidades) || unidades <= 0) {
      return { centimos: null, calculable: false, motivo: 'sin_unidades' };
    }
    return { centimos: Math.round((precio_e4 * unidades) / 100), calculable: true,
             base: 'unit', magnitud: unidades };
  }
  if (base === 'box') {
    if (!Number.isFinite(cajas) || cajas <= 0) {
      return { centimos: null, calculable: false, motivo: 'sin_cajas' };
    }
    return { centimos: Math.round((precio_e4 * cajas) / 100), calculable: true,
             base: 'box', magnitud: cajas };
  }
  return {
    centimos: null, calculable: false, motivo: 'base_de_facturacion_sin_confirmar',
    nota: 'Se puede decir el precio de la tarifa, pero no dar un subtotal como definitivo.',
  };
}

/** Lo que hay pendiente de confirmar, para el panel. */
function pendientes() {
  const d = cargar();
  return Object.entries(d.productos || {})
    .filter(([, v]) => v.billing_unit === 'unknown' || !v.approved)
    .map(([codigo, v]) => ({ product_code: codigo, ...v }));
}

function todas() { return cargar().productos || {}; }

module.exports = { BASES, baseDe, importe, pendientes, todas, recargar, ruta };
