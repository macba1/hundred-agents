/* ============================================================
   POST /api/chat
   Proxies the conversation to OpenAI (gpt-4o-mini). The
   OPENAI_API_KEY stays server-side. Picks a system prompt by
   "mode" (home | mexico). When the model decides it has enough
   data, it calls the save_lead tool — handled here server-side,
   writing to the right Notion database via lib/notion.
   ============================================================ */

const { createLeadPage } = require('../lib/notion');

const MODEL = 'gpt-4o-mini';
const MAX_TURNS = 20;          // user turns per conversation
const MAX_MESSAGES = 40;       // context window we forward
const MAX_TOKENS = 500;

const SYSTEM = {
  home: `You are the AI assistant for Hundred Agents, an AI implementation consultancy based in Austin, TX.

WHAT THE COMPANY DOES: We map how a business already runs today, find where AI agents create real value, and design "agentic" workflows that respect business rules, permissions and human-approval points. We do NOT replace processes that already work — we add agents only where they help.

TONE: Direct, clear, professional, no hype. Reply in the user's language (English or Spanish — match them).

GOAL & FLOW:
1) First, answer the user's question helpfully.
2) Conversationally (not as a form) gather: their name, their company / type of business, and the problem or process they want to improve.
3) Then ask for their email.
4) Once you have name + company + problem + a valid email, call the save_lead tool with mode "home" and a short one-line summary of the conversation. After it succeeds, confirm the team will reach out.

RULES: Never invent prices, timelines, or promise results. If you don't know something, say the team will follow up. Do not claim unverified capabilities. Keep replies concise.`,

  mexico: `You are the assistant for the Hundred Agents conference "AI en Acción — México 2026".

PURPOSE: You help attendees with TWO things, and you must make both explicit:
(1) registering for the conference, and (2) optionally leaving a question for the speakers (Ruth Anaya, CEO & Founder; Antonio Jiménez, Co-Founder & Strategic Advisor) so they can prepare it for the session. You may give brief context about the conference: a practical session on how real businesses can apply AI effectively across customer service, operations, sales, marketing, administration, information analysis and workflow automation.

TONE: Direct, clear, professional, no hype. Reply in the user's language (English or Spanish — match them).

FLOW (follow this order):
1) WELCOME: Open by saying you help with two things — "I help you with two things: registering for the conference and, if you want, leaving a question for the speakers." / "Te ayudo con dos cosas: registrarte para la conferencia y, si quieres, dejar una pregunta para los ponentes."
2) REGISTRATION FIRST: Conversationally gather the registration data — name, email, company, role/title, company size (one of: 1-10, 11-50, 51-200, 200+). Don't insist on optional fields; name is the minimum.
3) THEN INVITE THE QUESTION explicitly: "Would you like to leave a question for Ruth and Antonio? They'll prepare it for the session." / "¿Quieres dejar una pregunta para Ruth y Antonio? La prepararán para la sesión." The question is OPTIONAL — if they decline, register them anyway.
4) SAVE: Call the save_lead tool with mode "mexico" once you have at least a name (include the question if they gave one). If they declined the question, pass a short placeholder like "(sin pregunta)" / "(no question)".
5) CONFIRM CLEARLY after it succeeds: "You're registered" — and, if they left a question, add "and your question was sent to the speakers." / "Quedas registrado" — y si dejó pregunta, añade "y tu pregunta fue enviada a los ponentes."

RULES: Never invent dates, prices or promises. Keep replies concise.`,
};

const SAVE_LEAD_TOOL = {
  type: 'function',
  function: {
    name: 'save_lead',
    description: 'Save the lead (home) or conference attendee (mexico) to the database. Only call when the required fields are collected.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Person full name' },
        email: { type: 'string', description: 'Email address' },
        company: { type: 'string', description: 'Company or type of business' },
        role: { type: 'string', description: 'Job title / role (mexico only)' },
        company_size: { type: 'string', enum: ['1-10', '11-50', '51-200', '200+'], description: 'Company size (mexico only)' },
        problem: { type: 'string', description: 'Problem or process to improve (home only)' },
        question: { type: 'string', description: 'Question for the conference (mexico only)' },
        summary: { type: 'string', description: 'One-line summary of the conversation' },
      },
      required: ['name'],
    },
  },
};

function sanitize(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
    .slice(-MAX_MESSAGES);
}

async function callOpenAI(payload, key) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw { code: 'openai', status: resp.status, detail };
  }
  return resp.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(502).json({ error: 'config' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const mode = body.mode === 'mexico' ? 'mexico' : 'home';
  const history = sanitize(body.messages);
  const userTurns = history.filter((m) => m.role === 'user').length;

  if (userTurns > MAX_TURNS) {
    return res.status(200).json({
      reply: "We've covered a lot here — to keep going, please email us at info@thehagentic.com and the team will pick it up. / Hemos avanzado bastante — para continuar, escríbenos a info@thehagentic.com y el equipo lo retoma.",
      limitReached: true,
    });
  }

  const messages = [{ role: 'system', content: SYSTEM[mode] }, ...history];

  try {
    const first = await callOpenAI(
      { model: MODEL, messages, tools: [SAVE_LEAD_TOOL], tool_choice: 'auto', temperature: 0.4, max_tokens: MAX_TOKENS },
      key
    );
    const msg = first.choices && first.choices[0] && first.choices[0].message;
    if (!msg) throw { code: 'openai', status: 0 };

    const toolCalls = msg.tool_calls || [];
    if (!toolCalls.length) {
      return res.status(200).json({ reply: msg.content || '', saved: false });
    }

    // Execute save_lead tool calls server-side, then ask the model to confirm.
    const followup = [...messages, msg];
    let saved = false;
    for (const tc of toolCalls) {
      let result;
      if (tc.function && tc.function.name === 'save_lead') {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
        try {
          const r = await createLeadPage(mode, args);
          saved = true;
          result = { ok: true };
        } catch (err) {
          result = { ok: false, error: (err && err.code) || 'error' };
          if (!['incomplete', 'bad_email', 'bad_mode'].includes(result.error)) {
            console.error('[chat:save_lead]', result.error, err && err.message, err && err.detail);
          }
        }
      } else {
        result = { ok: false, error: 'unknown_tool' };
      }
      followup.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }

    const second = await callOpenAI(
      { model: MODEL, messages: followup, temperature: 0.4, max_tokens: MAX_TOKENS },
      key
    );
    const reply = second.choices && second.choices[0] && second.choices[0].message
      ? second.choices[0].message.content : '';
    return res.status(200).json({ reply: reply || '', saved });
  } catch (err) {
    if (err && err.code === 'openai') console.error('[chat:openai]', err.status, err.detail);
    return res.status(502).json({ error: 'upstream' });
  }
};
