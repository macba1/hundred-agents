/* ============================================================
   GET /api/chacon/panel?token=…  — panel interno de Chacón.

   Vistas: solicitudes · ofertas y precios · catálogo · conflictos de tarifa ·
   clientes · config pendiente. Protegido con el mismo PANEL_TOKEN.

   Aquí se toman las dos decisiones que el sistema NO puede tomar solo:
   resolver cuál de los dos precios repetidos está vigente, y dar de alta una
   oferta. Ambas quedan firmadas con quién y cuándo.

   Muestra pedidos y teléfonos de clientes reales: nunca sin token.
   ============================================================ */

const crypto = require('crypto');
const repo = require('../../lib/chacon/repo');
const catalogo = require('../../lib/chacon/catalogo');
const pedidoLib = require('../../lib/chacon/pedido');
const fabrica = require('../../lib/chacon/fabrica');
const ofertas = require('../../lib/chacon/ofertas');
const repeticion = require('../../lib/chacon/repeticion');
const categorias = require('../../lib/chacon/categorias');
const navegacion = require('../../lib/chacon/navegacion');
const imagenes = require('../../lib/chacon/imagenes');
const formato = require('../../lib/chacon/wa-formato');
const privacidad = require('../../lib/chacon/privacidad');
const agendaClientes = require('../../lib/chacon/clientes');
const tarifas = require('../../lib/chacon/tarifas');
const tramos = require('../../lib/chacon/tramos');
const facturacion = require('../../lib/chacon/facturacion');

