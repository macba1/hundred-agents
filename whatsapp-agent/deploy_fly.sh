#!/usr/bin/env bash
# Deploy del agente de WhatsApp a Fly.io — 24/7, URL fija, volumen persistente.
#
# Requisito único: FLY_API_TOKEN en el entorno (se saca de fly.io/user/personal_access_tokens).
# Todo lo demás lo hace este script: instala flyctl si falta, crea la app y el
# volumen, sube los secretos desde .env y despliega.
#
#   FLY_API_TOKEN=... ./deploy_fly.sh
set -euo pipefail

cd "$(dirname "$0")"
APP="${FLY_APP:-sanmi-whatsapp-agent}"
REGION="${FLY_REGION:-qro}"

[ -n "${FLY_API_TOKEN:-}" ] || { echo "❌ Falta FLY_API_TOKEN"; exit 1; }
[ -f .env ] || { echo "❌ Falta .env"; exit 1; }

# --- flyctl ---------------------------------------------------------------- #
if ! command -v flyctl >/dev/null 2>&1; then
  if [ -x "$HOME/.fly/bin/flyctl" ]; then
    export PATH="$HOME/.fly/bin:$PATH"
  else
    echo "▶ Instalando flyctl en ~/.fly (sin sudo)…"
    curl -fsSL https://fly.io/install.sh | sh
    export PATH="$HOME/.fly/bin:$PATH"
  fi
fi
flyctl version

echo "▶ Cuenta: $(flyctl auth whoami)"

# --- app ------------------------------------------------------------------- #
if flyctl status --app "$APP" >/dev/null 2>&1; then
  echo "▶ La app $APP ya existe."
else
  echo "▶ Creando app $APP…"
  flyctl apps create "$APP" --machines
fi

# --- volumen (SQLite persistente) ------------------------------------------ #
if [ -z "$(flyctl volumes list --app "$APP" --json 2>/dev/null | grep -o '"name":"agent_data"' || true)" ]; then
  echo "▶ Creando volumen agent_data (1GB) en $REGION…"
  flyctl volumes create agent_data --app "$APP" --region "$REGION" --size 1 --yes
else
  echo "▶ El volumen agent_data ya existe."
fi

# --- secretos -------------------------------------------------------------- #
# Se leen del .env local y se suben a Fly. Nunca se hornean en la imagen.
echo "▶ Subiendo secretos…"
get() { grep -E "^$1=" .env | head -1 | cut -d= -f2- ; }

PANEL_TOKEN_VAL="${PANEL_TOKEN:-$(get PANEL_TOKEN)}"
if [ -z "$PANEL_TOKEN_VAL" ]; then
  PANEL_TOKEN_VAL="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
  echo "PANEL_TOKEN=$PANEL_TOKEN_VAL" >> .env
  echo "  · PANEL_TOKEN generado y guardado en .env"
fi

flyctl secrets set --app "$APP" --stage \
  OPENAI_API_KEY="$(get OPENAI_API_KEY)" \
  WHATSAPP_TOKEN="$(get WHATSAPP_TOKEN)" \
  WHATSAPP_VERIFY_TOKEN="$(get WHATSAPP_VERIFY_TOKEN)" \
  PANEL_TOKEN="$PANEL_TOKEN_VAL" \
  PUBLIC_BASE_URL="https://$APP.fly.dev"

# --- deploy ----------------------------------------------------------------- #
echo "▶ Desplegando…"
flyctl deploy --app "$APP" --ha=false --yes

echo
echo "════════════════════════════════════════════════════════════"
echo " Webhook : https://$APP.fly.dev/webhook"
echo " Panel   : https://$APP.fly.dev/leads?client=sanmi&token=$PANEL_TOKEN_VAL"
echo " Health  : https://$APP.fly.dev/health"
echo " Logs    : flyctl logs --app $APP"
echo "════════════════════════════════════════════════════════════"
