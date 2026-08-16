/* ============================================================
   Navegación del catálogo por familias.

   La clasificación NO la decide el modelo en cada conversación: viene de
   `data/clasificacion-productos.json`, que se genera una vez, se revisa y se
   corrige desde el panel. Si la decidiera el modelo, dos tiendas verían
   catálogos distintos el mismo día y nadie podría arreglar un error.

   Un producto `pending_review` se muestra en "Otros productos", nunca en la
   familia que la regla insinuó. Es preferible que una tienda encuentre algo
   en Otros a que busque quesos y le salga un membrillo.

   Las páginas son de 4-5 productos. Mandar 30 fichas de golpe satura la
   conversación y en WhatsApp no hay forma de recuperarse de eso.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const catalogo = require('./catalogo');
const ofertas = require('./ofertas');
const precios = require('./precios');

const RUTA = process.env.CHACON_CLASIFICACION
  || path.join(__dirname, '..', '..', 'chacon-alcantara', 'data', 'clasificacion-productos.json');

const POR_PAGINA = Number(process.env.CHACON_PRODUCTOS_POR_PAGINA || 5);

/** Etiquetas que una tienda puede pedir por su nombre. */
const ETIQUETAS = {
  pollo: ['pollo', 'de pollo', 'ave'],
  pavo: ['pavo', 'de pavo'],
  iberico: ['iberico', 'ibericos', 'bellota', 'cebo'],
  cerdo: ['cerdo', 'de cerdo'],
  queso: ['queso', 'quesos'],
  pescado: ['pescado', 'pescados'],
  picante: ['picante', 'picantes'],
  congelado: ['congelado', 'congelados'],
  sin_lactosa: ['sin lactosa', 'sinlactosa'],
  oferta: ['oferta', 'ofertas', 'promocion', 'promociones'],
};

const norm = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Plural español: chorizo/chorizos, salchichon/salchichones. */
const plural = (base) => new RegExp(`\\b${base}(es|s)?\\b`);

let _cache = null;

function cargar() {
  if (_cache) return _cache;
  let datos = { categorias: [], productos: [] };
  try {
    datos = JSON.parse(fs.readFileSync(RUTA, 'utf8'));
  } catch (err) {
    console.error('[chacon] sin clasificación (%s): la navegación por familias no funcionará',
      err.code || err.message);
  }
  const porProducto = new Map();
  for (const p of datos.productos || []) {
    porProducto.set(p.producto_id, {
      ...p,
      tags: String(p.tags || '').split('|').filter(Boolean),
      // Lo dudoso vive en Otros hasta que una persona lo confirme.
      categoria_efectiva: p.classification_status === 'auto_confirmado'
        ? p.primary_category : 'otros',
    });
  }
  _cache = { datos, porProducto };
  return _cache;
}

function recargar() { _cache = null; return cargar(); }

/**
 * Mezcla las correcciones que una persona hizo desde el panel sobre la
 * propuesta automática. Una familia revisada a mano queda `confirmada` y ya
 * no se muestra en "Otros".
 *
 * Se llama antes de navegar. Es barato: el conjunto de correcciones es
 * pequeño y Redis está al lado.
 */
async function aplicarCorrecciones(repo) {
  const { porProducto } = cargar();
  let n = 0;
  for (const c of await repo.listarClasificaciones()) {
    const base = porProducto.get(c.producto_id);
    if (!base) continue;
    porProducto.set(c.producto_id, {
      ...base,
      primary_category: c.primary_category ?? base.primary_category,
      subcategory: c.subcategory ?? base.subcategory,
      tags: Array.isArray(c.tags) ? c.tags : base.tags,
      display_order: c.display_order ?? base.display_order,
      classification_status: 'revisado_por_persona',
      classification_reviewed_by: c.revisado_por || null,
      categoria_efectiva: c.primary_category ?? base.primary_category,
    });
    n += 1;
  }
  return n;
}

function categorias() {
  return (cargar().datos.categorias || []).slice()
    .sort((a, b) => a.display_order - b.display_order);
}

function clasificacionDe(productoId) {
  return cargar().porProducto.get(productoId) || null;
}

