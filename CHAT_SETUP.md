# Chat widget — setup & operations

AI chat widget with two modes, each writing to a different Notion database.

- **Home** (`/`): informs about Hundred Agents + captures a commercial lead → DB *Leads — Hundred Agents*.
- **Conference** (`/conferencia-mexico-2026`): registers attendees + collects their question → DB *Asistentes Conferencia México*.

## Architecture (security)

No API keys live in the frontend. The widget talks **only** to two Vercel
Serverless Functions, which read secrets from environment variables:

- `POST /api/chat` — reads `OPENAI_API_KEY`, calls OpenAI (**gpt-4o-mini**),
  picks the system prompt by `mode` (`home` | `mexico`). When the model has
  enough data it triggers the `save_lead` tool, handled **server-side**, which
  writes to Notion via `lib/notion.js`.
- `POST /api/lead` — independent endpoint that creates the Notion page for a
  mode using `NOTION_TOKEN`. The token is never sent to the client.

Files: `api/chat.js`, `api/lead.js`, `lib/notion.js` (shared writer),
`widget.js` + `chat.css` (frontend).

## Notion databases (already created)

| DB | Mode | `database_id` | URL |
|----|------|---------------|-----|
| Leads — Hundred Agents | `home` | `73c91cbed56c46cd96c157fd73a5039f` | https://app.notion.com/p/73c91cbed56c46cd96c157fd73a5039f |
| Asistentes Conferencia México | `mexico` | `071adb60ce0b427f8435cd9d52115f8f` | https://app.notion.com/p/071adb60ce0b427f8435cd9d52115f8f |

### One-time: give the server access to these DBs
The databases were created in your Notion workspace. The serverless functions
use a **separate internal integration token**, which must be granted access:

1. https://www.notion.so/my-integrations → **New integration** (internal) →
   copy the token (`NOTION_TOKEN`).
2. Open each database → `•••` → **Connections** → add your integration.
   (Do this for **both** DBs.)

### New-registration notifications (native Notion, no email)
On each DB: `•••` → **Automations** (or follow the database) → notify yourself
on **new page added**. This uses Notion's native notifications — the code does
**not** send any email.

## Environment variables (set in Vercel → Project → Settings → Environment Variables)

| Name | Value |
|------|-------|
| `OPENAI_API_KEY` | your OpenAI key |
| `NOTION_TOKEN` | internal integration token (above) |
| `NOTION_LEADS_DB_ID` | `73c91cbed56c46cd96c157fd73a5039f` |
| `NOTION_MEXICO_DB_ID` | `071adb60ce0b427f8435cd9d52115f8f` |

Set them for **Production** (and Preview if you test there), then redeploy.
Never commit these — `.env*` is gitignored.

> ⚠️ **Spending limit:** set a monthly usage limit / budget alert in the OpenAI
> dashboard (Billing → Limits) so the chat can't run up an unexpected bill.

## Limits & error handling
- Max **20 user turns** per conversation; beyond that the bot points to
  `info@thehagentic.com`.
- Email is validated before any Notion write.
- If OpenAI or Notion fail, the widget shows a clear message and falls back to
  `mailto:info@thehagentic.com`.

## Cost estimate (gpt-4o-mini)
Pricing: ~$0.15 / 1M input tokens, ~$0.60 / 1M output tokens.
A typical lead/registration conversation (~8–12 exchanges, history resent each
turn + one save round-trip) runs roughly **$0.004–0.008**. A maxed-out 20-turn
conversation is around **$0.015**. So on the order of **one cent or less per
conversation**.
