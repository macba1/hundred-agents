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

/** Property that tells Gabi rows apart from Hundred rows in the same DB.
    Isolated in a constant because it is also the property we drop and retry
    without, if the database does not have it yet (see notifyCompleted). */
const CLIENT_KEY_PROP = 'Agente';

/** Pure: build Notion page properties from the artifacts (testable). */
function buildProps(brain, score, sessionToken, clientKey) {
  const email = brain && brain.client_contact && brain.client_contact.email;
  // "Negocios" holds the business lines for Gabi; for the generic diagnostic
  // there are no lines, so it carries the giro + plaza instead.
  const lines = clientKey === 'hundred'
    ? [(brain && brain.company_profile && brain.company_profile.industry),
       (brain && brain.company_profile && brain.company_profile.location)].filter(Boolean).join(' · ')
    : ((brain && brain.business_lines) || []).map((b) => b.name || b).filter(Boolean).join(', ');
  const props = {
    'Cliente': title((brain && brain.client_name) || 'Cliente'),
    'Negocios': rich(lines),
    'Alcance': { select: { name: (score && score.classification) || 'Starter Pilot' } },
    'Session': rich(String(sessionToken || '').slice(0, 8) + '…'),
    'Estado': { select: { name: 'Nuevo' } },
    [CLIENT_KEY_PROP]: { select: { name: clientKey || 'gabi' } },
  };
  if (email) props['Email'] = { email };
  if (brain && typeof brain.completeness === 'number') props['Completitud'] = { number: Math.round(brain.completeness * 100) };
  // Assign a person so Notion notifies them (works on free plans; no paid automation needed).
  const uid = process.env.NOTION_NOTIFY_USER_ID;
  if (uid) props['Avisar a'] = { people: uid.split(',').map((id) => ({ id: id.trim() })).filter((p) => p.id) };
  return props;
}

/** Page body with an @mention of the notify user(s) — the most reliable
    free-plan notification trigger (fires because the server bot, not the
    mentioned user, creates it). */
function buildChildren(brain, clientKey) {
  const uid = process.env.NOTION_NOTIFY_USER_ID;
  if (!uid) return undefined;
  const email = (brain && brain.client_contact && brain.client_contact.email) || 'sin email';
  const kind = clientKey === 'hundred' ? 'diagnóstico' : 'discovery';
  const rt = uid.split(',').map((id) => id.trim()).filter(Boolean)
    .map((id) => ({ type: 'mention', mention: { type: 'user', user: { id } } }));
  rt.push({ type: 'text', text: { content: ` — nuevo ${kind} completado (${email}). Revísalo en el admin.` } });
  return [{ object: 'block', type: 'paragraph', paragraph: { rich_text: rt } }];
}

async function createPage(token, body) {
  return fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function notifyCompleted({ brain, score, sessionToken, clientKey }) {
  const token = process.env.NOTION_TOKEN;
  const db = process.env.NOTION_DISCOVERY_DB_ID;
  if (!token || !db) return { ok: false, skipped: 'config' };
  const body = { parent: { database_id: db }, properties: buildProps(brain, score, sessionToken, clientKey) };
  const children = buildChildren(brain, clientKey);
  if (children) body.children = children;

  let r = await createPage(token, body);

  // The database may not have the "Agente" property yet. Notion answers 400
  // on an unknown property and we would lose the whole notification over a
  // filtering nicety — so retry once without it and report the degradation.
  if (r.status === 400) {
    const detail = await r.text().catch(() => '');
    if (detail.includes(CLIENT_KEY_PROP)) {
      const retryProps = { ...body.properties };
      delete retryProps[CLIENT_KEY_PROP];
      r = await createPage(token, { ...body, properties: retryProps });
      if (r.ok) return { ok: true, degraded: 'client_key_prop_missing' };
    }
    if (!r.ok) return { ok: false, error: 'notion_400', detail };
  }

  if (!r.ok) return { ok: false, error: 'notion_' + r.status, detail: await r.text().catch(() => '') };
  return { ok: true };
}

module.exports = { shouldNotify, buildProps, buildChildren, notifyCompleted, CLIENT_KEY_PROP };
