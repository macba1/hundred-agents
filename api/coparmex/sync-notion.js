/* ============================================================
   GET /api/coparmex/sync-notion?token=ADMIN_TOKEN
   One-off admin: vuelca los leads de la landing Coparmex (Redis)
   al Notion "asistente conferencia mexico" (NOTION_MEXICO_DB_ID).

   - Sin ?do=1  -> inspección: devuelve el título del DB + props +
                   cuántos leads hay (NO escribe nada).
   - Con  ?do=1 -> inserta cada lead (idempotente: salta correos ya
                   sincronizados via set Redis coparmex:synced).

   Protegido con ADMIN_TOKEN. Reusa lib/notion (modo mexico) y
   lib/coparmex (leads en Redis).
   ============================================================ */

const { listLeads } = require('../../lib/coparmex');
const { createLeadPage } = require('../../lib/notion');

function authorized(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const url = new URL(req.url, 'http://x');
  return url.searchParams.get('token') === expected;
}

async function redis() {
  const { createClient } = require('redis');
  const c = createClient({ url: process.env.REDIS_URL });
  c.on('error', () => {});
  if (!c.isOpen) await c.connect();
  return c;
}

module.exports = async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_MEXICO_DB_ID;
  if (!token || !dbId) return res.status(502).json({ ok: false, error: 'notion_not_configured' });

  // Título del DB destino (para confirmar que es el correcto).
  let dbTitle = null;
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}`, {
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
    });
    if (r.ok) { const d = await r.json(); dbTitle = (d.title || []).map((t) => t.plain_text).join(''); }
    else dbTitle = `error_http_${r.status}`;
  } catch { dbTitle = 'error'; }

  let leads = [];
  try { leads = await listLeads(); } catch (e) {
    return res.status(502).json({ ok: false, error: 'store_unavailable', dbTitle });
  }

  const url = new URL(req.url, 'http://x');
  const doWrite = url.searchParams.get('do') === '1';

  if (!doWrite) {
    return res.status(200).json({
      ok: true, mode: 'inspect', dbTitle, leadCount: leads.length,
      sample: leads.slice(0, 3).map((l) => ({ name: l.name, email: l.email })),
      hint: 'Añade &do=1 para escribir en Notion.',
    });
  }

  // Escritura idempotente: salta correos ya sincronizados.
  const c = await redis();
  const inserted = [], skipped = [], failed = [];
  for (const l of leads) {
    const emailKey = (l.email || '').toLowerCase();
    if (emailKey && await c.sIsMember('coparmex:synced', emailKey)) { skipped.push(l.email); continue; }
    try {
      await createLeadPage('mexico', {
        name: l.name,
        email: l.email,
        question: '(registro/descarga desde landing Coparmex San Miguel el Alto)',
        summary: `Landing Coparmex · ${l.ts || ''}`,
      });
      if (emailKey) await c.sAdd('coparmex:synced', emailKey);
      inserted.push(l.email);
    } catch (err) {
      failed.push({ email: l.email, error: (err && err.code) || 'error' });
    }
  }
  await c.quit();

  return res.status(200).json({
    ok: true, mode: 'sync', dbTitle,
    total: leads.length, inserted: inserted.length, skipped: skipped.length, failed,
    insertedEmails: inserted,
  });
};
