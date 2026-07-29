/* ============================================================
   Coparmex landing — lead storage (Redis).

   Reuses the same Redis backend already connected to the project
   (REDIS_URL). Leads are appended to a single list so the admin
   CSV export (/api/coparmex/leads) can read them in order.

   No new external setup: if REDIS_URL is present it just works.
   ============================================================ */

const LIST_KEY = 'coparmex:leads';

let _redis = null;
async function client() {
  if (_redis && _redis.isOpen) return _redis;
  const url = process.env.REDIS_URL;
  if (!url) throw { code: 'store_unconfigured', message: 'REDIS_URL not set' };
  const { createClient } = require('redis'); // lazy: dep already in package.json
  _redis = createClient({ url });
  _redis.on('error', () => {}); // swallow error events; awaited calls still throw
  if (!_redis.isOpen) await _redis.connect();
  return _redis;
}

/** Append one lead. `lead` is a plain object; stored as JSON. */
async function addLead(lead) {
  const cli = await client();
  await cli.rPush(LIST_KEY, JSON.stringify(lead));
}

/** Return all leads (oldest first) as parsed objects. */
async function listLeads() {
  const cli = await client();
  const arr = await cli.lRange(LIST_KEY, 0, -1);
  return arr
    .map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .filter(Boolean);
}

/** Count without materializing all rows. */
async function countLeads() {
  const cli = await client();
  return cli.lLen(LIST_KEY);
}

module.exports = { addLead, listLeads, countLeads, LIST_KEY };
