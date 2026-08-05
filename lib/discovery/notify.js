/* ============================================================
   On a REAL (non-test) discovery completion, create a row in the
   Notion "Prospectos — Hundred Agents" database.

   ONE database holds every prospect, whatever the entry point:
   the discovery is the single funnel into Hundred Agents, and the
   "Origen" property is what segments it (diagnostico, gabi, or
   whatever ?ref= carried). No per-source databases.

   The page body carries the full internal report, and the @mention
   inside it is the notification — no email, no paid automation.
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

/** Where the prospect came from. ONE database holds every prospect, so this
    is the property that segments them: the funnel is single, the sources are
    many. Isolated in a constant because it is also the property we drop and
    retry without, if the database does not have it yet (see notifyCompleted). */
const ORIGIN_PROP = 'Origen';

/** Origins the code produces by itself. Any other value comes from ?ref= and
    is created on the fly by Notion (select options are open). */
const ORIGIN_BY_CLIENT = { hundred: 'diagnostico', gabi: 'gabi' };

/** A ?ref= is the truest answer to "where did this prospect come from", so it
    wins over the client default. Kept short and select-safe: Notion rejects
    commas in select option names. */
function originFor(clientKey, ref) {
  const r = String(ref == null ? '' : ref).trim().replace(/,/g, ' ').slice(0, 40);
  if (r) return r;
  return ORIGIN_BY_CLIENT[clientKey] || 'diagnostico';
}

/** Pure: build Notion page properties from the artifacts (testable). */
function buildProps(brain, score, sessionToken, clientKey, ref) {
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
    [ORIGIN_PROP]: { select: { name: originFor(clientKey, ref) } },
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
 * The requirements dossier, written into the page body so the whole case can
 * be read in Notion without opening the admin.
 *
 * It reports what the prospect SAID and what is still MISSING. It does not
 * recommend, score difficulty or suggest a price: the interview takes
 * requirements, people decide the rest.
 */
function buildReportBlocks(brain, score, proposal) {
  if (!proposal) return [];
  const b = brain || {};
  const cp = b.company_profile || {};
  const mp = b.main_problem || {};
  const op = proposal.operation || b.operation || {};
  const ur = proposal.urgency || b.urgency || {};
  const ct = b.client_contact || {};

  const costBullets = fields([
    ['Tiempo', mp.cost_time],
    ['Dinero', mp.cost_money],
    ['Clientes', mp.cost_customers],
  ]);

  const blocks = [
    divider(),
    { object: 'block', type: 'heading_2', heading_2: { rich_text: txt('Requerimientos recogidos en la entrevista') } },
    { object: 'block', type: 'callout', callout: {
      rich_text: txt('Esto es lo que contó el prospecto, tal cual. El diagnóstico no recomienda solución, alcance ni precio: eso lo define el equipo al estudiar el caso.'),
      icon: { emoji: '📋' },
    } },

    head('Empresa'),
    para(`${proposal.client || 'Prospecto'} — ${[cp.industry, cp.location, cp.size].filter(Boolean).join(' · ') || 'sin datos de empresa'}.`),
    ...fields([
      ['Contacto', [ct.email, ct.whatsapp || ct.phone, ct.name].filter(Boolean).join(' · ')],
      ['Copiar también a', (proposal.other_emails || []).join(', ')],
      ['Antigüedad', cp.years_operating],
      ['Tipo de cliente', cp.customer_type],
      ['Completitud de la entrevista', typeof b.completeness === 'number' ? Math.round(b.completeness * 100) + '%' : null],
    ]),

    head('Problema principal'),
    para(proposal.problem_summary || 'Sin problema principal registrado.'),
    ...fields([
      ['Cómo lo resuelven hoy', proposal.problem_today],
      ['Desde cuándo', proposal.problem_since],
      ['Qué han intentado', proposal.problem_tried],
      ['Si no se resuelve', proposal.problem_if_unsolved],
      ['Severidad declarada', proposal.problem_severity || mp.severity],
    ]),

    head('Qué les cuesta'),
    ...(costBullets.length ? costBullets : [para('No cuantificado — falta preguntarlo.')]),

    head('Operación'),
    ...fields([
      ['Canales de venta', (op.sales_channels || []).join(', ')],
      ['Canales de atención', (op.service_channels || []).join(', ')],
      ['Volumen de mensajes', op.volume_messages],
      ['Volumen de pedidos', op.volume_orders],
      ['Herramientas hoy', (op.tools_today || []).join(', ')],
      ['Quién lo operaría', op.who_would_operate],
    ]),

    head('Urgencia y presupuesto'),
    ...(fields([
      ['Para cuándo', ur.timeline],
      ['Por qué esa fecha', ur.driver],
      ['Señal de presupuesto', [ur.budget_signal, ur.budget_posture].filter(Boolean).join(' · ')],
    ]).length ? fields([
      ['Para cuándo', ur.timeline],
      ['Por qué esa fecha', ur.driver],
      ['Señal de presupuesto', [ur.budget_signal, ur.budget_posture].filter(Boolean).join(' · ')],
    ]) : [para('No se cubrió.')]),
  ];

  if ((proposal.success_criteria || []).length) {
    blocks.push(head('Qué quieren lograr'), ...proposal.success_criteria.map((x) => bullet(x)));
  }

  blocks.push(head('Qué falta preguntar'));
  blocks.push(...((proposal.gaps || []).length ? proposal.gaps.map((g) => bullet(g)) : [para('Nada: la entrevista quedó completa.')]));

  blocks.push(head('Siguiente paso'), para(proposal.next_step || '—'));
  return blocks;
}

/* Notion caps a create/append at 100 blocks and a text run at 2000 chars. */
const MAX_BLOCKS_PER_CALL = 100;
const MAX_RUN = 1900;

/** Split a long answer so no single block exceeds Notion's text limit. */
function chunk(s) {
  const t = String(s == null ? '' : s).trim();
  if (t.length <= MAX_RUN) return [t];
  const out = [];
  for (let i = 0; i < t.length; i += MAX_RUN) out.push(t.slice(i, i + MAX_RUN));
  return out;
}

/**
 * The conversation, verbatim.
 *
 * The dossier above is a SUMMARY, and summaries drop things: Dulces
 * Providencia asked for three colleagues to be copied and the compiled brain
 * kept only one address. Whatever the prospect actually typed has to survive
 * somewhere, and this is that place.
 */
function buildTranscriptBlocks(transcript) {
  const msgs = (transcript || []).filter((m) => m && m.content);
  if (!msgs.length) return [];
  const blocks = [
    divider(),
    { object: 'block', type: 'heading_2', heading_2: { rich_text: txt('Conversación completa (literal)') } },
    para('Lo que escribió el prospecto, palabra por palabra. Si algo del resumen de arriba no cuadra, la verdad está aquí.'),
  ];
  msgs.forEach((m) => {
    const who = m.role === 'user' ? 'Cliente' : 'Agente';
    chunk(m.content).forEach((part, i) => {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            { type: 'text', text: { content: i === 0 ? who + ': ' : '… ' }, annotations: { bold: true, color: m.role === 'user' ? 'orange' : 'default' } },
            { type: 'text', text: { content: part.slice(0, MAX_RUN) } },
          ],
        },
      });
    });
  });
  return blocks;
}

