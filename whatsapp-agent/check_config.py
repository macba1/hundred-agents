"""
check_config.py — valida la configuración SIN mostrar secretos.

Comprueba:
  - variables obligatorias presentes y no vacías (nombres nuevos con fallback);
  - clientes en clients/: archivos completos, phone_number_id, conflictos de
    enrutado entre clientes activos;
  - versión de Graph API definida;
  - verify token con longitud mínima;
  - .env NO rastreado por Git;
  - (opcional) conexión básica con Graph API leyendo metadata del número de
    cada cliente activo, sin enviar ningún mensaje.

Uso:  python check_config.py
Nunca imprime tokens ni claves completas.
"""
import os
import re
import sys
import json
import subprocess
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
ENV_FILE = BASE_DIR / ".env"
CLIENTS_DIR = BASE_DIR / "clients"

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


print("=== check_config — Agente WhatsApp multi-cliente ===\n")

if not ENV_FILE.exists():
    print(f"{WARN}No existe .env (copia .env.example -> .env). Reviso variables de entorno del proceso.\n")

# --- variables efectivas (nombres nuevos con fallback a los viejos) --------- #
openai_key = getv("OPENAI_API_KEY")
openai_model = getv("OPENAI_MODEL") or "gpt-4o (default)"
transcribe_model = getv("TRANSCRIBE_MODEL") or "whisper-1 (default)"
wa_token = getv("WHATSAPP_TOKEN", "WA_ACCESS_TOKEN")
verify_token = getv("WHATSAPP_VERIFY_TOKEN", "WA_VERIFY_TOKEN")
api_version = getv("WHATSAPP_API_VERSION") or "v20.0 (default)"
db_path = getv("DATABASE_PATH", "DB_PATH") or "demo.db (default)"
public_base = getv("PUBLIC_BASE_URL")
default_client = getv("DEFAULT_CLIENT")

print("[1] Variables obligatorias (solo presencia, sin valores):")
required = {
    "OPENAI_API_KEY": openai_key,
    "WHATSAPP_TOKEN / WA_ACCESS_TOKEN": wa_token,
    "WHATSAPP_VERIFY_TOKEN / WA_VERIFY_TOKEN": verify_token,
}
for name, val in required.items():
    present = bool(val)
    ok_all &= present
    print(f"  {mark(present)} {name}: {'sí' if present else 'FALTA'}")
print(f"  {OK} (el phone_number_id ya NO es global: vive en cada clients/<clave>/config.json)")

print("\n[2] Variables opcionales:")
print(f"  {OK} OPENAI_MODEL: {openai_model}")
print(f"  {OK} TRANSCRIBE_MODEL: {transcribe_model}")
print(f"  {OK} WHATSAPP_API_VERSION: {api_version}")
print(f"  {OK} DATABASE_PATH: {db_path}")
print(f"  {mark(bool(public_base))} PUBLIC_BASE_URL: {'configurado' if public_base else 'vacío (opcional)'}")
print(f"  {OK} DEFAULT_CLIENT: {default_client or 'vacío (se usa el único activo)'}")

# --- clientes ---------------------------------------------------------------- #
print("\n[3] Clientes en clients/:")
clientes: list[dict] = []
if not CLIENTS_DIR.exists():
    print(f"  {BAD} No existe la carpeta clients/")
    ok_all = False
