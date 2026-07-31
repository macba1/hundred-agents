/* ============================================================
   WhatsApp alert on a real "hundred" diagnostic completion.

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

const { sendText } = require('../wa/whatsapp');

const MAX_LINES = 12;
const DEFAULT_TO = '16503849019';
const ADMIN_PATH = '/discovery/admin.html';

/** Trim to one line and cap length so a chatty field can't eat the budget. */
function oneLine(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

/** Should this session send a WhatsApp alert? Only real hundred sessions. */
function shouldNotifyWA(session) {
  if (!session) return false;
  if (session.metadata && session.metadata.is_test === true) return false;
  return session.clientKey === 'hundred';
}

/**
 * Pure: build the message body (testable without touching Graph).
 * Never exceeds MAX_LINES lines.
 */
function buildWAReport({ brain, score, proposal, sessionToken, ref }) {
  const cp = (brain && brain.company_profile) || {};
  const contact = (brain && brain.client_contact) || {};
  const pricing = (proposal && proposal.pricing_internal) || {};
  const alerts = (proposal && proposal.alerts) || [];
  const short = String(sessionToken || '').slice(0, 8);

  const empresa = [
    oneLine(brain && brain.client_name, 40) || 'Sin nombre',
    oneLine(cp.industry, 28),
    oneLine(cp.location, 28),
  ].filter(Boolean).join(' · ');

  const mx = (n) => (typeof n === 'number' ? '$' + n.toLocaleString('en-US') : '?');

  const lines = [];
  lines.push('🔔 Diagnóstico nuevo — Hundred Agents');
  lines.push('Empresa: ' + empresa);
  lines.push('Problema: ' + (oneLine(proposal && proposal.problem_summary, 130) || 'sin registrar'));
  lines.push('Cuesta: ' + (oneLine(proposal && proposal.problem_cost, 110) || 'no cuantificado'));
  lines.push('Propuesta: ' + oneLine(
    [(proposal && proposal.recommended_build), ...((proposal && proposal.also_consider) || [])].filter(Boolean).join(' + '),
    110
  ));
  lines.push('Dificultad: ' + (score && score.difficulty ? score.difficulty : '?') +
    ' — ' + oneLine(((score && score.difficulty_reasons) || []).slice(0, 2).join(' '), 90));
  lines.push('Tier: ' + (proposal && proposal.suggested_tier ? proposal.suggested_tier : '?') +
    ' — ' + mx(pricing.setup_mxn) + ' + ' + mx(pricing.monthly_mxn) + '/mes (interno, ±20%)');

  // Alerts get whatever line budget is left after the fixed tail (contacto + sesión).
  const TAIL = 2;
  const room = MAX_LINES - lines.length - TAIL;
  alerts.slice(0, Math.max(0, room)).forEach((a) => lines.push('⚠️ ' + oneLine(a, 120)));

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
  const sent = await sendText({ phone_number_id: pnid }, to, body);
  return sent ? { ok: true, lines: body.split('\n').length } : { ok: false, error: 'graph_send_failed' };
}

module.exports = { shouldNotifyWA, buildWAReport, notifyWA, MAX_LINES, DEFAULT_TO };
