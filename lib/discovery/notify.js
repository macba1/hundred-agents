/* ============================================================
   On a REAL (non-test) discovery completion, create a page in the
   Notion "Discovery Completados" DB. Notion's native notification
   (follow the DB / automation) then alerts the team — no email.
   Best-effort: never blocks or fails finalize.
   ============================================================ */
const { configFor } = require('./clients');

const NOTION_VERSION = '2022-06-28';
const rich = (s) => ({ rich_text: [{ text: { content: String(s).slice(0, 1900) } }] });
const title = (s) => ({ title: [{ text: { content: String(s).slice(0, 1900) } }] });

/** Skip notification for internal/test sessions, or if the client has the
    Notion channel turned off in lib/discovery/clients.js. */
function shouldNotify(session) {
  if (session && session.metadata && session.metadata.is_test === true) return false;
  if (session && session.clientKey && !configFor(session.clientKey).notify_notion) return false;
  return true;
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
/* ---- Page body blocks ---------------------------------------------- */

const txt = (s) => [{ type: 'text', text: { content: String(s == null ? '' : s).slice(0, 1900) } }];
const para = (s) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: txt(s) } });
const head = (s) => ({ object: 'block', type: 'heading_3', heading_3: { rich_text: txt(s) } });
const bullet = (s) => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: txt(s) } });
const divider = () => ({ object: 'block', type: 'divider', divider: {} });

/** "Etiqueta: valor" bullets, skipping the values that are missing. */
function fields(pairs) {
  return pairs.filter(([, v]) => v != null && String(v).trim()).map(([k, v]) => bullet(`${k}: ${v}`));
}

/**
 * The full internal report, written into the page body so it can be read
 * end to end in Notion without opening the admin. Internal only: it carries
 * the internal price, so the page is never shared with the prospect.
 */
function buildReportBlocks(brain, score, proposal) {
  if (!proposal) return [];
  const b = brain || {};
  const cp = b.company_profile || {};
  const mp = b.main_problem || {};
  const op = b.operation || {};
  const ur = b.urgency || {};
  const ct = b.client_contact || {};
  const pi = proposal.pricing_internal || {};
  const mxn = (n) => (typeof n === 'number' ? '$' + n.toLocaleString('en-US') + ' MXN' : '—');

  const costBullets = fields([
    ['Tiempo', mp.cost_time],
    ['Dinero', mp.cost_money],
    ['Clientes', mp.cost_customers],
  ]);

  const blocks = [
    divider(),
    { object: 'block', type: 'heading_2', heading_2: { rich_text: txt('Informe interno — no enviar al prospecto') } },
    { object: 'block', type: 'callout', callout: {
      rich_text: txt('Revisión humana obligatoria. Incluye el precio interno: no se comparte con el cliente sin revisar.'),
      icon: { emoji: '🔒' },
    } },

    head('Resumen'),
    para(`${proposal.client || 'Prospecto'} — ${[cp.industry, cp.location, cp.size].filter(Boolean).join(' · ') || 'sin datos de empresa'}.`),
    ...fields([
      ['Contacto', [ct.email, ct.whatsapp || ct.phone, ct.name].filter(Boolean).join(' · ')],
      ['Antigüedad', cp.years_operating],
      ['Tipo de cliente', cp.customer_type],
      ['Completitud del expediente', typeof b.completeness === 'number' ? Math.round(b.completeness * 100) + '%' : null],
    ]),

    head('Problema principal'),
    para(proposal.problem_summary || 'Sin problema principal registrado.'),
    ...fields([
      ['Cómo lo resuelven hoy', proposal.problem_today],
      ['Desde cuándo', proposal.problem_since],
      ['Qué han intentado', proposal.problem_tried],
      ['Si no se resuelve', proposal.problem_if_unsolved],
      ['Severidad', mp.severity],
    ]),

    head('Costo del problema'),
    ...(costBullets.length ? costBullets : [para('No cuantificado — falta el caso de negocio.')]),

    head('Operación'),
    ...fields([
      ['Canales de venta', (op.sales_channels || []).join(', ')],
      ['Canales de atención', (op.service_channels || []).join(', ')],
      ['Volumen de mensajes', op.volume_messages],
      ['Volumen de pedidos', op.volume_orders],
      ['Herramientas hoy', (op.tools_today || []).join(', ')],
      ['Quién lo operaría', op.who_would_operate],
      ['Urgencia', [ur.timeline, ur.driver].filter(Boolean).join(' — ')],
      ['Señal de presupuesto', [ur.budget_signal, ur.budget_posture].filter(Boolean).join(' · ')],
    ]),

    head('Preproyecto propuesto'),
    para(`${proposal.recommended_build || '—'} — ${proposal.recommended_build_what || ''}`),
    ...(proposal.also_consider || []).map((x) => bullet('También considerar: ' + x)),
    ...(proposal.recommended_build_reasons || []).map((r) => bullet('Por qué: ' + r)),
    ...fields([
      ['Fase 1', (proposal.modules_phase_1 || []).join(' · ')],
      ['Fase 2', (proposal.modules_phase_2 || []).join(' · ')],
      ['Fase 3', (proposal.modules_phase_3 || []).join(' · ')],
    ]),

    head('Dificultad'),
    para(String(proposal.difficulty || score && score.difficulty || '—').toUpperCase()),
    ...(proposal.difficulty_justification || []).map((r) => bullet(r)),

    head('Tier y precio interno'),
    para(proposal.suggested_pricing_tier || '—'),
    ...fields([
      ['Implementación', `${mxn(pi.setup_mxn)} (banda ${mxn((pi.setup_range_mxn || [])[0])} – ${mxn((pi.setup_range_mxn || [])[1])})`],
      ['Mensual', `${mxn(pi.monthly_mxn)} (banda ${mxn((pi.monthly_range_mxn || [])[0])} – ${mxn((pi.monthly_range_mxn || [])[1])})`],
    ]),

    head('Alertas'),
    ...((proposal.alerts || []).length ? proposal.alerts.map((a) => bullet('⚠️ ' + a)) : [para('Ninguna.')]),

    head('Siguiente paso'),
    para(proposal.next_step || '—'),
  ];

  if ((proposal.open_questions || []).length) {
    blocks.push(head('Preguntas abiertas'), ...proposal.open_questions.map((q) => bullet(q)));
  }
  return blocks;
}

