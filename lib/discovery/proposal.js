/* ============================================================
   Proposal Draft — internal, human-review only.
   Deterministic skeleton from Brain + Score + Blueprint.
   HARD GATES: human_review_required always true; never a final
   price (tier band label only); reject any currency amount in
   client-facing text.
   ============================================================ */

const TIER_BY_CLASS = {
  'Starter Pilot': 'Starter Pilot tier',
  'Multi-Business MVP': 'Multi-Business MVP tier',
  'Full Agentic Desk': 'Full Agentic Desk tier',
};

// Detect a concrete price (currency) so we can refuse to emit one to Gabi.
const PRICE_RE = /(\$|usd|mxn|eur|€|£)\s?\d|[\d.,]\s?(usd|mxn|eur|pesos|dollars|dólares)/i;
function containsFinalPrice(text) {
  return PRICE_RE.test(String(text || ''));
}

function phaseComponents(blueprint, phase) {
  return (blueprint.components || []).filter((c) => c.phase === phase).map((c) => c.component);
}

function buildProposal(brain, score, blueprint) {
  const cls = score.classification;
  const p1 = phaseComponents(blueprint, 1);
  const p2 = phaseComponents(blueprint, 2);
  const p3 = phaseComponents(blueprint, 3);

  const required_materials = (brain.source_materials_available || [])
    .filter((m) => !m.provided)
    .map((m) => `${m.type}${m.business ? ' (' + m.business + ')' : ''}`);
  if (!(brain.business_unit_details || []).every((d) => d.knowledge_readiness === 'ready')) {
    required_materials.push('FAQs / price lists / catalog content for each priority business');
  }

  const open_questions = (brain.missing_information || []).map((m) => m.field);

  const draft = {
    client: brain.client_name || 'Gabi',
    executive_summary:
      `${brain.client_name || 'The client'} has ${(brain.business_lines || []).length} business line(s); ` +
      `recommended path is a ${cls} starting with: ${(blueprint.phase_1_businesses || []).join(', ') || 'the top-priority business'}. ` +
      `Begin where AI creates leverage fastest, prove it, then expand.`,
    recommended_phase_1: { focus: blueprint.phase_1_businesses, components: p1 },
    recommended_phase_2: { components: p2 },
    recommended_phase_3: { components: p3 },
    included: p1,
    not_included: ['Final pricing (set by Hundred Agents after review)', ...p2, ...p3],
    required_materials_from_gabi: Array.from(new Set(required_materials)),
    open_questions,
    suggested_pricing_tier: TIER_BY_CLASS[cls] || 'To be determined',
    monthly_maintenance_recommendation:
      cls === 'Full Agentic Desk' ? 'Monthly support + improvement loop (higher tier).'
      : cls === 'Multi-Business MVP' ? 'Monthly support + periodic review.'
      : 'Light monthly support.',
    risks_and_dependencies: [
      ...(score.overrides_applied || []),
      ...((brain.do_not_say_rules || []).some((r) => /invest|legal|land|terreno/i.test(r.rule)) ? ['Land/terrenos: legal/investment claims must be blocked.'] : []),
      ...((brain.business_unit_details || []).some((d) => d.knowledge_readiness === 'none') ? ['Some business knowledge must be created before automation.'] : []),
    ],
    human_review_required: true,
  };

  // GATE: client-facing fields must not contain a final price.
  const clientFacing = [draft.executive_summary, JSON.stringify(draft.recommended_phase_1), JSON.stringify(draft.included)].join(' ');
  draft.price_gate_passed = !containsFinalPrice(clientFacing);

  return draft;
}

module.exports = { buildProposal, containsFinalPrice };
