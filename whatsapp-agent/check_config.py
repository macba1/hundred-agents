"""
check_config.py — valida la configuración de la demo SIN mostrar secretos.

Comprueba:
  - variables obligatorias presentes y no vacías (nombres nuevos con fallback);
  - Phone Number ID con formato razonable;
  - versión de Graph API definida;
  - verify token con longitud mínima;
  - .env NO rastreado por Git;
  - (opcional) conexión básica con Graph API leyendo metadata del número,
    sin enviar ningún mensaje.

Uso:  python check_config.py
Nunca imprime tokens ni claves completas.
"""
import os
import re
import sys
import subprocess
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
ENV_FILE = BASE_DIR / ".env"

OK, BAD, WARN = "✅", "❌", "⚠️ "
ok_all = True


def mark(good: bool) -> str:
    return OK if good else BAD


# --- cargar .env local (parser simple, sin dependencias) -------------------- #
env_file_vals: dict[str, str] = {}
if ENV_FILE.exists():
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env_file_vals[k.strip()] = v.strip()


def getv(*names: str) -> str:
    """Prioridad: valor en .env local, luego variable de entorno real."""
    for n in names:
        if env_file_vals.get(n):
            return env_file_vals[n]
    for n in names:
        if os.getenv(n):
            return os.getenv(n, "")
    return ""


print("=== check_config — Dulces del Alto (DEMO) ===\n")

if not ENV_FILE.exists():
    print(f"{WARN}No existe .env (copia .env.example -> .env). Reviso variables de entorno del proceso.\n")

# --- variables efectivas (nombres nuevos con fallback a los viejos) --------- #
openai_key = getv("OPENAI_API_KEY")
openai_model = getv("OPENAI_MODEL") or "gpt-4o (default)"
wa_token = getv("WHATSAPP_TOKEN", "WA_ACCESS_TOKEN")
phone_id = getv("WHATSAPP_PHONE_NUMBER_ID", "WA_PHONE_NUMBER_ID")
verify_token = getv("WHATSAPP_VERIFY_TOKEN", "WA_VERIFY_TOKEN")
api_version = getv("WHATSAPP_API_VERSION") or "v20.0 (default)"
human_notify = getv("HUMAN_NOTIFY_WA")
db_path = getv("DATABASE_PATH", "DB_PATH") or "demo.db (default)"
public_base = getv("PUBLIC_BASE_URL")

print("[1] Variables obligatorias (solo presencia, sin valores):")
required = {
    "OPENAI_API_KEY": openai_key,
    "WHATSAPP_TOKEN / WA_ACCESS_TOKEN": wa_token,
    "WHATSAPP_PHONE_NUMBER_ID / WA_PHONE_NUMBER_ID": phone_id,
    "WHATSAPP_VERIFY_TOKEN / WA_VERIFY_TOKEN": verify_token,
}
for name, val in required.items():
    present = bool(val)
    ok_all &= present
    print(f"  {mark(present)} {name}: {'sí' if present else 'FALTA'}")

print("\n[2] Variables opcionales:")
print(f"  {OK} OPENAI_MODEL: {openai_model}")
print(f"  {OK} WHATSAPP_API_VERSION: {api_version}")
print(f"  {mark(bool(human_notify))} HUMAN_NOTIFY_WA: {'configurado' if human_notify else 'vacío (escalado no notifica)'}")
print(f"  {OK} DATABASE_PATH: {db_path}")
print(f"  {mark(bool(public_base))} PUBLIC_BASE_URL: {'configurado' if public_base else 'vacío (opcional)'}")

# --- formato ---------------------------------------------------------------- #
print("\n[3] Formato:")
phone_ok = bool(re.fullmatch(r"\d{10,20}", phone_id or ""))
ok_all &= phone_ok
print(f"  {mark(phone_ok)} Phone Number ID numérico ({len(phone_id)} dígitos): "
      f"{'…' + phone_id[-4:] if phone_id else 'FALTA'}")

ver_ok = bool(re.fullmatch(r"v\d+\.\d+", api_version.split()[0]))
print(f"  {mark(ver_ok)} API version formato vXX.X: {api_version}")

vt_ok = len(verify_token) >= 12
if verify_token:
    ok_all &= vt_ok
print(f"  {mark(vt_ok) if verify_token else BAD} Verify token longitud >=12: "
      f"{'sí (' + str(len(verify_token)) + ' chars)' if verify_token else 'FALTA'}")

# --- git: .env no trackeado ------------------------------------------------- #
print("\n[4] Seguridad Git:")
try:
    r = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "whatsapp-agent/.env"],
        cwd=BASE_DIR.parent, capture_output=True, text=True,
    )
    env_tracked = r.returncode == 0
except Exception:  # noqa: BLE001
    env_tracked = False
ok_all &= not env_tracked
print(f"  {mark(not env_tracked)} .env NO rastreado por Git: {'trackeado (¡PELIGRO!)' if env_tracked else 'correcto'}")

# --- conexión Graph API (opcional, sin enviar mensajes) --------------------- #
print("\n[5] Graph API (lectura de metadata, NO envía mensajes):")
if wa_token and phone_id:
    try:
        import httpx
        ver = api_version.split()[0]
        resp = httpx.get(
            f"https://graph.facebook.com/{ver}/{phone_id}",
            params={"fields": "verified_name,display_phone_number,quality_rating"},
            headers={"Authorization": f"Bearer {wa_token}"},
            timeout=15,
        )
        if resp.status_code == 200:
            d = resp.json()
            print(f"  {OK} Token + Phone ID válidos. Número: {d.get('display_phone_number', '?')} "
                  f"· nombre: {d.get('verified_name', '?')} · calidad: {d.get('quality_rating', '?')}")
        else:
            err = resp.json().get("error", {}) if resp.headers.get("content-type", "").startswith("application/json") else {}
            print(f"  {BAD} Graph respondió HTTP {resp.status_code} "
                  f"(code={err.get('code')}, {err.get('message', 'sin detalle')})")
            print(f"       Causa probable: token caducado/incorrecto o Phone ID equivocado. "
                  f"Regenera el token en Meta y pégalo en .env como WHATSAPP_TOKEN.")
            ok_all = False
    except Exception as e:  # noqa: BLE001
        print(f"  {WARN}No se pudo verificar contra Graph ({type(e).__name__}). Revisa red/token.")
else:
    print(f"  {WARN}Omitido: falta token o Phone ID.")

print("\n" + "=" * 48)
print(f"RESULTADO: {'LISTO para conectar Meta ✅' if ok_all else 'FALTAN cosas ❌ (revisa arriba)'}")
sys.exit(0 if ok_all else 1)
