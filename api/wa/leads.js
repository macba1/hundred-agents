/* ============================================================
   GET /api/wa/leads?client=<clave>&token=<PANEL_TOKEN>

   Live leads panel. Token-protected: it lists real customer phone numbers
   and orders, and it sits on the public site.
   ============================================================ */

const crypto = require('crypto');
const clientsLib = require('../../lib/wa/clients');
const store = require('../../lib/wa/store');
const panel = require('../../lib/wa/panel');

/** Constant-time compare that tolerates different lengths. */
function sameToken(got, want) {
  const a = Buffer.from(String(got || ''));
  const b = Buffer.from(String(want || ''));
  if (!b.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const want = process.env.PANEL_TOKEN || '';
  const got = (req.query && req.query.token) ||
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (!want) {
    return res.status(503).send('PANEL_TOKEN no está configurado: el panel queda cerrado.');
  }
  if (!sameToken(got, want)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(403).send('<h1>403</h1><p>Falta el token del panel.</p>');
  }

  const rd = store.ready();
  if (!rd.ok) return res.status(503).send(rd.error);

  const clienteSel = (req.query && req.query.client) || '';

  // ?transcript=<telefono> — conversación literal de un contacto, en JSON.
  // Mismo token que el panel: expone lo que el cliente escribió y lo que el
  // agente contestó, que es exactamente lo que hace falta para dar soporte.
  const transcriptPhone = (req.query && req.query.transcript) || '';
  if (transcriptPhone) {
    const c = clientsLib.get(clienteSel);
    if (!c) return res.status(400).json({ error: 'client_desconocido' });
    try {
      const s = await store.getSession(c.clave, transcriptPhone);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        client: c.clave, phone: transcriptPhone, turns: s.turns, mensajes: s.history,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const todos = clientsLib.all();
  const claves = todos.map((c) => c.clave);
  const sel = clienteSel ? clientsLib.get(clienteSel) : null;

  try {
    const rows = await store.listLeads(clienteSel || '', claves, 200);
    const phones = new Set(rows.map((r) => r.phone));

    const ref = sel || todos.find((c) => c.activo) || todos[0];
    const hora = ref ? clientsLib.ahoraCorto(ref) : new Date().toISOString().slice(11, 19);

    const html = panel.render({
      titulo: sel ? sel.nombre : 'Todos los clientes',
      acento: sel ? sel.acento_panel : '#ff4e1c',
      contactos: phones.size,
      total: rows.length,
      rows,
      clientes: todos,
      clienteSel,
      token: got,
      hora,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.status(200).send(html);
  } catch (err) {
    console.error('[wa] panel falló:', err.stack || err.message);
    return res.status(500).send('Error leyendo leads: ' + err.message);
  }
};
