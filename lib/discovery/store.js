/* ============================================================
   Storage adapter for discovery sessions.

   Mode selection (read live from env so it is testable):
   - "kv"           : KV_REST_API_URL + KV_REST_API_TOKEN present.
                      Durable across serverless invocations. Used in
                      preview/production.
   - "file"         : local development only (VERCEL_ENV unset/development).
                      JSON files under /tmp — NOT durable across multiple
                      serverless instances, only acceptable locally.
   - "unconfigured" : running on Vercel preview/production WITHOUT KV.
                      Refuses to operate so a real client discovery never
                      appears successful on non-durable storage.

   Sessions hold transcript + partial brain + finalized artifacts.
   ============================================================ */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const UNCONFIGURED_MSG = 'Durable storage is not configured. Please set KV_REST_API_URL and KV_REST_API_TOKEN.';

function fileDir() { return process.env.DISCOVERY_FILE_DIR || '/tmp/gabi-discovery'; }
function token() { return crypto.randomBytes(18).toString('hex'); }
function keyFor(t) { return 'disc:gabi:' + t; }

/** Resolve config + mode from the current environment (live). */
function cfg() {
  const KV_URL = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;
  const useKV = !!(KV_URL && KV_TOKEN);
  const vEnv = process.env.VERCEL_ENV || ''; // production | preview | development | ''
  const managed = vEnv === 'production' || vEnv === 'preview';
  // Explicit local override lets the deterministic test use files even if
  // VERCEL_ENV were set in CI.
  const forceFile = process.env.DISCOVERY_FORCE_FILE === '1';
  const mode = useKV ? 'kv' : (managed && !forceFile ? 'unconfigured' : 'file');
  return { KV_URL, KV_TOKEN, useKV, vEnv, managed, mode };
}

function ready() {
  const c = cfg();
  return { ok: c.mode !== 'unconfigured', mode: c.mode, error: c.mode === 'unconfigured' ? UNCONFIGURED_MSG : null };
}
function assertReady() {
  const c = cfg();
  if (c.mode === 'unconfigured') throw { code: 'durable_storage_unconfigured', message: UNCONFIGURED_MSG };
  return c;
}

/* ---- KV (Upstash REST) via fetch, no SDK dependency ---- */
async function kvSet(c, k, value) {
  const r = await fetch(`${c.KV_URL}/set/${encodeURIComponent(k)}?EX=${TTL_SECONDS}`, {
    method: 'POST', headers: { Authorization: `Bearer ${c.KV_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  if (!r.ok) throw { code: 'store_unavailable', detail: await r.text().catch(() => '') };
}
async function kvGet(c, k) {
  const r = await fetch(`${c.KV_URL}/get/${encodeURIComponent(k)}`, { headers: { Authorization: `Bearer ${c.KV_TOKEN}` } });
  if (!r.ok) throw { code: 'store_unavailable', detail: await r.text().catch(() => '') };
  const data = await r.json();
  if (data.result == null) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}
async function kvDel(c, k) {
  await fetch(`${c.KV_URL}/del/${encodeURIComponent(k)}`, { method: 'POST', headers: { Authorization: `Bearer ${c.KV_TOKEN}` } }).catch(() => {});
}
async function kvList(c) {
  const r = await fetch(`${c.KV_URL}/keys/disc:gabi:*`, { headers: { Authorization: `Bearer ${c.KV_TOKEN}` } });
  if (!r.ok) return [];
  const data = await r.json();
  const out = [];
  for (const k of (data.result || [])) { const s = await kvGet(c, k); if (s) out.push(s); }
  return out;
}

/* ---- file (local dev only) ---- */
function fpath(k) { return path.join(fileDir(), k.replace(/[:*]/g, '_') + '.json'); }
function ensureDir() { try { fs.mkdirSync(fileDir(), { recursive: true }); } catch {} }
function fileSet(k, v) { ensureDir(); fs.writeFileSync(fpath(k), JSON.stringify(v)); }
function fileGet(k) { try { return JSON.parse(fs.readFileSync(fpath(k), 'utf8')); } catch { return null; } }
function fileDel(k) { try { fs.unlinkSync(fpath(k)); } catch {} }
function fileList() {
  ensureDir();
  return fs.readdirSync(fileDir()).filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(fileDir(), f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

/* ---- public API (each enforces durability) ---- */
async function save(state) {
  const c = assertReady();
  state.updatedAt = new Date().toISOString();
  const k = keyFor(state.sessionToken);
  if (c.useKV) await kvSet(c, k, state); else fileSet(k, state);
  return state;
}
async function get(t) {
  const c = assertReady();
  if (!t) return null;
  const k = keyFor(t);
  return c.useKV ? await kvGet(c, k) : fileGet(k);
}
async function del(t) {
  const c = assertReady();
  const k = keyFor(t);
  if (c.useKV) await kvDel(c, k); else fileDel(k);
}
async function list() {
  const c = assertReady();
  return c.useKV ? await kvList(c) : fileList();
}

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

module.exports = { newSession, save, get, del, list, token, ready, assertReady, cfg, UNCONFIGURED_MSG };
