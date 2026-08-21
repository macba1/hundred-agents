/* ============================================================
   Catalog search for the WhatsApp agent.

   Supports two catalog shapes:
     flat   : { productos: [ {...} ] }
     nested : { categorias: { <categoria>: { <subcategoria>: {
                 descripcion, extras, sinonimos, items: [ {...} ] } } } }

   Search is accent- and plural-insensitive ("cafés" must reach the
   "coffee" subcategory), and name matches outrank description matches so
   "Pannini Arrachera" is never quoted as "Pannini SanMi".
   ============================================================ */

const MAX_RESULTS = Number(process.env.MAX_CATALOGO_RESULTS || 24);

/** Top-level catalog keys that describe the business, not products. */
const INFO_KEYS = [
  'direccion', 'ubicacion', 'telefono', 'tel_llamadas', 'tel_whatsapp',
  'horarios', 'horario_humano', 'domicilio', 'pagos', 'envios',
  'notas_generales', 'info', 'estado_menu', 'notas_precios',
];

/** Lowercase and strip diacritics. */
function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Token plus de-pluralised forms ("cafes" -> "cafe"). */
function variants(token) {
  const v = [token];
  if (token.length > 4 && token.endsWith('es')) v.push(token.slice(0, -2));
  if (token.length > 3 && token.endsWith('s')) v.push(token.slice(0, -1));
  return v;
}

/**
 * Normalise any catalog shape to a flat product list. The subcategory's
 * descripcion/extras/sinonimos are inherited so one match gives the model
 * everything it needs to quote.
 */
function flatten(catalogo) {
  const cat = catalogo || {};
  if (Array.isArray(cat.productos) && cat.productos.length) {
    return cat.productos.map((p) => ({ ...p }));
  }

  const out = [];
  const categorias = cat.categorias || {};
  for (const [categoria, subs] of Object.entries(categorias)) {
    if (!subs || typeof subs !== 'object') continue;
    for (const [sub, body] of Object.entries(subs)) {
      if (!body || typeof body !== 'object') continue;
      const items = Array.isArray(body.items) ? body.items : [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const p = { ...item };
        p.categoria = categoria.replace(/_/g, ' ');
        p.subcategoria = sub.replace(/_/g, ' ');
        // Underscore-prefixed fields are search-only and never sent to the model.
        // Se combinan los de la subcategoría con los del platillo concreto,
        // que es donde caben las variantes de escritura ("clericot").
        const sin = [...(body.sinonimos || []), ...(item.sinonimos || [])];
        if (sin.length) p._sinonimos = sin;
        delete p.sinonimos;
        if (body.descripcion) p.descripcion_grupo = body.descripcion;
        if (body.extras) p.extras = body.extras;
        out.push(p);
      }
    }
  }
  return out;
}

/** Searchable haystack for one product. */
function haystack(p) {
  const campos = [p.nombre, p.categoria, p.subcategoria, p.sku, p.descripcion, p.descripcion_grupo];
  if (p.extras && typeof p.extras === 'object' && !Array.isArray(p.extras)) {
    campos.push(...Object.keys(p.extras));
  } else if (Array.isArray(p.extras)) {
    campos.push(...p.extras);
  }
  // `presentaciones` es lo que usa Providencia para "5 kg", "20 piezas", "650 g":
  // sin esto, "¿tienen cajeta de 5 kilos?" no encontraría el granel. Los
  // catálogos que no traen la clave se comportan exactamente igual que antes.
  for (const k of ['opciones', 'tamanos', 'presentaciones', '_sinonimos']) {
    if (Array.isArray(p[k])) campos.push(...p[k]);
  }
  return norm(campos.filter(Boolean).join(' '));
}

function matches(token, text) {
  return variants(token).some((v) => text.includes(v));
}

/** Distancia de edición, acotada: si supera `max` se corta y devuelve max+1. */
function distancia(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const fila = [i];
    let mejor = i;
    for (let j = 1; j <= b.length; j += 1) {
      const coste = a[i - 1] === b[j - 1] ? 0 : 1;
      fila[j] = Math.min(prev[j] + 1, fila[j - 1] + 1, prev[j - 1] + coste);
      if (fila[j] < mejor) mejor = fila[j];
    }
    if (mejor > max) return max + 1; // ninguna continuación puede mejorar
    prev = fila;
  }
  return prev[b.length];
}

/** Tolerancia según lo larga que sea la palabra. */
function tolerancia(palabra) {
  if (palabra.length <= 3) return 0;
  if (palabra.length <= 5) return 1;
  return 2;
}