function buildChildren(brain, clientKey, artifacts, transcript) {
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
    blocks.push(...buildTranscriptBlocks(transcript));
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

/** Append blocks to an existing page, in Notion-sized batches.
    Returns how many landed; a failed batch stops the rest. */
async function appendChildren(token, pageId, blocks) {
  let done = 0;
  for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_CALL) {
    const batch = blocks.slice(i, i + MAX_BLOCKS_PER_CALL);
    const r = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({ children: batch }),
    });
    if (!r.ok) {
      console.error('[notion:append]', r.status, (await r.text().catch(() => '')).slice(0, 300));
      break;
    }
    done += batch.length;
  }
  return done;
}

async function notifyCompleted({ brain, score, proposal, transcript, sessionToken, clientKey, ref }) {
  const token = process.env.NOTION_TOKEN;
  const db = process.env.NOTION_DISCOVERY_DB_ID;
  if (!token || !db) return { ok: false, skipped: 'config' };
  const body = { parent: { database_id: db }, properties: buildProps(brain, score, sessionToken, clientKey, ref) };
  const all = buildChildren(brain, clientKey, { score, proposal }, transcript) || [];
  // Only the first batch travels with the page; the rest is appended after.
  const first = all.slice(0, MAX_BLOCKS_PER_CALL);
  const rest = all.slice(MAX_BLOCKS_PER_CALL);
  if (first.length) body.children = first;
  const nBlocks = all.length;

  let r = await createPage(token, body);

  // The database may not have the "Origen" property yet. Notion answers 400
  // on an unknown property and we would lose the whole prospect over a
  // segmentation nicety — so retry once without it and report the degradation.
  // Run POST /api/discovery/notion-setup to create it and stop degrading.
  if (r.status === 400) {
    const detail = await r.text().catch(() => '');
    if (detail.includes(ORIGIN_PROP)) {
      const retryProps = { ...body.properties };
      delete retryProps[ORIGIN_PROP];
      r = await createPage(token, { ...body, properties: retryProps });
      if (r.ok) return { ok: true, degraded: 'origin_prop_missing', ...(await finishPage(token, r, nBlocks, rest)) };
    }
    if (!r.ok) return { ok: false, error: 'notion_400', detail };
  }

  if (!r.ok) return { ok: false, error: 'notion_' + r.status, detail: await r.text().catch(() => '') };
  return { ok: true, ...(await finishPage(token, r, nBlocks, rest)) };
}

/** Finish the page: push whatever body did not fit in the create call, then
    report the URL and how many blocks actually landed. */
async function finishPage(token, res, nBlocks, rest) {
  const data = await res.json().catch(() => ({}));
  let appended = 0;
  if (data.id && rest && rest.length) appended = await appendChildren(token, data.id, rest);
  return { url: data.url || null, page_id: data.id || null, blocks: nBlocks, appended };
}

module.exports = {
  shouldNotify, buildProps, buildChildren, buildReportBlocks, buildTranscriptBlocks,
  notifyCompleted, appendChildren, ORIGIN_PROP, ORIGIN_BY_CLIENT, originFor, MAX_BLOCKS_PER_CALL,
};
