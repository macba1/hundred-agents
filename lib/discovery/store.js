/* ============================================================
   Storage adapter for discovery sessions.

   Mode selection (read live from env so it is testable), in priority order:
   - "redis"        : REDIS_URL present (e.g. Vercel-connected Redis).
                      Durable; used in preview/production.
   - "kv"           : KV_REST_API_URL + KV_REST_API_TOKEN present
                      (Upstash REST). Durable; used in preview/production.
   - "file"         : local development only (VERCEL_ENV unset/development).
                      JSON files under /tmp — NOT durable across multiple
                      serverless instances, only acceptable locally.
   - "unconfigured" : running on Vercel preview/production WITHOUT a durable
                      backend. Refuses to operate so a real client discovery
                      never appears successful on non-durable storage.

   Sessions hold transcript + partial brain + finalized artifacts.
   ============================================================ */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const UNCONFIGURED_MSG = 'Durable storage is not configured. Please set REDIS_URL (or KV_REST_API_URL and KV_REST_API_TOKEN).';

function fileDir() { return process.env.DISCOVERY_FILE_DIR || '/tmp/gabi-discovery'; }
function token() { return crypto.randomBytes(18).toString('hex'); }
function keyFor(t) { return 'disc:gabi:' + t; }

/** Resolve config + mode from the current environment (live). */
function cfg() {
  const REDIS_URL = process.env.REDIS_URL;
  const KV_URL = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;
  const useRedis = !!REDIS_URL;
  const useKV = !!(KV_URL && KV_TOKEN);
  const vEnv = process.env.VERCEL_ENV || ''; // production | preview | development | ''
  const managed = vEnv === 'production' || vEnv === 'preview';
  // Explicit local override lets the deterministic test use files even if
  // VERCEL_ENV were set in CI.
  const forceFile = process.env.DISCOVERY_FORCE_FILE === '1';
  const mode = useRedis ? 'redis'
    : useKV ? 'kv'
    : (managed && !forceFile ? 'unconfigured' : 'file');
  return { REDIS_URL, KV_URL, KV_TOKEN, useRedis, useKV, vEnv, managed, mode };
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

/* ---- Redis (node-redis over TCP/TLS); lazy singleton, reused warm ---- */
let _redis = null;
async function redisClient(c) {
  if (_redis && _redis.isOpen) return _redis;
  const { createClient } = require('redis'); // lazy: only loaded in redis mode
  _redis = createClient({ url: c.REDIS_URL });
  _redis.on('error', () => {}); // avoid unhandled error events; calls will throw
  if (!_redis.isOpen) await _redis.connect();
  return _redis;
}
async function redisSet(c, k, value) {
  const cli = await redisClient(c);
  await cli.set(k, JSON.stringify(value), { EX: TTL_SECONDS });
}
async function redisGet(c, k) {
  const cli = await redisClient(c);
  const v = await cli.get(k);
  if (v == null) return null;
  try { return JSON.parse(v); } catch { return null; }
}
async function redisDel(c, k) { const cli = await redisClient(c); await cli.del(k); }
async function redisIncr(c, k, ttl) { const cli = await redisClient(c); const n = await cli.incr(k); if (n === 1) await cli.expire(k, ttl); return n; }
async function redisList(c) {
  const cli = await redisClient(c);
  const keys = await cli.keys('disc:gabi:*');
  const out = [];
  for (const k of keys) { const s = await redisGet(c, k); if (s) out.push(s); }
  return out;
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
async function kvIncr(c, k, ttl) {
  const r = await fetch(`${c.KV_URL}/incr/${encodeURIComponent(k)}`, { method: 'POST', headers: { Authorization: `Bearer ${c.KV_TOKEN}` } });
  const n = ((await r.json().catch(() => ({}))).result) || 0;
  if (n === 1) await fetch(`${c.KV_URL}/expire/${encodeURIComponent(k)}/${ttl}`, { method: 'POST', headers: { Authorization: `Bearer ${c.KV_TOKEN}` } }).catch(() => {});
  return n;
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
function fileIncr(k, ttl) {
  const now = Math.floor(Date.now() / 1000);
  let rec = fileGet(k);
  if (!rec || !rec.exp || now > rec.exp) rec = { n: 0, exp: now + ttl };
  rec.n += 1;
  fileSet(k, rec);
  return rec.n;
}
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
  if (c.useRedis) await redisSet(c, k, state);
  else if (c.useKV) await kvSet(c, k, state);
  else fileSet(k, state);
  return state;
}
async function get(t) {
  const c = assertReady();
  if (!t) return null;
  const k = keyFor(t);
  if (c.useRedis) return redisGet(c, k);
  return c.useKV ? await kvGet(c, k) : fileGet(k);
}
async function del(t) {
  const c = assertReady();
  const k = keyFor(t);
  if (c.useRedis) await redisDel(c, k);
  else if (c.useKV) await kvDel(c, k);
  else fileDel(k);
}
async function list() {
  const c = assertReady();
  if (c.useRedis) return redisList(c);
  return c.useKV ? await kvList(c) : fileList();
}
/** Atomic-ish counter with TTL window for rate limiting. Returns the new count. */
async function incr(key, ttlSeconds) {
  const c = assertReady();
  if (c.useRedis) return redisIncr(c, key, ttlSeconds);
  if (c.useKV) return kvIncr(c, key, ttlSeconds);
  return fileIncr(key, ttlSeconds);
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

module.exports = { newSession, save, get, del, list, incr, token, ready, assertReady, cfg, UNCONFIGURED_MSG };