const esc = (x) => String(x == null ? '' : x)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function mismoToken(got, want) {
  const a = Buffer.from(String(got || '')); const b = Buffer.from(String(want || ''));
  if (!b.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const PENDIENTES = [
  ['reglas_8_tarifas', 'Reglas exactas de las 8 tarifas'],
  ['tabla_precios_por_tarifa', 'Tabla completa de precios por tarifa y producto'],
  ['definicion_fraccion_media_caja', 'Definición de fracción y media caja'],
  ['umbrales_cambio_tarifa', 'Umbrales exactos para cambiar de tarifa'],
  ['iva_por_producto', 'IVA correspondiente a cada producto'],
  ['numero_whatsapp_fabrica', 'Número operativo de WhatsApp que recibe los pedidos'],
  ['politica_stock', 'Política de stock y disponibilidad'],
  ['fuente_alergenos', 'Fuente completa de información de alérgenos'],
  ['pedido_minimo', 'Pedido mínimo'],
  ['dias_zonas_reparto', 'Días y zonas de reparto'],
  ['hora_limite_pedidos', 'Hora límite de pedidos'],
  ['gastos_transporte', 'Gastos de transporte'],
  ['sustituciones', 'Política de sustituciones'],
  ['promociones', 'Promociones y artículos sin cargo'],
  ['proceso_aceptacion', 'Proceso interno de aceptación y modificación'],
  ['responsable_fecha_entrega', 'Responsable de comunicar la fecha de entrega'],
];

module.exports = async function handler(req, res) {
  // POST solo para reintentar un envío fallido. Todo lo demás es lectura.
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method_not_allowed' });
  }
  const want = process.env.PANEL_TOKEN || '';
  const got = (req.query && req.query.token) || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!want) return res.status(503).send('PANEL_TOKEN no configurado.');
  if (!mismoToken(got, want)) return res.status(403).send('<h1>403</h1><p>Falta el token.</p>');

  let aviso = '';
  if (req.method === 'POST') {
    const b = req.body || {};
    const accion = b.accion || (req.query && req.query.accion) || 'reintentar';
    // Quién firma la decisión. Sin nombre no se guarda: el encargo pide saber
    // quién validó cada precio, y "alguien" no es una respuesta.
    const por = String(b.por || '').trim();
    try {
      if (accion === 'reintentar') {
        const id = String(b.pedido || '');
        const r = await fabrica.reintentar(id);
        aviso = r.ok
          ? `<p class="ok">Reintento de ${esc(id)}: aceptado por el proveedor. Pendiente de confirmación de entrega.</p>`
          : `<p class="bad">Reintento de ${esc(id)} fallido: ${esc(r.aviso_configuracion || r.error || 'error')}</p>`;

      } else if (accion === 'precio') {
        if (!por) {
          aviso = '<p class="bad">Escribe tu nombre: cada precio queda firmado por quien lo valida.</p>';
        } else {
          const pid = String(b.producto_id || '');
          const p = catalogo.porId(pid);
          if (!p) aviso = `<p class="bad">No existe el producto ${esc(pid)}.</p>`;
          else {
            const reg = await ofertas.guardar(pid, {
              standard_price_per_kg: b.standard_price_per_kg,
              offer_price_per_kg: b.offer_price_per_kg,
              offer_active: b.offer_active,
              offer_start_date: b.offer_start_date,
              offer_end_date: b.offer_end_date,
              offer_min_quantity: b.offer_min_quantity,
              offer_unit: b.offer_unit,
              offer_conditions: b.offer_conditions,
              offer_source: b.offer_source || 'panel',
              offer_validated_by: por,
            }, { por, nota: b.nota || null });
            const est = ofertas.estadoOferta(reg);
            aviso = `<p class="ok">Guardado ${esc(p.codigo)} — ${esc(p.descripcion)}. `
              + `Oferta: ${est.visible ? 'visible para las tiendas' : 'no visible (' + esc(est.motivo) + ')'}.</p>`;
          }
        }

      } else if (accion === 'clasificar') {
        if (!por) {
          aviso = '<p class="bad">Escribe tu nombre: cada corrección queda firmada.</p>';
        } else {
          const pid = String(b.producto_id || '');
          const p = catalogo.porId(pid);
          if (!p) aviso = `<p class="bad">No existe el producto ${esc(pid)}.</p>`;
          else {
            await repo.guardarClasificacion({
              producto_id: pid,
              primary_category: b.primary_category || null,
              subcategory: (b.subcategory || '').trim() || null,
              tags: String(b.tags || '').split(/[,|]/).map((x) => x.trim()).filter(Boolean),
              display_order: Number(b.display_order) || undefined,
              revisado_por: por,
              ts: new Date().toISOString(),
            });
            categorias.recargar();
            await categorias.aplicarCorrecciones(repo);
            aviso = `<p class="ok">${esc(p.codigo)} — ${esc(p.descripcion)} movido a `
              + `<b>${esc(b.primary_category)}</b>, revisado por ${esc(por)}.</p>`;
          }
        }

      } else if (accion === 'cliente_estado') {
        if (!por) {
          aviso = '<p class="bad">Escribe tu nombre: cada cambio queda firmado.</p>';
        } else {
          const c = await repo.clientePorId(String(b.cliente_id || ''));
          if (!c) aviso = '<p class="bad">No existe ese cliente.</p>';
          else {
            c.estado = b.estado || c.estado;
            c.verificado_por = por;
            c.verificado_en = new Date().toISOString();
            await repo.guardarCliente(c);
            aviso = `<p class="ok">${esc(c.nombre)} → <b>${esc(c.estado)}</b>, por ${esc(por)}.</p>`;
          }
        }
      } else if (accion === 'marketing') {
        if (!por) {
          aviso = '<p class="bad">Escribe tu nombre: cada cambio queda firmado.</p>';
        } else {
          await privacidad.fijarMarketing(String(b.telefono || ''), b.valor === '1',
            { source: 'panel', recorded_by: por });
          aviso = `<p class="ok">Marketing de +${esc(b.telefono)} → `
            + `<b>${b.valor === '1' ? 'sí' : 'no'}</b>, por ${esc(por)}.</p>`;
        }
      } else if (accion === 'facturacion') {
        if (!por) {
          aviso = '<p class="bad">Escribe tu nombre: cada base de facturación queda firmada.</p>';
        } else if (!facturacion.BASES.includes(b.billing_unit)) {
          aviso = '<p class="bad">Base de facturación no válida.</p>';
        } else {
          await repo.guardarFacturacion({
            product_code: String(b.product_code || ''),
            billing_unit: b.billing_unit,
            approved: b.billing_unit !== 'unknown',
            customer_visible: b.customer_visible === 'on',
            origen: 'panel', revisado_por: por, ts: new Date().toISOString(),
          });
          aviso = `<p class="ok">${esc(b.product_code)} → <b>${esc(b.billing_unit)}</b>, `
            + `revisado por ${esc(por)}.</p>`;
        }

      } else if (accion === 'duplicar') {
        const ped = await repo.getPedido(String(b.pedido || ''));
        if (!ped) aviso = '<p class="bad">No existe ese pedido.</p>';
        else {
          const r = await repeticion.preparar(ped.cliente.id, { pedido_id: ped.id });
          aviso = r.ok
            ? `<p class="ok">Borrador preparado para ${esc(ped.cliente.nombre)} a partir de ${esc(ped.id)}. `
              + `${r.cambios_de_precio.length ? esc(r.cambios_de_precio.length) + ' precio(s) han cambiado.' : 'Sin cambios de precio.'} `
              + 'La tienda debe confirmarlo desde WhatsApp: un pedido nunca se envía sin su confirmación.</p>'
            : `<p class="bad">No se pudo duplicar: ${esc(r.error)}</p>`;
        }
      }
    } catch (err) { aviso = `<p class="bad">Error: ${esc(err.message)}</p>`; }
  }

  const rd = repo.ready();
  const vista = (req.query && req.query.v) || 'pedidos';
  const tk = `token=${encodeURIComponent(got)}`;

  let cuerpo = '';
  try {
    if (!rd.ok && vista !== 'catalogo' && vista !== 'conflictos') {
      cuerpo = `<p class="warn">${esc(rd.error)}</p>`;
    } else if (vista === 'catalogo') {
      cuerpo = vistaCatalogo(req.query.q || '');
    } else if (vista === 'conflictos') {
      cuerpo = await vistaConflictos(tk);
    } else if (vista === 'ofertas') {
      cuerpo = await vistaOfertas(tk, req.query.q || '');
    } else if (vista === 'clasificacion') {
      cuerpo = await vistaClasificacion(tk, req.query.q || '', req.query.cat || '');
    } else if (vista === 'imagenes') {
      cuerpo = vistaImagenes(req.query.estado || '', tk);
    } else if (vista === 'tarifas') {
      cuerpo = vistaTarifas(tk, req.query.v2 || '');
    } else if (vista === 'facturacion') {
      cuerpo = await vistaFacturacion(tk, req.query.q || '');
    } else if (vista === 'simulador') {
      cuerpo = await vistaSimulador(req.query.msg || '', tk);
    } else if (vista === 'clientes') {
      cuerpo = await vistaClientesPrivacidad(tk);
    } else if (vista === 'config') {
      cuerpo = vistaConfig(await repo.todaLaConfig());
    } else {
      cuerpo = vistaPedidos(await repo.listarPedidos({ limite: 100,
        cliente: req.query.cliente || null, estado: req.query.estado || null }), tk);
    }
  } catch (err) {
    cuerpo = `<p class="warn">Error: ${esc(err.message)}</p>`;
  }

  const problema = fabrica.revisarConfiguracion();
  let cfgAviso = problema ? `<br><span class="bad">⚠️ ${esc(problema.aviso)}</span>` : '';
  if (process.env.CHACON_ALTA_LIBRE === '1') {
    cfgAviso += '<br><span class="warn">⚠️ MODO DEMO: cualquier nombre de tienda puede '
      + 'comprar. Las altas quedan marcadas <code>alta_libre_demo</code> y '
      + '<code>pendiente_aprobacion</code>. Apagar <code>CHACON_ALTA_LIBRE</code> al recibir '
      + 'el listado de clientes.</span>';
  }

  const tabs = [['pedidos', 'Solicitudes'], ['tarifas', 'Tarifas'],
                ['facturacion', 'Base de facturación'], ['clasificacion', 'Familias'],
                ['imagenes', 'Imágenes'], ['simulador', 'Simulador'],
                ['ofertas', 'Ofertas y precios'], ['catalogo', 'Catálogo'],
                ['conflictos', 'Precios repetidos'], ['clientes', 'Clientes'],
                ['config', 'Configuración pendiente']]
    .map(([k, t]) => `<a href="/api/chacon/panel?v=${k}&${tk}" class="${vista === k ? 'on' : ''}">${t}</a>`).join('');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  return res.status(200).send(`<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Chacón Alcántara — panel</title>
<style>
 :root{--bg:#0d0f12;--fg:#eceef2;--muted:#8b8f9a;--line:#22252b;--ac:#c0392b}
 *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);
   font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:28px}
 h1{margin:0 0 4px;font-size:19px} h1 span{color:var(--ac)}
 .sub{color:var(--muted);font-size:13px;margin-bottom:18px}
 .tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:22px}
 .tabs a{color:var(--muted);text-decoration:none;border:1px solid var(--line);padding:6px 13px;border-radius:999px;font-size:13px}
 .tabs a.on{background:var(--ac);color:#fff;border-color:var(--ac);font-weight:600}
 .wrap{overflow-x:auto} table{width:100%;border-collapse:collapse;font-size:13px}
 th,td{text-align:left;padding:8px 11px;border-bottom:1px solid var(--line);vertical-align:top}
 th{color:var(--muted);text-transform:uppercase;font-size:10.5px;letter-spacing:1px}
 tr:hover td{background:#15181d}
 .warn{color:#e6a23c} .bad{color:#e05c5c} .ok{color:#4fbf7f}
 .pill{font-size:10px;padding:2px 7px;border-radius:4px;background:#2a2e35;color:#c9ccd3}
 form{margin-bottom:14px} input{background:#15181d;border:1px solid var(--line);color:var(--fg);padding:7px 10px;border-radius:6px}
 code{background:#15181d;padding:1px 5px;border-radius:4px}
 button{background:#2a2e35;border:1px solid var(--line);color:var(--fg);padding:5px 10px;
   border-radius:6px;font-size:12px;cursor:pointer} button:hover{background:var(--ac);border-color:var(--ac)}
 select{background:#15181d;border:1px solid var(--line);color:var(--fg);padding:7px 10px;border-radius:6px}
 h3{margin:22px 0 6px;font-size:15px;font-weight:600}
 .card{border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:14px;background:#111419}
 .card h3{margin:0 0 4px} .card p{margin:2px 0 10px}
 .pf .g{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px}
 .pf label{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
 .pf label.w2{grid-column:span 2} .pf label.ck{flex-direction:row;align-items:center;text-transform:none;font-size:12.5px}
 .pf input,.pf select{font-size:13px} .pf input[type=checkbox]{width:auto}
 .pf .row{display:flex;align-items:center;gap:12px;margin-top:11px;flex-wrap:wrap;font-size:12px}
 details{margin-top:9px} summary{cursor:pointer;font-size:12px}
 .chips{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:16px}
 .chip{color:var(--muted);text-decoration:none;border:1px solid var(--line);padding:4px 11px;
   border-radius:999px;font-size:12px} .chip.on{background:var(--ac);color:#fff;border-color:var(--ac)}
 .chip b{color:inherit;opacity:.75;margin-left:3px}
 .mos{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
 .im{margin:0;background:#181c22;border:1px solid #262a31;border-radius:9px;overflow:hidden}
 .im img{width:100%;height:150px;object-fit:contain;background:#fff;display:block}
 .im .sin{height:150px;display:flex;align-items:center;justify-content:center;color:#6b7280;background:#0d1013;font-size:12px}
 .im figcaption{padding:8px 10px;font-size:11.5px}
 .chat{max-width:520px;display:flex;flex-direction:column;gap:11px}
 .bu{background:#15321f;border:1px solid #22452c;border-radius:11px;padding:11px 13px;font-size:13px;position:relative}
 .bu .tp{position:absolute;top:-8px;right:9px;background:#2a2e35;color:#c9ccd3;font-size:9.5px;
   padding:1px 7px;border-radius:4px;text-transform:uppercase;letter-spacing:.5px}
 .bu img{max-width:100%;border-radius:7px;margin-bottom:7px;background:#fff}
</style></head><body>
<h1>Chacón <span>Alcántara</span> — panel interno</h1>
<div class="sub">Tarifa 1 · precios por kilo y sin IVA · almacenamiento ${esc(rd.backend)}
 · canal interno: <code>${esc(fabrica.modo())}</code> → ${esc(fabrica.nombreDestinatario())}
 ${cfgAviso}</div>
<div class="tabs">${tabs}</div>${aviso}${cuerpo}</body></html>`);
};

