/* ============================================================
   POST /api/wa/admin?action=purge&client=<clave>&scope=test|all
   POST /api/wa/admin?action=reset_session&client=<clave>&phone=<tel>

   Purga datos del agente en Redis. Protegido con PANEL_TOKEN.

   scope=test  borra solo lo marcado como prueba (rango WA_TEST_PREFIX).
   scope=all   deja el cliente en cero: leads, folios, sesiones y cuotas.
               Es destructivo e irreversible, así que además exige
               confirm=<clave del cliente>.

   reset_session cierra la conversación de un teléfono SIN borrar su perfil,
   para poder probar el saludo de cliente recurrente sin esperar el TTL de 48h.

   POST a propósito: un GET podría dispararse desde el navegador, un
   prefetch o un bot de enlaces.
   ============================================================ */

const crypto = require('crypto');
const clientsLib = require('../../lib/wa/clients');
const store = require('../../lib/wa/store');
const { esTest, TEST_PREFIX } = require('../../lib/wa/testmode');

function sameToken(got, want) {
  const a = Buffer.from(String(got || ''));
  const b = Buffer.from(String(want || ''));
  if (!b.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const want = process.env.PANEL_TOKEN || '';
  const got = (req.query && req.query.token) ||
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!want) return res.status(503).json({ error: 'panel_token_no_configurado' });
  if (!sameToken(got, want)) return res.status(403).json({ error: 'forbidden' });

  const q = req.query || {};
  const clave = String(q.client || '');
  const c = clientsLib.get(clave);
  if (!c) return res.status(400).json({ error: 'client_desconocido', clave });

  /* ---- reset_session: cierra la charla, conserva el perfil ---- */
  if (q.action === 'reset_session') {
    const phone = String(q.phone || '').replace(/[^0-9]/g, '');
    if (!phone) return res.status(400).json({ error: 'falta_phone' });
    try {
      const r = await store.resetSession(clave, phone);
      const perfil = await store.getPerfil(clave, phone);
      console.warn('[wa][admin] reset_session', clave, phone, JSON.stringify(r));
      return res.status(200).json({
        ok: true, client: clave, phone, ...r,
        perfil: perfil ? { nombre: perfil.nombre, pedidos: perfil.pedidos,
          ultimo_pedido: perfil.ultimo_pedido && perfil.ultimo_pedido.folio } : null,
      });
    } catch (err) {
      console.error('[wa][admin] reset_session falló:', err.stack || err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  if (q.action !== 'purge') return res.status(400).json({ error: 'action_desconocida' });

  const scope = q.scope === 'all' ? 'all' : 'test';
  if (scope === 'all' && q.confirm !== clave) {
    return res.status(400).json({
      error: 'confirmacion_requerida',
      mensaje: `scope=all borra TODO de '${clave}'. Repite confirm=${clave} si es lo que quieres.`,
    });
  }

  try {
    const r = await store.purge(clave, scope, esTest);
    console.warn('[wa][admin] purge', clave, scope, JSON.stringify(r));
    return res.status(200).json({ ok: true, client: clave, test_prefix: TEST_PREFIX, ...r });
  } catch (err) {
    console.error('[wa][admin] purge falló:', err.stack || err.message);
    return res.status(500).json({ error: err.message });
  }
};
