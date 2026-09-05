/* ============================================================
   Fichas técnicas de producto.

   Chacón entrega los documentos del fabricante en PDF. Hay dos formas muy
   distintas de usarlos, y aquí no se mezclan nunca:

   **Enviar el PDF.** Siempre correcto. Es el documento oficial del
   fabricante, íntegro y con su membrete. No depende de que hayamos sabido
   leerlo, así que funciona para las cincuenta fichas, escaneadas incluidas.

   **Afirmar un dato suelto** —"lleva soja", "se conserva a 4º"— exige que
   una persona de Chacón lo haya validado. La extracción automática acierta
   en muchas y se equivoca en otras: los PDF vienen de veinte fabricantes con
   veinte maquetaciones, y un pie de página o una tabla contigua se cuelan
   con facilidad. Un texto capturado del sitio equivocado no parece un error,
   parece un dato, y en alérgenos eso es lo peor que puede pasar.

   Por eso el estado por defecto de todo campo extraído es **`propuesto`**, y
   propuesto no se le enseña a nadie. El agente responde con lo validado o
   dice que no lo tiene y manda el PDF. Las dos respuestas son correctas;
   inventar no lo es.

   El texto validado sigue siendo el LITERAL del documento. Ni el modelo ni
   este módulo lo reescriben, lo resumen ni lo traducen.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const repo = require('./repo');

const DIR = () => process.env.CHACON_FICHAS_DIR
  || path.join(__dirname, '..', '..', 'chacon-alcantara', 'data', 'fichas');

const PDFS = () => process.env.CHACON_FICHAS_PDF_DIR
  || path.join(__dirname, '..', '..', 'chacon-alcantara', 'fuentes', 'fichas');

/** Campos que puede tener una ficha, con el título que ve la tienda. */
const CAMPOS = {
  denominacion: 'Denominación',
  ingredientes: 'Ingredientes',
  alergenos: 'Alérgenos',
  conservacion: 'Conservación',
  presentacion: 'Presentación',
  modo_empleo: 'Modo de empleo',
};

const ESTADOS = {
  PROPUESTO: 'propuesto',     // extraído del PDF, NO se enseña
  VALIDADO: 'validado',       // una persona lo ha comprobado: se puede enseñar
  RECHAZADO: 'rechazado',     // mal extraído: no se enseña ni se vuelve a proponer
};

let _cache = null;

function cargar() {
  if (_cache) return _cache;
  let estado = { version_activa: null, versiones: [] };
  let version = null;
  try {
    estado = JSON.parse(fs.readFileSync(path.join(DIR(), 'estado.json'), 'utf8'));
    if (estado.version_activa) {
      version = JSON.parse(fs.readFileSync(
        path.join(DIR(), `version-${estado.version_activa}.json`), 'utf8'));
    }
  } catch { /* sin fichas importadas todavía */ }

  const fichas = (version && version.approved ? version.fichas : []) || [];
  const porCodigo = new Map();
  for (const f of fichas) porCodigo.set(String(f.product_code), f);
  _cache = { estado, version, fichas, porCodigo };
  return _cache;
}

function recargar() { _cache = null; return cargar(); }

const disponible = () => !!cargar().version?.approved;
const versionActiva = () => cargar().estado.version_activa || null;
const todas = () => cargar().fichas;

/** Los códigos vienen sin ceros de relleno: `0053` y `53` son el mismo. */
const normalizarCodigo = (c) => String(c == null ? '' : c).trim().replace(/^0+/, '') || '0';

function porCodigo(codigo) {
  return cargar().porCodigo.get(normalizarCodigo(codigo)) || null;
}

/** ¿Hay documento que enviar? Vale igual aunque no hayamos sabido leerlo. */
function tienePdf(codigo) {
  const f = porCodigo(codigo);
  if (!f) return false;
  return fs.existsSync(path.join(PDFS(), f.archivo));
}

function rutaPdf(codigo) {
  const f = porCodigo(codigo);
  if (!f) return null;
  const p = path.join(PDFS(), f.archivo);
  return fs.existsSync(p) ? p : null;
}

/* ---- validación humana --------------------------------------------------- */
/**
 * Lo que Chacón ha decidido sobre cada campo de una ficha.
 * Vive en Redis, no en el fichero: el fichero es la fuente, esto es la
 * revisión, y reimportar no puede borrar el trabajo de revisión.
 */
async function revision(codigo) {
  return (await repo.getRevisionFicha(normalizarCodigo(codigo))) || {};
}

/**
 * Campos que SÍ se pueden decir por escrito.
 *
 * Solo lo validado. Un campo propuesto y sin revisar no sale de aquí, por
 * mucho que el texto tenga buena pinta: nadie lo ha comprobado contra el
 * documento.
 */
