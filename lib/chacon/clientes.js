/* ============================================================
   CustomerResolver: encontrar un negocio en la agenda de Chacón.

   **Nada que ver con el buscador de productos.** Índice distinto, ranking
   distinto, datos distintos. Compartirlos fue el bug que ya vimos en
   producción: "tony tienda" acabó buscándose en el catálogo. Aquí solo se
   miran razones sociales, nombres comerciales, alias y códigos de cliente.

   Solo puede devolver clientes que EXISTEN en la agenda aprobada. Ni el
   modelo ni este módulo pueden fabricar un `customer_code`: si un negocio no
   está en el fichero, no es cliente de Chacón, y decir lo contrario sería
   dejar pedir a quien no tiene cuenta.

   Cómo se decide, de más fiable a menos:

     exacto_normalizado   una sola coincidencia tras quitar tildes,
                          puntuación y el sufijo societario -> se confirma
     alta_confianza       una destaca claramente sobre la segunda -> se confirma
     varios               2-3 candidatos -> se pregunta cuál
     baja_confianza       nada suficientemente parecido -> reintentar o Fernando

   Un parecido flojo NUNCA vincula. Meter el pedido de una tienda en la
   cuenta de otra es peor que preguntar otra vez.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const DIR = () => process.env.CHACON_AGENDA_DIR
  || path.join(__dirname, '..', '..', 'chacon-alcantara', 'data', 'clientes');

/* Sufijos societarios: se ignoran al comparar, pero el nombre oficial se
   guarda y se enseña tal cual viene de la agenda. */
const SUFIJOS = [
  's l u', 's l l', 's coop and', 's coop', 's c a', 's a u',
  'sociedad limitada', 'sociedad anonima',
  's l', 's a', 'c b', 's c', 'scp', 'sl', 'sa', 'cb',
];

/* Palabras tan comunes en el gremio que por sí solas no identifican a nadie:
   "carnicería" casa con doce clientes. Cuentan menos al puntuar. */
const GENERICAS = new Set([
  'carniceria', 'supermercado', 'supermercados', 'autoservicio', 'alimentacion',
  'comercial', 'distribuciones', 'distribucion', 'hermanos', 'hnos', 'grupo',
  'super', 'market', 'tienda', 'ultramarinos', 'charcuteria', 'fruteria',
]);

const sinTildes = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Forma canónica para comparar. El dato oficial no se toca nunca. */
function normalizar(nombre) {
  return sinTildes(nombre).toLowerCase()
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Quita el sufijo societario del final: "el chino s l" -> "el chino". */
function sinSufijo(normalizado) {
  let s = normalizado;
  let cambiado = true;
  while (cambiado) {
    cambiado = false;
    for (const suf of SUFIJOS) {
      if (s.endsWith(` ${suf}`)) { s = s.slice(0, -(suf.length + 1)).trim(); cambiado = true; break; }
    }
  }
  return s;
}

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
  } catch { /* sin agenda importada todavía */ }

  const clientes = (version && version.approved ? version.clientes : []) || [];
  const porCodigo = new Map(clientes.map((c) => [String(c.customer_code), c]));
  _cache = { estado, version, clientes, porCodigo };
  return _cache;
}

function recargar() { _cache = null; return cargar(); }

const disponible = () => !!cargar().version?.approved;
const versionActiva = () => cargar().estado.version_activa || null;
const todos = () => cargar().clientes;
const porCodigo = (codigo) => cargar().porCodigo.get(String(codigo)) || null;

/* ---- parecido ----------------------------------------------------------- */
function distancia(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const fila = [i];
    let mejor = i;
    for (let j = 1; j <= b.length; j += 1) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      fila[j] = Math.min(prev[j] + 1, fila[j - 1] + 1, prev[j - 1] + c);
      mejor = Math.min(mejor, fila[j]);
    }
    if (mejor > max) return max + 1;
    prev = fila;
  }
  return prev[b.length];
}

/** Todos los textos con los que se puede llamar a un cliente. */
function formasDe(c) {
  const formas = new Set([
    normalizar(c.legal_name),
    sinSufijo(normalizar(c.legal_name)),
  ]);
  if (c.display_name && c.display_name !== c.legal_name) {
    formas.add(normalizar(c.display_name));
    formas.add(sinSufijo(normalizar(c.display_name)));
  }
  for (const a of c.aliases || []) {
    formas.add(normalizar(a));
    formas.add(sinSufijo(normalizar(a)));
  }
  /* Las razones sociales de persona vienen "APELLIDO APELLIDO, NOMBRE".
     La gente se presenta al revés, así que se indexa también volteado. */
  const partes = String(c.legal_name || '').split(',');
  if (partes.length === 2) {
    formas.add(normalizar(`${partes[1]} ${partes[0]}`));
  }
  formas.delete('');
  return [...formas];
}

