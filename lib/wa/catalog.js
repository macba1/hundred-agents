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
        if (body.sinonimos) p._sinonimos = body.sinonimos;
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
  for (const k of ['opciones', 'tamanos', '_sinonimos']) {
    if (Array.isArray(p[k])) campos.push(...p[k]);
  }
  return norm(campos.filter(Boolean).join(' '));
}

function matches(token, text) {
  return variants(token).some((v) => text.includes(v));
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
  for (const k of INFO_KEYS) if (k in cat) out[k] = cat[k];
  return out;
}

module.exports = { norm, variants, flatten, buscar, publicFields, INFO_KEYS, MAX_RESULTS };
