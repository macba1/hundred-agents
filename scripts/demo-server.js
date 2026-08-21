/* ============================================================
   Servidor local para probar las demos de cliente sin Vercel.

       node scripts/demo-server.js
       -> http://localhost:4321/clientes/providencia/

   Sirve los archivos estáticos del repo y enruta /api/<ruta> al handler
   correspondiente de api/, igual que hace Vercel. Es solo para desarrollo:
   no hay cache, no hay compresión y no se despliega.

   La OPENAI_API_KEY se toma del entorno. Para cargarla desde un .env local:

       node -r ./scripts/env-local.js scripts/demo-server.js

   o exportándola en la terminal antes de arrancar.
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = path.join(__dirname, '..');
const PUERTO = Number(process.env.PORT || 4321);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
};

function leerCuerpo(req) {
  return new Promise((resolve) => {
    let datos = '';
    req.on('data', (c) => { datos += c; if (datos.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(datos ? JSON.parse(datos) : {}); } catch { resolve({}); }
    });
  });
}

/** Envuelve res con los ayudantes que esperan los handlers de Vercel. */
function adaptar(res) {
  res.status = function (c) { this.statusCode = c; return this; };
  res.json = function (o) {
    this.setHeader('Content-Type', 'application/json; charset=utf-8');
    this.end(JSON.stringify(o));
    return this;
  };
  res.send = function (t) { this.end(t); return this; };
  return res;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  let ruta = decodeURIComponent(parsed.pathname);

  /* ---- API: se resuelve contra api/<ruta>.js ---- */
  if (ruta.startsWith('/api/')) {
    const archivo = path.join(ROOT, ruta.replace(/\/$/, '') + '.js');
    if (!archivo.startsWith(path.join(ROOT, 'api')) || !fs.existsSync(archivo)) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'no_handler', ruta }));
      return;
    }
    try {
      delete require.cache[require.resolve(archivo)];  // recarga en caliente
      const handler = require(archivo);
      req.query = parsed.query;
      req.body = req.method === 'POST' ? await leerCuerpo(req) : {};
      await handler(req, adaptar(res));
    } catch (err) {
      console.error('[demo-server]', ruta, err.stack || err.message);
      if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(err.message) })); }
    }
    return;
  }

  /* ---- estáticos ---- */
  if (ruta.endsWith('/')) ruta += 'index.html';
  const archivo = path.join(ROOT, ruta);
  if (!archivo.startsWith(ROOT) || !fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
    // /clientes/providencia (sin barra) -> su index
    const conIndex = path.join(ROOT, ruta, 'index.html');
    if (fs.existsSync(conIndex)) {
      res.setHeader('Content-Type', MIME['.html']);
      res.end(fs.readFileSync(conIndex));
      return;
    }
    res.statusCode = 404;
    res.end('404 · ' + ruta);
    return;
  }
  res.setHeader('Content-Type', MIME[path.extname(archivo)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.end(fs.readFileSync(archivo));
});

server.listen(PUERTO, () => {
  console.log('\n  Demo local en marcha');
  console.log('  ────────────────────────────────────────────');
  console.log('  Providencia : http://localhost:' + PUERTO + '/clientes/providencia/');
  console.log('  Sanmi       : http://localhost:' + PUERTO + '/clientes/sanmi/');
  console.log('  Sitio       : http://localhost:' + PUERTO + '/');
  console.log('  OpenAI      : ' + (process.env.OPENAI_API_KEY ? 'configurado' : 'SIN CLAVE — el chat responderá 502'));
  console.log('  ────────────────────────────────────────────\n');
});