/** Estado del envío interno, en palabras, y botón de reintento si procede. */
function celdaEnvio(p, tk) {
  const e = p.envio_interno || {};
  if (e.entregado) return '<span class="ok">entregado</span>';
  const etiquetas = {
    aceptado_por_proveedor: '<span class="warn">aceptado, sin confirmar entrega</span>',
    simulado: '<span class="pill">simulado</span>',
    fallido: '<span class="bad">fallido</span>',
    bloqueado_por_configuracion: '<span class="bad">config incorrecta</span>',
  };
  let html = etiquetas[e.estado] || '<span class="warn">sin enviar</span>';
  if (e.aviso_configuracion) html += `<br><span class="sub">${esc(e.aviso_configuracion)}</span>`;
  const ultimo = e.intentos?.slice(-1)[0];
  if (ultimo && !ultimo.ok && ultimo.detalle) html += `<br><span class="sub">${esc(String(ultimo.detalle).slice(0, 120))}</span>`;
  if (!e.entregado && e.estado !== 'simulado') {
    html += `<form method="post" action="/api/chacon/panel?${tk}" style="margin:6px 0 0">
      <input type="hidden" name="pedido" value="${esc(p.id)}">
      <button type="submit">Reintentar envío</button></form>`;
  }
  return html;
}

const eur = (n) => (n === null || n === undefined ? '—' : String(n).replace('.', ',') + ' €');


/* ---- familias: revisar y corregir la clasificación ---------------------- */
async function vistaClasificacion(tk, q, catFiltro) {
  await categorias.aplicarCorrecciones(repo).catch(() => {});
  const cats = categorias.categorias();
  const busca = String(q || '').trim();

  let lista = catalogo.todos();
  if (busca) lista = catalogo.buscar(busca).candidatos;
  if (catFiltro) {
    lista = lista.filter((p) => (categorias.clasificacionDe(p.id) || {}).categoria_efectiva === catFiltro);
  }
  // Sin filtro se enseña primero lo que hace falta revisar: es el trabajo real.
  if (!busca && !catFiltro) {
    lista = lista.filter((p) => {
      const c = categorias.clasificacionDe(p.id);
      return c && c.classification_status === 'pending_review';
    });
  }

  const porEstado = { auto_confirmado: 0, pending_review: 0, revisado_por_persona: 0 };
  for (const p of catalogo.todos()) {
    const c = categorias.clasificacionDe(p.id);
    if (c && porEstado[c.classification_status] !== undefined) porEstado[c.classification_status] += 1;
  }

  const chips = cats.map((c) => {
    const n = categorias.productosDe(c.clave).length;
    return `<a class="chip${catFiltro === c.clave ? ' on' : ''}"
      href="/api/chacon/panel?v=clasificacion&amp;cat=${c.clave}&amp;${tk}">${esc(c.nombre)} <b>${n}</b></a>`;
  }).join('');

  const fichas = lista.slice(0, 40).map((p) => {
    const c = categorias.clasificacionDe(p.id) || {};
    const revisado = c.classification_status === 'revisado_por_persona';
    const dudoso = c.classification_status === 'pending_review';
    const opciones = cats.map((x) => `<option value="${x.clave}"${
      x.clave === (c.categoria_efectiva || 'otros') ? ' selected' : ''}>${esc(x.nombre)}</option>`).join('');
    return `<div class="card">
      <h3><code>${esc(p.codigo)}</code> ${esc(p.descripcion)}
        ${revisado ? '<span class="ok">revisado por ' + esc(c.classification_reviewed_by || '') + '</span>'
          : dudoso ? '<span class="warn">a revisar</span>' : '<span class="sub">automático</span>'}</h3>
      <p class="sub">${esc(p.marca || 'sin marca')} · ${esc(c.classification_source || '')}
        ${c.motivo ? ' · ' + esc(c.motivo) : ''}</p>
      <form method="post" action="/api/chacon/panel?v=clasificacion&amp;${tk}" class="pf">
        <input type="hidden" name="accion" value="clasificar">
        <input type="hidden" name="producto_id" value="${esc(p.id)}">
        <div class="g">
          <label>Familia<select name="primary_category">${opciones}</select></label>
          <label>Subcategoría<input name="subcategory" value="${esc(c.subcategory || '')}"></label>
          <label class="w2">Etiquetas (separadas por comas)<input name="tags" value="${esc((c.tags || []).join(', '))}"></label>
          <label>Orden<input name="display_order" value="${esc(c.display_order || '')}"></label>
          <label>Tu nombre<input name="por" value="${esc(c.classification_reviewed_by || '')}" required></label>
        </div>
        <div class="row"><button type="submit">Guardar familia</button></div>
      </form>
    </div>`;
  }).join('');

  return `<p class="sub">${porEstado.auto_confirmado} automáticos ·
    <b class="warn">${porEstado.pending_review} a revisar</b> ·
    ${porEstado.revisado_por_persona} revisados por una persona.
    <br>Lo que está <b>a revisar</b> se enseña en «Otros productos» hasta que alguien lo confirme:
    es preferible eso a que una tienda busque quesos y le salga un membrillo.</p>
  <div class="chips">${chips}</div>
  <form method="get" action="/api/chacon/panel"><input type="hidden" name="v" value="clasificacion">
    <input type="hidden" name="token" value="${esc(tk.replace('token=', ''))}">
    <input name="q" value="${esc(busca)}" placeholder="Busca un producto por código o nombre">
    <button type="submit">Buscar</button></form>
  ${fichas || '<p class="sub">Nada pendiente de revisar aquí.</p>'}`;
}

