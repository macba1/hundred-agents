/* ============================================================
   Encontrar un producto sin saberse el código.

   Un tendero no sabe que el chorizo cular es el 6305, ni tiene por qué. Aquí
   se resuelve lo que dice —nombre, trozo del nombre, marca, familia, una
   errata— contra productos REALES del catálogo. El modelo puede interpretar
   la frase; **elegir el producto lo hace este módulo**, y siempre devuelve un
   `producto_id` que existe o ninguno.

   Los siete fallos que arregla, todos medidos contra el buscador anterior:

     "que salchichones tienes"  devolvía QUESOS       -> `que` era un término
     "el chorizo de Marcial"    devolvía 75           -> `el`, `de` casaban con todo
     "choriso cular"            devolvía SALCHICHÓN   -> la difusa no se disparaba
     "chorizo iberico marcial"  coronaba un LOMITO    -> ranking sin sustantivo
     "embutido"                 devolvía 1 de 21      -> no conocía familias
     "uno sin gluten"           devolvía OF3900       -> texto, no el campo real
     los 19 duplicados          salían por duplicado  -> sin agrupar por código

   Y una regla que no es de búsqueda sino de negocio: los artículos internos
   (portes, palés, etiquetas, baterías, film) y los códigos `OF*` **no son
   comprables**, así que no aparecen aunque se escriba su nombre exacto.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const catalogo = require('./catalogo');
const categorias = require('./categorias');
const imagenes = require('./imagenes');

const RUTA_BASE = process.env.CHACON_BASE_FACTURACION
  || path.join(__dirname, '..', '..', 'chacon-alcantara', 'data', 'base-facturacion.json');

/* Palabras que un cliente escribe y que no significan nada al buscar. Sin
   esto, "el chorizo de Marcial" devuelve 75 resultados porque `el` y `de`
   aparecen en medio catálogo. */
const VACIAS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al',
  'a', 'y', 'o', 'que', 'qué', 'me', 'te', 'se', 'lo', 'le', 'en', 'con',
  'por', 'para', 'quiero', 'querria', 'queria', 'necesito', 'busco', 'dame',
  'ponme', 'mandame', 'enviame', 'tienes', 'tienen', 'hay', 'tengo', 'algo',
  'algun', 'alguna', 'alguno', 'uno', 'otra', 'otro', 'ese', 'esa', 'este', 'esta', 'eso', 'esto',
  'mas', 'muy', 'tambien', 'ver', 'enseñame', 'ensename', 'mostrar', 'muestrame',
  'cual', 'cuales', 'cuanto', 'cuanta', 'precio', 'cuesta', 'vale', 'sale',
  'porfa', 'favor', 'gracias', 'hola', 'buenas', 'pedido', 'caja', 'cajas',
  'unidad', 'unidades', 'pieza', 'piezas', 'kilo', 'kilos', 'kg',
]);

/* Atributos que SÍ existen en el catálogo. Solo estos se pueden filtrar: de
   lo contrario "sin gluten" haría coincidencia de texto y devolvería
   cualquier cosa que lleve la palabra "sin". */
const ATRIBUTOS = {
  sin_gluten: { campo: 'gluten', valor: false,
                frases: ['sin gluten', 'singluten', 'celiaco', 'celiacos'] },
  sin_lactosa: { campo: 'lactosa', valor: false,
                 frases: ['sin lactosa', 'sinlactosa'] },
};

const norm = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Formas singular/plural de una palabra. Se prueban TODAS en vez de adivinar
 * una: en español `salchichones` cae a `salchichon` pero `portes` cae a
 * `porte`, y elegir mal convierte "portes" en "port", que luego se parece a
 * "pork" y devuelve chopped. Comparar contra varias formas es más barato que
 * acertar con una regla.
 */
