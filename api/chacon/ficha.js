/* ============================================================
   GET /api/chacon/ficha?p=<codigo> — ficha técnica del fabricante en PDF.

   WhatsApp descarga el documento desde esta URL, así que tiene que ser
   pública y estable: los servidores de Meta no pueden autenticarse. El
   contenido es documentación comercial del fabricante —la misma que va
   impresa en la caja—, no datos de clientes.

   Lo que sí se impide es enumerar: solo responde a códigos que existen en la
   versión APROBADA de fichas. Un código inventado devuelve 404 aunque haya
   un PDF con ese nombre en el disco, y una versión sin aprobar no sirve
   nada.

   Aquí se sirve el documento entero, tal cual lo entregó el fabricante. No
   se recorta ni se reescribe: si algo se le va a enseñar a una tienda sobre
   ingredientes o alérgenos, que sea el documento original.
   ============================================================ */

const fs = require('fs');

const fichas = require('../../lib/chacon/fichas');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const codigo = (req.query && (req.query.p || req.query.codigo)) || '';
  if (!codigo) return res.status(400).json({ error: 'falta_codigo' });

  if (!fichas.disponible()) return res.status(404).end();

  const ficha = fichas.porCodigo(codigo);
  const ruta = ficha && fichas.rutaPdf(codigo);
  if (!ruta) return res.status(404).end();

  let datos;
  try {
    datos = fs.readFileSync(ruta);
  } catch {
    return res.status(404).end();
  }

  res.setHeader('Content-Type', 'application/pdf');
  /* `inline` para que se abra dentro de WhatsApp en vez de forzar una
     descarga. El nombre lleva el código porque la tienda guarda la ficha y
     luego tiene que saber de qué producto era. */
  res.setHeader('Content-Disposition',
    `inline; filename="ficha-${ficha.product_code}.pdf"`);
  res.setHeader('Content-Length', String(datos.length));
  // Las fichas cambian con cada versión aprobada, no de un día para otro.
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.status(200).send(datos);
};