/** Productos activos de una familia, en su orden de presentación. */
function productosDe(clave) {
  const { porProducto } = cargar();
  const out = [];
  const vistos = new Set();
  for (const p of catalogo.todos()) {
    if (p.activo === false) continue;
    const c = porProducto.get(p.id);
    if (!c || c.categoria_efectiva !== clave) continue;
    // Los 19 códigos repetidos son el mismo artículo dos veces: en la
    // navegación se enseña una sola vez, aunque se pueda pedir igual.
    if (vistos.has(p.codigo)) continue;
    vistos.add(p.codigo);
    out.push({ producto: p, clasificacion: c });
  }
  return out.sort((a, b) => a.clasificacion.display_order - b.clasificacion.display_order);
}

/** Productos que llevan una etiqueta concreta. */
function productosConEtiqueta(tag) {
  const { porProducto } = cargar();
  const out = [];
  const vistos = new Set();
  for (const p of catalogo.todos()) {
    if (p.activo === false) continue;
    const c = porProducto.get(p.id);
    if (!c || !c.tags.includes(tag)) continue;
    if (vistos.has(p.codigo)) continue;
    vistos.add(p.codigo);
    out.push({ producto: p, clasificacion: c });
  }
  return out;
}

/**
 * Interpreta lo que ha pedido la tienda: una familia, una etiqueta o una
 * subcategoría. Devuelve qué ha entendido y si es una sugerencia.
 *
 * "Algo para desayunos" no es una categoría: se propone panadería, pero se
 * marca como sugerencia para que el agente lo diga y no lo afirme.
 */
function subcategorias() {
  return [...new Set([...cargar().porProducto.values()]
    .map((c) => c.subcategory).filter(Boolean))];
}

function interpretar(consulta) {
  const q = norm(consulta);
  if (!q) return { tipo: 'ninguno' };

  // 1. Nombre o alias exacto de familia. "quesos" es la familia entera.
  for (const c of categorias()) {
    if (norm(c.nombre) === q || (c.aliases || []).some((a) => norm(a) === q)) {
      return { tipo: 'categoria', clave: c.clave, nombre: c.nombre, sugerencia: false };
    }
  }
  // 2. Etiqueta exacta.
  for (const [tag, palabras] of Object.entries(ETIQUETAS)) {
    if (palabras.some((p) => q === norm(p))) {
      return { tipo: 'etiqueta', clave: tag, nombre: tag.replace('_', ' '), sugerencia: false };
    }
  }
  // 3. Subcategoría exacta: "chorizos" filtra chorizo, no abre los 30
  //    embutidos. Quien pide chorizos no quiere ver salchichones.
  for (const sub of subcategorias()) {
    if (plural(norm(sub)).test(q.trim()) && q.split(' ').length <= 2) {
      return { tipo: 'subcategoria', clave: sub, nombre: sub.replace(/_/g, ' '), sugerencia: false };
    }
  }
  // 4. Alias de familia contenido en la frase ("enséñame los quesos").
  for (const c of categorias()) {
    for (const a of c.aliases || []) {
      const na = norm(a);
      if (na.length >= 4 && new RegExp(`\\b${na}`).test(q)) {
        return { tipo: 'categoria', clave: c.clave, nombre: c.nombre, sugerencia: false, por: a };
      }
    }
  }
  // 5. Subcategoría dentro de una frase ("ponme dos chorizos de los buenos").
  for (const sub of subcategorias()) {
    if (plural(norm(sub)).test(q)) {
      return { tipo: 'subcategoria', clave: sub, nombre: sub.replace(/_/g, ' '), sugerencia: false };
    }
  }
  // 6. Etiqueta contenida en la frase ("¿qué tienes de pollo?").
  for (const [tag, palabras] of Object.entries(ETIQUETAS)) {
    for (const p of palabras) {
      const np = norm(p);
      if (np.length >= 4 && new RegExp(`\\b${np}`).test(q)) {
        return { tipo: 'etiqueta', clave: tag, nombre: tag.replace('_', ' '), sugerencia: false, por: p };
      }
    }
  }
  // 7. Conceptos blandos. Se proponen, no se afirman: "algo para desayunar"
  //    no es una familia del catálogo, es una interpretación nuestra.
  const BLANDOS = [
    [/desayun|merend|merienda/, 'panaderia'],
    [/aperitiv|picoteo|tapa/, 'embutidos_curados'],
    [/barato|economic|precio bajo/, '__mas_barato__'],
  ];
  for (const [re, destino] of BLANDOS) {
    if (re.test(q)) {
      if (destino === '__mas_barato__') return { tipo: 'mas_barato', sugerencia: true };
      const c = categorias().find((x) => x.clave === destino);
      return { tipo: 'categoria', clave: destino, nombre: c ? c.nombre : destino, sugerencia: true };
    }
  }
  return { tipo: 'ninguno' };
}