function variantes(p) {
  const v = new Set([p]);
  if (p.length > 4) {
    if (p.endsWith('ces')) v.add(`${p.slice(0, -3)}z`);      // peces -> pez
    if (p.endsWith('ones')) v.add(`${p.slice(0, -4)}on`);    // jamones -> jamon
    if (p.endsWith('es')) v.add(p.slice(0, -2));             // salchichones
    if (p.endsWith('s')) v.add(p.slice(0, -1));              // portes -> porte
  }
  v.add(`${p}s`);
  v.add(`${p}es`);
  return v;
}

/** Forma canónica para indexar: la más corta de sus variantes razonables. */
function singular(p) {
  if (p.length <= 4) return p;
  if (p.endsWith('ces')) return `${p.slice(0, -3)}z`;
  if (p.endsWith('s')) return p.slice(0, -1);
  return p;
}

/** Distancia de edición acotada: si supera `max`, corta y devuelve max+1. */
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

/* ---- qué se puede vender ------------------------------------------------ */
let _comercial = null;

/**
 * Códigos que un cliente puede comprar. Se excluyen los internos y los `OF*`
 * aunque el cliente escriba su nombre exacto: no son producto, y cotizarlos
 * sería venderle un palé a una carnicería.
 */
function comerciales() {
  if (_comercial) return _comercial;
  let base = {};
  try {
    base = JSON.parse(fs.readFileSync(RUTA_BASE, 'utf8')).productos || {};
  } catch { /* sin archivo: no se excluye nada por esta vía */ }

  const fuera = new Set();
  for (const [cod, v] of Object.entries(base)) {
    if (v.customer_visible === false) fuera.add(cod);
  }
  _comercial = { fuera, base };
  return _comercial;
}

function recargar() { _comercial = null; imagenes.recargar(); return comerciales(); }

const esComprable = (codigo) => !comerciales().fuera.has(String(codigo));

/* ---- vocabulario del catálogo ------------------------------------------- */
let _vocab = null;

/**
 * Índice por código: un producto, no un registro. Los 19 duplicados del PDF
 * son el mismo artículo dos veces y el cliente no debe verlos repetidos.
 */
function indice() {
  if (_vocab) return _vocab;
  const porCodigo = new Map();
  for (const p of catalogo.todos()) {
    if (!esComprable(p.codigo)) continue;
    if (porCodigo.has(p.codigo)) continue;
    const c = categorias.clasificacionDe(p.id) || {};
    const nombre = norm(p.descripcion);
    const marca = norm(p.marca);
    const familia = (categorias.categorias()
      .find((x) => x.clave === c.categoria_efectiva) || {}).nombre || '';
    porCodigo.set(p.codigo, {
      producto: p,
      codigo: p.codigo,
      nombre,
      marca,
      familia: c.categoria_efectiva || 'otros',
      familia_nombre: familia,
      subcategoria: c.subcategory || null,
      etiquetas: c.tags || [],
      // Alias: se derivan del catálogo y de la clasificación, nunca de lo que
      // un cliente escribió una vez.
      alias: new Set([
        ...nombre.split(' ').filter((w) => w.length > 3),
        ...marca.split(' ').filter((w) => w.length > 3),
        ...(c.subcategory ? [norm(c.subcategory)] : []),
      ].map(singular)),
      tokens_nombre: nombre.split(' ').filter(Boolean).map(singular),
      tiene_foto: !!imagenes.registro(p.id) && imagenes.registro(p.id).estado === 'verified',
    });
  }
  _vocab = porCodigo;
  return _vocab;
}

function invalidarIndice() { _vocab = null; }

/* ---- interpretación de la frase ----------------------------------------- */
/**
 * Parte lo que dijo el cliente en piezas útiles. Determinista: no interviene
 * el modelo.
 */