/**
 * Vocabulario buscable: cada palabra de los nombres, sinónimos y
 * subcategorías, apuntando a los productos donde aparece.
 */
function vocabulario(productos) {
  const mapa = new Map();
  // `peso` desempata: una palabra del nombre vale más que un sinónimo de
  // categoría, para que "malteda" sugiera Malteada y no todas las bebidas frías.
  const añadir = (palabra, p, peso) => {
    const w = norm(palabra);
    if (w.length < 3) return;
    if (!mapa.has(w)) mapa.set(w, []);
    mapa.get(w).push({ p, peso });
  };
  for (const p of productos) {
    for (const w of String(p.nombre || '').split(/[\s,()/]+/)) añadir(w, p, 0);
    for (const s of p._sinonimos || []) for (const w of String(s).split(/\s+/)) añadir(w, p, 0.5);
    for (const w of String(p.subcategoria || '').split(/\s+/)) añadir(w, p, 0.75);
  }
  return mapa;
}

/**
 * "¿Quisiste decir…?" — se usa solo cuando la búsqueda no encontró nada.
 * Un cliente que escribe "clericot", "frape" o "panini" está pidiendo algo
 * que SÍ está en la carta; decirle que no lo manejamos es un error caro.
 */
function sugerir(productos, tokens) {
  const vocab = vocabulario(productos);
  const encontrados = new Map(); // producto -> mejor puntuación (menor = mejor)
  for (const t of tokens) {
    const max = tolerancia(t);
    if (!max) continue;
    for (const [palabra, entradas] of vocab) {
      const d = distancia(t, palabra, max);
      if (d > max) continue;
      for (const { p, peso } of entradas) {
        const punt = d + peso;
        if (!encontrados.has(p) || encontrados.get(p) > punt) encontrados.set(p, punt);
      }
    }
  }
  return [...encontrados.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, 6)
    .map(([p]) => p);
}

/** Strip search-only fields before handing a product to the model. */
function publicFields(p) {
  const out = {};
  for (const [k, v] of Object.entries(p)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

/**
 * buscar_catalogo tool implementation.
 * @param {object} client  loaded client (needs .catalogo, .productos, .nombre)
 * @param {string} consulta free text; empty returns the whole menu (capped)
 */
function buscar(client, consulta) {
  const cat = client.catalogo || {};
  const productos = client.productos || [];
  const tokens = String(consulta || '').split(/\s+/).map(norm).filter(Boolean);

  let hits;
  if (!tokens.length) {
    hits = productos.slice();
  } else {
    hits = productos.filter((p) => {
      const h = haystack(p);
      return tokens.every((t) => matches(t, h));
    });
    // Nothing on strict AND -> fall back to a loose OR.
    if (!hits.length) {
      hits = productos.filter((p) => {
        const h = haystack(p);
        return tokens.some((t) => matches(t, h));
      });
    }
    // Relevance: name matches first.
    hits = hits
      .map((p) => {
        const n = norm(p.nombre || '');
        const enNombre = tokens.filter((t) => matches(t, n)).length;
        return { p, enNombre };
      })
      .sort((a, b) => b.enNombre - a.enNombre)
      .map((x) => x.p);
  }

  // Nada encontrado: puede ser un platillo mal escrito, no uno inexistente.
  const sugerencias = (!hits.length && tokens.length) ? sugerir(productos, tokens) : [];

  const total = hits.length;
  const out = {
    negocio: cat.negocio || client.nombre,
    moneda: cat.moneda || 'MXN',
    coincidencias: hits.slice(0, MAX_RESULTS).map(publicFields),
    total_coincidencias: total,
    productos_en_carta: productos.length,
  };
  if (total > MAX_RESULTS) {
    out.aviso = `Se muestran ${MAX_RESULTS} de ${total} coincidencias. Afina la búsqueda si necesitas el resto.`;
  }
  if (sugerencias.length) {
    out.sugerencias = sugerencias.map(publicFields);
    out.aviso = 'Sin coincidencias exactas, pero hay platillos parecidos: puede ser una ' +
      'falta de ortografía. PREGUNTA "¿quisiste decir X?" antes de decir que no lo manejamos.';
  }
  for (const k of INFO_KEYS) if (k in cat) out[k] = cat[k];
  return out;
}

module.exports = { norm, variants, flatten, buscar, sugerir, distancia, publicFields, INFO_KEYS, MAX_RESULTS };
