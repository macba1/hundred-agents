/* ============================================================
   Demos comerciales de agente en la web.

     GET  /api/demo-chat?client=providencia          -> catálogo para la vitrina
     POST /api/demo-chat  {client, mensaje, historial} -> un turno del agente

   Es un endpoint NUEVO a propósito. /api/chat sirve la home y la conferencia
   (otro modelo, otras herramientas, Notion detrás): meter aquí un tercer modo
   habría puesto en riesgo dos páginas que ya funcionan por ahorrar un archivo.

   Sólo responde a clientes que tengan `demo_web: true` en su config.json. Un
   cliente de WhatsApp de verdad no queda expuesto en la web por existir: hay
   que marcarlo. Y el turno lo ejecuta lib/wa/demo.js, que no toca Redis ni
   Meta, así que esta ruta no puede mandar un WhatsApp a nadie.

   OPENAI_API_KEY se queda en el servidor: el navegador nunca la ve.
   ============================================================ */

const clientsLib = require('../lib/wa/clients');
const demo = require('../lib/wa/demo');
const ratelimit = require('../lib/discovery/ratelimit');

// Turnos por IP y hora. Generoso para una reunión (varias personas pueden
// estar tras la misma IP de oficina) y suficiente para que la landing no se
// convierta en una API de OpenAI abierta.
const LIMITE_POR_IP_HORA = Number(process.env.DEMO_RATE_IP_HORA || 150);

const CORTES = {
  metodo: { code: 405, error: 'method_not_allowed' },
  cliente: { code: 404, error: 'demo_no_disponible' },
  vacio: { code: 400, error: 'mensaje_vacio' },
  limite: { code: 429, error: 'rate_limited' },
  openai: { code: 502, error: 'modelo_no_disponible' },
};

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  return body || {};
}

/** Cliente pedido, o null si no existe o no está habilitado para demo web. */
function resolverDemo(clave) {
  const c = clientsLib.get(String(clave || '').trim().toLowerCase());
  if (!c) return null;
  return c.demo_web ? c : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const clave = req.method === 'GET'
    ? (req.query && req.query.client)
    : parseBody(req).client;

  const client = resolverDemo(clave);
  if (!client) {
    return res.status(CORTES.cliente.code).json({ ok: false, error: CORTES.cliente.error });
  }

  /* ---- vitrina para la landing ---- */
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, cliente: client.clave, vitrina: demo.vitrina(client) });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(CORTES.metodo.code).json({ ok: false, error: CORTES.metodo.error });
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('[demo-chat] falta OPENAI_API_KEY');
    return res.status(CORTES.openai.code).json({
      ok: false,
      error: 'openai_no_configurado',
      respuesta: 'La demo no está conectada al modelo en este entorno. Falta configurar OPENAI_API_KEY.',
    });
  }

  // Falla abierto si el store no está: preferimos una demo que responde a una
  // demo que se cae delante del cliente por un limitador.
  const ip = ratelimit.clientIp(req);
  const rl = await ratelimit.check('demochat', `${client.clave}:${ip}`, LIMITE_POR_IP_HORA);
  if (!rl.ok) {
    return res.status(CORTES.limite.code).json({
      ok: false,
      error: CORTES.limite.error,
      respuesta: 'Llegamos al límite de mensajes de esta demostración por ahora. ' +
        'Vuelve a intentarlo en un rato o escríbenos a info@thehagentic.com.',
    });
  }

  const body = parseBody(req);
  try {
    const r = await demo.turno(client, { mensaje: body.mensaje, historial: body.historial });
    return res.status(200).json({
      ok: true,
      cliente: client.clave,
      demo: true,
      respuesta: r.respuesta,
      historial: r.historial,
      leads: r.leads,
      escalamientos: r.escalamientos,
      busquedas: r.busquedas,
      limite: r.limite,
    });
  } catch (err) {
    if (err.code === 'mensaje_vacio') {
      return res.status(CORTES.vacio.code).json({ ok: false, error: CORTES.vacio.error });
    }
    console.error('[demo-chat]', client.clave, err.stack || err.message);
    return res.status(CORTES.openai.code).json({
      ok: false,
      error: CORTES.openai.error,
      respuesta: 'Tuvimos un detalle técnico atendiendo tu mensaje. ¿Me lo repites?',
    });
  }
};

module.exports.resolverDemo = resolverDemo;
