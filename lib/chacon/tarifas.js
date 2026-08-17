/* ============================================================
   Repositorio de tarifas versionadas.

   Reglas que sostienen todo lo demás:

   1. **El dinero es entero.** Los precios llegan a cuatro decimales
      (`0,0001 €`) y un float los arruina en la primera suma. Se guardan en
      diezmilésimas de euro: `13,889 €` -> `138890`. Solo se redondea a
      céntimos al calcular el importe final de una línea.

   2. **Solo manda la versión ACTIVA y aprobada.** Importar no cambia nada:
      hasta que alguien aprueba, la versión nueva no existe para el agente.

   3. **Un pedido confirmado guarda su propio precio.** Cambiar de versión no
      puede tocar lo que ya se le dijo a un cliente.

   4. **Las tarifas especiales (ALI, COO, OFC, S) están fuera del flujo
      público.** Se importan, pero no se aplican por parecido, por nombre ni
      por teléfono: solo por una asociación explícita y aprobada.

   5. **El prefijo `OF` de un CÓDIGO no es una oferta.** `OF3900`, `OF6804` y
      `OF6812` son artículos; las ofertas son las tablas `1OF`-`4OF`.
      Confundirlo regalaría producto o cobraría 0,001 € como precio normal.

   Todo esto queda detrás de `CHACON_TARIFAS_V2`. Con la variable apagada el
   agente sigue con el comportamiento anterior, sin enterarse.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const tramos = require('./tramos');

/* El directorio y el interruptor se leen en cada uso, no al cargar el módulo.
   Si se capturaran arriba, cambiarlos y llamar a `recargar()` no serviría de
   nada: es justo lo que hace falta para probar el motor sin activar la versión
   real, y para poder encenderlo en producción sin redeplegar el bundle. */
const dir = () => process.env.CHACON_TARIFAS_DIR
  || path.join(__dirname, '..', '..', 'chacon-alcantara', 'data', 'tarifas');

/** El motor nuevo solo actúa si se enciende a propósito. */
const activo = () => process.env.CHACON_TARIFAS_V2 === '1';

const ESCALA = 10000;
const ESPECIALES = new Set(['ALI', 'COO', 'OFC', 'S']);

let _cache = null;

function cargar() {
  if (_cache) return _cache;
  let estado = { version_activa: null, versiones: [] };
  try {
    estado = JSON.parse(fs.readFileSync(path.join(dir(), 'estado.json'), 'utf8'));
  } catch { /* sin tarifas importadas todavía */ }

  let version = null;
  if (estado.version_activa) {
    try {
      version = JSON.parse(fs.readFileSync(
        path.join(dir(), `version-${estado.version_activa}.json`), 'utf8'));
    } catch (err) {
      console.error('[chacon][tarifas] no se pudo leer la versión activa:', err.message);
    }
  }

  // Índice (codigo, tariff_code) -> fila. Solo lo aprobado y activo.
  const porCodigo = new Map();
  const especiales = new Map();
  if (version && version.approved) {
    for (const f of version.filas || []) {
      if (!f.approved) continue;
      const destino = ESPECIALES.has(f.tariff_code) ? especiales : porCodigo;
      if (destino === porCodigo && !f.active) continue;
      if (!destino.has(f.product_code)) destino.set(f.product_code, {});
      destino.get(f.product_code)[f.tariff_code] = f;
    }
  }
  _cache = { estado, version, porCodigo, especiales };
  return _cache;
}

function recargar() { _cache = null; return cargar(); }

const versionActiva = () => cargar().estado.version_activa || null;
const disponible = () => activo() && !!cargar().version?.approved;

/* ---- dinero ------------------------------------------------------------- */
/** `138890` -> `"13,889"`. Solo para mostrar; nunca para calcular. */
function mostrar(e4) {
  if (e4 === null || e4 === undefined) return null;
  const s = (e4 / ESCALA).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return s.replace('.', ',');
}

/** Céntimos, redondeo al alza en el medio (lo habitual en facturación). */
function aCentimos(e4Total) {
  return Math.round(e4Total / 100);
}

/** `1234` céntimos -> `"12,34"`. */
function centimosMostrar(c) {
  if (c === null || c === undefined) return null;
  return (c / 100).toFixed(2).replace('.', ',');
}

/* ---- consulta de precio ------------------------------------------------- */
/**
 * Precio de un código en un tramo concreto.
 *
 * Devuelve normal y oferta por separado, y cuál se aplica. La oferta gana
 * automáticamente cuando existe fila `OF` activa para ese tramo.
 */
function precioDe(codigo, tier) {
  const { porCodigo, estado } = cargar();
  const filas = porCodigo.get(String(codigo));
  if (!filas) return { encontrado: false, motivo: 'codigo_no_esta_en_la_tarifa_activa' };

  const normal = filas[String(tier)] || null;
  const oferta = filas[`${tier}OF`] || null;
  if (!normal && !oferta) {
    return { encontrado: false, motivo: `sin precio para el tramo ${tier}` };
  }

  const aplicada = oferta || normal;
  return {
    encontrado: true,
    product_code: String(codigo),
    product_name: aplicada.product_name,
    tier: String(tier),
    tier_label: aplicada.tier_label,
    normal_e4: normal ? normal.price_e4 : null,
    oferta_e4: oferta ? oferta.price_e4 : null,
    aplicado_e4: aplicada.price_e4,
    es_oferta: !!oferta,
    tariff_code: aplicada.tariff_code,
    catalog_version: estado.version_activa,
    // El agente no debe añadir esto al carrito sin que Fernando fije reglas.
    promotion_rule_required: aplicada.review_status === 'promotion_rule_required',
    review_status: aplicada.review_status || null,
  };
}

