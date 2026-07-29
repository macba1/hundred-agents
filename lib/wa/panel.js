/* ============================================================
   HTML for the live leads panel. Same layout as the old Python /leads:
   two counters, per-client tabs and a 5s auto-refresh.
   ============================================================ */

function esc(x) {
  return String(x == null ? '' : x)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** ts ISO (UTC) -> HH:MM:SS en la zona indicada. */
function horaLocal(ts, zona) {
  if (!ts) return '';
  try {
    return new Intl.DateTimeFormat('es-MX', {
      timeZone: zona, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date(ts));
  } catch { return String(ts).slice(11, 19); }
}

function render({ titulo, acento, contactos, total, rows, clientes, clienteSel, token, hora, zona, tests }) {
  const tk = token ? `&token=${encodeURIComponent(token)}` : '';

  let tabs = `<a href="/api/wa/leads?client=${tk}" class="${!clienteSel ? 'on' : ''}">Todos</a>`;
  for (const c of clientes) {
    const estado = c.activo ? '' : ' ·inactivo';
    tabs += `<a href="/api/wa/leads?client=${encodeURIComponent(c.clave)}${tk}" ` +
      `class="${clienteSel === c.clave ? 'on' : ''}">${esc(c.nombre)}${esc(estado)}</a>`;
  }

  let trs = '';
  for (const r of rows) {
    // La hora se muestra en la zona del negocio: el ts es UTC y verla cruda
    // hizo pensar que unos escalados eran de otra hora de la que fueron.
    const hhmm = horaLocal(r.ts, zona);
    const tel4 = String(r.phone || '').slice(-4);
    const totalTxt = r.total != null
      ? '$' + Number(r.total).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '';
    const badge = r.test ? '<span class="test">TEST</span> ' : '';
    trs += `<tr class="${r.test ? 'esTest' : ''}"><td>${esc(hhmm)}</td><td>${badge}${esc(r.client)}</td><td>…${esc(tel4)}</td>` +
      `<td>${esc(r.tipo)}</td><td>${esc(r.clasificacion)}</td><td>${esc(r.folio)}</td>` +
      `<td class='res'>${esc(String(r.resumen || '').slice(0, 80))}</td>` +
      `<td class='num'>${esc(totalTxt)}</td></tr>`;
  }

  return `<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta http-equiv="refresh" content="5">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(titulo)} — Leads en vivo</title>
<style>
  :root { --bg:#0b0b0d; --accent:${esc(acento)}; --fg:#f2f2f4; --muted:#8a8a92; --line:#1e1e22; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; padding:32px; }
  h1 { margin:0 0 4px; font-size:20px; letter-spacing:.5px; }
  h1 span { color:var(--accent); }
  .sub { color:var(--muted); margin-bottom:20px; font-size:13px; }
  .tabs { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:28px; }
  .tabs a { color:var(--muted); text-decoration:none; border:1px solid var(--line);
    padding:6px 14px; border-radius:999px; font-size:13px; }
  .tabs a.on { color:#0b0b0d; background:var(--accent); border-color:var(--accent); font-weight:600; }
  .cards { display:flex; gap:24px; margin-bottom:32px; flex-wrap:wrap; }
  .card { background:#131316; border:1px solid var(--line); border-radius:16px;
    padding:24px 32px; min-width:220px; }
  .card .n { font-size:64px; font-weight:800; color:var(--accent); line-height:1; }
  .card .l { color:var(--muted); text-transform:uppercase; font-size:12px;
    letter-spacing:1.5px; margin-top:10px; }
  .wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th,td { text-align:left; padding:10px 14px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); text-transform:uppercase; font-size:11px; letter-spacing:1px; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; color:var(--accent); }
  td.res { color:#cfcfd4; }
  tr.esTest td { opacity:.55; }
  .test { background:#3a3a44; color:#c9c9d2; font-size:10px; font-weight:700;
    padding:2px 6px; border-radius:4px; letter-spacing:.5px; }
  tr:hover td { background:#141418; }
</style></head><body>
  <h1>${esc(titulo)} — <span>leads en vivo</span></h1>
  <div class="sub">Hundred Agents · Vercel + Redis · auto-refresh 5s · ${esc(hora)}${tests ? ` · ${tests} de prueba (no cuentan)` : ''}</div>
  <div class="tabs">${tabs}</div>
  <div class="cards">
    <div class="card"><div class="n">${contactos}</div><div class="l">Contactos únicos</div></div>
    <div class="card"><div class="n">${total}</div><div class="l">Eventos totales</div></div>
  </div>
  <div class="wrap"><table>
    <thead><tr><th>Hora</th><th>Cliente</th><th>Tel</th><th>Tipo</th><th>Clasificación</th>
      <th>Folio</th><th>Resumen</th><th class="num">Total</th></tr></thead>
    <tbody>${trs || '<tr><td colspan="8" style="color:#8a8a92">Sin eventos todavía…</td></tr>'}</tbody>
  </table></div>
</body></html>`;
}

module.exports = { render, esc };
