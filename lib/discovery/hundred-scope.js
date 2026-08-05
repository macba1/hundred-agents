/* ============================================================
   Expediente de requerimientos para el clientKey "hundred".

   GUARDARRAÍL (2026-08-04): el diagnóstico SOLO toma requerimientos.
   No recomienda qué construir, no clasifica dificultad y no sugiere
   tier ni precio — ni al prospecto ni en las notas internas. Eso lo
   decide el equipo después de estudiar el caso.

   El motivo es concreto: la recomendación automática se equivocó con
   un prospecto real (una empresa que pedía automatizar requisiciones
   contra su ERP salió clasificada como "AI Front Desk WhatsApp",
   porque el catálogo hacía match por palabras clave). Una etiqueta
   equivocada en la ficha es peor que ninguna: invita a cotizar sobre
   una lectura falsa del problema.

   Lo que sí produce este módulo son HECHOS y HUECOS: qué contó el
   prospecto, y qué falta preguntarle. Todo pure y determinista.
   ============================================================ */

const clamp = (n) => Math.max(1, Math.min(5, n));
const text = (v) => String(v == null ? '' : v).toLowerCase();

/* ---- Señales medibles (hechos, no juicios) -------------------------- */

/** Highest number mentioned in a volume string, normalised to per-day.
    "80 mensajes al día" -> 80 ; "300 a la semana" -> ~43 ; "" -> null */
function perDay(s) {
  const t = text(s);
  if (!t) return null;
  const nums = (t.match(/\d[\d.,]*/g) || []).map((x) => Number(x.replace(/[.,]/g, '')));
  if (!nums.length) return null;
  const n = Math.max(...nums);
  if (/semana|week/.test(t)) return n / 7;
  if (/mes|month/.test(t)) return n / 30;
  return n; // día / diario / sin unidad => se asume por día
}

/** Channels an agent would have to cover. Drops the physical counter (no
    agent attends it) and any channel the prospect described as dead. */
const DEAD_CHANNEL_RE = /abandonad|inactiv|no lo usamos|no la usamos|sin uso|muerto|ya no|desactivad|olvidad/;
const PHYSICAL_CHANNEL_RE = /mostrador|presencial|tienda f[íi]sica|sucursal|piso de venta/;

function channelSet(brain) {
  const op = brain.operation || {};
  const entries = [
    ...(op.sales_channels || []).map((c) => [c, '']),
    ...(op.service_channels || []).map((c) => [c, '']),
    ...(brain.current_channels || []).map((c) => [c.channel || c, [c.volume, c.owner_today].filter(Boolean).join(' ')]),
    ...(brain.desired_channels || []).map((c) => [c, '']),
  ].map(([c, note]) => [text(c).trim(), text(note)]).filter(([c]) => c);

  const dead = new Set(entries.filter(([, note]) => DEAD_CHANNEL_RE.test(note)).map(([c]) => c));
  const set = new Set(entries.map(([c]) => c));
  for (const c of Array.from(set)) {
    if (PHYSICAL_CHANNEL_RE.test(c) || DEAD_CHANNEL_RE.test(c) || dead.has(c)) set.delete(c);
  }
  return set;
}

function toolsText(brain) {
  const op = brain.operation || {};
  return [...(op.tools_today || []), ...(brain.integrations || []).map((i) => i.tool)].map(text).join(' ');
}

function hasRealTools(brain) {
  const t = toolsText(brain);
  if (!t.trim()) return false;
  if (/^(\s|,)*(nada|ninguno|ninguna|no|n\/a)(\s|,)*$/.test(t)) return false;
  return /punto de venta|pos\b|crm|erp|facturaci|sistema|software|shopify|odoo|contpaq|aspel|sae|excel|sheets|hoja/.test(t);
}

function integrationAppetite(brain) {
  const ap = (brain.integrations || []).map((i) => i.integration_appetite || 'unknown');
  if (ap.includes('read_write')) return 'read_write';
  if (ap.includes('read')) return 'read';
  return 'unknown';
}

/* ---- Score: señal factual, SIN clasificación comercial -------------- */

const PENDING = 'Por estudiar';

function scoreHundred(brain) {
  const nCh = channelSet(brain).size;
  const vol = Math.max(perDay((brain.operation || {}).volume_messages) || 0, perDay((brain.operation || {}).volume_orders) || 0);
  const ap = integrationAppetite(brain);

  const dimensions = {
    channels: clamp(nCh >= 3 ? 5 : nCh === 2 ? 3 : 1),
    volume: clamp(vol >= 100 ? 5 : vol >= 30 ? 3 : vol > 0 ? 2 : 1),
    integration: clamp(ap === 'read_write' ? 5 : ap === 'read' ? 3 : hasRealTools(brain) ? 2 : 1),
    ownership: clamp((brain.operation || {}).who_would_operate ? 1 : 4),
    urgency: clamp(/urgent|inmediato|ya|ayer|este mes/.test(text((brain.urgency || {}).timeline)) ? 5 : 2),
  };
  const vals = Object.values(dimensions);

  return {
    dimensions,
    average: +(vals.reduce((a, c) => a + c, 0) / vals.length).toFixed(2),
    channels_to_cover: Array.from(channelSet(brain)),
    volume_per_day: vol || null,
    integration_appetite: ap,
    // El alcance lo decide una persona. La ficha nunca lo prejuzga.
    classification: PENDING,
    overrides_applied: [],
  };
}

