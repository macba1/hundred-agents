/* ============================================================
   Scope Score — deterministic 1..5 per dimension + classification.
   Derived purely from the Business Brain (auditable, testable).
   ============================================================ */

const clamp = (n) => Math.max(1, Math.min(5, n));

function dimNumberOfBusinessLines(b) {
  const n = (b.business_lines || []).length;
  if (n <= 1) return 1;
  if (n <= 3) return 3;
  return 5; // 4+
}

function dimNumberOfChannels(b) {
  const set = new Set([
    ...(b.current_channels || []).map((c) => c.channel || c),
    ...(b.desired_channels || []),
  ].filter(Boolean));
  const n = set.size;
  if (n <= 1) return 1;
  if (n === 2) return 3;
  return 5;
}

function dimIntegration(b) {
  const ap = (b.integrations || []).map((i) => i.integration_appetite || 'unknown');
  if (ap.includes('read_write')) return 5;
  if (ap.includes('read')) return 3;
  return 1; // inform_only / unknown / none
}

function dimKnowledgeReadiness(b) {
  const levels = (b.business_unit_details || []).map((d) => d.knowledge_readiness || 'none');
  if (!levels.length) return 4;
  const worst = ['ready', 'partial', 'scattered', 'none'];
  const rank = { ready: 1, partial: 3, scattered: 4, none: 5 };
  let max = 1;
  levels.forEach((l) => { max = Math.max(max, rank[l] || 4); });
  return clamp(max);
}

function dimRisk(b) {
  const rules = (b.do_not_say_rules || []).map((r) => (r.rule || '').toLowerCase());
  const text = rules.join(' ');
  const high = /(invest|return|legal|terreno|land|availab|disponib|booking)/.test(text);
  if (high) return 5;
  if (rules.length > 1) return 3;
  return 2;
}

function dimLeadQualification(b) {
  const lists = b.lead_capture_fields_by_business || [];
  let maxFields = 0, hasScoring = false;
  lists.forEach((l) => {
    maxFields = Math.max(maxFields, (l.fields || []).length);
    if ((l.qualification_signals || []).length) hasScoring = true;
  });
  if (lists.length > 1 && (hasScoring || maxFields >= 5)) return 5;
  if (maxFields >= 3 || hasScoring) return 3;
  return 1;
}

function dimDashboard(b) {
  const sc = (b.success_criteria || []).map((s) => (s.metric || s.statement || '')).join(' ').toLowerCase();
  const wantsMetrics = /(dashboard|report|metric|kpi|insight|leads\/|por semana|weekly)/.test(sc);
  const multi = (b.business_lines || []).length > 1;
  if (wantsMetrics && multi) return 5;
  if (wantsMetrics) return 3;
  return 1;
}

function dimHandoff(b) {
  const rules = b.escalation_rules || [];
  const people = new Set(rules.map((r) => r.handoff_to).filter(Boolean));
  const afterHours = rules.some((r) => /24|after|noche|night|always/.test((r.hours || '').toLowerCase()));
  if (people.size > 1 && afterHours) return 5;
  if (rules.length > 1 || afterHours) return 3;
  if (rules.length === 1) return 2;
  return 1;
}

function scoreBrain(b) {
  const dimensions = {
    business_lines: dimNumberOfBusinessLines(b),
    channels: dimNumberOfChannels(b),
    integration: dimIntegration(b),
    knowledge_readiness: dimKnowledgeReadiness(b),
    risk: dimRisk(b),
    lead_qualification: dimLeadQualification(b),
    dashboard: dimDashboard(b),
    human_handoff: dimHandoff(b),
  };
  const vals = Object.values(dimensions);
  const average = +(vals.reduce((a, c) => a + c, 0) / vals.length).toFixed(2);

  // hard overrides
  const overrides = [];
  const nLines = (b.business_lines || []).length;
  if (dimensions.risk === 5) overrides.push('risk=5 (guardrails required)');
  if (nLines >= 4) overrides.push('4+ business lines');
  if (dimensions.integration === 5) overrides.push('read/write integration');
  if (dimensions.knowledge_readiness === 5) overrides.push('knowledge readiness=5 (content creation needed first)');

  let classification;
  const forceFull = nLines >= 4 || dimensions.integration === 5 || dimensions.risk === 5;
  if (forceFull || average >= 3.7) classification = 'Full Agentic Desk';
  else if (average >= 2.3) classification = 'Multi-Business MVP';
  else classification = 'Starter Pilot';

  return { dimensions, average, classification, overrides_applied: overrides };
}

module.exports = { scoreBrain };
