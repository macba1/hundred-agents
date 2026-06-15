# Hundred Agents

Landing page for **Hundred Agents** — an AI workflow consultancy in Austin, TX.
Static HTML/CSS/JS, no build step. Implemented from the Claude Design handoff
bundle (`Hundred Agents.dc.html`) in the Scale.ai-style dark/technical direction.

## Features
- Bilingual EN/ES toggle (header) — all copy swaps live
- Live agentic-network canvas (FIG.01): data particles route through the pulsing
  `HUMAN_GATE` into `EXEC`
- Scroll reveals (IntersectionObserver), FAQ accordion
- Contact form with client-side validation; submit opens the user's email
  client via `mailto:info@thehagentic.com` (subject + body pre-filled,
  URL-encoded) and shows a success state

## Files
- `index.html` — page structure
- `styles.css` — design tokens + all component styles
- `script.js` — copy (EN/ES), rendering, canvas viz, reveals, form
- `assets/` — logo / favicon SVGs

## Run locally
Any static server, e.g.:
```
python3 -m http.server 8000
```
then open http://localhost:8000

## Deploy
Static — deploys to Vercel as-is (no framework, no build command).

## Contact form
Submitting opens the visitor's email client (`mailto:`) pre-filled with their
name, email and problem description. To capture leads server-side instead, swap
the `mailto` block in `script.js` for a POST to an endpoint (Vercel form,
Formspree, or your backend/CRM).
