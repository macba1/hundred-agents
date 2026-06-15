/* ============================================================
   Shared Notion writer.
   Creates a page in the correct database depending on the chat
   mode. Uses NOTION_TOKEN (server-only env var) — never exposed
   to the client. Imported by /api/lead.js and /api/chat.js.
   ============================================================ */

const NOTION_VERSION = '2022-06-28';
const SIZE_OPTIONS = ['1-10', '11-50', '51-200', '200+'];

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function validEmail(s) {
  return typeof s === 'string' && EMAIL_RE.test(s.trim());
}

const rich = (s) => ({ rich_text: [{ text: { content: String(s).slice(0, 1900) } }] });
const title = (s) => ({ title: [{ text: { content: String(s).slice(0, 1900) } }] });
const sel = (name) => ({ select: { name } });

/**
 * Build Notion page properties for the given mode + fields.
 * Throws { code, message } on validation failure so callers can
 * surface a clear message / ask the user again.
 */
function buildProperties(mode, f = {}) {
  const name = (f.name || '').trim();

  if (mode === 'home') {
    const email = (f.email || '').trim();
    const company = (f.company || '').trim();
    const problem = (f.problem || '').trim();
    if (!name || !email || !company || !problem) {
      throw { code: 'incomplete', message: 'home lead requires name, email, company and problem' };
    }
    if (!validEmail(email)) {
      throw { code: 'bad_email', message: 'invalid email' };
    }
    const props = {
      'Nombre': title(name),
      'Email': { email },
      'Empresa / tipo de negocio': rich(company),
      'Problema o proceso a mejorar': rich(problem),
      'Origen': sel('Home'),
      'Estado': sel('Nuevo'),
    };
    if (f.summary) props['Resumen conversación'] = rich(f.summary);
    return props;
  }

  if (mode === 'mexico') {
    const question = (f.question || '').trim();
    if (!name || !question) {
      throw { code: 'incomplete', message: 'mexico registration requires at least name and question' };
    }
    const props = {
      'Nombre': title(name),
      'Pregunta para la conferencia': rich(question),
      'Estado': sel('Registrado'),
    };
    const email = (f.email || '').trim();
    if (email) {
      if (!validEmail(email)) throw { code: 'bad_email', message: 'invalid email' };
      props['Email'] = { email };
    }
    if (f.company && f.company.trim()) props['Empresa'] = rich(f.company.trim());
    if (f.role && f.role.trim()) props['Cargo'] = rich(f.role.trim());
    if (f.company_size && SIZE_OPTIONS.includes(f.company_size)) props['Tamaño de empresa'] = sel(f.company_size);
    if (f.summary) props['Resumen conversación'] = rich(f.summary);
    return props;
  }

  throw { code: 'bad_mode', message: 'unknown mode' };
}

/**
 * Create the lead/attendee page in Notion.
 * Returns { ok: true, url }. Throws { code, message } on error.
 */
async function createLeadPage(mode, fields) {
  const token = process.env.NOTION_TOKEN;
  const dbId = mode === 'home' ? process.env.NOTION_LEADS_DB_ID
            : mode === 'mexico' ? process.env.NOTION_MEXICO_DB_ID
            : null;
  if (!token || !dbId) {
    throw { code: 'config', message: 'Notion env vars not configured' };
  }

  const properties = buildProperties(mode, fields); // may throw validation

  const resp = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ parent: { database_id: dbId }, properties }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw { code: 'notion_error', message: `Notion API ${resp.status}`, detail };
  }
  const data = await resp.json();
  return { ok: true, url: data.url || null, id: data.id || null };
}

module.exports = { createLeadPage, buildProperties, validEmail, SIZE_OPTIONS };
