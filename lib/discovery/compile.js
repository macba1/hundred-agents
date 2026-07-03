/* ============================================================
   Compile a full Business Brain partial from a transcript via one
   LLM pass. Uses a stronger model + higher token budget than the
   chat turns so large multi-business transcripts extract fully.
   Shared by /api/discovery/finalize and /api/discovery/recompile.
   ============================================================ */
const brainLib = require('./brain');
const { COMPILE_SYSTEM, UPDATE_BRAIN_TOOL } = require('./prompts');

const COMPILE_MODEL = process.env.DISCOVERY_COMPILE_MODEL || 'gpt-4o';
const COMPILE_MAX_TOKENS = 6000;

async function callOpenAI(payload, key) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!r.ok) throw { code: 'openai', status: r.status, detail: await r.text().catch(() => '') };
  return r.json();
}

/** Returns a merged brain partial (never throws to the caller's flow — caller
    decides whether to treat a throw as best-effort). */
async function compileSession(transcript, partial, key) {
  if (!key || !transcript || !transcript.length) return partial;
  const convo = transcript.map((m) => `${m.role}: ${m.content}`).join('\n');
  const out = await callOpenAI({
    model: COMPILE_MODEL,
    messages: [{ role: 'system', content: COMPILE_SYSTEM }, { role: 'user', content: 'Transcript:\n' + convo }],
    tools: [UPDATE_BRAIN_TOOL], tool_choice: { type: 'function', function: { name: 'update_brain' } },
    temperature: 0.1, max_tokens: COMPILE_MAX_TOKENS,
  }, key);
  const tc = out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.tool_calls && out.choices[0].message.tool_calls[0];
  if (tc) { let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch {} return brainLib.mergePartial(partial, args); }
  return partial;
}

module.exports = { compileSession, COMPILE_MODEL };