function interpretar(consulta) {
  const bruto = String(consulta || '');
  const q = norm(bruto);

  // Un código explícito es la vía rápida de quien ya lo conoce.
  const codigoDirecto = (bruto.match(/\b[0-9A-Za-z]{3,10}\b/g) || [])
    .map((t) => t.trim())
    .find((t) => indice().has(t) || catalogo.todos().some((p) => p.codigo === t));

  const atributos = [];
  let resto = q;
  for (const [clave, def] of Object.entries(ATRIBUTOS)) {
    for (const f of def.frases) {
      if (resto.includes(f)) { atributos.push(clave); resto = resto.replace(f, ' '); break; }
    }
  }

  const palabras = resto.split(' ')
    .filter((w) => w && !VACIAS.has(w) && w.length >= 3);

  // ¿Nombra una familia, una subcategoría o una etiqueta?
  const familia = categorias.interpretar(resto);

  return { bruto, q, codigo: codigoDirecto || null, palabras, atributos, familia };
}

/* ---- ranking ------------------------------------------------------------ */
/**
 * Puntúa un producto contra las palabras del cliente.
 *
 * El sustantivo importa más que el adjetivo: por eso una coincidencia al
 * principio del nombre pesa más. Sin esto, "chorizo iberico marcial" coronaba
 * un LOMITO ibérico de Marcial en vez de un chorizo.
 */
function puntuar(entrada, palabras, atributos, historico) {
  let score = 0;
  let exactas = 0;

  for (const w of palabras) {
    const formas = variantes(w);
    const pos = entrada.tokens_nombre.findIndex((t) => formas.has(t));
    if (pos === 0) { score += 100; exactas += 1; continue; }   // sustantivo
    if (pos > 0) { score += 60 - Math.min(pos, 5) * 5; exactas += 1; continue; }
    if ([...formas].some((f) => entrada.marca.includes(f))) { score += 45; exactas += 1; continue; }
    if ([...formas].some((f) => entrada.alias.has(f))) { score += 40; exactas += 1; continue; }
    if ([...formas].some((f) => entrada.nombre.includes(f))) { score += 30; exactas += 1; continue; }
    if (entrada.subcategoria && norm(entrada.subcategoria).includes(w)) { score += 35; exactas += 1; continue; }

    // Errata: se intenta SIEMPRE, no solo cuando no hay nada. Antes, si otra
    // palabra acertaba, "choriso" se quedaba sin corregir y ganaba el
    // producto equivocado.
    const max = w.length <= 5 ? 1 : 2;
    let mejor = max + 1;
    for (const t of entrada.tokens_nombre) mejor = Math.min(mejor, distancia(w, t, max));
    if (mejor <= max) { score += 55 - mejor * 12; exactas += 1; }
  }

  // Todas las palabras del cliente encajan: eso es una señal fuerte.
  if (palabras.length && exactas === palabras.length) score += 40;
  // Lo que el cliente ya ha comprado sube: es lo que suele querer otra vez.
  if (historico.has(entrada.codigo)) score += 35;
  if (entrada.tiene_foto) score += 5;

  return { score, exactas };
}

function cumpleAtributos(entrada, atributos) {
  for (const a of atributos) {
    const def = ATRIBUTOS[a];
    // Solo se afirma con el dato en el catálogo. `null` es "no consta" y no
    // vale como "no lleva": esa confusión aquí es sanitaria.
    if (entrada.producto[def.campo] !== def.valor) return false;
  }
  return true;
}

/* ---- API ---------------------------------------------------------------- */
/**
 * Resuelve lo que dijo el cliente.
 *
 * Devuelve siempre uno de estos, nunca un producto inventado:
 *   { tipo:'producto',  producto }              un candidato claro
 *   { tipo:'varios',    candidatos }            hay que preguntar
 *   { tipo:'familia',   clave, candidatos }     ha nombrado una familia
 *   { tipo:'nada',      sugerencias }           sin resultados
 */
