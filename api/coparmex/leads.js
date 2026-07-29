/* ============================================================
   GET /api/coparmex/leads?token=ADMIN_TOKEN
   Admin-only CSV export of captured leads. Protected by the
   ADMIN_TOKEN env var (query ?token= or Authorization: Bearer).
   Never public: without a matching token it returns 401.
   ============================================================ */

const { listLeads } = require('../../lib/coparmex');

function authorized(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false; // no token configured → locked down
  const url = new URL(req.url, 'http://x');
  const qToken = url.searchParams.get('token') || '';
  const auth = (req.headers && req.headers['authorization']) || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return qToken === expected || bearer === expected;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  let leads;
  try {
    leads = await listLeads();
  } catch (err) {
    console.error('[coparmex:leads]', (err && err.code) || 'error', err && err.message);
    return res.status(502).json({ ok: false, error: 'store_unavailable' });
  }

  const cols = ['ts', 'name', 'email', 'consent', 'ip', 'ua'];
  const rows = [cols.join(',')];
  for (const l of leads) rows.push(cols.map((c) => csvCell(l[c])).join(','));
  const csv = rows.join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="coparmex-leads.csv"');
  return res.status(200).send(csv);
};
