/* ============================================================
   Business Brain — schema-lite validation, merge of partial
   updates from the agent, completeness + missing_information,
   and enforcement of high-risk do-not-say defaults.
   Pure functions (no I/O) so they are unit-testable.
   ============================================================ */

const REQUIRED_TOP = [
  'client_name', 'client_contact', 'business_lines', 'priority_businesses', 'current_channels',
  'desired_channels', 'pain_points', 'business_unit_details', 'faqs_by_business',
  'lead_capture_fields_by_business', 'escalation_rules', 'do_not_say_rules',
  'integrations', 'source_materials_available', 'missing_information',
  'success_criteria', 'phasing_preference',
];

/* The "hundred" profile is one-problem-deep instead of many-businesses-wide,
   so completeness is measured over its own fields. Dotted paths are
   supported: the consultant-depth answers live inside main_problem, and a
   brain that only has main_problem.description is NOT a complete one. */
const REQUIRED_HUNDRED = [
  'client_name', 'client_contact',
  'company_profile.industry', 'company_profile.location', 'company_profile.size',
  'main_problem.description', 'main_problem.how_solved_today',
  'main_problem.cost_time', 'main_problem.cost_money', 'main_problem.cost_customers',
  'main_problem.since_when', 'main_problem.tried_before', 'main_problem.consequence_if_unsolved',
  'operation.sales_channels', 'operation.service_channels', 'operation.volume_messages',
  'operation.tools_today', 'operation.who_would_operate',
  'urgency.timeline', 'urgency.budget_signal',
  'success_criteria',
];

const REQUIRED_BY_CLIENT = { gabi: REQUIRED_TOP, hundred: REQUIRED_HUNDRED };
const BLOCKING_BY_CLIENT = {
  gabi: ['business_lines', 'priority_businesses'],
  hundred: ['client_name', 'main_problem.description'],
};

const WHY_BY_FIELD = {
  'main_problem.cost_money': 'Sin el costo del problema no se puede justificar la inversión ni elegir tier.',
  'main_problem.cost_time': 'Las horas perdidas son la métrica de retorno más fácil de defender.',
  'main_problem.how_solved_today': 'El proceso actual define qué se automatiza y qué se sustituye.',
  'operation.volume_messages': 'El volumen determina el esfuerzo y el tier.',
  'operation.who_would_operate': 'Sin dueño del lado del cliente el proyecto se estanca tras la entrega.',
  'urgency.budget_signal': 'Marca si es una oportunidad real o exploración.',
};

/** Read a possibly dotted path ('main_problem.cost_money') off an object. */
function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function hasEmail(brain) {
  const e = brain && brain.client_contact && brain.client_contact.email;
  return typeof e === 'string' && EMAIL_RE.test(e.trim());
}

// High-risk rules that must always be present even if Gabi never raised them.
const DEFAULT_DO_NOT_SAY = [
  { scope: 'global', rule: 'Never quote or confirm a final setup or monthly price; pricing is reviewed by a human and sent by email.' },
  { scope: 'global', rule: 'Never confirm real-time availability or bookings without a verified integration.' },
  { scope: 'global', rule: 'Never make investment, return (ROI), appreciation, or legal claims about land / terrenos.' },
  { scope: 'global', rule: 'Never give legal or contract advice; route legal/contract questions to a human.' },
  { scope: 'global', rule: 'Never promise the AI will close sales automatically; closing is a human-approval step.' },
];

/* Same hard guardrails for the hundred profile, plus the two that this
   sales-facing diagnostic adds: no prices at all, and no designing the
   solution in front of the prospect. */
const DEFAULT_DO_NOT_SAY_HUNDRED = [
  ...DEFAULT_DO_NOT_SAY,
  { scope: 'global', rule: 'Nunca dar precios, rangos ni estimaciones de costo al prospecto; eso lo presenta el equipo en la propuesta.' },
  { scope: 'global', rule: 'Nunca diseñar la solución frente al prospecto (arquitectura, módulos, fases, tiempos o funciones concretas).' },
];

const DEFAULTS_BY_CLIENT = { gabi: DEFAULT_DO_NOT_SAY, hundred: DEFAULT_DO_NOT_SAY_HUNDRED };

function emptyBrain(clientName, clientKey) {
  if (clientKey === 'hundred') {
    return {
      client_name: clientName || '',
      client_contact: {},
      company_profile: {},
      main_problem: {},
      operation: {},
      urgency: {},
      pain_points: [],
      current_channels: [],
      desired_channels: [],
      integrations: [],
      do_not_say_rules: [],
      source_materials_available: [],
      missing_information: [],
      success_criteria: [],
    };
  }
  return {
    client_name: clientName || '',
    client_contact: {},
    business_lines: [],
    priority_businesses: [],
    current_channels: [],
    desired_channels: [],
    pain_points: [],
    business_unit_details: [],
    faqs_by_business: [],
    lead_capture_fields_by_business: [],
    escalation_rules: [],
    do_not_say_rules: [],
    integrations: [],
    source_materials_available: [],
    missing_information: [],
    success_criteria: [],
    phasing_preference: {},
  };
}

const isArr = Array.isArray;
const filled = (v) =>
  isArr(v) ? v.length > 0 : (v && typeof v === 'object') ? Object.keys(v).length > 0 : !!(v && String(v).trim());

