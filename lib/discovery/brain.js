/* ============================================================
   Business Brain — schema-lite validation, merge of partial
   updates from the agent, completeness + missing_information,
   and enforcement of high-risk do-not-say defaults.
   Pure functions (no I/O) so they are unit-testable.
   ============================================================ */

const REQUIRED_TOP = [
  'client_name', 'business_lines', 'priority_businesses', 'current_channels',
  'desired_channels', 'pain_points', 'business_unit_details', 'faqs_by_business',
  'lead_capture_fields_by_business', 'escalation_rules', 'do_not_say_rules',
  'integrations', 'source_materials_available', 'missing_information',
  'success_criteria', 'phasing_preference',
];

// High-risk rules that must always be present even if Gabi never raised them.
const DEFAULT_DO_NOT_SAY = [
  { scope: 'global', rule: 'Never quote or confirm a final price; pricing is reviewed by a human.' },
  { scope: 'global', rule: 'Never confirm real-time availability or bookings without a verified integration.' },
  { scope: 'global', rule: 'Never make investment, return, or legal claims about land / terrenos.' },
];

function emptyBrain(clientName) {
  return {
    client_name: clientName || '',
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

/** Shallow-merge a partial update: arrays replace if non-empty, scalars/objects overwrite if truthy. */
function mergePartial(brain, partial) {
  const out = { ...brain };
  if (!partial || typeof partial !== 'object') return out;
  for (const k of Object.keys(partial)) {
    const v = partial[k];
    if (v === undefined || v === null) continue;
    if (isArr(v)) { if (v.length) out[k] = v; }
    else if (typeof v === 'object') { out[k] = { ...(out[k] || {}), ...v }; }
    else if (String(v).trim()) { out[k] = v; }
  }
  return out;
}

/** Always include the high-risk do-not-say defaults (dedup by rule text). */
function ensureDoNotSayDefaults(brain) {
  const have = new Set((brain.do_not_say_rules || []).map((r) => (r.rule || '').toLowerCase()));
  const merged = [...(brain.do_not_say_rules || [])];
  for (const d of DEFAULT_DO_NOT_SAY) {
    if (!have.has(d.rule.toLowerCase())) merged.push(d);
  }
  return { ...brain, do_not_say_rules: merged };
}

/** Completeness 0..1 + a missing_information list with blocking flags. */
function assess(brain) {
  const missing = [];
  let have = 0;
  for (const key of REQUIRED_TOP) {
    if (filled(brain[key])) { have++; }
    else {
      missing.push({
        field: key,
        why_it_matters: 'Required to scope and price the project.',
        blocking: ['business_lines', 'priority_businesses'].includes(key),
      });
    }
  }
  const completeness = +(have / REQUIRED_TOP.length).toFixed(2);
  return { completeness, missing_information: missing };
}

/** Final compile pass: enforce defaults + recompute completeness/missing. */
function finalizeBrain(brain) {
  let b = ensureDoNotSayDefaults({ ...emptyBrain(brain.client_name), ...brain });
  const a = assess(b);
  b.completeness = a.completeness;
  b.missing_information = a.missing_information;
  return b;
}

function validate(brain) {
  const errors = [];
  if (!brain || typeof brain !== 'object') return { valid: false, errors: ['not an object'] };
  for (const k of REQUIRED_TOP) if (!(k in brain)) errors.push('missing key: ' + k);
  if (!isArr(brain.business_lines)) errors.push('business_lines must be array');
  if (typeof brain.client_name !== 'string') errors.push('client_name must be string');
  return { valid: errors.length === 0, errors };
}

module.exports = {
  REQUIRED_TOP, DEFAULT_DO_NOT_SAY, emptyBrain, mergePartial,
  ensureDoNotSayDefaults, assess, finalizeBrain, validate,
};
