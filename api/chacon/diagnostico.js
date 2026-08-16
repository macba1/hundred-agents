/* ============================================================
   GET /api/chacon/diagnostico?token=… — qué permite la cuenta de Meta.

   Antes de montar un catálogo nativo hay que saber si el número puede
   tenerlo. Este endpoint lo pregunta a Graph con el token que ya vive en el
   servidor, para que nadie tenga que copiar credenciales a mano.

   Contesta, con evidencia y no de memoria:
     - qué número es, y si es un número DE PRUEBA de Meta
     - a qué WABA pertenece y de qué Business Portfolio
     - si hay catálogo conectado
     - si el carrito está activado y el catálogo es visible
     - qué permisos lleva el token

   Un número de prueba de Meta **no admite comercio**. Si el diagnóstico dice
   eso, no hay configuración que lo arregle: hace falta un número propio.
   ============================================================ */

const crypto = require('crypto');
const wa = require('../../lib/wa/whatsapp');

function mismoToken(got, want) {
  const a = Buffer.from(String(got || '')); const b = Buffer.from(String(want || ''));
  if (!b.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** GET a Graph que nunca lanza: un fallo es un dato del diagnóstico. */
async function graph(ruta, tok, campos = null) {
  const url = `${wa.GRAPH}/${ruta}${campos ? `?fields=${encodeURIComponent(campos)}` : ''}`;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    const cuerpo = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, datos: cuerpo };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const want = process.env.PANEL_TOKEN || '';
  const got = (req.query && req.query.token)
    || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!want) return res.status(503).json({ error: 'PANEL_TOKEN no configurado' });
  if (!mismoToken(got, want)) return res.status(403).json({ error: 'forbidden' });

  const tok = wa.token();
  const pnid = process.env.CHACON_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID || '';

  const out = {
    generado: new Date().toISOString(),
    api_version: wa.API_VERSION,
    phone_number_id: pnid,
    token_presente: !!tok,
    conclusiones: [],
  };
  if (!tok || !pnid) {
    out.conclusiones.push('Sin token o sin phone_number_id: no se puede diagnosticar nada.');
    return res.status(200).json(out);
  }

  /* ---- 1. el número --------------------------------------------------- */
  const numero = await graph(pnid, tok,
    'id,display_phone_number,verified_name,quality_rating,platform_type,'
    + 'code_verification_status,is_official_business_account,account_mode,'
    + 'name_status,messaging_limit_tier');
  out.numero = numero.datos || { error: numero };

  /* ---- 2. WABA y Business Portfolio ----------------------------------- */
  // El WABA no cuelga del número: se pregunta por los que ve el token.
  const wabas = await graph('me/businesses', tok, 'id,name,verification_status');
  out.business_portfolios = wabas.datos || { error: wabas };

  const dueno = await graph(pnid, tok, 'whatsapp_business_account{id,name,currency,'
    + 'account_review_status,business_verification_status,owner_business_info}');
  out.waba = dueno.datos?.whatsapp_business_account || { error: dueno };

  const wabaId = out.waba?.id;

  /* ---- 3. catálogos conectados ---------------------------------------- */
  if (wabaId) {
    const cat = await graph(`${wabaId}/product_catalogs`, tok, 'id,name,vertical,product_count');
    out.catalogos_conectados = cat.ok ? (cat.datos?.data || []) : { error: cat };
  } else {
    out.catalogos_conectados = { error: 'sin WABA: no se pueden listar catálogos' };
  }

  /* ---- 4. ajustes de comercio del número ------------------------------ */
  // Aquí es donde se ve si el carrito está activado y el catálogo es visible.
  const comercio = await graph(`${pnid}/whatsapp_commerce_settings`, tok);
  out.commerce_settings = comercio.ok ? comercio.datos : { error: comercio };

  /* ---- 5. permisos del token ------------------------------------------ */
  const permisos = await graph('me/permissions', tok);
  out.permisos = permisos.ok
    ? (permisos.datos?.data || []).filter((p) => p.status === 'granted').map((p) => p.permission)
    : { error: permisos };

  /* ---- 6. lectura del diagnóstico ------------------------------------- */
  const C = out.conclusiones;
  const plataforma = out.numero?.platform_type;
  const esPrueba = plataforma === 'NOT_APPLICABLE' || out.numero?.account_mode === 'SANDBOX'
    || /test/i.test(out.numero?.verified_name || '');

  if (esPrueba) {
    C.push('BLOQUEANTE: parece un NÚMERO DE PRUEBA de Meta. Los números de prueba no '
      + 'admiten catálogo ni carrito nativos. Hace falta un número propio verificado.');
  }
  if (!out.waba?.id) {
    C.push('No se ha podido leer el WABA con este token: revisa los permisos '
      + 'whatsapp_business_management y business_management.');
  }
  if (out.waba?.business_verification_status && out.waba.business_verification_status !== 'verified') {
    C.push(`BLOQUEANTE: el negocio está en "${out.waba.business_verification_status}". `
      + 'El comercio en WhatsApp exige verificación de empresa.');
  }
  if (Array.isArray(out.catalogos_conectados)) {
    if (!out.catalogos_conectados.length) {
      C.push('No hay ningún catálogo conectado al WABA: hay que crearlo en Commerce Manager '
        + 'y conectarlo. No reutilices un catálogo de otro cliente.');
    } else {
      C.push(`Catálogos conectados: ${out.catalogos_conectados
        .map((c) => `${c.name} (${c.id}, ${c.product_count ?? '?'} productos)`).join(' · ')}`);
    }
  }
  const cs = out.commerce_settings?.data?.[0];
  if (cs) {
    C.push(`Carrito ${cs.is_cart_enabled ? 'ACTIVADO' : 'desactivado'} · `
      + `catálogo ${cs.is_catalog_visible ? 'visible' : 'oculto'}.`);
  } else if (out.commerce_settings?.error) {
    C.push('No se pueden leer los ajustes de comercio de este número. Suele significar que '
      + 'el número no admite comercio (número de prueba) o que falta el permiso.');
  }
  if (Array.isArray(out.permisos)) {
    for (const p of ['whatsapp_business_management', 'whatsapp_business_messaging',
                     'business_management', 'catalog_management']) {
      if (!out.permisos.includes(p)) C.push(`Falta el permiso ${p}.`);
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(out);
};