/* Fields that must always hold a list. The model occasionally sends a single
   item where the schema asks for an array ("do_not_say_rules": {scope, rule}).
   Spreading that into the array slot turned the array into an object and made
   finalize crash with a 500 — so list-shaped keys are normalised on the way in
   and again on the way out. */
const LIST_FIELDS = new Set([
  ...Object.keys(emptyBrain('', 'gabi')).filter((k) => isArr(emptyBrain('', 'gabi')[k])),
  ...Object.keys(emptyBrain('', 'hundred')).filter((k) => isArr(emptyBrain('', 'hundred')[k])),
]);

/** Coerce anything into the list it was supposed to be. */
function asList(v) {
  if (isArr(v)) return v;
  if (v === undefined || v === null || v === '') return [];
  if (typeof v === 'object') return [v];
  return String(v).trim() ? [v] : [];
}

/** Shallow-merge a partial update: arrays replace if non-empty, scalars/objects overwrite if truthy. */
function mergePartial(brain, partial) {
  const out = { ...brain };
  if (!partial || typeof partial !== 'object') return out;
  for (const k of Object.keys(partial)) {
    const v = partial[k];
    if (v === undefined || v === null) continue;
    if (isArr(v)) { if (v.length) out[k] = v; }
    else if (LIST_FIELDS.has(k)) {
      // A single item where a list belongs: append it instead of replacing the
      // list (and instead of corrupting its type).
      const current = asList(out[k]);
      const seen = new Set(current.map((x) => JSON.stringify(x)));
      const add = asList(v).filter((x) => !seen.has(JSON.stringify(x)));
      if (add.length) out[k] = current.concat(add);
    }
    else if (typeof v === 'object') { out[k] = { ...(out[k] || {}), ...v }; }
    else if (String(v).trim()) { out[k] = v; }
  }
  return out;
}

/** Last line of defence: every list-shaped field really is a list. */
function normalizeLists(brain) {
  const out = { ...brain };
  for (const k of LIST_FIELDS) if (k in out) out[k] = asList(out[k]);
  return out;
}

/** Always include the high-risk do-not-say defaults (dedup by rule text). */
function ensureDoNotSayDefaults(brain, clientKey) {
  const defaults = DEFAULTS_BY_CLIENT[clientKey] || DEFAULT_DO_NOT_SAY;
  const have = new Set((brain.do_not_say_rules || []).map((r) => (r.rule || '').toLowerCase()));
  const merged = [...(brain.do_not_say_rules || [])];
  for (const d of defaults) {
    if (!have.has(d.rule.toLowerCase())) merged.push(d);
  }
  return { ...brain, do_not_say_rules: merged };
}

/** Completeness 0..1 + a missing_information list with blocking flags. */
function assess(brain, clientKey) {
  const required = REQUIRED_BY_CLIENT[clientKey] || REQUIRED_TOP;
  const blocking = BLOCKING_BY_CLIENT[clientKey] || BLOCKING_BY_CLIENT.gabi;
  const missing = [];
  let have = 0;
  for (const key of required) {
    if (filled(getPath(brain, key))) { have++; }
    else {
      missing.push({
        field: key,
        why_it_matters: WHY_BY_FIELD[key] || 'Required to scope and price the project.',
        blocking: blocking.includes(key),
      });
    }
  }
  // Email is required before finalization — flag it explicitly even if a
  // client_contact object exists without a valid email.
  if (!hasEmail(brain) && !missing.find((m) => m.field === 'client_contact.email')) {
    missing.push({
      field: 'client_contact.email',
      why_it_matters: 'The implementation & commercial proposal is sent here by email.',
      blocking: true,
    });
  }
  const completeness = +(have / required.length).toFixed(2);
  return { completeness, missing_information: missing };
}

/** Final compile pass: enforce defaults + recompute completeness/missing. */
function finalizeBrain(brain, clientKey) {
  let b = ensureDoNotSayDefaults(normalizeLists({ ...emptyBrain(brain.client_name, clientKey), ...brain }), clientKey);
  const a = assess(b, clientKey);
  b.completeness = a.completeness;
  b.missing_information = a.missing_information;
  return b;
}

function validate(brain, clientKey) {
  const errors = [];
  if (!brain || typeof brain !== 'object') return { valid: false, errors: ['not an object'] };
  if (clientKey === 'hundred') {
    for (const k of ['client_name', 'client_contact', 'company_profile', 'main_problem', 'operation', 'urgency']) {
      if (!(k in brain)) errors.push('missing key: ' + k);
    }
    if (brain.main_problem && typeof brain.main_problem !== 'object') errors.push('main_problem must be object');
  } else {
    for (const k of REQUIRED_TOP) if (!(k in brain)) errors.push('missing key: ' + k);
    if (!isArr(brain.business_lines)) errors.push('business_lines must be array');
  }
  if (typeof brain.client_name !== 'string') errors.push('client_name must be string');
  return { valid: errors.length === 0, errors };
}

module.exports = {
  REQUIRED_TOP, REQUIRED_HUNDRED, REQUIRED_BY_CLIENT, LIST_FIELDS,
  DEFAULT_DO_NOT_SAY, DEFAULT_DO_NOT_SAY_HUNDRED,
  emptyBrain, mergePartial, getPath, asList, normalizeLists,
  ensureDoNotSayDefaults, assess, finalizeBrain, validate, hasEmail,
};