/* ---- Huecos: qué falta preguntar ------------------------------------ */

/** Data the team will miss when studying the case. These are gaps in the
    INTERVIEW, never judgements about the deal. */
function buildGaps(brain) {
  const gaps = [];
  const p = brain.main_problem || {};
  const u = brain.urgency || {};
  const op = brain.operation || {};

  if (!p.cost_money && !p.cost_time && !p.cost_customers) gaps.push('No se cuantificó lo que cuesta el problema.');
  if (!p.how_solved_today) gaps.push('No quedó claro cómo lo resuelven hoy.');
  if (!p.tried_before) gaps.push('No se preguntó qué han intentado antes.');
  if (!perDay(op.volume_messages) && !perDay(op.volume_orders)) gaps.push('Volumen sin cuantificar.');
  if (!op.who_would_operate) gaps.push('No hay nadie identificado del lado del cliente para operar.');
  if (!u.timeline) gaps.push('Sin fecha objetivo.');
  if (!u.budget_signal && !u.budget_posture) gaps.push('Sin señal de presupuesto.');
  if ((brain.completeness || 0) < 0.6) gaps.push('Expediente incompleto (<60%): la entrevista se quedó corta.');

  return gaps;
}

/* ---- Expediente interno --------------------------------------------- */

/**
 * What the prospect told us, organised. No recommendation, no difficulty,
 * no tier, no price: the team reads this and decides.
 */
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+\w/g;

/** Every address the prospect typed, beyond the one we kept as THE contact.
    Dulces Providencia asked for three colleagues to be copied and all three
    were dropped by the summary — the raw text is the only place they existed. */
function otherEmails(transcript, primary) {
  const said = (transcript || []).filter((m) => m.role === 'user').map((m) => m.content).join(' ');
  const found = said.match(EMAIL_RE) || [];
  const p = String(primary || '').toLowerCase();
  return Array.from(new Set(found.map((e) => e.trim()))).filter((e) => e.toLowerCase() !== p);
}

function buildHundredProposal(brain, transcript) {
  const cp = brain.company_profile || {};
  const p = brain.main_problem || {};
  const op = brain.operation || {};
  const ur = brain.urgency || {};
  const ct = brain.client_contact || {};

  const cost = [p.cost_time, p.cost_money, p.cost_customers].filter(Boolean).join(' · ') || 'no cuantificado';

  return {
    kind: 'intake',
    client: brain.client_name || cp.name || 'Prospecto',
    client_email: ct.email || null,
    client_whatsapp: ct.whatsapp || ct.phone || null,
    client_person: ct.name || null,
    other_emails: otherEmails(transcript, ct.email),
    company: {
      industry: cp.industry || null,
      location: cp.location || null,
      size: cp.size || null,
      years_operating: cp.years_operating || null,
      customer_type: cp.customer_type || null,
    },

    problem_summary: p.description || 'Sin problema principal registrado.',
    problem_cost: cost,
    problem_today: p.how_solved_today || null,
    problem_since: p.since_when || null,
    problem_tried: p.tried_before || null,
    problem_if_unsolved: p.consequence_if_unsolved || null,
    problem_severity: p.severity || null,

    operation: {
      sales_channels: op.sales_channels || [],
      service_channels: op.service_channels || [],
      volume_messages: op.volume_messages || null,
      volume_orders: op.volume_orders || null,
      tools_today: op.tools_today || [],
      who_would_operate: op.who_would_operate || null,
    },
    urgency: {
      timeline: ur.timeline || null,
      driver: ur.driver || null,
      budget_signal: ur.budget_signal || null,
      budget_posture: ur.budget_posture || null,
    },
    success_criteria: (brain.success_criteria || []).map((s) => s.statement || s.metric).filter(Boolean),

    gaps: buildGaps(brain),
    open_questions: (brain.missing_information || []).map((m) => m.field),

    // Lo que sigue es trabajo humano, siempre.
    scope: PENDING,
    next_step: 'Estudiar el caso y preparar la propuesta. Contactar en menos de 24 h, como se le prometió en la entrevista.',
    human_review_required: true,
    internal_only: true,
  };
}

/** El diagnóstico no diseña arquitectura. Se conserva la firma porque
    finalize construye siempre la misma cuarteta de artefactos. */
function buildHundredBlueprint() {
  return null;
}

module.exports = {
  PENDING,
  scoreHundred, buildHundredBlueprint, buildHundredProposal, buildGaps, otherEmails,
  perDay, channelSet, hasRealTools, integrationAppetite,
};