function productosDeSubcategoria(sub) {
  const { porProducto } = cargar();
  const out = [];
  const vistos = new Set();
  for (const p of catalogo.todos()) {
    if (p.activo === false) continue;
    const c = porProducto.get(p.id);
    if (!c || c.subcategory !== sub) continue;
    if (vistos.has(p.codigo)) continue;
    vistos.add(p.codigo);
    out.push({ producto: p, clasificacion: c });
  }
  return out;
}

/**
 * Productos más baratos, por precio VALIDADO de Tarifa 1.
 * Un artículo con el precio sin resolver no entra: no se puede ordenar por
 * una cifra que no se puede afirmar. Y barato no es oferta.
 */
async function masBaratos(limite = POR_PAGINA) {
  const vistos = new Set();
  const conPrecio = [];
  for (const p of catalogo.todos()) {
    if (p.activo === false || vistos.has(p.codigo)) continue;
    vistos.add(p.codigo);
    const v = await ofertas.precioVigente(p);
    if (v.precio_kg === null) continue;
    conPrecio.push({ producto: p, clasificacion: clasificacionDe(p.id), precio_kg: v.precio_kg,
                     es_oferta: !!v.es_oferta });
  }
  conPrecio.sort((a, b) => a.precio_kg - b.precio_kg);
  return conPrecio.slice(0, limite);
}

/** Trocea en páginas de 4-5. Nunca se manda el catálogo entero de golpe. */
function pagina(lista, offset = 0, tam = POR_PAGINA) {
  const items = lista.slice(offset, offset + tam);
  return {
    items,
    offset,
    mostrados: items.length,
    total: lista.length,
    hay_mas: offset + items.length < lista.length,
    siguiente_offset: offset + items.length,
  };
}

const eur = (n) => (n === null || n === undefined ? null : String(n).replace('.', ','));

/**
 * Ficha de un producto tal y como se le enseña a la tienda.
 * El precio sale de `precioVigente`, nunca del catálogo directamente: puede
 * haber una oferta validada o un precio resuelto a mano.
 */
async function fichaDe({ producto, clasificacion }) {
  const v = await ofertas.precioVigente(producto);
  const L = [`[${producto.codigo}] ${producto.descripcion}`];

  if (v.precio_kg === null) {
    L.push('Precio pendiente de que Chacón Alcántara lo confirme.');
  } else if (v.es_oferta) {
    L.push(`Precio de OFERTA: ${eur(v.precio_kg)} €/kg, sin IVA`);
  } else {
    L.push(`Precio Tarifa 1: ${eur(v.precio_kg)} €/kg, sin IVA`);
  }

  if (Number.isFinite(producto.und_caja) && producto.und_caja > 0) {
    L.push(`Caja: ${producto.und_caja} ${producto.und_caja === 1 ? 'unidad' : 'unidades'}`);
  }
  if (Number.isFinite(producto.peso_und_kg) && producto.peso_und_kg > 0) {
    L.push(`Peso aproximado: ${eur(producto.peso_und_kg)} kg`);
  }
  L.push('');
  L.push('Puedes pedirlo por cajas o unidades.');

  return {
    producto_id: producto.id,
    codigo: producto.codigo,
    descripcion: producto.descripcion,
    marca: producto.marca || null,
    und_caja: producto.und_caja ?? null,
    peso_und_kg: producto.peso_und_kg ?? null,
    precio_kg_sin_iva: v.precio_kg,
    es_oferta: !!v.es_oferta,
    precio_pendiente_de_confirmacion: v.precio_kg === null,
    categoria: clasificacion ? clasificacion.categoria_efectiva : 'otros',
    subcategoria: clasificacion ? clasificacion.subcategory : null,
    etiquetas: clasificacion ? clasificacion.tags : [],
    texto: L.join('\n'),
  };
}

const PISTA_DE_USO =
  'Puedes responder, por ejemplo: «2 cajas del 0052», «3 unidades del segundo» '
  + 'o decirme el nombre del producto.';

module.exports = {
  categorias, clasificacionDe, productosDe, productosConEtiqueta,
  productosDeSubcategoria, subcategorias, masBaratos, interpretar, pagina, fichaDe,
  aplicarCorrecciones,
  recargar, POR_PAGINA, PISTA_DE_USO, ETIQUETAS, norm,
};
