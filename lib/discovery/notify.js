/* ============================================================
   On a REAL (non-test) discovery completion, create a page in the
   Notion "Discovery Completados" DB. Notion's native notification
   (follow the DB / automation) then alerts the team — no email.
   Best-effort: never blocks or fails finalize.
   ============================================================ */
const NOTION_VERSION = '2022-06-28';
const rich = (s) => ({ rich_text: [{ text: { content: String(s).slice(0, 1900) } }] });
const title = (s) => ({ title: [{ text: { content: String(s).slice(0, 1900) } }] });

/** Skip notification for internal/test sessions. */
function shouldNotify(session) {
  return !(session && session.metadata && session.metadata.is_test === true);
}

/** Pure: build Notion page properties from the artifacts (testable). */
function buildProps(brain, score, sessionToken) {
  const email = brain && brain.client_contact && brain.client_contact.email;
  const lines = ((brain && brain.business_lines) || []).map((b) => b.name || b).filter(Boolean).join(', ');
  const props = {
    'Cliente': title((brain && brain.client_name) || 'Cliente'),
    'Negocios': rich(lines),
    'Alcance': { select: { name: (score && score.classification) || 'Starter Pilot' } },
    'Session': rich(String(sessionToken || '').slice(0, 8) + '…'),
    'Estado': { select: { name: 'Nuevo' } },
  };
  if (email) props['Email'] = { email };
  if (brain && typeof brain.completeness === 'number') props['Completitud'] = { number: Math.round(brain.completeness * 100) };
  return props;
}

async function notifyCompleted({ brain, score, sessionToken }) {
  const token = process.env.NOTION_TOKEN;
  const db = process.env.NOTION_DISCOVERY_DB_ID;
  if (!token || !db) return { ok: false, skipped: 'config' };
  const r = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent: { database_id: db }, properties: buildProps(brain, score, sessionToken) }),
  });
  if (!r.ok) return { ok: false, error: 'notion_' + r.status, detail: await r.text().catch(() => '') };
  return { ok: true };
}

module.exports = { shouldNotify, buildProps, notifyCompleted };
