/* ============================================================
   Scope / Blueprint / Proposal for clientKey "hundred".

   Same contract as the Gabi trio (score.js + blueprint.js +
   proposal.js) so finalize.js can swap them by clientKey, but
   scored against OUR catalogue and OUR commercial tiers instead
   of the multi-business-line model.

   Everything here is pure and deterministic: the same brain always
   yields the same recommendation, difficulty and tier, so the
   internal proposal is auditable.

   HARD GATE: the output is INTERNAL. human_review_required is
   always true and nothing here is ever shown to the prospect.
   ============================================================ */

const clamp = (n) => Math.max(1, Math.min(5, n));
const text = (v) => String(v == null ? '' : v).toLowerCase();

/* ---- Catalogue ---------------------------------------------------- */

const CATALOG = {
  front_desk: {
    key: 'front_desk',
    name: 'AI Front Desk WhatsApp',
    what: 'Atiende WhatsApp 24/7: responde preguntas frecuentes, informa producto/servicio, captura el lead y pasa a un humano cuando hace falta.',
  },
  pedidos: {
    key: 'pedidos',
    name: 'Agente de pedidos',
    what: 'Toma pedidos y cotizaciones por WhatsApp contra el catálogo, confirma con el cliente y deja el pedido listo para que lo surta una persona.',
  },
  citas: {
    key: 'citas',
    name: 'Agente de citas',
    what: 'Agenda, reagenda y recuerda citas por WhatsApp, con confirmación humana cuando la agenda es crítica.',
  },
  leads: {
    key: 'leads',
    name: 'Agente de calificación de leads',
    what: 'Atiende lo que entra por redes y web, califica contra los criterios del cliente y entrega el lead calificado al vendedor.',
  },
  otro: {
    key: 'otro',
    name: 'Agente a medida',
    what: 'El caso no cae limpio en un producto del catálogo; el alcance lo define el equipo tras revisar el expediente.',
  },
};

/* Optional modules, added on top of the recommended primary agent. */
const MODULES = {
  catalogo:     { name: 'Catálogo estructurado', what: 'Convertir lista de precios / inventario en catálogo consultable por el agente.' },
  handoff:      { name: 'Escalamiento a humano', what: 'Ruta y aviso al responsable cuando el caso requiere persona.' },
  panel:        { name: 'Panel de leads y conversaciones', what: 'Bandeja para ver, filtrar y exportar lo que entra.' },
  integracion:  { name: 'Integración con sistema actual', what: 'Lectura/escritura contra el punto de venta, CRM o sistema de facturación.' },
  multicanal:   { name: 'Canales adicionales', what: 'Instagram / Facebook / web sobre el mismo cerebro.' },
  contenido:    { name: 'Levantamiento de contenido', what: 'Construir desde cero las respuestas, precios y políticas que hoy no existen escritas.' },
  reportes:     { name: 'Reportes mensuales', what: 'Métricas de atención, leads y pedidos, y ciclo de mejora.' },
};

/* ---- Tiers (MXN) --------------------------------------------------- */

const TIERS = {
  basico:  { key: 'basico',  name: 'Básico',  setup: 15000, monthly: 1500 },
  pro:     { key: 'pro',     name: 'Pro',     setup: 40000, monthly: 3000 },
  fabrica: { key: 'fabrica', name: 'Fábrica', setup: 75000, monthly: 5000 },
};
const TIER_BAND = 0.2; // ±20% según alcance final

const mxn = (n) => '$' + Number(n).toLocaleString('en-US') + ' MXN';
function band(n) {
  return { low: Math.round(n * (1 - TIER_BAND)), mid: n, high: Math.round(n * (1 + TIER_BAND)) };
}

/* ---- Signal extraction --------------------------------------------- */

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