async function camposVisibles(codigo) {
  const f = porCodigo(codigo);
  if (!f) return {};
  const rev = await revision(codigo);
  const out = {};
  for (const [campo, texto] of Object.entries(f.campos || {})) {
    const r = rev[campo];
    if (r && r.estado === ESTADOS.VALIDADO) {
      // Se enseña el texto corregido si lo hubo, y si no el del PDF.
      out[campo] = { texto: r.texto || texto, validado_por: r.por, validado_en: r.ts };
    }
  }
  // Un campo puede haberse añadido a mano aunque la extracción no lo pillara.
  for (const [campo, r] of Object.entries(rev)) {
    if (!out[campo] && r && r.estado === ESTADOS.VALIDADO && r.texto) {
      out[campo] = { texto: r.texto, validado_por: r.por, validado_en: r.ts };
    }
  }
  return out;
}

/**
 * Qué contestar sobre un campo concreto.
 *
 * Devuelve siempre uno de estos, y el agente debe usarlo **tal cual**:
 *   { hay: true,  texto, campo, ... }   texto literal del documento
 *   { hay: false, motivo, pdf }         no se afirma nada; se ofrece el PDF
 */
async function consultar(codigo, campo) {
  const cod = normalizarCodigo(codigo);
  const f = porCodigo(cod);
  const pdf = tienePdf(cod);

  if (!f) return { hay: false, motivo: 'sin_ficha', pdf: false, codigo: cod };

  const visibles = await camposVisibles(cod);
  const v = visibles[campo];
  if (v) {
    return { hay: true, campo, etiqueta: CAMPOS[campo] || campo, texto: v.texto,
             archivo: f.archivo, pdf, codigo: cod };
  }

  /* Sin capa de texto no se afirma NADA del contenido: es un escaneo y no
     hemos leído una sola palabra de él con garantías. */
  if (f.sin_capa_texto) {
    return { hay: false, motivo: 'ficha_escaneada', pdf, archivo: f.archivo, codigo: cod };
  }
  const propuesto = (f.campos || {})[campo];
  return { hay: false, motivo: propuesto ? 'pendiente_de_validar' : 'campo_ausente',
           pdf, archivo: f.archivo, codigo: cod };
}

/**
 * Frase exacta para cuando no hay dato. La escribe este módulo y no el
 * modelo, porque es justo donde un modelo tendería a rellenar el hueco.
 */
function textoSinDato(r, { nombreProducto = null } = {}) {
  const de = nombreProducto ? ` de ${nombreProducto}` : '';
  if (r.motivo === 'sin_ficha') {
    return `No tenemos ficha técnica${de}. Chacón Alcántara puede facilitártela.`;
  }
  if (r.pdf) {
    return `No tengo ese dato por escrito${de}, así que no te lo voy a suponer. `
      + 'Te envío la ficha técnica del fabricante para que lo veas en el documento.';
  }
  return `No tengo ese dato${de} y prefiero no suponerlo. Chacón Alcántara te lo confirma.`;
}

/**
 * URL pública del PDF. Sin base configurada NO se devuelve enlace: WhatsApp
 * descarga el documento por HTTP y una ruta de disco no le sirve. Prometer un
 * adjunto que no llega es peor que decir que no lo tenemos.
 */
const BASE = () => (process.env.CHACON_IMAGENES_BASE_URL || '').replace(/\/+$/, '');

function urlPdf(codigo) {
  const base = BASE();
  if (!base || !tienePdf(codigo)) return null;
  return `${base}/api/chacon/ficha?p=${encodeURIComponent(normalizarCodigo(codigo))}`;
}

/** Resumen para el panel. */
async function resumen() {
  const { estado, version } = cargar();
  const fichas = todas();
  let validados = 0;
  let propuestos = 0;
  for (const f of fichas) {
    const rev = await revision(f.product_code);
    for (const campo of Object.keys(f.campos || {})) {
      if (rev[campo]?.estado === ESTADOS.VALIDADO) validados += 1;
      else if (rev[campo]?.estado !== ESTADOS.RECHAZADO) propuestos += 1;
    }
  }
  return {
    version_activa: estado.version_activa,
    aprobada: !!version?.approved,
    aprobada_por: version?.approved_by || null,
    ...(version?.resumen || {}),
    campos_validados: validados,
    campos_pendientes: propuestos,
    versiones: estado.versiones || [],
  };
}

module.exports = {
  CAMPOS, ESTADOS, DIR, PDFS, normalizarCodigo,
  disponible, versionActiva, todas, porCodigo, tienePdf, rutaPdf, urlPdf,
  revision, camposVisibles, consultar, textoSinDato, resumen, recargar,
};
