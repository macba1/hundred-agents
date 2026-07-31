/* ============================================================
   GET/POST /api/discovery/notion-setup?key=<DISCOVERY_ADMIN_TOKEN>

   Ops tool: makes the Notion database match what the code writes.
   It exists because NOTION_TOKEN is a sensitive Vercel env var — it
   cannot be read back locally, so the only place able to call the
   Notion API with it is the deployment itself.

   GET   → inspect: current title, description and properties.
   POST  → apply (idempotent):
           - title       "Prospectos — Hundred Agents"
           - description one line explaining what a row is
           - property    "Origen" (select) with the base options

   Never touches rows, never deletes a property. Re-running it is a
   no-op once the database already matches.

   Auth: DISCOVERY_ADMIN_TOKEN, or NOTION_SETUP_TOKEN when the first
   one is not at hand. Closed by default if neither is set.
   ============================================================ */

const NOTION_VERSION = '2022-06-28';

const DB_TITLE = 'Prospectos — Hundred Agents';
const DB_DESCRIPTION =
  'Cada fila = una empresa que quiere trabajar con Hundred. Se crea al completar ' +
  'la entrevista en /diagnostico, con informe interno y preproyecto en el cuerpo de la página.';

/* Base options. Notion creates any other value on the fly when a ?ref= brings
   one, so this list is a starting point, not a whitelist. */
const ORIGIN_OPTIONS = [
  { name: 'diagnostico', color: 'orange' },
  { name: 'gabi', color: 'brown' },
  { name: 'coparmex', color: 'blue' },
  { name: 'comercial', color: 'green' },
];

function authed(req) {
  // Either token opens it: the usual admin one, or a setup-only one for when
  // the admin token is not at hand. Closed by default if neither is set.
  const accepted = [process.env.DISCOVERY_ADMIN_TOKEN, process.env.NOTION_SETUP_TOKEN].filter(Boolean);
  if (!accepted.length) return false;
  const got = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')
    || (req.query && req.query.key) || '';
  return !!got && accepted.includes(got);
}

async function notion(path, method, token, body) {
  const r = await fetch('https://api.notion.com/v1/' + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text().catch(() => '');
  let json = {}; try { json = JSON.parse(text); } catch {}
  return { ok: r.ok, status: r.status, json, text };
}

const plain = (rich) => (rich || []).map((x) => (x.plain_text != null ? x.plain_text : (x.text && x.text.content) || '')).join('');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });

  const token = process.env.NOTION_TOKEN;
  const db = process.env.NOTION_DISCOVERY_DB_ID;
  if (!token || !db) return res.status(503).json({ error: 'notion_unconfigured' });

  const before = await notion('databases/' + db, 'GET', token);
  if (!before.ok) return res.status(502).json({ error: 'notion_' + before.status, detail: before.text.slice(0, 400) });

  const snapshot = (d) => ({
    title: plain(d.title),
    description: plain(d.description),
    properties: Object.keys(d.properties || {}),
    origen_options: ((d.properties && d.properties['Origen'] && d.properties['Origen'].select) || {}).options
      ? d.properties['Origen'].select.options.map((o) => o.name) : null,
  });

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, database_id: db, current: snapshot(before.json) });
  }

  // ---- apply ----
  const props = before.json.properties || {};
  const patch = {
    title: [{ type: 'text', text: { content: DB_TITLE } }],
    description: [{ type: 'text', text: { content: DB_DESCRIPTION } }],
    properties: {},
  };

  // Keep any option the database already has; only add the ones missing.
  const existing = (props['Origen'] && props['Origen'].select && props['Origen'].select.options) || [];
  const have = new Set(existing.map((o) => o.name));
  patch.properties['Origen'] = {
    select: { options: [...existing, ...ORIGIN_OPTIONS.filter((o) => !have.has(o.name))] },
  };

  // The old name for the same idea. Renaming keeps whatever rows already
  // carry it instead of stranding them in an orphan column.
  if (props['Agente'] && !props['Origen']) {
    delete patch.properties['Origen'];
    patch.properties['Agente'] = {
      name: 'Origen',
      select: { options: [...((props['Agente'].select || {}).options || []), ...ORIGIN_OPTIONS.filter((o) => !have.has(o.name))] },
    };
  }

  const applied = await notion('databases/' + db, 'PATCH', token, patch);
  if (!applied.ok) return res.status(502).json({ error: 'notion_' + applied.status, detail: applied.text.slice(0, 600) });

  return res.status(200).json({
    ok: true,
    database_id: db,
    url: applied.json.url || null,
    before: snapshot(before.json),
    after: snapshot(applied.json),
  });
};

module.exports.DB_TITLE = DB_TITLE;
module.exports.DB_DESCRIPTION = DB_DESCRIPTION;
module.exports.ORIGIN_OPTIONS = ORIGIN_OPTIONS;
