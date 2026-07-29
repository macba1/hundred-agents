"""
Configura el webhook de la app de Meta por API — sin entrar al panel web.

Meta exige un *App access token* (app_id|app_secret) para tocar
/{app-id}/subscriptions; el token de System User NO alcanza. Por eso hace falta
META_APP_SECRET en .env (solo para esto, no se usa en runtime).

Uso:
    python set_meta_webhook.py              # usa la URL de producción por defecto
    python set_meta_webhook.py --ver        # solo muestra la config actual
    python set_meta_webhook.py https://otro-host/api/wa/webhook
"""
import os
import sys
import json
from pathlib import Path

import httpx

BASE_DIR = Path(__file__).resolve().parent
GRAPH = "https://graph.facebook.com/v20.0"
DEFAULT_CALLBACK = "https://www.thehagentic.com/api/wa/webhook"


def load_env() -> dict:
    env = {}
    f = BASE_DIR / ".env"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    for k, v in os.environ.items():
        env.setdefault(k, v)
    return env


def main() -> None:
    env = load_env()
    app_id = env.get("META_APP_ID", "")
    app_secret = env.get("META_APP_SECRET", "")
    verify_token = env.get("WHATSAPP_VERIFY_TOKEN", "")

    if not app_id or not app_secret:
        sys.exit(
            "❌ Faltan META_APP_ID / META_APP_SECRET en .env.\n"
            "   El App Secret está en developers.facebook.com → tu app →\n"
            "   Settings → Basic → App Secret (botón 'Show')."
        )
    if not verify_token:
        sys.exit("❌ Falta WHATSAPP_VERIFY_TOKEN en .env")

    app_token = f"{app_id}|{app_secret}"

    # --- estado actual ------------------------------------------------------ #
    r = httpx.get(f"{GRAPH}/{app_id}/subscriptions",
                  params={"access_token": app_token}, timeout=30)
    print(f"GET subscriptions → HTTP {r.status_code}")
    print(json.dumps(r.json(), ensure_ascii=False, indent=2)[:1200])
    if r.status_code >= 400:
        sys.exit("❌ No se pudo leer la configuración. Revisa el App Secret.")

    if "--ver" in sys.argv:
        return

    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    # La versión viva del agente son las funciones de Vercel (ver INFRA.md).
    callback = args[0] if args else DEFAULT_CALLBACK
    if not callback.startswith("https://"):
        sys.exit("❌ El callback debe ser https://")

    # --- alta del webhook --------------------------------------------------- #
    print(f"\n▶ Registrando callback: {callback}")
    r = httpx.post(
        f"{GRAPH}/{app_id}/subscriptions",
        params={"access_token": app_token},
        data={
            "object": "whatsapp_business_account",
            "callback_url": callback,
            "verify_token": verify_token,
            "fields": "messages",
        },
        timeout=30,
    )
    print(f"POST subscriptions → HTTP {r.status_code}: {r.text}")
    if r.status_code >= 400:
        sys.exit(
            "❌ Meta rechazó el alta. Causas típicas: la URL no responde el "
            "challenge del GET /webhook, o el verify token no coincide."
        )

    r = httpx.get(f"{GRAPH}/{app_id}/subscriptions",
                  params={"access_token": app_token}, timeout=30)
    print("\n✅ Configuración final:")
    print(json.dumps(r.json(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