function buildChildren(brain, clientKey, artifacts) {
  const uid = process.env.NOTION_NOTIFY_USER_ID;
  const cfg = configFor(clientKey);
  const email = (brain && brain.client_contact && brain.client_contact.email) || 'sin email';
  const kind = clientKey === 'hundred' ? 'diagnóstico' : 'discovery';
  const blocks = [];

  // The @mention is the notification itself: it fires because the bot, not the
  // mentioned user, creates the page.
  if (uid) {
    const rt = uid.split(',').map((id) => id.trim()).filter(Boolean)
      .map((id) => ({ type: 'mention', mention: { type: 'user', user: { id } } }));
    rt.push({ type: 'text', text: { content: ` — nuevo ${kind} completado (${email}). El informe interno completo está aquí abajo.` } });
    blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: rt } });
  }

  if (cfg.notion_full_report && artifacts) {
    blocks.push(...buildReportBlocks(brain, artifacts.score, artifacts.proposal));
  }

  return blocks.length ? blocks : undefined;
}

async function createPage(token, body) {
  return fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function notifyCompleted({ brain, score, proposal, sessionToken, clientKey }) {
  const token = process.env.NOTION_TOKEN;
  const db = process.env.NOTION_DISCOVERY_DB_ID;
  if (!token || !db) return { ok: false, skipped: 'config' };
  const body = { parent: { database_id: db }, properties: buildProps(brain, score, sessionToken, clientKey) };
  const children = buildChildren(brain, clientKey, { score, proposal });
  if (children) body.children = children;
  const nBlocks = children ? children.length : 0;

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
      if (r.ok) return { ok: true, degraded: 'client_key_prop_missing', ...(await pageRef(r, nBlocks)) };
    }
    if (!r.ok) return { ok: false, error: 'notion_400', detail };
  }

  if (!r.ok) return { ok: false, error: 'notion_' + r.status, detail: await r.text().catch(() => '') };
  return { ok: true, ...(await pageRef(r, nBlocks)) };
}

/** The created page's URL plus how much body went with it, so "did the full
    report make it?" is answerable from the session record. */
async function pageRef(res, blocks) {
  const data = await res.json().catch(() => ({}));
  return { url: data.url || null, blocks };
}

module.exports = { shouldNotify, buildProps, buildChildren, buildReportBlocks, notifyCompleted, CLIENT_KEY_PROP };
