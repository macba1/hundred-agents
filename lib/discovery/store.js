/* ============================================================
   Storage adapter for discovery sessions.
   - If Vercel KV / Upstash REST env vars are present, use them
     (durable across serverless invocations — required in prod).
   - Otherwise fall back to a local JSON file under /tmp
     (good enough for local dev / the e2e pipeline test, NOT
     for multi-instance production).
   Sessions hold transcript + partial brain + finalized artifacts.
   ============================================================ */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const useKV = !!(KV_URL && KV_TOKEN);
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const FILE_DIR = process.env.DISCOVERY_FILE_DIR || '/tmp/gabi-discovery';

function token() { return crypto.randomBytes(18).toString('hex'); }
function keyFor(t) { return 'disc:gabi:' + t; }

/* ---- KV (Upstash REST) via fetch, no SDK dependency ---- */
async function kvSet(k, value) {
  const url = `${KV_URL}/set/${encodeURIComponent(k)}?EX=${TTL_SECONDS}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw { code: 'store_unavailable', detail: await r.text().catch(() => '') };
}
async function kvGet(k) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(k)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) throw { code: 'store_unavailable', detail: await r.text().catch(() => '') };
  const data = await r.json();
  if (data.result == null) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}
async function kvList() {
  // best-effort: scan keys under prefix
  const r = await fetch(`${KV_URL}/keys/disc:gabi:*`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!r.ok) return [];
  const data = await r.json();
  const keys = data.result || [];
  const out = [];
  for (const k of keys) { const s = await kvGet(k); if (s) out.push(s); }
  return out;
}

/* ---- file fallback ---- */
function ensureDir() { try { fs.mkdirSync(FILE_DIR, { recursive: true }); } catch {} }
function fileSet(k, value) { ensureDir(); fs.writeFileSync(path.join(FILE_DIR, k.replace(/[:*]/g, '_') + '.json'), JSON.stringify(value)); }
function fileGet(k) {
  try { return JSON.parse(fs.readFileSync(path.join(FILE_DIR, k.replace(/[:*]/g, '_') + '.json'), 'utf8')); }
  catch { return null; }
}
function fileList() {
  ensureDir();
  return fs.readdirSync(FILE_DIR).filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(FILE_DIR, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

async function save(state) {
  state.updatedAt = state.updatedAt || new Date().toISOString();
  const k = keyFor(state.sessionToken);
  if (useKV) await kvSet(k, state); else fileSet(k, state);
  return state;
}
async function get(t) {
  if (!t) return null;
  const k = keyFor(t);
  return useKV ? await kvGet(k) : fileGet(k);
}
async function list() { return useKV ? await kvList() : fileList(); }

function newSession(clientKey, createdAtISO) {
  return {
    sessionToken: token(),
    clientKey: clientKey || 'gabi',
    status: 'active',
    sectionIndex: 0,
    transcript: [],
    brainPartial: {},
    createdAt: createdAtISO || new Date().toISOString(),
    updatedAt: createdAtISO || new Date().toISOString(),
    artifacts: null,
  };
}

module.exports = { useKV, newSession, save, get, list, token };
