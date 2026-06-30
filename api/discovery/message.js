/* POST /api/discovery/message — one conversational turn.
   Loads session, calls OpenAI with the update_brain tool, merges
   structured facts into the partial brain, persists, returns reply. */
const store = require('../../lib/discovery/store');
const brainLib = require('../../lib/discovery/brain');
const { SYSTEM, UPDATE_BRAIN_TOOL, SECTIONS, FINAL_MESSAGE } = require('../../lib/discovery/prompts');

const MODEL = 'gpt-4o-mini';
const MAX_TURNS = 40;
const MAX_WINDOW = 40;
const MAX_TOKENS = 500;

async function callOpenAI(payload, key) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!r.ok) throw { code: 'upstream', status: r.status, detail: await r.text().catch(() => '') };
  return r.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  const rd = store.ready();
  if (!rd.ok) return res.status(503).json({ error: 'durable_storage_unconfigured', message: rd.error });
  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(502).json({ error: 'config' });

  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } } body = body || {};
  const message = (body.message || '').toString().slice(0, 4000).trim();
  if (!message) return res.status(400).json({ error: 'empty_message' });

  let s;
  try { s = await store.get(body.sessionToken); }
  catch (e) { return res.status(503).json({ error: 'store_unavailable' }); }
  if (!s) return res.status(404).json({ error: 'session_not_found' });
  if (s.status === 'finalized') return res.status(409).json({ error: 'session_finalized' });

  s.transcript.push({ role: 'user', content: message, ts: new Date().toISOString() });
  const userTurns = s.transcript.filter((m) => m.role === 'user').length;

  if (userTurns > MAX_TURNS) {
    const reply = FINAL_MESSAGE;
    s.transcript.push({ role: 'assistant', content: reply, ts: new Date().toISOString() });
    s.status = 'ready_to_finalize';
    await store.save(s);
    return res.status(200).json({ reply, done: true, progress: 1 });
  }

  const window = s.transcript.slice(-MAX_WINDOW).map((m) => ({ role: m.role, content: m.content }));
  const messages = [{ role: 'system', content: SYSTEM }, ...window];

  try {
    const first = await callOpenAI(
      { model: MODEL, messages, tools: [UPDATE_BRAIN_TOOL], tool_choice: 'auto', temperature: 0.4, max_tokens: MAX_TOKENS },
      key
    );
    const msg = first.choices && first.choices[0] && first.choices[0].message;
    if (!msg) throw { code: 'upstream', status: 0 };

    // apply update_brain tool calls
    const toolCalls = msg.tool_calls || [];
    let reply = msg.content || '';
    if (toolCalls.length) {
      for (const tc of toolCalls) {
        if (tc.function && tc.function.name === 'update_brain') {
          let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
          s.brainPartial = brainLib.mergePartial(s.brainPartial, args);
        }
      }
      // model used a tool and may not have produced text — ask for the natural reply
      if (!reply) {
        const follow = [...messages, msg, ...toolCalls.map((tc) => ({ role: 'tool', tool_call_id: tc.id, content: '{"ok":true}' }))];
        const second = await callOpenAI({ model: MODEL, messages: follow, temperature: 0.4, max_tokens: MAX_TOKENS }, key);
        reply = (second.choices && second.choices[0] && second.choices[0].message && second.choices[0].message.content) || 'Entendido, gracias.';
      }
    }

    s.transcript.push({ role: 'assistant', content: reply, ts: new Date().toISOString() });
    const { completeness } = brainLib.assess(brainLib.finalizeBrain(s.brainPartial));
    await store.save(s);
    return res.status(200).json({ reply, progress: completeness, sections: SECTIONS.length });
  } catch (err) {
    // user's answer is already saved; surface a retryable error
    try { await store.save(s); } catch {}
    console.error('[discovery:message]', err && err.code, err && err.status, err && err.detail);
    return res.status(502).json({ error: 'upstream' });
  }
};
