/* ============================================================
   Redis storage for the WhatsApp agent.

   Serverless has no memory between requests and no writable disk, so every
   piece of state lives here. Same REDIS_URL the discovery flow already uses.

   Keys (all namespaced per client so tenants never collide):
     wa:{client}:session:{phone}   JSON {turns, history[]}      TTL 48h
     wa:{client}:leads             LIST of lead JSON (newest first, capped)
     wa:{client}:folio             INCR counter for folio numbers
     wa:{client}:audio:{phone}:{d} INCR audios that day         TTL 48h
     wa:seen:{message_id}          dedupe marker                TTL 24h
   ============================================================ */

const SESSION_TTL = Number(process.env.WA_SESSION_TTL || 60 * 60 * 48); // 48h
const SEEN_TTL = Number(process.env.WA_SEEN_TTL || 60 * 60 * 24);       // 24h
const AUDIO_TTL = Number(process.env.WA_AUDIO_TTL || 60 * 60 * 48);     // 48h
const LEADS_MAX = Number(process.env.WA_LEADS_MAX || 500);

const UNCONFIGURED = 'REDIS_URL no está configurado: el agente de WhatsApp necesita Redis.';

/* ---- lazy singleton, reused while the instance stays warm ---- */
let _redis = null;

async function client() {
  const url = process.env.REDIS_URL;
  if (!url) throw Object.assign(new Error(UNCONFIGURED), { code: 'redis_unconfigured' });
  if (_redis && _redis.isOpen) return _redis;
  const { createClient } = require('redis');
  _redis = createClient({ url });
  _redis.on('error', () => {}); // avoid unhandled 'error'; calls still throw
  if (!_redis.isOpen) await _redis.connect();
  return _redis;
}

function ready() {
  return process.env.REDIS_URL
    ? { ok: true, mode: 'redis' }
    : { ok: false, mode: 'unconfigured', error: UNCONFIGURED };
}

const kSession = (c, phone) => `wa:${c}:session:${phone}`;
const kLeads = (c) => `wa:${c}:leads`;
const kFolio = (c) => `wa:${c}:folio`;
const kAudio = (c, phone, dia) => `wa:${c}:audio:${phone}:${dia}`;
const kSeen = (mid) => `wa:seen:${mid}`;

/* ---- dedupe ------------------------------------------------ */
/**
 * True when this message_id was already accepted. SET NX is atomic, so a Meta
 * retry that lands on a second instance still collapses to one processing.
 */
async function alreadySeen(messageId) {
  if (!messageId) return false;
  const cli = await client();
  const ok = await cli.set(kSeen(messageId), '1', { NX: true, EX: SEEN_TTL });
  return ok === null; // null => key existed => already seen
}

/* ---- session / memory -------------------------------------- */
async function getSession(c, phone) {
  const cli = await client();
  const raw = await cli.get(kSession(c, phone));
  if (!raw) return { turns: 0, history: [] };
  try {
    const s = JSON.parse(raw);
    return { turns: Number(s.turns || 0), history: Array.isArray(s.history) ? s.history : [] };
  } catch {
    return { turns: 0, history: [] };
  }
}

async function saveSession(c, phone, session, memoriaMax) {
  const cli = await client();
  const history = session.history.slice(-Math.max(2, memoriaMax || 24));
  await cli.set(
    kSession(c, phone),
    JSON.stringify({ turns: session.turns, history }),
    { EX: SESSION_TTL }
  );
}

/** Increment and return this contact's turn number. */
async function bumpTurn(c, phone, memoriaMax) {
  const s = await getSession(c, phone);
  s.turns += 1;
  await saveSession(c, phone, s, memoriaMax);
  return s.turns;
}

/* ---- leads -------------------------------------------------- */
/**
 * Sequential id from a Redis counter. Folios need the id *before* the record
 * is written, and INCR is atomic, so concurrent instances never collide.
 */
async function nextId(c) {
  const cli = await client();
  return cli.incr(kFolio(c));
}

/** Write one lead record verbatim (newest first, list capped). */
async function pushLead(c, record) {
  const cli = await client();
  await cli.lPush(kLeads(c), JSON.stringify(record));
  await cli.lTrim(kLeads(c), 0, LEADS_MAX - 1);
  return record;
}

/** Append a lead, assigning the id automatically. */
async function addLead(c, lead) {
  const id = await nextId(c);
  return pushLead(c, { id, client: c, ts: new Date().toISOString(), ...lead });
}

/** Newest-first leads for one client, or for every client when clave is falsy. */
async function listLeads(clave, claves, limit = 200) {
  const cli = await client();
  const targets = clave ? [clave] : claves;
  const out = [];
  for (const c of targets) {
    const raw = await cli.lRange(kLeads(c), 0, limit - 1);
    for (const r of raw) {
      try { out.push(JSON.parse(r)); } catch { /* ignora entradas corruptas */ }
    }
  }
  out.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return out.slice(0, limit);
}

async function countLeads(clave, claves) {
  const rows = await listLeads(clave, claves, LEADS_MAX);
  const phones = new Set(rows.map((r) => r.phone));
  return { total: rows.length, contactos: phones.size };
}

/* ---- audio quota -------------------------------------------- */
/** Increment and return how many audios this contact used today. */
async function bumpAudio(c, phone, diaISO) {
  const cli = await client();
  const key = kAudio(c, phone, diaISO);
  const n = await cli.incr(key);
  if (n === 1) await cli.expire(key, AUDIO_TTL);
  return n;
}

/** Connectivity probe for /api/wa/health. */
async function ping() {
  const cli = await client();
  return (await cli.ping()) === 'PONG';
}

module.exports = {
  ready, ping,
  alreadySeen,
  getSession, saveSession, bumpTurn,
  nextId, pushLead, addLead, listLeads, countLeads,
  bumpAudio,
  SESSION_TTL, SEEN_TTL, AUDIO_TTL, LEADS_MAX,
};
