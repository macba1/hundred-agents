/* ============================================================
   Catálogo versionado y búsqueda determinista de Chacón.

   La IA puede proponer una búsqueda en lenguaje natural, pero lo que entra
   al carrito es SIEMPRE un `producto_id` real de esta tabla. Ese es el
   límite que impide que se inventen artículos.

   Importar una versión nueva no sobrescribe: crea versión, se diffea y se
   aprueba desde el panel.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const DIR_DATOS = path.join(__dirname, '..', '..', 'chacon-alcantara', 'data');
const ARCHIVO = process.env.CHACON_CATALOGO || path.join(DIR_DATOS, 'catalogo-normalizado.json');

let _cache = null;

function cargar() {
  if (_cache) return _cache;
  const raw = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
  const productos = raw.productos.map((p) => ({ ...p }));
  const porId = new Map(productos.map((p) => [p.id, p]));
  const porCodigo = new Map();
  for (const p of productos) {
    if (!porCodigo.has(p.codigo)) porCodigo.set(p.codigo, []);
    porCodigo.get(p.codigo).push(p);
  }
  const porEan = new Map();
  for (const p of productos) if (p.cod_barras) porEan.set(p.cod_barras, p);

  _cache = { version: raw.version, productos, porId, porCodigo, porEan };
  return _cache;
}

/* ---- normalización y búsqueda difusa ---------------------------------- */
function norm(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ ]+/g, ' ')
    .split(/\s+/).filter(Boolean).join(' ');
}

function distancia(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const fila = [i]; let mejor = i;
    for (let j = 1; j <= b.length; j += 1) {
      fila[j] = Math.min(prev[j] + 1, fila[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (fila[j] < mejor) mejor = fila[j];
    }
    if (mejor > max) return max + 1;
    prev = fila;
  }
  return prev[b.length];
}

/**
 * Busca por código, EAN, nombre, marca o texto aproximado.
 * Devuelve candidatos; **no elige**. La elección la hace el cliente.
 */
function buscar(consulta, { limite = 8 } = {}) {
  const cat = cargar();
  const q = String(consulta || '').trim();
  if (!q) return { candidatos: [], total: 0, tipo: 'vacia' };

  // 1) código exacto (texto, respeta ceros iniciales)
  if (cat.porCodigo.has(q)) {
    const g = cat.porCodigo.get(q);
    return { candidatos: g.slice(0, limite), total: g.length, tipo: 'codigo_exacto' };
  }
  // 2) código de barras exacto
  if (cat.porEan.has(q)) {
    return { candidatos: [cat.porEan.get(q)], total: 1, tipo: 'ean_exacto' };
  }
  // 3) código parcial: "52" debe encontrar "0052"
  const soloDigitos = q.replace(/\D/g, '');
  if (soloDigitos && soloDigitos.length >= 2 && soloDigitos.length === q.length) {
    const parcial = cat.productos.filter((p) => p.codigo.replace(/^0+/, '') === soloDigitos.replace(/^0+/, ''));
    if (parcial.length) return { candidatos: parcial.slice(0, limite), total: parcial.length, tipo: 'codigo_parcial' };
  }

  // 4) texto: AND de tokens sobre descripción normalizada + marca
  const tokens = norm(q).split(' ').filter(Boolean);
  const hay = (p) => `${p.descripcion_normalizada} ${norm(p.marca)}`;
  let hits = cat.productos.filter((p) => tokens.every((t) => hay(p).includes(t)));
  if (!hits.length) hits = cat.productos.filter((p) => tokens.some((t) => hay(p).includes(t)));

  // 5) difusa: "chorico" -> "chorizo"
  let tipo = hits.length ? 'texto' : 'aproximada';
  if (!hits.length) {
    const vocab = new Map();
    for (const p of cat.productos) {
      for (const w of hay(p).split(' ')) {
        if (w.length < 4) continue;
        if (!vocab.has(w)) vocab.set(w, new Set());
        vocab.get(w).add(p);
      }
    }
    const encontrados = new Map();
    for (const t of tokens) {
      const max = t.length <= 5 ? 1 : 2;
      for (const [w, prods] of vocab) {
        const d = distancia(t, w, max);
        if (d <= max) for (const p of prods) encontrados.set(p, Math.min(encontrados.get(p) ?? 9, d));
      }
    }
    hits = [...encontrados.entries()].sort((a, b) => a[1] - b[1]).map(([p]) => p);
  }

  // relevancia: coincidencia en descripción antes que en marca
  hits.sort((a, b) => {
    const ca = tokens.filter((t) => a.descripcion_normalizada.includes(t)).length;
    const cb = tokens.filter((t) => b.descripcion_normalizada.includes(t)).length;
    return cb - ca;
  });
  return { candidatos: hits.slice(0, limite), total: hits.length, tipo };
}

/** Vista de un producto para enseñar al cliente. Nunca afirma disponibilidad. */
function paraMostrar(p) {
  return {
    producto_id: p.id,
    codigo: p.codigo,
    descripcion: p.descripcion,
    marca: p.marca,
    und_caja: p.und_caja,
    peso_und_kg: p.peso_und_kg,
    // El precio solo se muestra si se puede usar. Si está bloqueado, se dice.
    precio_kg_sin_iva: p.bloqueado_para_calculo_precio ? null : p.tarifa,
    precio_bloqueado: !!p.bloqueado_para_calculo_precio,
    motivo_precio_bloqueado: p.bloqueado_para_calculo_precio
      ? (p.estado === 'promotion_requires_validation'
        ? 'Artículo promocional: sus condiciones las define Chacón Alcántara.'
        : 'Este artículo tiene varios precios en el catálogo y su tarifa está por confirmar.')
      : null,
    gluten: p.gluten,       // true / false / null  — null es "no sabemos"
    lactosa: p.lactosa,
    observaciones: p.observaciones,
    // Stock: no hay fuente. Nunca se afirma disponibilidad.
    disponibilidad: 'pendiente_de_revision',
  };
}

/** Texto para responder sobre alérgenos. Nunca infiere por tipo de producto. */
function textoAlergeno(p, cual) {
  const v = p[cual];
  if (v === true) return `Sí, contiene ${cual}.`;
  if (v === false) return `Según el catálogo, no contiene ${cual}.`;
  return `No tenemos registrada esa información para este producto. Chacón Alcántara deberá confirmarla.`;
}

function version() { return cargar().version; }
function porId(id) { return cargar().porId.get(id) || null; }
function todos() { return cargar().productos; }
function recargar() { _cache = null; return cargar(); }

module.exports = { cargar, recargar, buscar, paraMostrar, textoAlergeno, version, porId, todos, norm };
