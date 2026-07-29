/* ============================================================
   GET /api/coparmex/sync-notion?token=ADMIN_TOKEN
   Vuelca los leads de la landing Coparmex (Redis) al Notion
   "Asistentes Conferencia México" (NOTION_MEXICO_DB_ID), SIN
   duplicar correos.

   Dedup real: consulta TODOS los correos ya presentes en el DB
   (no solo un set local) y salta los leads cuyo correo ya existe.
   También audita y reporta correos duplicados dentro del DB.

   - Sin ?do=1  -> inspección: título DB, nº leads, cuántos son
                   nuevos, y duplicados existentes. NO escribe.
   - Con  ?do=1 -> inserta solo los correos nuevos.

   Protegido con ADMIN_TOKEN.
   ============================================================ */

const { listLeads } = require('../../lib/coparmex');
const { createLeadPage } = require('../../lib/notion');

const NOTION_VERSION = '2022-06-28';

function authorized(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const url = new URL(req.url, 'http://x');
  return url.searchParams.get('token') === expected;
}

function notionHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' };
}

async function dbTitle(token, dbId) {
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}`, { headers: notionHeaders(token) });
    if (!r.ok) return `error_http_${r.status}`;
    const d = await r.json();
    return (d.title || []).map((t) => t.plain_text).join('');
  } catch { return 'error'; }
}

/** Map<emailLower, count> of every email already in the DB (paginated). */
async function dbEmailCounts(token, dbId) {
  const counts = new Map();
  let cursor;
  do {
    const body = cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 };
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST', headers: notionHeaders(token), body: JSON.stringify(body),
    });
    if (!r.ok) throw { code: 'notion_query', status: r.status };
    const d = await r.json();
    for (const pg of d.results || []) {
      const props = pg.properties || {};
      for (const k in props) {
        if (props[k] && props[k].type === 'email' && props[k].email) {
          const key = String(props[k].email).trim().toLowerCase();
          counts.set(key, (counts.get(key) || 0) + 1);
          break;
        }
      }
    }
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);
  return counts;
}

module.exports = async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_MEXICO_DB_ID;
  if (!token || !dbId) return res.status(502).json({ ok: false, error: 'notion_not_configured' });

  const title = await dbTitle(token, dbId);

  let leads = [];
  try { leads = await listLeads(); } catch {
    return res.status(502).json({ ok: false, error: 'store_unavailable', dbTitle: title });
  }

  let existing;
  try { existing = await dbEmailCounts(token, dbId); } catch (e) {
    return res.status(502).json({ ok: false, error: 'notion_query_failed', detail: e && e.status, dbTitle: title });
  }

  // Duplicados YA presentes en el DB (correo repetido >1 vez).
  const duplicatesInDb = [...existing.entries()].filter(([, n]) => n > 1).map(([email, n]) => ({ email, count: n }));

  // Qué leads son nuevos (correo no presente en DB), deduplicando también dentro del batch.
  const seenBatch = new Set();
  const toInsert = [], alreadyInDb = [];
  for (const l of leads) {
    const key = String(l.email || '').trim().toLowerCase();
    if (!key) continue;
    if (existing.has(key) || seenBatch.has(key)) { alreadyInDb.push(l.email); continue; }
    seenBatch.add(key);
    toInsert.push(l);
  }

  const url = new URL(req.url, 'http://x');

  // Modo limpieza: para cada correo duplicado, conserva la página más
  // antigua (created_time) y archiva las demás. Idempotente.
  if (url.searchParams.get('dedupe') === '1') {
    const archived = [], kept = [];
    for (const { email } of duplicatesInDb) {
      const q = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: 'POST', headers: notionHeaders(token),
        body: JSON.stringify({ filter: { property: 'Email', email: { equals: email } } }),
      });
      if (!q.ok) continue;
      const d = await q.json();
      const pages = (d.results || []).slice().sort((a, b) => new Date(a.created_time) - new Date(b.created_time));
      kept.push({ email, keepId: pages[0] && pages[0].id, keepCreated: pages[0] && pages[0].created_time });
      for (const pg of pages.slice(1)) {
        const r = await fetch(`https://api.notion.com/v1/pages/${pg.id}`, {
          method: 'PATCH', headers: notionHeaders(token), body: JSON.stringify({ archived: true }),
        });
        archived.push({ email, id: pg.id, created: pg.created_time, ok: r.ok });
      }
    }
    return res.status(200).json({ ok: true, mode: 'dedupe', dbTitle: title, kept, archived });
  }

  const doWrite = url.searchParams.get('do') === '1';

  if (!doWrite) {
    return res.status(200).json({
      ok: true, mode: 'inspect', dbTitle: title,
      leadsInRedis: leads.length, alreadyInNotion: alreadyInDb.length, wouldInsert: toInsert.length,
      newEmails: toInsert.map((l) => l.email),
      duplicatesInDb,
      hint: 'Añade &do=1 para insertar los nuevos.',
    });
  }

  const inserted = [], failed = [];
  for (const l of toInsert) {
    try {
      await createLeadPage('mexico', {
        name: l.name,
        email: l.email,
        question: '(registro/descarga desde landing Coparmex San Miguel el Alto)',
        summary: `Landing Coparmex · ${l.ts || ''}`,
      });
      inserted.push(l.email);
    } catch (err) {
      failed.push({ email: l.email, error: (err && err.code) || 'error' });
    }
  }

  return res.status(200).json({
    ok: true, mode: 'sync', dbTitle: title,
    leadsInRedis: leads.length, skippedAlreadyInNotion: alreadyInDb.length,
    inserted: inserted.length, insertedEmails: inserted, failed,
    duplicatesInDb,
  });
};