function channelSet(brain) {
  const op = brain.operation || {};
  const set = new Set([
    ...(op.sales_channels || []),
    ...(op.service_channels || []),
    ...(brain.current_channels || []).map((c) => c.channel || c),
    ...(brain.desired_channels || []),
  ].map((c) => text(c).trim()).filter(Boolean));
  // Mostrador/presencial no es un canal que el agente pueda atender.
  for (const c of Array.from(set)) if (/mostrador|presencial|tienda física|sucursal/.test(c)) set.delete(c);
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

/** All free text about the problem + operation, for keyword detection. */
function problemText(brain) {
  const p = brain.main_problem || {};
  return [
    p.description, p.how_solved_today, p.cost_time, p.cost_money, p.cost_customers,
    p.consequence_if_unsolved, p.tried_before,
    (brain.company_profile || {}).industry,
    ...(brain.pain_points || []).map((x) => x.description),
    ...(brain.success_criteria || []).map((x) => x.statement || x.metric),
  ].map(text).join(' ');
}

/* ---- Recommendation ------------------------------------------------ */

/** Which product from the catalogue this case calls for. */
function recommendBuild(brain) {
  const t = problemText(brain);
  const ch = Array.from(channelSet(brain)).join(' ');
  const reasons = [];

  const wantsOrders = /pedido|orden|cotiza|surt|mayoreo|reorden|resurtid|levanta/.test(t);
  const wantsAppointments = /cita|agenda|consulta|reserv|turno/.test(t);
  const wantsLeads = /lead|prospect|cotizador|instagram|facebook|anuncio|campañ|publicidad/.test(t);
  const wantsAttention = /contest|atend|respond|pregunt|whats|llamad|teléfono|telefono|mensaje|informaci/.test(t)
    || /whats/.test(ch);

  let primary;
  if (wantsOrders) { primary = CATALOG.pedidos; reasons.push('El problema gira alrededor de pedidos/cotizaciones, no solo de responder dudas.'); }
  else if (wantsAppointments) { primary = CATALOG.citas; reasons.push('El problema gira alrededor de la agenda y las citas.'); }
  else if (wantsAttention) { primary = CATALOG.front_desk; reasons.push('El problema es de atención: se pierden mensajes o llamadas sin responder.'); }
  else if (wantsLeads) { primary = CATALOG.leads; reasons.push('El problema está en la entrada de prospectos por redes/web, no en la operación diaria.'); }
  else { primary = CATALOG.otro; reasons.push('La transcripción no define con claridad el tipo de agente; requiere criterio humano.'); }

  // El front desk casi siempre acompaña a pedidos/citas: sin atención no hay pedido.
  const secondary = [];
  if (primary.key === 'pedidos' || primary.key === 'citas') {
    if (wantsAttention) secondary.push(CATALOG.front_desk);
  }
  if (primary.key === 'front_desk' && wantsLeads) secondary.push(CATALOG.leads);

  return { primary, secondary, reasons };
}

/* ---- Difficulty ---------------------------------------------------- */

function assessDifficulty(brain, rec) {
  const reasons = [];
  let points = 0;

  const nCh = channelSet(brain).size;
  if (nCh >= 3) { points += 2; reasons.push(`${nCh} canales a cubrir.`); }
  else if (nCh === 2) { points += 1; reasons.push('Dos canales a cubrir.'); }
  else reasons.push(nCh === 1 ? 'Un solo canal.' : 'Canales no especificados (se asume uno).');

  const vol = Math.max(perDay((brain.operation || {}).volume_messages) || 0, perDay((brain.operation || {}).volume_orders) || 0);
  if (vol >= 100) { points += 2; reasons.push(`Volumen alto (~${Math.round(vol)}/día).`); }
  else if (vol >= 30) { points += 1; reasons.push(`Volumen medio (~${Math.round(vol)}/día).`); }
  else if (vol > 0) reasons.push(`Volumen bajo (~${Math.round(vol)}/día).`);
  else reasons.push('Volumen no cuantificado.');

  const ap = integrationAppetite(brain);
  if (ap === 'read_write') { points += 3; reasons.push('Integración de lectura/escritura contra su sistema.'); }
  else if (ap === 'read') { points += 1; reasons.push('Integración de solo lectura.'); }
  else if (hasRealTools(brain)) { points += 1; reasons.push('Tiene sistema propio; hay que decidir si se integra o se convive.'); }
  else reasons.push('Sin sistemas que integrar.');

  if (rec.primary.key === 'pedidos') { points += 2; reasons.push('Tomar pedidos exige catálogo estructurado y confirmación, no solo responder.'); }
  else if (rec.primary.key === 'citas') { points += 1; reasons.push('Agendar exige manejo de disponibilidad.'); }
  else if (rec.primary.key === 'otro') { points += 1; reasons.push('Alcance sin definir.'); }

  if (needsContent(brain)) { points += 1; reasons.push('El contenido (precios, respuestas, políticas) no existe escrito y hay que levantarlo.'); }
  if (rec.secondary.length) { points += 1; reasons.push('Requiere más de un agente conviviendo.'); }

  const difficulty = points >= 6 ? 'alta' : points >= 3 ? 'media' : 'baja';
  return { difficulty, points, reasons };
}

function needsContent(brain) {
  const mats = brain.source_materials_available || [];
  if (mats.length && mats.every((m) => m.provided)) return false;
  const t = toolsText(brain);
  const hasCatalogSignal = /catálogo|catalogo|lista de precios|inventario|excel|sheets|punto de venta|pos\b/.test(t)
    || mats.some((m) => /catálogo|catalogo|precio|inventario/i.test(m.type || ''));
  return !hasCatalogSignal;
}

/* ---- Score (same shape as score.js so the admin can render both) ---- */

function scoreHundred(brain) {
  const rec = recommendBuild(brain);
  const diff = assessDifficulty(brain, rec);
  const nCh = channelSet(brain).size;
  const vol = Math.max(perDay((brain.operation || {}).volume_messages) || 0, perDay((brain.operation || {}).volume_orders) || 0);
  const ap = integrationAppetite(brain);

  const dimensions = {
    channels: clamp(nCh >= 3 ? 5 : nCh === 2 ? 3 : 1),
    volume: clamp(vol >= 100 ? 5 : vol >= 30 ? 3 : vol > 0 ? 2 : 1),
    integration: clamp(ap === 'read_write' ? 5 : ap === 'read' ? 3 : hasRealTools(brain) ? 2 : 1),
    process_complexity: clamp(rec.primary.key === 'pedidos' ? 5 : rec.primary.key === 'citas' ? 3 : rec.primary.key === 'otro' ? 3 : 1),
    knowledge_readiness: clamp(needsContent(brain) ? 5 : 2),
    ownership: clamp((brain.operation || {}).who_would_operate ? 1 : 4),
    urgency: clamp(/urgent|inmediato|ya|ayer|este mes/.test(text((brain.urgency || {}).timeline)) ? 5 : 2),
  };
  const vals = Object.values(dimensions);
  const average = +(vals.reduce((a, c) => a + c, 0) / vals.length).toFixed(2);

  return {
    dimensions,
    average,
    // `classification` keeps the name the rest of the pipeline (and the Notion
    // "Alcance" select) already uses; for hundred it is the tier name.
    classification: tierFor(diff.difficulty).name,
    difficulty: diff.difficulty,
    difficulty_points: diff.points,
    difficulty_reasons: diff.reasons,
    recommended_build: rec.primary.name,
    recommended_build_key: rec.primary.key,
    recommendation_reasons: rec.reasons,
    overrides_applied: [],
  };
}

function tierFor(difficulty) {
  return difficulty === 'alta' ? TIERS.fabrica : difficulty === 'media' ? TIERS.pro : TIERS.basico;
}

/* ---- Blueprint: modules and phases ---------------------------------- */

function buildHundredBlueprint(brain, score) {
  const rec = recommendBuild(brain);
  const components = [];
  const add = (component, phase, why) => components.push({ component, phase, why_this_phase: why });

  add(rec.primary.name, 1, 'Es el agente que ataca directamente el problema principal.');
  add(MODULES.handoff.name, 1, 'Debe haber ruta a humano desde el día uno.');

  if (needsContent(brain)) add(MODULES.contenido.name, 1, 'Sin contenido escrito el agente no puede responder; va antes que nada.');
  if (rec.primary.key === 'pedidos') add(MODULES.catalogo.name, 1, 'El agente de pedidos necesita el catálogo estructurado para operar.');
  else if (!needsContent(brain)) add(MODULES.catalogo.name, 2, 'Mejora las respuestas una vez validado el flujo base.');

  add(MODULES.panel.name, 1, 'El cliente necesita ver y exportar lo que entra desde el primer día.');

  rec.secondary.forEach((s) => add(s.name, 2, 'Se suma cuando el agente principal ya está validado.'));

  const ap = integrationAppetite(brain);
  if (ap === 'read_write' || ap === 'read') add(MODULES.integracion.name, 2, 'La integración se hace después de validar el flujo conversacional.');
  else if (hasRealTools(brain)) add(MODULES.integracion.name, 3, 'Opcional: solo si el volumen justifica dejar de capturar a mano.');

  if (channelSet(brain).size > 1) add(MODULES.multicanal.name, 2, 'Se replica el mismo cerebro en los demás canales.');
  add(MODULES.reportes.name, 3, 'Ciclo de mejora con transcripciones reales tras el lanzamiento.');

  return {
    classification: score.classification,
    recommended_build: rec.primary.name,
    phase_1: components.filter((c) => c.phase === 1).map((c) => c.component),
    phase_2: components.filter((c) => c.phase === 2).map((c) => c.component),
    phase_3: components.filter((c) => c.phase === 3).map((c) => c.component),
    components,
  };
}

/* ---- Alerts --------------------------------------------------------- */

function buildAlerts(brain, score) {
  const alerts = [];
  const p = brain.main_problem || {};
  const u = brain.urgency || {};
  const op = brain.operation || {};
  const t = problemText(brain);

  if (!p.cost_money && !p.cost_time && !p.cost_customers) {
    alerts.push('Sin costo del problema cuantificado: no hay caso de negocio que defender en la propuesta.');
  }
  if (text(u.budget_posture) === 'tight') alerts.push('Presupuesto declarado como ajustado; el tier sugerido puede no caber.');
  if (text(u.budget_posture) === 'exploring' || (!u.budget_signal && !u.budget_posture)) {
    alerts.push('Sin señal de presupuesto: puede ser exploración, no compra.');
  }
  if (!op.who_would_operate) alerts.push('Nadie identificado del lado del cliente para operar el sistema.');

  const vol = Math.max(perDay(op.volume_messages) || 0, perDay(op.volume_orders) || 0);
  if (vol > 0 && vol < 10) alerts.push(`Volumen bajo (~${Math.round(vol)}/día): el retorno puede no justificar la inversión.`);
  if (!vol) alerts.push('Volumen sin cuantificar: el esfuerzo y el tier son estimaciones débiles.');

  if (/cierre? autom|que venda sol|cierre las ventas/.test(t)) {
    alerts.push('Expectativa de cierre automático de ventas: hay que alinear en la propuesta que la AI califica y pasa a humano.');
  }
  if (score.difficulty === 'alta' && /urgent|inmediato|ya|ayer|este mes/.test(text(u.timeline))) {
    alerts.push('Dificultad alta con urgencia inmediata: el calendario prometido debe ser realista o se pierde el cliente en la entrega.');
  }
  if (needsContent(brain)) alerts.push('No hay contenido escrito (precios/respuestas): la fase 1 incluye levantamiento y eso alarga la entrega.');
  if (integrationAppetite(brain) === 'read_write') alerts.push('Integración de escritura contra su sistema: validar acceso y API antes de comprometer alcance.');
  if ((brain.completeness || 0) < 0.6) alerts.push('Expediente incompleto (<60%): faltan respuestas para cotizar con confianza.');

  return alerts;
}

/* ---- Internal proposal ---------------------------------------------- */

function buildHundredProposal(brain, score, blueprint) {
  const rec = recommendBuild(brain);
  const tier = tierFor(score.difficulty);
  const setup = band(tier.setup);
  const monthly = band(tier.monthly);
  const cp = brain.company_profile || {};
  const p = brain.main_problem || {};
  const alerts = buildAlerts(brain, score);

  const cost = [p.cost_time, p.cost_money, p.cost_customers].filter(Boolean).join(' · ') || 'no cuantificado';

  const draft = {
    client: brain.client_name || cp.name || 'Prospecto',
    client_email: (brain.client_contact && brain.client_contact.email) || null,
    client_whatsapp: (brain.client_contact && (brain.client_contact.whatsapp || brain.client_contact.phone)) || null,
    company: {
      industry: cp.industry || null,
      location: cp.location || null,
      size: cp.size || null,
    },
    delivery_method: 'email + llamada en <24h',

    problem_summary: p.description || 'Sin problema principal registrado.',
    problem_cost: cost,
    problem_today: p.how_solved_today || null,
    problem_since: p.since_when || null,
    problem_tried: p.tried_before || null,
    problem_if_unsolved: p.consequence_if_unsolved || null,

    recommended_build: rec.primary.name,
    recommended_build_what: rec.primary.what,
    recommended_build_reasons: rec.reasons,
    also_consider: rec.secondary.map((s) => s.name),

    modules_phase_1: blueprint.phase_1,
    modules_phase_2: blueprint.phase_2,
    modules_phase_3: blueprint.phase_3,

    difficulty: score.difficulty,
    difficulty_justification: score.difficulty_reasons,

    suggested_tier: tier.name,
    suggested_pricing_tier: `${tier.name} — ${mxn(tier.setup)} + ${mxn(tier.monthly)}/mes`,
    pricing_internal: {
      tier: tier.key,
      setup_mxn: tier.setup,
      monthly_mxn: tier.monthly,
      band_pct: TIER_BAND,
      setup_range_mxn: [setup.low, setup.high],
      monthly_range_mxn: [monthly.low, monthly.high],
      note: `Banda ±${Math.round(TIER_BAND * 100)}% según alcance final. Precio interno: NO se comparte con el prospecto sin revisión humana.`,
    },

    alerts,
    open_questions: (brain.missing_information || []).map((m) => m.field),
    next_step: alerts.length
      ? 'Revisar alertas antes de cotizar; llamada de 15 min para cerrar los huecos y luego enviar propuesta.'
      : 'Armar propuesta con el tier sugerido y contactar en <24h como se prometió en el diagnóstico.',

    human_review_required: true,
    internal_only: true,
  };

  return draft;
}

module.exports = {
  CATALOG, MODULES, TIERS, TIER_BAND,
  scoreHundred, buildHundredBlueprint, buildHundredProposal,
  recommendBuild, assessDifficulty, buildAlerts, tierFor,
  perDay, channelSet, needsContent, mxn,
};
