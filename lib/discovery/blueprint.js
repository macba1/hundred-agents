/* ============================================================
   Agent Blueprint — future architecture with recommended phases.
   Pure: derives which components are needed and when, from the
   Business Brain + Scope Score. Does NOT assume all in phase 1.
   ============================================================ */

// Map known business-line names (loose match) to a specialized agent.
const BUSINESS_AGENTS = [
  { match: /glamp/i,  component: 'Glamping Agent' },
  { match: /terren|land/i, component: 'Terrenos Agent', risk: 'Strict do-not-say: no investment/legal claims.' },
  { match: /recicl|recycl/i, component: 'Recicladora Agent' },
  { match: /hangar/i, component: 'Hangares Agent' },
];

function buildBlueprint(brain, score) {
  const lines = brain.business_lines || [];
  const priority = (brain.priority_businesses || []).slice().sort((a, b) => (a.rank || 99) - (b.rank || 99));
  const cls = score.classification;
  const components = [];

  const add = (component, phase, why, opts = {}) =>
    components.push({ component, phase, depends_on: opts.depends_on || [], why_this_phase: why, risk_notes: opts.risk || '' });

  // Discovery already exists.
  add('Discovery Agent', 0, 'Already in use to collect this context.');

  // Decide phase-1 businesses: top priority (1, or 2 for MVP/Full).
  const p1Count = cls === 'Starter Pilot' ? 1 : cls === 'Multi-Business MVP' ? 2 : 2;
  const p1Names = (priority.length ? priority.map((p) => p.name) : lines.map((l) => l.name)).slice(0, p1Count);

  // Specialized agents, phased.
  const seen = new Set();
  function agentFor(name) {
    const hit = BUSINESS_AGENTS.find((a) => a.match.test(name));
    return hit || { component: `${name} Agent` };
  }
  lines.forEach((l) => {
    const a = agentFor(l.name);
    if (seen.has(a.component)) return;
    seen.add(a.component);
    const inP1 = p1Names.some((n) => agentFor(n).component === a.component);
    add(a.component, inP1 ? 1 : 2,
      inP1 ? 'Priority business for the first phase.' : 'Added once phase 1 is validated.',
      { risk: a.risk || '' });
  });

  // Router: needed when >1 business agent is live.
  const businessAgentCount = components.filter((c) => /Agent$/.test(c.component) && c.component !== 'Discovery Agent' && c.component !== 'Human Escalation Agent').length;
  add('Router Agent', businessAgentCount > 1 ? 1 : 2,
    businessAgentCount > 1 ? 'More than one business agent in phase 1 requires routing.' : 'Needed once a second business agent goes live.');

  // Escalation: phase 1 (always need a human path).
  add('Human Escalation Agent', 1, 'A human handoff path is required from day one.',
    { depends_on: [] });

  // Dashboard + monthly loop scale with classification.
  add('Dashboard', cls === 'Full Agentic Desk' ? 1 : 2,
    cls === 'Full Agentic Desk' ? 'Multi-business reporting needed early.' : 'Add once there is enough volume to report on.');
  add('Monthly Improvement Loop', cls === 'Full Agentic Desk' ? 2 : 3,
    'Refine FAQs/guardrails from real transcripts after launch.');

  return {
    classification: cls,
    phase_1_businesses: p1Names,
    components,
  };
}

module.exports = { buildBlueprint };