/** Todos los tramos de un código, para "¿y por media caja?". */
function tramosDe(codigo) {
  const out = {};
  for (const t of ['1', '2', '3', '4']) {
    const p = precioDe(codigo, t);
    if (p.encontrado) out[t] = p;
  }
  return out;
}

/**
 * Precio a aplicar dada una cantidad. Une tramo + tarifa en un solo paso,
 * que es como se usa de verdad.
 */
function precioParaCantidad(codigo, { cantidad, unidadPedido, unidadesPorCaja = null }) {
  const tramo = tramos.elegirTramo({ cantidad, unidadPedido, unidadesPorCaja });
  if (!tramo.determinado) {
    return { ok: false, error: 'tramo_indeterminado', tramo,
             pregunta: tramo.falta === 'unidades_por_caja'
               ? 'No tengo registrado cuántas unidades trae la caja de este artículo. '
                 + '¿Lo quieres por cajas o por unidades?'
               : '¿Me lo dices en cajas o en unidades?' };
  }
  const precio = precioDe(codigo, tramo.tier);
  if (!precio.encontrado) return { ok: false, error: precio.motivo, tramo };
  return { ok: true, tramo, precio };
}

/* ---- ofertas ------------------------------------------------------------ */
/**
 * Códigos con oferta en la versión activa. Sin inventar vigencias: una oferta
 * sin fechas vive mientras viva su versión, hasta que una importación nueva
 * la retire o un administrador la desactive.
 */
function ofertasActivas({ tier = null } = {}) {
  const { porCodigo, estado } = cargar();
  const out = [];
  for (const [codigo, filas] of porCodigo) {
    for (const t of ['1', '2', '3', '4']) {
      if (tier && t !== String(tier)) continue;
      const of = filas[`${t}OF`];
      const normal = filas[t];
      if (!of) continue;
      out.push({
        product_code: codigo, product_name: of.product_name,
        tier: t, tier_label: of.tier_label,
        oferta_e4: of.price_e4, normal_e4: normal ? normal.price_e4 : null,
        catalog_version: estado.version_activa,
      });
    }
  }
  return out;
}

/** Los códigos distintos que tienen alguna oferta. */
function codigosConOferta() {
  return [...new Set(ofertasActivas().map((o) => o.product_code))].sort();
}

/* ---- lo que NO entra en el flujo público -------------------------------- */
function tarifasEspeciales() {
  const { especiales } = cargar();
  const out = [];
  for (const [codigo, filas] of especiales) {
    for (const f of Object.values(filas)) {
      out.push({ product_code: codigo, product_name: f.product_name,
                 tariff_code: f.tariff_code, tier_label: f.tier_label,
                 price_e4: f.price_e4, activa_en_flujo_publico: false });
    }
  }
  return out;
}

/** Precios antiguos que el PDF nuevo no respalda. Evidencia, no tarifa. */
function legadoSinCorrespondencia() {
  const { version } = cargar();
  return version?.legado?.precios_antiguos_huerfanos || [];
}

function codigosNuevosPendientesDeRevision() {
  const { version } = cargar();
  return version?.legado?.codigos_nuevos || [];
}

/** Artículos internos o dudosos: se importan, no se publican. */
function articulosInternos() {
  const { version } = cargar();
  const vistos = new Set();
  const out = [];
  for (const f of version?.filas || []) {
    if (f.tariff_code !== '1') continue;
    if (!f.es_articulo_interno && !f.codigo_empieza_por_of) continue;
    if (vistos.has(f.product_code)) continue;
    vistos.add(f.product_code);
    out.push({ product_code: f.product_code, product_name: f.product_name,
               price_display: f.price_display, review_status: f.review_status,
               codigo_empieza_por_of: f.codigo_empieza_por_of });
  }
  return out;
}

function resumen() {
  const { estado, version } = cargar();
  return {
    motor_v2_encendido: activo(),
    version_activa: estado.version_activa,
    versiones: estado.versiones || [],
    aprobada: !!version?.approved,
    aprobada_por: version?.approved_by || null,
    registros: version?.registros || 0,
    invariantes_fallidos: version?.invariantes_fallidos || [],
    resumen_por_tarifa: version?.resumen_por_tarifa || {},
    codigos_con_oferta: version?.codigos_con_oferta || [],
    advertencia_tarifa_4: tramos.ADVERTENCIA_TARIFA_4,
  };
}

/** Todas las versiones, para el panel. */
function versiones() { return cargar().estado.versiones || []; }

function cargarVersion(n) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(), `version-${n}.json`), 'utf8'));
  } catch { return null; }
}

module.exports = {
  activo, ESCALA, dir,
  disponible, versionActiva, recargar, resumen, versiones, cargarVersion,
  precioDe, tramosDe, precioParaCantidad,
  ofertasActivas, codigosConOferta,
  tarifasEspeciales, legadoSinCorrespondencia,
  codigosNuevosPendientesDeRevision, articulosInternos,
  mostrar, aCentimos, centimosMostrar,
};
