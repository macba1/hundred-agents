/* ============================================================
   Discovery Agent prompts: section list, system prompt, the
   update_brain tool schema, and the finalize/compile prompt.
   ============================================================ */

const SECTIONS = [
  { key: 'business_map',        title: 'Business Map' },
  { key: 'current_channels',    title: 'Current Channels' },
  { key: 'current_pain',        title: 'Current Pain' },
  { key: 'business_unit',       title: 'Business Unit Details' },
  { key: 'lead_capture',        title: 'Lead Capture' },
  { key: 'escalation',          title: 'Escalation Rules' },
  { key: 'do_not_say',          title: 'Do Not Say Rules' },
  { key: 'tools',               title: 'Tools & Integrations' },
  { key: 'success',             title: 'Success Criteria' },
  { key: 'phasing',             title: 'Phasing Preference' },
];

const SYSTEM = `You are the Gabi Discovery Agent, an INTERNAL interviewer for Hundred Agents. You interview a potential client (referred to as Gabi) to collect structured business context so Hundred Agents can prepare a proposal. You are NOT a customer-facing assistant for Gabi's customers.

TONE: warm, professional, concise. One topic at a time — ask progressively, never dump a long form. Reply in the user's language (Spanish or English — match them). Acknowledge answers briefly, then ask the next most useful question.

GOAL: gather, across these sections in order — Business Map, Current Channels, Current Pain, Business Unit Details (loop per business line), Lead Capture, Escalation Rules, Do Not Say Rules, Tools & Integrations, Success Criteria, Phasing Preference.

RULES (hard):
- Never quote or promise a final price. If asked, say Hundred Agents will review and follow up with pricing.
- Never confirm availability/bookings or make investment/legal claims about land — note these as do-not-say rules instead.
- If an answer is vague, reflect concrete options/examples; if still unknown, record it as missing rather than inventing.
- If Gabi mentions a NEW business line, capture it and ask its Business Unit details too.
- After each user message, call the update_brain tool with any new structured facts you learned (only fields you are confident about). Keep chatting naturally regardless.
- When you believe all sections have enough signal (or Gabi wants to stop), tell them you have what's needed and that Hundred Agents will review — do not produce a proposal or price yourself.`;

const UPDATE_BRAIN_TOOL = {
  type: 'function',
  function: {
    name: 'update_brain',
    description: 'Record new structured facts learned in the latest message. Only include fields you are confident about; omit the rest.',
    parameters: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        business_lines: { type: 'array', items: { type: 'object', properties: {
          name: { type: 'string' }, status: { type: 'string', enum: ['active', 'seasonal', 'planned', 'unsure'] },
          one_line: { type: 'string' }, customer_type: { type: 'string' } } } },
        priority_businesses: { type: 'array', items: { type: 'object', properties: {
          name: { type: 'string' }, rank: { type: 'integer' }, reason: { type: 'string' } } } },
        current_channels: { type: 'array', items: { type: 'object', properties: {
          channel: { type: 'string' }, volume: { type: 'string' }, owner_today: { type: 'string' }, response_time_today: { type: 'string' } } } },
        desired_channels: { type: 'array', items: { type: 'string' } },
        pain_points: { type: 'array', items: { type: 'object', properties: {
          description: { type: 'string' }, business: { type: 'string' }, severity: { type: 'string' } } } },
        business_unit_details: { type: 'array', items: { type: 'object', properties: {
          business: { type: 'string' }, sells: { type: 'string' },
          what_ai_should_answer: { type: 'array', items: { type: 'string' } },
          what_ai_must_not_answer: { type: 'array', items: { type: 'string' } },
          knowledge_readiness: { type: 'string', enum: ['none', 'scattered', 'partial', 'ready'] } } } },
        faqs_by_business: { type: 'array', items: { type: 'object', properties: {
          business: { type: 'string' }, faqs: { type: 'array', items: { type: 'object', properties: {
            question: { type: 'string' }, expected_answer: { type: 'string' }, answer_known: { type: 'boolean' } } } } } } },
        lead_capture_fields_by_business: { type: 'array', items: { type: 'object', properties: {
          business: { type: 'string' }, fields: { type: 'array', items: { type: 'object', properties: {
            field: { type: 'string' }, required: { type: 'boolean' } } } },
          qualification_signals: { type: 'array', items: { type: 'string' } }, lead_destination_today: { type: 'string' } } } },
        escalation_rules: { type: 'array', items: { type: 'object', properties: {
          business: { type: 'string' }, trigger: { type: 'string' }, handoff_to: { type: 'string' },
          channel: { type: 'string' }, hours: { type: 'string' }, target_latency: { type: 'string' } } } },
        do_not_say_rules: { type: 'array', items: { type: 'object', properties: {
          scope: { type: 'string' }, business: { type: 'string' }, rule: { type: 'string' } } } },
        integrations: { type: 'array', items: { type: 'object', properties: {
          tool: { type: 'string' }, use: { type: 'string' }, access_owner: { type: 'string' },
          integration_appetite: { type: 'string', enum: ['inform_only', 'read', 'read_write', 'unknown'] } } } },
        source_materials_available: { type: 'array', items: { type: 'object', properties: {
          type: { type: 'string' }, business: { type: 'string' }, location: { type: 'string' }, provided: { type: 'boolean' } } } },
        success_criteria: { type: 'array', items: { type: 'object', properties: {
          statement: { type: 'string' }, metric: { type: 'string' }, timeframe: { type: 'string' } } } },
        phasing_preference: { type: 'object', properties: {
          appetite: { type: 'string', enum: ['start_small', 'all_at_once', 'unsure'] }, timeline: { type: 'string' },
          budget_posture: { type: 'string', enum: ['tight', 'moderate', 'flexible', 'unknown'] }, content_owner: { type: 'string' } } },
      },
    },
  },
};

// Used at finalize to compile a complete Business Brain from the transcript.
const COMPILE_SYSTEM = `You compile a structured Business Brain from a discovery transcript. Output ONLY via the update_brain tool with the most complete, accurate values you can infer from the conversation. Do not invent facts that were not stated; leave unknown fields out. Do not include prices.`;

const GREETING = `¡Hola! Soy el asistente de descubrimiento de Hundred Agents. Te haré algunas preguntas guiadas sobre tus negocios para que podamos diseñar la solución correcta. Toma ~15 min y puedes pausar y volver con este mismo enlace.\n\nPara empezar: ¿qué negocios manejas hoy? (por ejemplo glamping, terrenos, recicladora, hangares… los que tengas).`;

module.exports = { SECTIONS, SYSTEM, UPDATE_BRAIN_TOOL, COMPILE_SYSTEM, GREETING };