function buscar(consulta, { historico = [], limite = 5 } = {}) {
  const i = interpretar(consulta);
  const hist = new Set(historico.map(String));
  const idx = indice();

  // 1. Código exacto: el atajo de quien ya lo sabe.
  if (i.codigo && idx.has(i.codigo)) {
    return { tipo: 'producto', por: 'codigo', interpretacion: i,
             producto: idx.get(i.codigo).producto, confianza: 1 };
  }
  // Un código que existe pero NO es comprable se dice con claridad.
  if (i.codigo && !idx.has(i.codigo)) {
    const real = catalogo.todos().find((p) => p.codigo === i.codigo);
    if (real) {
      return { tipo: 'no_comercial', por: 'codigo', interpretacion: i,
               codigo: i.codigo, descripcion: real.descripcion };
    }
  }

  /* 2. Si lo que nombró es SOLO una familia o categoría —"embutidos",
     "quiero chorizo"— gana la familia. Si además nombra algo del producto
     —"embutido de pollo", "chorizo cular"— mandan las palabras.

     Se decide viendo si queda alguna palabra con contenido después de lo que
     consume la familia. Sin esto, EMBUTIDO DE POLLO se comía la consulta
     "embutidos" y el cliente veía un producto en vez de los veintiuno de su
     familia. */
  if (i.familia.tipo !== 'ninguno') {
    const consumidas = new Set();
    const etiquetaFamilia = norm(i.familia.por || i.familia.clave || i.familia.nombre);
    for (const w of i.palabras) {
      for (const f of variantes(w)) {
        if (etiquetaFamilia.includes(f) || f.includes(etiquetaFamilia)) { consumidas.add(w); break; }
      }
    }
    const sobran = i.palabras.filter((w) => !consumidas.has(w));
    if (!sobran.length) {
      const productos = candidatosDeFamilia(i.familia);
      return { tipo: 'familia', interpretacion: i,
               clave: i.familia.clave, nombre: i.familia.nombre,
               es_sugerencia: !!i.familia.sugerencia,
               candidatos: productos.slice(0, limite), total: productos.length };
    }
  }

  // 3. Ranking sobre el catálogo comprable.
  let entradas = [...idx.values()].filter((e) => cumpleAtributos(e, i.atributos));

  /* La familia acota solo cuando el cliente NO ha nombrado producto. Si dice
     "qué jamones tienes", filtrar por la familia "Jamones y cocidos" dejaría
     fuera el jamón ibérico —que está clasificado en embutidos curados— y
     acabaría enseñando uno solo. Con palabras, la familia suma puntos. */
  const enFamilia = (e) => (
    i.familia.tipo === 'categoria' ? e.familia === i.familia.clave
      : i.familia.tipo === 'subcategoria' ? e.subcategoria === i.familia.clave
        : i.familia.tipo === 'etiqueta' ? e.etiquetas.includes(i.familia.clave)
          : false);

  if (i.familia.tipo !== 'ninguno' && !i.palabras.length) {
    const dentro = entradas.filter(enFamilia);
    if (dentro.length) entradas = dentro;
  }

  if (!i.palabras.length) {
    if (i.atributos.length || i.familia.tipo !== 'ninguno') {
      return { tipo: 'varios', interpretacion: i,
               candidatos: entradas.slice(0, limite).map((e) => e.producto),
               total: entradas.length };
    }
    return { tipo: 'nada', interpretacion: i, sugerencias: familiasSugeridas() };
  }

  const puntuadas = entradas
    .map((e) => {
      const p = puntuar(e, i.palabras, i.atributos, hist);
      // Estar en la familia que nombró desempata, sin excluir a los demás.
      if (i.familia.tipo !== 'ninguno' && enFamilia(e)) p.score += 25;
      return { e, ...p };
    })
    .filter((x) => x.exactas > 0)
    .sort((a, b) => b.score - a.score);

  if (!puntuadas.length) {
    /* Nombró una familia pero ninguna palabra casa con un producto concreto
       ("embutidos"): se abre la familia en vez de contestar que no hay nada. */
    if (i.familia.tipo !== 'ninguno') {
      return { tipo: 'familia', interpretacion: i,
               clave: i.familia.clave, nombre: i.familia.nombre,
               es_sugerencia: !!i.familia.sugerencia };
    }
    return { tipo: 'nada', interpretacion: i, sugerencias: familiasSugeridas() };
  }

  const mejor = puntuadas[0];
  const segundo = puntuadas[1];

  /* Un único candidato, o uno claramente por delante: se propone. El margen
     es amplio a propósito — proponer el producto equivocado con seguridad es
     peor que preguntar. */
  const destacado = !segundo || (mejor.score - segundo.score) >= 50;
  if (destacado && mejor.exactas === i.palabras.length) {
    return { tipo: 'producto', por: 'nombre', interpretacion: i,
             producto: mejor.e.producto, confianza: segundo ? 0.8 : 0.95,
             otros: puntuadas.slice(1, limite).map((x) => x.e.producto) };
  }

  return {
    tipo: 'varios', interpretacion: i,
    candidatos: puntuadas.slice(0, limite).map((x) => x.e.producto),
    total: puntuadas.length,
  };
}

