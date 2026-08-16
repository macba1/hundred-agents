/* ============================================================
   Fotografías del catálogo.

   Regla única y no negociable: **solo se envía lo que está `verified`.**

   Una foto equivocada es peor que no enseñar ninguna. Si el agente le manda
   a una tienda la foto de un queso llamándolo chorizo, el error es del
   proveedor y la tienda pide mal. Sin foto, como mucho hay una consulta de
   más; con la foto equivocada hay un pedido mal servido.

   Los estados los fija `import/extraer_imagenes.py` por geometría, no por
   orden de aparición:
     verified        una sola foto en la banda vertical de la ficha
     pending_review  la misma foto sale en varias fichas
     conflict        varias fotos en la misma banda
     missing         el PDF no trae foto de esa ficha
   ============================================================ */

const fs = require('fs');
const path = require('path');

const RUTA = process.env.CHACON_IMAGENES
  || path.join(__dirname, '..', '..', 'chacon-alcantara', 'data', 'imagenes.json');

/**
 * Base pública del sitio. Sin ella no se manda ninguna foto: WhatsApp
 * descarga la imagen por HTTP y una ruta de disco no le sirve. Mandar un
 * enlace roto es peor que no mandar foto.
 */
const BASE = (process.env.CHACON_IMAGENES_BASE_URL || '').replace(/\/+$/, '');

let _cache = null;

function cargar() {
  if (_cache) return _cache;
  let datos = { imagenes: [], totales: {} };
  try {
    datos = JSON.parse(fs.readFileSync(RUTA, 'utf8'));
  } catch (err) {
    console.warn('[chacon] sin imagenes.json (%s): se opera solo con texto', err.code || err.message);
  }
  const porProducto = new Map();
  for (const r of datos.imagenes || []) porProducto.set(r.producto_id, r);
  _cache = { datos, porProducto };
  return _cache;
}

function recargar() { _cache = null; return cargar(); }

/** Registro completo, con su estado. Para el panel, no para WhatsApp. */
function registro(productoId) {
  return cargar().porProducto.get(productoId) || null;
}

/**
 * URL de la foto que SÍ se puede enviar, o null.
 *
 * Devuelve null en todo lo que no sea `verified`, y también si no hay una
 * base pública configurada: una ruta de disco no le sirve a WhatsApp, y
 * mandar un enlace roto es peor que no mandar nada.
 */
function urlVerificada(productoId) {
  const r = registro(productoId);
  if (!r || r.estado !== 'verified' || !r.archivo) return null;
  if (!BASE) return null;
  // Se sirve por la ruta de la API, que vuelve a comprobar el estado antes de
  // entregar el archivo. Es el último filtro antes de que la foto salga.
  return `${BASE}/api/chacon/imagen?p=${encodeURIComponent(productoId)}`;
}

/** ¿Por qué no se envía foto de este producto? Para el panel y el log. */
function motivoSinFoto(productoId) {
  const r = registro(productoId);
  if (!r) return 'sin_registro';
  if (r.estado === 'verified') return BASE ? null : 'sin_base_publica_configurada';
  return r.estado;
}

function totales() {
  const { datos } = cargar();
  return datos.totales || {};
}

/** Todas las fichas, para la pantalla de revisión del panel. */
function todas() {
  return cargar().datos.imagenes || [];
}

module.exports = { urlVerificada, registro, motivoSinFoto, totales, todas, recargar, BASE, RUTA };