else:
    for folder in sorted(p for p in CLIENTS_DIR.iterdir() if p.is_dir()):
        cfg_path = folder / "config.json"
        if not cfg_path.exists():
            print(f"  {WARN}{folder.name}: sin config.json, se ignora")
            continue
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"  {BAD} {folder.name}: config.json inválido ({e})")
            ok_all = False
            continue
        falta = [f for f in ("prompt.md", "catalogo.json") if not (folder / f).exists()]
        pid = str(cfg.get("phone_number_id", ""))
        activo = bool(cfg.get("activo", True))
        pid_ok = bool(re.fullmatch(r"\d{10,20}", pid))
        estado = "ACTIVO  " if activo else "inactivo"
        bandera = mark(pid_ok and not falta) if activo else WARN
        print(f"  {bandera}{estado} {cfg.get('clave', folder.name):14} "
              f"pnid=…{pid[-6:] if pid else 'FALTA':>6} "
              f"folio={cfg.get('folio_prefix', '?')}- "
              f"max_turns={cfg.get('max_turns', '?')} "
              f"memoria={cfg.get('memoria_mensajes', '?')} "
              f"notify={'sí' if cfg.get('human_notify_wa') else 'NO'}")
        if falta:
            print(f"       {BAD} faltan archivos: {', '.join(falta)}")
            if activo:
                ok_all = False
        if activo and not pid_ok:
            print(f"       {BAD} phone_number_id ausente o con formato raro")
            ok_all = False
        clientes.append({"clave": cfg.get("clave", folder.name), "activo": activo, "pnid": pid})

activos = [c for c in clientes if c["activo"]]
if not activos:
    print(f"  {BAD} No hay ningún cliente activo: nadie contestará el webhook.")
    ok_all = False

# Enrutado: dos clientes activos con el mismo número harían fallar el arranque.
vistos: dict[str, str] = {}
choque = False
for c in activos:
    if c["pnid"] and c["pnid"] in vistos:
        print(f"  {BAD} CONFLICTO DE ENRUTADO: '{vistos[c['pnid']]}' y '{c['clave']}' "
              f"comparten phone_number_id (…{c['pnid'][-6:]}). Deja activo=true en solo uno.")
        choque = True
        ok_all = False
    elif c["pnid"]:
        vistos[c["pnid"]] = c["clave"]
if not choque and activos:
    print(f"  {OK} Sin conflictos de enrutado ({len(vistos)} número(s) → {len(activos)} cliente(s) activo(s)).")

# --- formato ---------------------------------------------------------------- #
print("\n[4] Formato:")
ver_ok = bool(re.fullmatch(r"v\d+\.\d+", api_version.split()[0]))
print(f"  {mark(ver_ok)} API version formato vXX.X: {api_version}")

vt_ok = len(verify_token) >= 12
if verify_token:
    ok_all &= vt_ok
print(f"  {mark(vt_ok) if verify_token else BAD} Verify token longitud >=12: "
      f"{'sí (' + str(len(verify_token)) + ' chars)' if verify_token else 'FALTA'}")

# --- git: .env no trackeado ------------------------------------------------- #
print("\n[5] Seguridad Git:")
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
print("\n[6] Graph API por cliente activo (lectura de metadata, NO envía mensajes):")
if wa_token and activos:
    try:
        import httpx
        ver = api_version.split()[0]
        for c in activos:
            if not c["pnid"]:
                continue
            resp = httpx.get(
                f"https://graph.facebook.com/{ver}/{c['pnid']}",
                params={"fields": "verified_name,display_phone_number,quality_rating"},
                headers={"Authorization": f"Bearer {wa_token}"},
                timeout=15,
            )
            if resp.status_code == 200:
                d = resp.json()
                print(f"  {OK} {c['clave']}: {d.get('display_phone_number', '?')} "
                      f"· nombre: {d.get('verified_name', '?')} · calidad: {d.get('quality_rating', '?')}")
            else:
                err = resp.json().get("error", {}) if resp.headers.get("content-type", "").startswith("application/json") else {}
                print(f"  {BAD} {c['clave']}: Graph respondió HTTP {resp.status_code} "
                      f"(code={err.get('code')}, {err.get('message', 'sin detalle')})")
                print("       Causa probable: token caducado/incorrecto o phone_number_id equivocado.")
                ok_all = False
    except Exception as e:  # noqa: BLE001
        print(f"  {WARN}No se pudo verificar contra Graph ({type(e).__name__}). Revisa red/token.")
else:
    print(f"  {WARN}Omitido: falta token o no hay clientes activos.")

print("\n" + "=" * 48)
print(f"RESULTADO: {'LISTO para conectar Meta ✅' if ok_all else 'FALTAN cosas ❌ (revisa arriba)'}")
sys.exit(0 if ok_all else 1)
