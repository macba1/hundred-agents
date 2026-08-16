/* ============================================================
   GET /api/chacon/imagen?p=<producto_id> — foto de un artículo.

   WhatsApp descarga la imagen desde esta URL, así que tiene que ser pública
   y estable. Lo que NO es público es qué se sirve: **solo las `verified`**.
   Una foto en estado dudoso devuelve 404 aunque el archivo exista en disco.

   Ese filtro está aquí y no solo en el agente porque esta ruta es el último
   punto por el que pasa la imagen antes de salir. Si algún día otro camino
   pide una foto, seguirá sin poder sacar una sin verificar.

   No lleva token a propósito: los servidores de Meta no pueden autenticarse
   y el contenido es un catálogo comercial, no datos de clientes. Lo que sí
   se impide es enumerar: solo responde a IDs de producto que existen.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const imagenes = require('../../lib/chacon/imagenes');

const DIR = path.join(__dirname, '..', '..', 'chacon-alcantara', 'data');

const TIPOS = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif',
};

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const productoId = (req.query && (req.query.p || req.query.producto_id)) || '';
  const reg = imagenes.registro(String(productoId));

  if (!reg || !reg.archivo) return res.status(404).json({ error: 'sin_imagen' });
  if (reg.estado !== 'verified') {
    // Se registra: si esto aparece en los logs, alguien está intentando
    // enseñar una foto que no está confirmada.
    console.warn('[chacon][imagen] %s está en %s: no se sirve', productoId, reg.estado);
    return res.status(404).json({ error: 'imagen_no_verificada', estado: reg.estado });
  }

  // `archivo` viene del JSON generado por el importador, no del usuario, pero
  // se ancla igualmente: un path traversal aquí serviría cualquier fichero.
  const destino = path.resolve(DIR, reg.archivo);
  if (!destino.startsWith(path.resolve(DIR) + path.sep)) {
    console.error('[chacon][imagen] ruta fuera del directorio de datos:', reg.archivo);
    return res.status(400).json({ error: 'ruta_no_valida' });
  }

  let datos;
  try {
    datos = fs.readFileSync(destino);
  } catch (err) {
    console.error('[chacon][imagen] no se pudo leer %s: %s', reg.archivo, err.message);
    return res.status(404).json({ error: 'archivo_no_encontrado' });
  }

  res.setHeader('Content-Type', TIPOS[path.extname(destino).toLowerCase()] || 'application/octet-stream');
  // El catálogo cambia poco y WhatsApp vuelve a pedir la imagen en cada envío.
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (reg.sha256) res.setHeader('ETag', `"${reg.sha256.slice(0, 32)}"`);
  return res.status(200).send(datos);
};