/** Familias con producto comprable, para ofrecer cuando no hay resultados. */
function familiasSugeridas() {
  const cuenta = new Map();
  for (const e of indice().values()) {
    cuenta.set(e.familia, (cuenta.get(e.familia) || 0) + 1);
  }
  return categorias.categorias()
    .filter((c) => cuenta.get(c.clave))
    .map((c) => ({ clave: c.clave, nombre: c.nombre, productos: cuenta.get(c.clave) }));
}

/** Productos comprables de una familia, ya deduplicados por código. */
function deFamilia(clave) {
  return [...indice().values()].filter((e) => e.familia === clave).map((e) => e.producto);
}

/**
 * Productos de lo que el cliente nombró, sea familia, subcategoría o
 * etiqueta. Sin esto, "chorizo" resolvía a una subcategoría y luego se
 * buscaba como si fuese familia: cero resultados.
 */
function candidatosDeFamilia(familia) {
  const idx = [...indice().values()];
  if (familia.tipo === 'categoria') {
    return idx.filter((e) => e.familia === familia.clave).map((e) => e.producto);
  }
  if (familia.tipo === 'subcategoria') {
    return idx.filter((e) => e.subcategoria === familia.clave).map((e) => e.producto);
  }
  if (familia.tipo === 'etiqueta') {
    return idx.filter((e) => e.etiquetas.includes(familia.clave)).map((e) => e.producto);
  }
  return [];
}

/**
 * Lo que este cliente suele pedir, por frecuencia y recencia. Determinista:
 * se cuenta lo que hay en sus pedidos, sin recomendador ni modelo.
 */
function habituales(pedidos, { limite = 5 } = {}) {
  const cuenta = new Map();
  pedidos.forEach((p, orden) => {
    for (const l of p.lineas || []) {
      if (!esComprable(l.codigo)) continue;
      const v = cuenta.get(l.codigo) || { codigo: l.codigo, veces: 0, ultimo: orden };
      v.veces += 1;
      v.ultimo = Math.min(v.ultimo, orden);      // 0 = el pedido más reciente
      cuenta.set(l.codigo, v);
    }
  });
  return [...cuenta.values()]
    .sort((a, b) => (b.veces - a.veces) || (a.ultimo - b.ultimo))
    .slice(0, limite)
    .map((v) => {
      const e = indice().get(v.codigo);
      return e ? { producto: e.producto, veces: v.veces } : null;
    })
    .filter(Boolean);
}

module.exports = {
  buscar, interpretar, indice, deFamilia, candidatosDeFamilia, habituales, familiasSugeridas,
  esComprable, comerciales, recargar, invalidarIndice,
  norm, singular, variantes, VACIAS, ATRIBUTOS,
};
