/* ============================================================
   GET /api/chacon/panel?token=…  — panel interno de Chacón.

   Vistas: pedidos · catálogo · conflictos de tarifa · clientes · config
   pendiente. Protegido con el mismo PANEL_TOKEN del proyecto.

   Muestra pedidos y teléfonos de clientes reales: nunca sin token.
   ============================================================ */

const crypto = require('crypto');
const repo = require('../../lib/chacon/repo');
const catalogo = require('../../lib/chacon/catalogo');
const pedidoLib = require('../../lib/chacon/pedido');
const fabrica = require('../../lib/chacon/fabrica');

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
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const want = process.env.PANEL_TOKEN || '';
  const got = (req.query && req.query.token) || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!want) return res.status(503).send('PANEL_TOKEN no configurado.');
  if (!mismoToken(got, want)) return res.status(403).send('<h1>403</h1><p>Falta el token.</p>');

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
      cuerpo = vistaConflictos();
    } else if (vista === 'clientes') {
      cuerpo = vistaClientes(await repo.listarClientes());
    } else if (vista === 'config') {
      cuerpo = vistaConfig(await repo.todaLaConfig());
    } else {
      cuerpo = vistaPedidos(await repo.listarPedidos({ limite: 100,
        cliente: req.query.cliente || null, estado: req.query.estado || null }));
    }
  } catch (err) {
    cuerpo = `<p class="warn">Error: ${esc(err.message)}</p>`;
  }

  const tabs = [['pedidos', 'Pedidos'], ['catalogo', 'Catálogo'], ['conflictos', 'Conflictos de tarifa'],
                ['clientes', 'Clientes'], ['config', 'Configuración pendiente']]
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
</style></head><body>
<h1>Chacón <span>Alcántara</span> — panel interno</h1>
<div class="sub">Importes sin IVA · almacenamiento ${esc(rd.backend)} · envío a fábrica: <code>${esc(fabrica.modo())}</code></div>
<div class="tabs">${tabs}</div>${cuerpo}</body></html>`);
};

function vistaPedidos(pedidos) {
  if (!pedidos.length) return '<p class="sub">Sin pedidos todavía.</p>';
  const filas = pedidos.map((p) => {
    const t = p.totales || {};
    const envio = p.envio_interno?.entregado ? '<span class="ok">entregado</span>'
      : `<span class="warn">${esc(p.envio_interno?.intentos?.slice(-1)[0]?.modo || 'sin enviar')}</span>`;
    const lineas = (p.lineas || []).map((l) =>
      `${esc(l.codigo)} ×${l.cantidad} ${esc(l.unidad_pedido)}`).join('<br>');
    return `<tr><td><code>${esc(p.id)}</code></td><td>${esc(p.creado).slice(0, 16).replace('T', ' ')}</td>
      <td>${esc(p.cliente?.nombre)}<br><span class="sub">+${esc(p.cliente?.telefonos?.[0])}</span></td>
      <td><span class="pill">${esc(p.estado)}</span></td><td>${lineas}</td>
      <td>${t.base_estimada_sin_iva !== null && t.base_estimada_sin_iva !== undefined
        ? esc(t.base_estimada_sin_iva) + ' €' : '<span class="warn">pendiente</span>'}
        ${t.lineas_pendientes_revision ? `<br><span class="warn">${t.lineas_pendientes_revision} línea(s) a revisar</span>` : ''}</td>
      <td>${envio}</td></tr>`;
  }).join('');
  return `<div class="wrap"><table><thead><tr><th>Pedido</th><th>Fecha</th><th>Tienda</th>
    <th>Estado</th><th>Líneas</th><th>Estimado s/IVA</th><th>Envío interno</th></tr></thead>
    <tbody>${filas}</tbody></table></div>`;
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

function vistaConflictos() {
  const porCodigo = new Map();
  for (const p of catalogo.todos()) {
    if (p.estado !== 'tariff_variant_unresolved' && p.estado !== 'promotion_requires_validation') continue;
    if (!porCodigo.has(p.codigo)) porCodigo.set(p.codigo, []);
    porCodigo.get(p.codigo).push(p);
  }
  const filas = [...porCodigo.entries()].sort().map(([cod, g]) => `<tr>
    <td><code>${esc(cod)}</code></td><td>${esc(g[0].descripcion)}</td>
    <td>${g.map((p) => `${esc(p.tarifa)} €/kg <span class="sub">(p.${p._origen.pagina})</span>`).join('<br>')}</td>
    <td><span class="pill">${esc(g[0].estado)}</span></td>
    <td class="sub">${esc(g[0].evidencia_tarifa || g[0].avisos.join(', '))}</td></tr>`).join('');
  return `<p class="sub">Estos artículos <b>se pueden buscar y pedir</b>, pero su precio no se calcula
    automáticamente hasta que Chacón indique cuál es la tarifa válida.</p>
    <div class="wrap"><table><thead><tr><th>Código</th><th>Descripción</th><th>Precios en el catálogo</th>
    <th>Estado</th><th>Evidencia</th></tr></thead><tbody>${filas}</tbody></table></div>`;
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