/* ---- imágenes: qué se puede enviar y qué no ---------------------------- */
function vistaImagenes(estadoFiltro, tk) {
  const todas = imagenes.todas();
  const t = imagenes.totales();
  const filtro = estadoFiltro || '';
  const lista = filtro ? todas.filter((r) => r.estado === filtro) : todas;

  const COLOR = { verified: 'ok', pending_review: 'warn', conflict: 'bad', missing: 'sub' };
  const chips = ['verified', 'pending_review', 'conflict', 'missing'].map((e) =>
    `<a class="chip${filtro === e ? ' on' : ''}"
       href="/api/chacon/panel?v=imagenes&amp;estado=${e}&amp;${tk}">${e} <b>${t[e] || 0}</b></a>`).join('');

  const tarjetas = lista.slice(0, 120).map((r) => `<figure class="im">
    ${r.archivo && imagenes.BASE ? `<img src="${esc(imagenes.BASE)}/${esc(r.archivo)}" loading="lazy" alt="">`
      : '<div class="sin">sin foto que enviar</div>'}
    <figcaption><b>[${esc(r.codigo)}]</b> ${esc(r.descripcion)}<br>
      <span class="${COLOR[r.estado]}">${esc(r.estado)}</span>
      <span class="sub">pág. ${esc(r.pagina)} · pos. ${esc(r.posicion)}</span><br>
      <span class="sub">${esc(r.motivo || '')}</span></figcaption></figure>`).join('');

  return `<p class="sub"><b>Solo se envían por WhatsApp las <span class="ok">verified</span>.</b>
    Una foto equivocada es peor que ninguna: el resto va solo con texto.
    ${imagenes.BASE ? '' : '<br><span class="warn">CHACON_IMAGENES_BASE_URL sin configurar: '
      + 'ahora mismo NO se envía ninguna foto, aunque esté verificada.</span>'}</p>
  <div class="chips">${chips}</div>
  <div class="mos">${tarjetas}</div>`;
}

/* ---- simulador: ver el flujo sin gastar un WhatsApp -------------------- */
async function vistaSimulador(msg, tk) {
  const TEL = 'simulador';
  const pantallas = [];

  if (!msg) {
    pantallas.push(formato.accesosRapidos('Hola, Carnicería de prueba. ¿Qué necesitas hoy?'));
    pantallas.push(formato.menuCategorias(navegacion.listarCategorias()));
  } else {
    const r = await navegacion.mostrar(TEL, { consulta: msg });
    if (r.ok) pantallas.push(...formato.paginaDeProductos(r, { titulo: `Esto tengo de «${msg}»:` }));
    else {
      pantallas.push(formato.texto('No he reconocido esa familia. Te enseño las que hay:'));
      pantallas.push(formato.menuCategorias(r.categorias || navegacion.listarCategorias()));
    }
  }

  const burbujas = pantallas.map((p) => {
    const cuerpo = esc(formato.aTexto(p)).replace(/\n/g, '<br>');
    const foto = p.type === 'image'
      ? `<img src="${esc(p.image.link)}" alt="">` : '';
    return `<div class="bu"><span class="tp">${p.type}</span>${foto}<div>${cuerpo}</div></div>`;
  }).join('');

  return `<p class="sub">Así se ve el flujo sin gastar un mensaje real. Cada burbuja es un mensaje
    de WhatsApp; <b>${esc(formato.INTERACTIVO ? 'interactivos activados' : 'interactivos apagados')}</b>.
    Debajo de cada una está su versión en texto, que es la que se envía si el proveedor
    rechaza el formato.</p>
  <form method="get" action="/api/chacon/panel"><input type="hidden" name="v" value="simulador">
    <input type="hidden" name="token" value="${esc(tk.replace('token=', ''))}">
    <input name="msg" value="${esc(msg)}" placeholder="Escribe lo que diría la tienda: quesos, chorizos, de pollo…">
    <button type="submit">Simular</button></form>
  <div class="chat">${burbujas}</div>`;
}


