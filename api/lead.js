/* ============================================================
   POST /api/lead
   Creates a page in the correct Notion database for the given
   mode. Public endpoint the frontend can call directly. The
   NOTION_TOKEN stays server-side (read from env vars).
   ============================================================ */

const { createLeadPage } = require('../lib/notion');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const mode = body.mode === 'mexico' ? 'mexico' : body.mode === 'home' ? 'home' : null;
  if (!mode) return res.status(400).json({ ok: false, error: 'bad_mode' });

  const fields = body.fields || body;

  try {
    const result = await createLeadPage(mode, fields);
    return res.status(200).json({ ok: true, url: result.url });
  } catch (err) {
    const code = err && err.code ? err.code : 'error';
    // Validation errors → 400 (client can re-ask). Config/Notion → 502.
    const clientErr = code === 'incomplete' || code === 'bad_email' || code === 'bad_mode';
    const status = clientErr ? 400 : 502;
    if (!clientErr) console.error('[lead]', code, err && err.message, err && err.detail);
    return res.status(status).json({ ok: false, error: code });
  }
};
