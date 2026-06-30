/* ============================================================
   Lightweight Redis-backed rate limiting for the Discovery Agent.
   Fixed-window counters keyed by IP. Fails OPEN on store errors
   (never blocks a real client because the limiter hiccuped).
   ============================================================ */
const store = require('./store');

const HOUR = 3600;
const LIMITS = {
  start_per_ip_hour: 8,    // new discovery sessions per IP per hour
  msg_per_ip_hour: 120,    // chat messages per IP per hour
  // messages per session are capped separately by MAX_TURNS in message.js
};

const FRIENDLY = "You've reached the limit for now. Please email info@thehagentic.com and our team will continue with you. / Has alcanzado el límite por ahora. Escríbenos a info@thehagentic.com y el equipo sigue contigo.";

function clientIp(req) {
  const xff = (req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '';
  const ip = String(xff).split(',')[0].trim();
  return ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** Returns { ok, count, limit }. Fails open (ok:true) if the store errors. */
async function check(kind, id, limit, ttl = HOUR) {
  try {
    const n = await store.incr(`rl:${kind}:${id}`, ttl);
    return { ok: n <= limit, count: n, limit };
  } catch {
    return { ok: true, count: 0, limit, degraded: true };
  }
}

module.exports = { LIMITS, FRIENDLY, clientIp, check };