/* ---- tarifas: versiones, diff, aprobación, ofertas --------------------- */
function vistaTarifas(tk, verV2) {
  const r = tarifas.resumen();
  const vs = tarifas.versiones();
  const adv = r.advertencia_tarifa_4;

  const estado = r.motor_v2_encendido
    ? (r.aprobada
      ? `<p class="ok">Motor de tarifas <b>ENCENDIDO</b> · versión activa ${esc(r.version_activa)}
         aprobada por ${esc(r.aprobada_por || '?')}.</p>`
      : '<p class="bad">Motor encendido pero SIN versión aprobada: el agente no tiene precios.</p>')
    : `<p class="warn">Motor de tarifas <b>APAGADO</b> (<code>CHACON_TARIFAS_V2</code> sin poner a 1).
       El agente sigue con el comportamiento anterior. Hay ${vs.length} versión(es) importada(s).</p>`;

  const filasV = vs.map((v) => {
    const activa = v.version === r.version_activa;
    const marca = activa ? '<span class="ok">ACTIVA</span>'
      : v.approved ? '<span class="pill">aprobada</span>'
        : '<span class="warn">pendiente</span>';
    const inv = v.invariantes_fallidos
      ? `<span class="bad">${esc(v.invariantes_fallidos)} invariantes fallidos</span>`
      : '<span class="ok">invariantes en verde</span>';
    return `<tr><td><code>v${esc(v.version)}</code></td>
      <td>${esc(String(v.generado).slice(0, 16).replace('T', ' '))}</td>
      <td>${esc(v.registros)}</td><td>${inv}</td><td>${marca}</td>
      <td><span class="sub">${esc(String(v.source_sha256 || '').slice(0, 12))}</span></td></tr>`;
  }).join('');

  const porTarifa = Object.entries(r.resumen_por_tarifa || {})
    .map(([k, n]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(n)}</td></tr>`).join('');

  const ofs = r.aprobada ? tarifas.ofertasActivas({ tier: '1' }) : [];
  const filasOf = ofs.map((o) => {
    const t = tarifas.tramosDe(o.product_code);
    const celdas = ['1', '2', '3', '4'].map((n) => {
      const p = t[n];
      if (!p) return '<td class="sub">—</td>';
      return `<td>${esc(tarifas.mostrar(p.normal_e4))}<br>
        <span class="ok">${esc(tarifas.mostrar(p.oferta_e4))}</span></td>`;
    }).join('');
    return `<tr><td><code>${esc(o.product_code)}</code></td>
      <td>${esc(o.product_name)}</td>${celdas}</tr>`;
  }).join('');

  const huerfanos = r.aprobada ? tarifas.legadoSinCorrespondencia() : [];
  const filasH = huerfanos.map((h) => `<tr><td><code>${esc(h.product_code)}</code></td>
    <td>${esc(h.price_display)} €</td><td><span class="bad">${esc(h.estado)}</span></td>
    <td class="sub">${esc(h.motivo)}</td></tr>`).join('');

  const esp = r.aprobada ? tarifas.tarifasEspeciales() : [];
  const porEsp = {};
  for (const e of esp) porEsp[e.tariff_code] = (porEsp[e.tariff_code] || 0) + 1;

  const internos = r.aprobada ? tarifas.articulosInternos() : [];
  const filasI = internos.map((x) => `<tr><td><code>${esc(x.product_code)}</code></td>
    <td>${esc(x.product_name)}</td><td>${esc(x.price_display)} €</td>
    <td><span class="warn">${esc(x.review_status || 'revisar')}</span></td></tr>`).join('');

  return `${estado}
  <div class="card"><h3>⚠️ Umbral de la tarifa 4 — pendiente de ${esc(adv.pendiente_de)}</h3>
    <p class="sub">El PDF la titula <b>«${esc(adv.etiqueta_pdf)}»</b>; la instrucción comercial
    dice <b>«${esc(adv.instruccion_comercial)}»</b>. ${esc(adv.por_que_importa)}
    <br>En el MVP se aplica: <b>${esc(adv.aplicado_en_el_mvp)}</b>
    (<code>CHACON_UMBRAL_TARIFA_4=${esc(adv.umbral_actual)}</code>).</p></div>

  <h3>Versiones</h3>
  <div class="wrap"><table><thead><tr><th>Versión</th><th>Importada</th><th>Registros</th>
    <th>Invariantes</th><th>Estado</th><th>SHA del PDF</th></tr></thead><tbody>${filasV
    || '<tr><td colspan="6" class="sub">Ninguna importada.</td></tr>'}</tbody></table></div>
  <p class="sub">Para aprobar y activar una versión:
    <code>python3 chacon-alcantara/import/extraer_tarifas.py --aprobar N --por "Nombre"</code>.
    Una versión con invariantes fallidos no se puede activar.</p>

  <h3>Registros por tarifa</h3>
  <div class="wrap"><table><thead><tr><th>Tarifa</th><th>Registros</th></tr></thead>
    <tbody>${porTarifa || '<tr><td colspan="2" class="sub">—</td></tr>'}</tbody></table></div>

  <h3>Ofertas — ${ofs.length} códigos, precio normal / <span class="ok">oferta</span> por tramo</h3>
  <div class="wrap"><table><thead><tr><th>Código</th><th>Producto</th>
    <th>T1 PIEZA</th><th>T2 ½ CAJA</th><th>T3 1 CAJA</th><th>T4 +CAJAS</th></tr></thead>
    <tbody>${filasOf || '<tr><td colspan="6" class="sub">Sin versión aprobada.</td></tr>'}</tbody></table></div>

  <h3>Precios antiguos sin correspondencia — evidencia, no tarifa</h3>
  <div class="wrap"><table><thead><tr><th>Código</th><th>Precio</th><th>Estado</th><th>Motivo</th>
    </tr></thead><tbody>${filasH || '<tr><td colspan="4" class="sub">—</td></tr>'}</tbody></table></div>

  <h3>Tarifas especiales — importadas, FUERA del flujo público</h3>
  <p class="sub">${Object.entries(porEsp).map(([k, n]) => `${esc(k)}: ${n}`).join(' · ') || '—'}.
    Solo se aplican por asociación explícita y aprobada entre cliente y tarifa. Nunca por
    nombre, teléfono ni parecido.</p>

  <h3>Artículos internos y códigos OF — no se publican solos</h3>
  <div class="wrap"><table><thead><tr><th>Código</th><th>Nombre</th><th>Precio</th>
    <th>Estado</th></tr></thead><tbody>${filasI
    || '<tr><td colspan="4" class="sub">—</td></tr>'}</tbody></table></div>`;
}

/* ---- base de facturación ------------------------------------------------ */
async function vistaFacturacion(tk, q) {
  const overrides = await repo.facturacionesRevisadas().catch(() => ({}));
  const todas = facturacion.todas();
  const busca = String(q || '').trim().toLowerCase();

  const entradas = Object.entries(todas)
    .filter(([cod, v]) => (busca
      ? cod.toLowerCase().includes(busca)
      : (overrides[cod] ? false : v.billing_unit === 'unknown')))
    .slice(0, 40);

  const cuenta = { kg: 0, unit: 0, box: 0, unknown: 0 };
  for (const cod of Object.keys(todas)) {
    cuenta[facturacion.baseDe(cod, overrides).billing_unit] += 1;
  }

  const fichas = entradas.map(([cod, v]) => {
    const b = facturacion.baseDe(cod, overrides);
    const ops = facturacion.BASES.map((x) =>
      `<option value="${x}"${x === b.billing_unit ? ' selected' : ''}>${x}</option>`).join('');
    return `<div class="card">
      <h3><code>${esc(cod)}</code>
        ${b.approved ? '<span class="ok">' + esc(b.billing_unit) + '</span>'
          : '<span class="warn">' + esc(b.billing_unit) + '</span>'}
        <span class="sub">${esc(b.origen)}${b.revisado_por ? ' · ' + esc(b.revisado_por) : ''}</span></h3>
      <p class="sub">${v.review_status ? '⚠️ ' + esc(v.review_status) : 'sin marcas'}
        ${v.units_per_box ? ' · ' + esc(v.units_per_box) + ' uds/caja' : ''}
        ${v.peso_und_kg ? ' · ' + esc(v.peso_und_kg) + ' kg/ud' : ''}</p>
      <form method="post" action="/api/chacon/panel?v=facturacion&amp;${tk}" class="pf">
        <input type="hidden" name="accion" value="facturacion">
        <input type="hidden" name="product_code" value="${esc(cod)}">
        <div class="g">
          <label>Base de facturación<select name="billing_unit">${ops}</select></label>
          <label class="ck"><input type="checkbox" name="customer_visible" value="on"${
            v.customer_visible ? ' checked' : ''}> Visible para tiendas</label>
          <label>Tu nombre<input name="por" required></label>
        </div>
        <div class="row"><button type="submit">Guardar</button></div>
      </form></div>`;
  }).join('');

  return `<p class="sub">La base de facturación <b>no se deduce</b> de las etiquetas del PDF:
    de «PIEZA» no se sigue que el precio sea por unidad. Con <code>unknown</code> el agente
    puede decir el precio de la tarifa pero <b>no dar un subtotal como definitivo</b>.
    <br>kg: ${cuenta.kg} · unidad: ${cuenta.unit} · caja: ${cuenta.box} ·
    <b class="warn">sin confirmar: ${cuenta.unknown}</b></p>
  <form method="get" action="/api/chacon/panel"><input type="hidden" name="v" value="facturacion">
    <input type="hidden" name="token" value="${esc(tk.replace('token=', ''))}">
    <input name="q" value="${esc(busca)}" placeholder="Busca un código">
    <button type="submit">Buscar</button></form>
  ${fichas || '<p class="sub">Nada sin confirmar.</p>'}`;
}


/* ---- clientes: canal y marketing, separados --------------------------- */
async function vistaClientesPrivacidad(tk) {
  const clientes = await repo.listarClientes();
  const registros = await repo.listarPrivacidades().catch(() => []);
  const porTel = new Map(registros.map((r) => [r.phone_number, r]));

  const sinFicha = registros.filter((r) => !r.customer_id);
  const ESTADOS_CLIENTE = ['pendiente_aprobacion', 'verificado', 'bloqueado'];

  const filas = clientes.map((c) => {
    const tel = (c.telefonos || [])[0] || '';
    const r = porTel.get(tel);
    const canal = r && r.status === 'aceptado'
      ? `<span class="ok">autorizado</span><br><span class="sub">${esc(r.privacy_notice_version)} · `
        + `${esc(String(r.accepted_at || '').slice(0, 16).replace('T', ' '))}</span>`
      : r && r.status === 'rechazado'
        ? '<span class="bad">rechazado</span>'
        : '<span class="warn">sin registro</span>';
    const mk = r && r.marketing_opt_in
      ? `<span class="ok">sí</span><br><span class="sub">${esc(String(r.marketing_opt_in_at || '').slice(0, 10))}</span>`
      : `<span class="sub">no</span>${r && r.marketing_opt_out_at
        ? `<br><span class="sub">baja ${esc(String(r.marketing_opt_out_at).slice(0, 10))}</span>` : ''}`;
    const ops = ESTADOS_CLIENTE.map((e) =>
      `<option value="${e}"${e === c.estado ? ' selected' : ''}>${e}</option>`).join('');
    return `<tr>
      <td><b>${esc(c.display_name || c.nombre)}</b>
        <br><span class="sub">${c.customer_code
          ? `cód. ${esc(c.customer_code)}${c.customer_center ? ` · centro ${esc(c.customer_center)}` : ''}`
          : esc(c.id)}</span>
        ${c.legal_name && c.legal_name !== (c.display_name || c.nombre)
          ? `<br><span class="sub">${esc(c.legal_name)}</span>` : ''}
        ${c.center_status === 'sin_resolver'
          ? '<br><span class="warn">centro sin resolver</span>' : ''}
        ${c.link_status ? `<br><span class="ok">${esc(c.link_status)}</span>` : ''}</td>
      <td>+${esc(tel)}</td>
      <td>${canal}</td>
      <td>${mk}</td>
      <td><form method="post" action="/api/chacon/panel?v=clientes&amp;${tk}" class="pf">
        <input type="hidden" name="accion" value="cliente_estado">
        <input type="hidden" name="cliente_id" value="${esc(c.id)}">
        <div class="g"><label>Estado<select name="estado">${ops}</select></label>
        <label>Tu nombre<input name="por" required></label></div>
        <div class="row"><button type="submit">Guardar</button></div></form>
        <form method="post" action="/api/chacon/panel?v=clientes&amp;${tk}" class="pf">
        <input type="hidden" name="accion" value="marketing">
        <input type="hidden" name="telefono" value="${esc(tel)}">
        <input type="hidden" name="valor" value="${r && r.marketing_opt_in ? '0' : '1'}">
        <div class="row"><label>Tu nombre<input name="por" required style="width:120px"></label>
        <button type="submit">${r && r.marketing_opt_in ? 'Quitar' : 'Activar'} marketing</button>
        </div></form></td></tr>`;
  }).join('');

  const ag = agendaClientes.resumen();
  return `<p class="sub">Agenda oficial: <code>${esc(ag.source_file || 'sin importar')}</code>
    · v${esc(ag.version_activa || '—')} · ${esc(ag.clientes_unicos || 0)} clientes
    · ${esc(ag.multi_centro || 0)} con varios centros.
    Un negocio que no esté en la agenda <b>no puede identificarse solo</b>.</p>
  <p class="sub"><b>Autorización del canal</b> y <b>marketing</b> son cosas distintas:
    la primera hace falta para gestionar pedidos, la segunda es opcional y rechazarla no impide
    comprar. Por eso no hay una sola casilla de «consentimiento».
    <br>Aviso vigente: <code>${esc(privacidad.VERSION_AVISO)}</code> ·
    política: ${privacidad.urlPolitica()
      ? `<code>${esc(privacidad.urlPolitica())}</code>`
      : '<span class="warn">SIN CONFIGURAR (CHACON_PRIVACIDAD_URL)</span>'}</p>
  <div class="wrap"><table><thead><tr><th>Cliente</th><th>Teléfono</th>
    <th>Canal WhatsApp</th><th>Ofertas</th><th>Acciones</th></tr></thead>
    <tbody>${filas || '<tr><td colspan="5" class="sub">Sin clientes.</td></tr>'}</tbody></table></div>
  ${sinFicha.length ? `<h3>Teléfonos con aviso pero sin ficha (${sinFicha.length})</h3>
    <div class="wrap"><table><thead><tr><th>Teléfono</th><th>Estado</th><th>Cuándo</th>
    </tr></thead><tbody>${sinFicha.map((r) => `<tr><td>+${esc(r.phone_number)}</td>
    <td>${esc(r.status)}</td><td>${esc(String(r.accepted_at || r.declined_at || '').slice(0, 16).replace('T', ' '))}</td></tr>`).join('')}
    </tbody></table></div>` : ''}`;
}

function vistaPedidos(pedidos, tk) {
  if (!pedidos.length) return '<p class="sub">Sin solicitudes todavía.</p>';

  // Agrupadas por tienda: así se ve el historial de cada una de un vistazo,
  // que es lo que hace falta para repetir un pedido.
  const porTienda = new Map();
  for (const p of pedidos) {
    const k = p.cliente?.id || '(sin tienda)';
    if (!porTienda.has(k)) porTienda.set(k, []);
    porTienda.get(k).push(p);
  }

  const bloques = [...porTienda.values()].map((grupo) => {
    const c = grupo[0].cliente || {};
    const filas = grupo.map((p) => {
      const lineas = (p.lineas || []).map((l) => {
        const precio = l.precio_kg_sin_iva === null || l.precio_kg_sin_iva === undefined
          ? '<span class="warn">precio pendiente</span>'
          : `${esc(String(l.precio_kg_sin_iva).replace('.', ','))} €/kg${l.es_oferta ? ' <span class="ok">oferta</span>' : ''}`;
        return `${esc(l.codigo)} ×${l.cantidad} ${esc(l.unidad_pedido)} · ${precio}`;
      }).join('<br>');
      const avisos = fabrica.avisosInternos(p);
      const t = p.totales || {};
      return `<tr><td><code>${esc(p.id)}</code>
          ${p.repite_pedido ? `<br><span class="sub">🔁 repite ${esc(p.repite_pedido)}</span>` : ''}
          ${p.modificaciones_aplicadas?.length ? `<br><span class="sub">${esc(p.modificaciones_aplicadas.join('; '))}</span>` : ''}</td>
        <td>${esc(p.creado).slice(0, 16).replace('T', ' ')}</td>
        <td><span class="pill">${esc(p.estado)}</span></td><td>${lineas}</td>
        <td>${eur(t.base_estimada_sin_iva)}<br><span class="sub">estimado s/IVA</span>
          ${t.lineas_pendientes_revision ? `<br><span class="warn">${t.lineas_pendientes_revision} sin importe</span>` : ''}</td>
        <td>${avisos.length ? `<span class="warn">${avisos.map(esc).join('<br>')}</span>` : '<span class="sub">—</span>'}</td>
        <td>${celdaEnvio(p, tk)}
          <form method="post" action="/api/chacon/panel?${tk}" style="margin:6px 0 0">
            <input type="hidden" name="accion" value="duplicar">
            <input type="hidden" name="pedido" value="${esc(p.id)}">
            <button type="submit">Duplicar como borrador</button></form></td></tr>`;
    }).join('');
    return `<h3>${esc(c.nombre || '(sin tienda)')} <span class="sub">${esc(c.id || '')} · +${esc(c.telefonos?.[0] || '?')} · ${grupo.length} solicitud(es)</span></h3>
      <div class="wrap"><table><thead><tr><th>Solicitud</th><th>Fecha</th><th>Estado</th><th>Líneas</th>
      <th>Importe</th><th>Avisos internos</th><th>Envío interno</th></tr></thead><tbody>${filas}</tbody></table></div>`;
  }).join('');
  return bloques;
}

function vistaCatalogo(q) {
  const r = q ? catalogo.buscar(q, { limite: 200 }) : { candidatos: catalogo.todos().slice(0, 200), total: catalogo.todos().length };
  const filas = r.candidatos.map((p) => `<tr>
    <td><code>${esc(p.codigo)}</code></td><td>${esc(p.descripcion)}</td><td>${esc(p.marca)}</td>
    <td>${esc(p.und_caja)}</td><td>${p.peso_und_kg || '<span class="warn">0</span>'}</td>
    <td>${p.bloqueado_para_calculo_precio ? '<span class="warn">bloqueado</span>' : esc(p.tarifa) + ' €/kg'}</td>
    <td>${p.gluten === null ? '<span class="muted">?</span>' : (p.gluten ? 'SÍ' : 'no')}</td>
    <td>${p.lactosa === null ? '<span class="muted">?</span>' : (p.lactosa ? 'SÍ' : 'no')}</td>
    <td><span class="pill">${esc(p.estado)}</span></td><td class="sub">p.${p._origen.pagina}</td></tr>`).join('');
  return `<form><input type="hidden" name="v" value="catalogo">
    <input type="hidden" name="token" value="">
    <input name="q" placeholder="código, EAN, nombre, marca…" value="${esc(q)}" size="34"></form>
    <p class="sub">${r.total ?? r.candidatos.length} resultado(s). Precio por kilo, sin IVA. "?" = dato no informado, no es "no".</p>
    <div class="wrap"><table><thead><tr><th>Código</th><th>Descripción</th><th>Marca</th><th>U/caja</th>
    <th>Peso u.</th><th>Tarifa</th><th>Gluten</th><th>Lactosa</th><th>Estado</th><th>Origen</th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;
}

/** Formulario de precio/oferta de un producto. El corazón del panel. */
function formPrecio(p, reg, tk, { compacto = false } = {}) {
  const v = (x) => (x === null || x === undefined ? '' : esc(x));
  const est = ofertas.estadoOferta(reg);
  const badge = reg.offer_price_per_kg === null ? '<span class="sub">sin oferta</span>'
    : est.visible ? '<span class="ok">oferta visible</span>'
      : `<span class="warn">oferta no visible (${esc(est.motivo)})</span>`;
  const firma = reg.offer_validated_by
    ? `<span class="sub">validado por ${esc(reg.offer_validated_by)} el ${esc(String(reg.offer_validated_at).slice(0, 16).replace('T', ' '))}</span>`
    : '<span class="sub">sin validar</span>';

  return `<form method="post" action="/api/chacon/panel?v=ofertas&amp;${tk}" class="pf">
    <input type="hidden" name="accion" value="precio">
    <input type="hidden" name="producto_id" value="${esc(p.id)}">
    <div class="g">
      <label>Precio normal T1 €/kg<input name="standard_price_per_kg" value="${v(reg.standard_price_per_kg)}"
        placeholder="${p.bloqueado_para_calculo_precio ? 'sin resolver' : v(p.tarifa)}"></label>
      <label>Precio de oferta €/kg<input name="offer_price_per_kg" value="${v(reg.offer_price_per_kg)}"></label>
      <label>Desde<input type="date" name="offer_start_date" value="${v(reg.offer_start_date)}"></label>
      <label>Hasta<input type="date" name="offer_end_date" value="${v(reg.offer_end_date)}"></label>
      <label>Cantidad mínima<input name="offer_min_quantity" value="${v(reg.offer_min_quantity)}"></label>
      <label>Unidad de la oferta<select name="offer_unit">
        <option value=""${!reg.offer_unit ? ' selected' : ''}>—</option>
        <option value="caja"${reg.offer_unit === 'caja' ? ' selected' : ''}>caja</option>
        <option value="unidad"${reg.offer_unit === 'unidad' ? ' selected' : ''}>unidad</option>
        <option value="kg"${reg.offer_unit === 'kg' ? ' selected' : ''}>kg</option>
      </select></label>
      <label class="w2">Condiciones<input name="offer_conditions" value="${v(reg.offer_conditions)}"
        placeholder="Se le enseña tal cual a la tienda"></label>
      <label>Tu nombre<input name="por" value="${v(reg.offer_validated_by)}" required></label>
      <label class="ck"><input type="checkbox" name="offer_active" value="on"${reg.offer_active ? ' checked' : ''}> Oferta activa</label>
    </div>
    <div class="row">${badge} · ${firma}
      <button type="submit">Guardar</button></div>
  </form>${compacto ? '' : ''}`;
}

/** Ofertas y precios de Tarifa 1. Aquí se dan de alta y se activan. */
async function vistaOfertas(tk, q) {
  const busca = String(q || '').trim();
  const activas = await ofertas.activas();
  const decididos = await repo.listarPrecios();
  const conDecision = new Set(decididos.map((r) => r.producto_id));

  // Sin búsqueda se muestran solo los productos con alguna decisión tomada:
  // pintar 112 formularios no ayuda a nadie.
  const lista = busca
    ? catalogo.buscar(busca).candidatos.slice(0, 12)
    : catalogo.todos().filter((p) => conDecision.has(p.id));

  const resumen = activas.length
    ? `<p class="ok">${activas.length} oferta(s) visibles ahora mismo para las tiendas: `
      + activas.map((o) => `${esc(o.codigo)} a ${esc(String(o.precio_oferta_kg).replace('.', ','))} €/kg`).join(' · ') + '</p>'
    : '<p class="sub">No hay ninguna oferta activa. El agente responde que no tiene ofertas registradas.</p>';

  const fichas = [];
  for (const p of lista) {
    const reg = await ofertas.get(p.id);
    const hist = (reg.historial || []).slice(-3).reverse().map((h) =>
      `<li>${esc(String(h.ts).slice(0, 16).replace('T', ' '))} · ${esc(h.por)}` +
      `${h.nota ? ' · ' + esc(h.nota) : ''}</li>`).join('');
    fichas.push(`<div class="card">
      <h3><code>${esc(p.codigo)}</code> ${esc(p.descripcion)} ${p.marca ? '<span class="sub">' + esc(p.marca) + '</span>' : ''}</h3>
      <p class="sub">Catálogo: ${p.bloqueado_para_calculo_precio
        ? '<span class="warn">' + esc(p.estado) + '</span>'
        : esc(String(p.tarifa).replace('.', ',')) + ' €/kg'} ·
        ${p.und_caja || '?'} uds/caja · ${p.peso_und_kg ? esc(String(p.peso_und_kg).replace('.', ',')) + ' kg/ud' : '<span class="warn">sin peso</span>'}</p>
      ${formPrecio(p, reg, tk)}
      ${hist ? `<details><summary class="sub">Historial de cambios</summary><ul class="sub">${hist}</ul></details>` : ''}
    </div>`);
  }

  return `${resumen}
    <form method="get" action="/api/chacon/panel"><input type="hidden" name="v" value="ofertas">
      <input type="hidden" name="token" value="${esc(tk.replace('token=', ''))}">
      <input name="q" value="${esc(busca)}" placeholder="Busca un producto por código o nombre para fijar su precio">
      <button type="submit">Buscar</button></form>
    ${lista.length ? fichas.join('') : '<p class="sub">Busca un producto arriba para fijar su precio normal o darle una oferta.</p>'}`;
}

async function vistaConflictos(tk) {
  const porCodigo = new Map();
  for (const p of catalogo.todos()) {
    if (p.estado !== 'tariff_variant_unresolved' && p.estado !== 'promotion_requires_validation') continue;
    if (!porCodigo.has(p.codigo)) porCodigo.set(p.codigo, []);
    porCodigo.get(p.codigo).push(p);
  }

  const fichas = [];
  for (const [cod, g] of [...porCodigo.entries()].sort()) {
    const reg = await ofertas.get(g[0].id);
    const resuelto = reg.standard_price_per_kg !== null;
    const precios = g.map((p) => `${esc(String(p.tarifa).replace('.', ','))} €/kg `
      + `<span class="sub">(pág. ${esc(p._origen.pagina)})</span>`).join(' &nbsp;·&nbsp; ');
    fichas.push(`<div class="card">
      <h3><code>${esc(cod)}</code> ${esc(g[0].descripcion)}
        ${resuelto ? '<span class="ok">resuelto</span>' : '<span class="warn">sin resolver</span>'}</h3>
      <p class="sub">Precios en el PDF: ${precios}</p>
      <p class="sub">${esc(g[0].evidencia_tarifa || g[0].avisos.join(', '))}</p>
      ${formPrecio(g[0], reg, tk)}
    </div>`);
  }

  return `<p class="sub">El PDF trae dos precios para estos códigos y <b>no dice cuál está vigente</b>:
    no hay etiqueta de oferta, el orden de aparición no lo indica y el más bajo no es
    necesariamente una promoción. Se comprobó y no se sostiene, así que el sistema no elige.
    <br>Mientras siga sin resolver, la tienda <b>puede pedir el producto</b> pero el agente le dice
    que el precio lo confirma Chacón. Escribe abajo el precio normal de Tarifa 1 —y, si el otro
    era una oferta, márcalo como tal— para desbloquearlo.</p>${fichas.join('')}`;
}

function vistaClientes(clientes) {
  if (!clientes.length) return '<p class="sub">Sin tiendas registradas todavía.</p>';
  const filas = clientes.map((c) => `<tr><td><code>${esc(c.id)}</code></td><td>${esc(c.nombre)}</td>
    <td>${(c.telefonos || []).map((t) => '+' + esc(t)).join('<br>')}</td>
    <td>${esc(c.contacto || '')}</td><td><span class="pill">${esc(c.estado)}</span></td>
    <td class="sub">${esc(c.creado).slice(0, 10)}</td></tr>`).join('');
  return `<div class="wrap"><table><thead><tr><th>ID</th><th>Nombre comercial</th><th>Teléfonos</th>
    <th>Contacto</th><th>Estado</th><th>Alta</th></tr></thead><tbody>${filas}</tbody></table></div>`;
}

function vistaConfig(actual) {
  const filas = PENDIENTES.map(([k, t]) => {
    const v = actual[k];
    return `<tr><td><code>${esc(k)}</code></td><td>${esc(t)}</td>
      <td>${v === undefined || v === null
        ? '<span class="warn">pendiente de Chacón</span>'
        : '<span class="ok">' + esc(JSON.stringify(v)).slice(0, 90) + '</span>'}</td></tr>`;
  }).join('');
  return `<p class="sub">Mientras una regla siga pendiente, el sistema pide validación humana
    o informa de la limitación. <b>Nunca la inventa.</b></p>
    <div class="wrap"><table><thead><tr><th>Clave</th><th>Qué falta</th><th>Valor</th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;
}
