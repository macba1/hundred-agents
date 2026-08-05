/* ============================================================
   WhatsApp alert on a real diagnostic completion.

   DISABLED TODAY. No client has notify_whatsapp: true in
   lib/discovery/clients.js, so shouldNotifyWA always answers false
   and nothing here reaches Graph. The path is kept complete and
   under test so re-enabling is a one-line config change.

   Reuses the existing WhatsApp infrastructure (lib/wa/whatsapp.js →
   Graph API). No new service, no new dependency.

   Contract:
   - MAX 12 lines. The report is a trigger to go look, not the report
     itself: the full expediente lives in the discovery admin.
   - Best-effort, exactly like the Notion notification: wrapped in
     try/catch by the caller and never blocks or fails finalize.
   - is_test sessions never notify.

   Note on delivery: Graph only accepts free-form text inside the
   24-hour customer-service window. If the destination has not written
   to the business number in the last 24h, Graph answers 131047 and
   sendText returns false — finalize still succeeds, and the failure is
   visible in the Vercel logs.
   ============================================================ */

const { sendTextDetailed } = require('../wa/whatsapp');
const { channelEnabled } = require('./clients');

const MAX_LINES = 12;
const DEFAULT_TO = '16503849019';
const ADMIN_PATH = '/discovery/admin.html';

/* The compiler sometimes writes a placeholder instead of leaving a field out
   ("No proporcionado"), which then shows up in the alert as if it were data. */
const PLACEHOLDER_RE = /^(no |sin )?(proporcionad[oa]|especificad[oa]|disponible|informaci[óo]n|dato[s]?|aplica|n\/?a|ninguno|ninguna|desconocido|-{1,}|\.{1,})$/i;

/** Trim to one line and cap length so a chatty field can't eat the budget. */
function oneLine(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (!t || PLACEHOLDER_RE.test(t)) return '';
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

/** Should this session send a WhatsApp alert?
    Three gates, in order: the client's channel flag (off for everyone today),
    then test sessions, then a session that actually has a client. */
function shouldNotifyWA(session) {
  if (!session) return false;
  if (!channelEnabled(session.clientKey, 'whatsapp')) return false;
  if (session.metadata && session.metadata.is_test === true) return false;
  return true;
}

/**
 * Pure: build the message body (testable without touching Graph).
 * Never exceeds MAX_LINES lines.
 */
function buildWAReport({ brain, score, proposal, sessionToken, ref }) {
  const cp = (brain && brain.company_profile) || {};
  const contact = (brain && brain.client_contact) || {};
  const op = (proposal && proposal.operation) || {};
  const ur = (proposal && proposal.urgency) || {};
  const gaps = (proposal && proposal.gaps) || [];
  const short = String(sessionToken || '').slice(0, 8);

  const empresa = [
    oneLine(brain && brain.client_name, 40) || 'Sin nombre',
    oneLine(cp.industry, 28),
    oneLine(cp.location, 28),
  ].filter(Boolean).join(' · ');

  // Requirements only — the alert never carries a recommendation or a price.
  const lines = [];
  lines.push('🔔 Diagnóstico nuevo — Hundred Agents');
  lines.push('Empresa: ' + empresa);
  lines.push('Problema: ' + (oneLine(proposal && proposal.problem_summary, 130) || 'sin registrar'));
  lines.push('Cuesta: ' + (oneLine(proposal && proposal.problem_cost, 110) || 'no cuantificado'));
  lines.push('Hoy: ' + (oneLine(proposal && proposal.problem_today, 110) || 'sin registrar'));
  lines.push('Canales: ' + (oneLine([...(op.service_channels || []), ...(op.sales_channels || [])].join(', '), 70) || '—') +
    ' · Vol: ' + (oneLine(op.volume_messages, 30) || '—'));
  lines.push('Urgencia: ' + (oneLine(ur.timeline, 50) || '—') +
    ' · Presupuesto: ' + (oneLine(ur.budget_signal || ur.budget_posture, 40) || '—'));

  // Gaps get whatever line budget is left after the fixed tail (contacto + sesión).
  const TAIL = 2;
  const room = MAX_LINES - lines.length - TAIL;
  gaps.slice(0, Math.max(0, room)).forEach((g) => lines.push('❓ ' + oneLine(g, 120)));

  lines.push('Contacto: ' + [oneLine(contact.email, 45), oneLine(contact.whatsapp || contact.phone, 20)].filter(Boolean).join(' · '));
  lines.push('Sesión ' + short + (ref ? ' · ref:' + oneLine(ref, 20) : '') + ' — expediente completo en ' + ADMIN_PATH);

  return lines.slice(0, MAX_LINES).join('\n');
}

/** Send the alert. Returns { ok, skipped? , error? }; never throws to the caller. */
async function notifyWA({ brain, score, proposal, sessionToken, ref }) {
  const to = process.env.DISCOVERY_WA_NOTIFY_TO || DEFAULT_TO;
  const pnid = process.env.DISCOVERY_WA_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID || '';
  if (!to || !pnid) return { ok: false, skipped: 'config' };

  const body = buildWAReport({ brain, score, proposal, sessionToken, ref });
  const sent = await sendTextDetailed({ phone_number_id: pnid }, to, body);
  return sent.ok
    ? { ok: true, to, lines: body.split('\n').length }
    : { ok: false, to, error: 'graph_send_failed', status: sent.status, detail: sent.detail };
}

module.exports = { shouldNotifyWA, buildWAReport, notifyWA, MAX_LINES, DEFAULT_TO };
