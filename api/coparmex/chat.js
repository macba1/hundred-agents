/* ============================================================
   POST /api/coparmex/chat
   Welcome agent for the Coparmex San Miguel el Alto talk.
   Calls OpenAI (OPENAI_MODEL, default gpt-4o-mini) with a
   system prompt that knows the talk content. Rate-limited per IP
   (reuses lib/discovery/ratelimit). History lives on the client;
   we cap forwarded turns. OPENAI_API_KEY stays server-side.
   ============================================================ */

const rl = require('../../lib/discovery/ratelimit');

const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_TURNS = 12;        // user turns per conversation
const MAX_MESSAGES = 24;     // context window forwarded
const MAX_TOKENS = 450;
const CHAT_PER_IP_HOUR = 30; // cost guard

const SYSTEM = `Eres el asistente de bienvenida de Hundred Agents en la charla de Coparmex San Miguel el Alto.

TONO: español mexicano, cálido y directo, sin humo. Máximo 6 líneas por respuesta.

QUÉ SABES DE LA CHARLA (no inventes nada fuera de esto):
- Tesis: la IA es un cambio de paradigma, no solo una herramienta más.
- Dato WEF: se crean ~170M de empleos nuevos y un neto de +78M de empleos.
- Casos reales mencionados:
  · Bayer — "Carlota", asistente de IA en agricultura.
  · Coca-Cola FEMSA — pedidos de tienditas por WhatsApp.
  · Bimbo — optimización de rutas y logística.
  · Aeroméxico — "Aerobot", atención al cliente.
- Metodología para aplicar un agente: 1) elegir una pérdida concreta del negocio,
  2) conectar el conocimiento del negocio, 3) definir límites y permisos,
  4) integrar el flujo real de trabajo, 5) medir el resultado.

CÓMO RESPONDES:
- Puedes explicar cualquier ejemplo de la charla o cómo se aplicaría un agente al
  negocio de la persona, usando la metodología de 5 pasos.
- Si preguntan por precios o por un proyecto concreto: NO inventes precios ni plazos.
  Usa su nombre/contexto y ofrece que el equipo de Hundred Agents los contacte.
- Nunca inventes casos, cifras ni capacidades fuera de lo anterior. Si no lo sabes,
  di que el equipo da seguimiento (info@thehagentic.com).`;

function sanitize(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 3000) }))
    .slice(-MAX_MESSAGES);
}

async function callOpenAI(payload, key) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
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

  // Rate limit per IP (fails open if the store hiccups).
  const ip = rl.clientIp(req);
  const gate = await rl.check('coparmex_chat', ip, CHAT_PER_IP_HOUR);
  if (!gate.ok) {
    return res.status(429).json({
      error: 'rate_limited',
      reply: 'Estamos saturados en este momento 🙏. Intenta de nuevo en un ratito o escríbenos a info@thehagentic.com.',
    });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const name = String(body.name || '').trim().slice(0, 120);
  const history = sanitize(body.messages);
  const userTurns = history.filter((m) => m.role === 'user').length;

  if (userTurns > MAX_TURNS) {
    return res.status(200).json({
      reply: 'Hemos avanzado bastante por aquí 🙂. Para seguir, escríbenos a info@thehagentic.com y el equipo lo retoma.',
      limitReached: true,
    });
  }

  const sys = name ? `${SYSTEM}\n\nEl nombre de la persona es ${name}; salúdala por su nombre cuando sea natural.` : SYSTEM;
  const messages = [{ role: 'system', content: sys }, ...history];

  try {
    const data = await callOpenAI(
      { model: process.env.OPENAI_MODEL || DEFAULT_MODEL, messages, temperature: 0.5, max_tokens: MAX_TOKENS },
      key
    );
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    return res.status(200).json({ reply: (msg && msg.content) || '' });
  } catch (err) {
    if (err && err.code === 'openai') console.error('[coparmex:chat:openai]', err.status, err.detail);
    return res.status(502).json({
      error: 'upstream',
      reply: 'Tuvimos un detalle técnico 🙏. Intenta de nuevo en un momento.',
    });
  }
};