function puntuar(c, q, qSin) {
  const formas = formasDe(c);
  let mejor = 0;

  for (const f of formas) {
    if (f === q || f === qSin) return 100;                 // exacto
    const fSin = sinSufijo(f);
    if (fSin === q || fSin === qSin) return 98;            // exacto sin sufijo
  }
  for (const f of formas) {
    const fSin = sinSufijo(f);
    // Contención: "el chino" dentro de "carniceria el chino".
    if (qSin.length >= 4 && (fSin.includes(qSin) || qSin.includes(fSin))) {
      const largo = Math.max(fSin.length, qSin.length) || 1;
      const ratio = Math.min(fSin.length, qSin.length) / largo;
      mejor = Math.max(mejor, 60 + Math.round(ratio * 30));
    }
    // Palabras compartidas, descontando las genéricas del gremio.
    const pf = new Set(fSin.split(' ').filter(Boolean));
    const pq = qSin.split(' ').filter(Boolean);
    if (pq.length) {
      let peso = 0; let total = 0;
      for (const w of pq) {
        const v = GENERICAS.has(w) ? 0.25 : 1;
        total += v;
        if (pf.has(w)) peso += v;
      }
      if (total > 0) mejor = Math.max(mejor, Math.round((peso / total) * 85));
    }
    // Erratas razonables sobre el conjunto.
    const max = qSin.length <= 8 ? 1 : 2;
    if (distancia(qSin, fSin, max) <= max) mejor = Math.max(mejor, 90);
  }
  return mejor;
}

/* ---- API ---------------------------------------------------------------- */
/**
 * Busca un negocio. Devuelve siempre uno de estos, y nunca un cliente que no
 * esté en la agenda:
 *
 *   { tipo:'exacto',  cliente }            una sola coincidencia clara
 *   { tipo:'probable', cliente, otros }    una destaca: se confirma igual
 *   { tipo:'varios',   candidatos }        hay que preguntar
 *   { tipo:'nada' }                        no está: reintentar o Fernando
 */
function buscar(texto, { maximo = 3 } = {}) {
  const bruto = String(texto || '').trim();
  if (!bruto || !disponible()) return { tipo: 'nada', motivo: !disponible() ? 'sin_agenda' : 'vacio' };

  // Código de cliente, para quien lo conozca. No se le exige a nadie.
  const porCod = porCodigo(bruto);
  if (porCod) return { tipo: 'exacto', por: 'codigo', cliente: porCod };

  const q = normalizar(bruto);
  const qSin = sinSufijo(q);
  if (!qSin || qSin.length < 3) return { tipo: 'nada', motivo: 'consulta_muy_corta' };

  const puntuados = todos()
    .map((c) => ({ c, score: puntuar(c, q, qSin) }))
    .filter((x) => x.score >= 55)
    .sort((a, b) => b.score - a.score);

  if (!puntuados.length) return { tipo: 'nada', motivo: 'sin_coincidencias' };

  const primero = puntuados[0];
  const segundo = puntuados[1];

  // Coincidencia exacta y única: se propone para confirmar.
  if (primero.score >= 98 && (!segundo || segundo.score < 98)) {
    return { tipo: 'exacto', por: 'nombre', cliente: primero.c, score: primero.score };
  }
  // Una destaca claramente: se propone, pero se confirma igual.
  if (primero.score >= 80 && (!segundo || primero.score - segundo.score >= 15)) {
    return { tipo: 'probable', cliente: primero.c, score: primero.score,
             otros: puntuados.slice(1, maximo).map((x) => x.c) };
  }
  return { tipo: 'varios', candidatos: puntuados.slice(0, maximo).map((x) => x.c),
           scores: puntuados.slice(0, maximo).map((x) => x.score) };
}

/**
 * Qué centro aplica a un cliente.
 *
 * Con varios centros NO se elige por orden de aparición: son códigos internos
 * que el cliente probablemente ni conoce, así que se deja sin resolver y lo
 * decide Fernando cuando haga falta.
 */
function centroDe(cliente, { preferido = null } = {}) {
  const centros = (cliente.centers || []).filter((x) => x !== null && x !== undefined);
  if (preferido && centros.includes(preferido)) {
    return { center: preferido, estado: 'confirmado' };
  }
  if (!centros.length) return { center: null, estado: 'sin_centro' };
  if (centros.length === 1) return { center: centros[0], estado: 'unico' };
  return { center: null, estado: 'sin_resolver', opciones: centros };
}

function resumen() {
  const { estado, version } = cargar();
  return {
    version_activa: estado.version_activa,
    aprobada: !!version?.approved,
    aprobada_por: version?.approved_by || null,
    source_file: version?.source_file || null,
    ...(version?.resumen || {}),
    versiones: estado.versiones || [],
  };
}

module.exports = {
  buscar, porCodigo, centroDe, todos, disponible, versionActiva, resumen,
  recargar, normalizar, sinSufijo, formasDe, DIR, SUFIJOS, GENERICAS,
};
