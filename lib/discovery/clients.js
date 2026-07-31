/* ============================================================
   Per-client configuration for the discovery agents.

   Separate from the prompt profiles (prompts.js) on purpose: this
   file answers "how does this client behave operationally", not
   "what does it say". Notification channels live here so turning
   one on or off is a config change, never a code change.

   Channel state today:
   - Notion: ON for both clients. The @mention inside the created
     page IS the notification, and the page body carries the full
     internal report.
   - WhatsApp: OFF for both. The code path is complete and tested;
     flipping notify_whatsapp to true re-enables it with no other
     change. Kept off by decision, not by omission.
   ============================================================ */

const CLIENTS = {
  gabi: {
    key: 'gabi',
    label: 'Gabi / GAMARE',
    notify_notion: true,
    notify_whatsapp: false,
    // Gabi's internal proposal has always been read in the admin only.
    notion_full_report: false,
  },
  hundred: {
    key: 'hundred',
    label: 'Hundred Agents — diagnóstico genérico',
    notify_notion: true,
    // OFF por decisión (2026-07-31). El envío está implementado y probado en
    // lib/discovery/wa-notify.js; poner esto en true lo reactiva tal cual.
    notify_whatsapp: false,
    // El informe interno completo se escribe en el CUERPO de la página de
    // Notion, para poder leerlo entero sin abrir el admin.
    notion_full_report: true,
  },
};

const DEFAULT_CLIENT = 'gabi';

/** Config for a clientKey. Unknown keys fall back to the safest client. */
function configFor(clientKey) {
  return CLIENTS[clientKey] || CLIENTS[DEFAULT_CLIENT];
}

/** Is this notification channel enabled for this client? */
function channelEnabled(clientKey, channel) {
  return configFor(clientKey)['notify_' + channel] === true;
}

module.exports = { CLIENTS, DEFAULT_CLIENT, configFor, channelEnabled };
