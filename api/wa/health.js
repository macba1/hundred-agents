/* ============================================================
   GET /api/wa/health — readiness for the WhatsApp agent.

   Confirms the two things that silently break on serverless: Redis being
   reachable, and the client bundle (config/prompt/catalog) actually making
   it into the deployment. Never returns secret values, only booleans.
   ============================================================ */

const clientsLib = require('../../lib/wa/clients');
const store = require('../../lib/wa/store');
const agent = require('../../lib/wa/agent');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const config = {
    openai_api_key: !!process.env.OPENAI_API_KEY,
    whatsapp_token: !!(process.env.WHATSAPP_TOKEN || process.env.WA_ACCESS_TOKEN),
    whatsapp_verify_token: !!(process.env.WHATSAPP_VERIFY_TOKEN || process.env.WA_VERIFY_TOKEN),
    meta_app_secret: !!process.env.META_APP_SECRET,
    panel_token: !!process.env.PANEL_TOKEN,
    redis_url: !!process.env.REDIS_URL,
  };

  let clientes = [];
  let erroresClientes = [];
  let cargaOk = false;
  try {
    const reg = clientsLib.load();
    erroresClientes = reg.errores;
    clientes = clientsLib.all().map((c) => ({
      clave: c.clave,
      nombre: c.nombre,
      activo: c.activo,
      phone_number_id: c.phone_number_id,
      productos_catalogo: c.productos.length,
      prompt_chars: c.prompt.length,
      modo_demo: c.modo_demo,
      human_notify_wa: !!c.human_notify_wa,
    }));
    // El prompt y el catálogo son archivos: si el bundle no los subió, aquí sale.
    cargaOk = clientes.length > 0 &&
      clientes.every((c) => c.prompt_chars > 0) &&
      clientes.filter((c) => c.activo).every((c) => c.productos_catalogo > 0);
  } catch (err) {
    erroresClientes = [err.message];
  }

  let redisOk = false;
  let redisError = null;
  try {
    redisOk = await store.ping();
  } catch (err) {
    redisError = err.message;
  }

  const activos = clientes.filter((c) => c.activo);
  const ready = redisOk && cargaOk && activos.length > 0 &&
    config.openai_api_key && config.whatsapp_token && config.whatsapp_verify_token;

  res.setHeader('Cache-Control', 'no-store');
  return res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'degraded',
    runtime: 'vercel-serverless',
    vercel_env: process.env.VERCEL_ENV || null,
    redis: { ok: redisOk, mode: store.ready().mode, error: redisError },
    clientes_ok: cargaOk,
    errores_clientes: erroresClientes,
    config_present: config,
    modelos: { chat: agent.OPENAI_MODEL, transcripcion: agent.TRANSCRIBE_MODEL },
    voz: { max_por_dia: agent.AUDIO_MAX_PER_DAY, max_segundos: agent.AUDIO_MAX_SECONDS },
    clientes,
  });
};
