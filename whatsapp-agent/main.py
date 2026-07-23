"""
Agente de ventas de WhatsApp — Dulces del Alto (DEMO).

Stack: Python + FastAPI + OpenAI (gpt-4o, function calling + visión) +
WhatsApp Cloud API (Graph v20.0) + SQLite (sqlite3 directo, sin ORM).

Servicio autónomo. No toca la estructura Node/Vercel del repo.
Corre con:  uvicorn main:app --host 0.0.0.0 --port 8000
"""

import os
import re
import json
import base64
import sqlite3
import logging
from pathlib import Path
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, Request, Response, BackgroundTasks
from fastapi.responses import PlainTextResponse, HTMLResponse, JSONResponse

# --------------------------------------------------------------------------- #
# Config (todo por env)
# --------------------------------------------------------------------------- #
BASE_DIR = Path(__file__).resolve().parent

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o")

WA_ACCESS_TOKEN = os.getenv("WA_ACCESS_TOKEN", "")
WA_PHONE_NUMBER_ID = os.getenv("WA_PHONE_NUMBER_ID", "")
WA_VERIFY_TOKEN = os.getenv("WA_VERIFY_TOKEN", "")
HUMAN_NOTIFY_WA = os.getenv("HUMAN_NOTIFY_WA", "")

DB_PATH = os.getenv("DB_PATH", "demo.db")
MAX_TURNS = int(os.getenv("MAX_TURNS", "14"))
GRAPH = "https://graph.facebook.com/v20.0"

HISTORY_LIMIT = 24        # mensajes de memoria por teléfono
MAX_TOOL_ITERS = 5        # iteraciones del loop de function calling

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("dulces-agent")

app = FastAPI(title="Dulces del Alto — Agente WhatsApp (DEMO)")

# --------------------------------------------------------------------------- #
# Carga de catálogo + system prompt (editables sin tocar código)
# --------------------------------------------------------------------------- #
with open(BASE_DIR / "catalogo.json", encoding="utf-8") as f:
    CATALOGO = json.load(f)

SYSTEM_PROMPT = (BASE_DIR / "prompt_agente.md").read_text(encoding="utf-8")


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


# --------------------------------------------------------------------------- #
# SQLite
# --------------------------------------------------------------------------- #
def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def init_db() -> None:
    conn = db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS seen (
            message_id TEXT PRIMARY KEY,
            ts         TEXT
        );
        CREATE TABLE IF NOT EXISTS messages (
            id    INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT NOT NULL,
            role  TEXT NOT NULL,
            content TEXT NOT NULL,
            ts    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone, id);
        CREATE TABLE IF NOT EXISTS sessions (
            phone TEXT PRIMARY KEY,
            turns INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS leads (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            ts            TEXT NOT NULL,
            phone         TEXT NOT NULL,
            tipo          TEXT NOT NULL,
            clasificacion TEXT,
            resumen       TEXT,
            total         REAL,
            folio         TEXT
        );
        """
    )
    conn.commit()
    conn.close()


init_db()


# ---- memoria / sesión ------------------------------------------------------ #
def load_history(phone: str) -> list[dict]:
    conn = db()
    rows = conn.execute(
        "SELECT role, content FROM messages WHERE phone=? ORDER BY id DESC LIMIT ?",
        (phone, HISTORY_LIMIT),
    ).fetchall()
    conn.close()
    return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]


def save_message(phone: str, role: str, content: str) -> None:
    conn = db()
    conn.execute(
        "INSERT INTO messages(phone, role, content, ts) VALUES (?,?,?,?)",
        (phone, role, content, now_iso()),
    )
    conn.commit()
    conn.close()


def bump_turn(phone: str) -> int:
    """Incrementa y devuelve el número de turno del usuario."""
    conn = db()
    conn.execute(
        "INSERT INTO sessions(phone, turns) VALUES (?, 1) "
        "ON CONFLICT(phone) DO UPDATE SET turns = turns + 1",
        (phone,),
    )
    conn.commit()
    turns = conn.execute("SELECT turns FROM sessions WHERE phone=?", (phone,)).fetchone()["turns"]
    conn.close()
    return turns


def already_seen(message_id: str) -> bool:
    conn = db()
    try:
        conn.execute("INSERT INTO seen(message_id, ts) VALUES (?,?)", (message_id, now_iso()))
        conn.commit()
        seen = False
    except sqlite3.IntegrityError:
        seen = True
    conn.close()
    return seen


def log_lead(phone: str, tipo: str, clasificacion=None, resumen=None, total=None, folio=None) -> int:
    conn = db()
    cur = conn.execute(
        "INSERT INTO leads(ts, phone, tipo, clasificacion, resumen, total, folio) "
        "VALUES (?,?,?,?,?,?,?)",
        (now_iso(), phone, tipo, clasificacion, resumen, total, folio),
    )
    conn.commit()
    lead_id = cur.lastrowid
    conn.close()
    return lead_id


# --------------------------------------------------------------------------- #
# Herramientas (function calling)
# --------------------------------------------------------------------------- #
def tool_buscar_catalogo(consulta: str) -> dict:
    q = (consulta or "").strip().lower()
    matches = []
    for p in CATALOGO["productos"]:
        haystack = f'{p["nombre"]} {p["categoria"]} {p["sku"]}'.lower()
        if not q or all(tok in haystack for tok in q.split()):
            matches.append(p)
        if len(matches) >= 6:
            break
    # fallback: si el AND por tokens no encontró nada, prueba OR laxo
    if not matches and q:
        for p in CATALOGO["productos"]:
            haystack = f'{p["nombre"]} {p["categoria"]} {p["sku"]}'.lower()
            if any(tok in haystack for tok in q.split()):
                matches.append(p)
            if len(matches) >= 6:
                break
    return {
        "moneda": CATALOGO["moneda"],
        "envios": CATALOGO["envios"],
        "coincidencias": matches,
        "total_coincidencias": len(matches),
    }


def tool_registrar_pedido(phone: str, clasificacion: str, resumen: str, total=None) -> dict:
    valid = {"pedido", "cotizacion", "duda", "lead_caliente"}
    if clasificacion not in valid:
        clasificacion = "duda"
    try:
        total_val = float(total) if total is not None else None
    except (TypeError, ValueError):
        total_val = None
    lead_id = log_lead(phone, clasificacion, clasificacion, resumen, total_val)
    folio = f"DA-{lead_id:04d}"
    conn = db()
    conn.execute("UPDATE leads SET folio=? WHERE id=?", (folio, lead_id))
    conn.commit()
    conn.close()
    return {"folio": folio, "clasificacion": clasificacion, "total": total_val}


async def tool_escalar_humano(phone: str, motivo: str) -> dict:
    log_lead(phone, "escalado", "lead_caliente", motivo, None, None)
    aviso = (
        f"🚨 Escalamiento Dulces del Alto (DEMO)\n"
        f"Cliente: +{phone}\n"
        f"Motivo: {motivo}"
    )
    entregado = False
    if HUMAN_NOTIFY_WA:
        entregado = await send_whatsapp_text(HUMAN_NOTIFY_WA, aviso)
    return {"escalado": True, "notificado_a_humano": entregado, "motivo": motivo}


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "buscar_catalogo",
            "description": (
                "Busca productos en el catálogo por nombre, categoría o SKU. "
                "DEBES llamarla antes de dar cualquier precio o stock. "
                "Devuelve hasta 6 coincidencias con precios de menudeo/mayoreo y stock."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "consulta": {"type": "string", "description": "Texto a buscar (producto, categoría o sku)."}
                },
                "required": ["consulta"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registrar_pedido",
            "description": "Registra un pedido/cotización/lead y devuelve un folio DA-XXXX.",
            "parameters": {
                "type": "object",
                "properties": {
                    "clasificacion": {
                        "type": "string",
                        "enum": ["pedido", "cotizacion", "duda", "lead_caliente"],
                    },
                    "resumen": {"type": "string", "description": "Resumen breve del pedido/consulta."},
                    "total": {"type": "number", "description": "Total estimado en MXN si aplica."},
                },
                "required": ["clasificacion", "resumen"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "escalar_humano",
            "description": "Escala a un humano y notifica al equipo por WhatsApp.",
            "parameters": {
                "type": "object",
                "properties": {"motivo": {"type": "string", "description": "Por qué se escala."}},
                "required": ["motivo"],
            },
        },
    },
]


async def dispatch_tool(phone: str, name: str, args: dict) -> dict:
    try:
        if name == "buscar_catalogo":
            return tool_buscar_catalogo(args.get("consulta", ""))
        if name == "registrar_pedido":
            return tool_registrar_pedido(
                phone, args.get("clasificacion", "duda"), args.get("resumen", ""), args.get("total")
            )
        if name == "escalar_humano":
            return await tool_escalar_humano(phone, args.get("motivo", ""))
        return {"error": f"herramienta desconocida: {name}"}
    except Exception as e:  # noqa: BLE001
        log.exception("tool %s falló", name)
        return {"error": str(e)}


# --------------------------------------------------------------------------- #
# OpenAI (REST directo vía httpx — sin SDK extra)
# --------------------------------------------------------------------------- #
async def openai_chat(messages: list[dict]) -> dict:
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            json={"model": OPENAI_MODEL, "messages": messages, "tools": TOOLS, "temperature": 0.4},
        )
        r.raise_for_status()
        return r.json()


async def run_agent(phone: str, user_content, memory_text: str) -> str:
    """
    user_content: string (texto) o lista de partes (visión).
    memory_text : representación en texto para persistir en memoria.
    """
    history = load_history(phone)
    messages = [{"role": "system", "content": SYSTEM_PROMPT}] + history
    messages.append({"role": "user", "content": user_content})
    save_message(phone, "user", memory_text)

    final_text = ""
    for _ in range(MAX_TOOL_ITERS):
        data = await openai_chat(messages)
        msg = data["choices"][0]["message"]
        messages.append(msg)

        tool_calls = msg.get("tool_calls")
        if not tool_calls:
            final_text = msg.get("content") or ""
            break

        for tc in tool_calls:
            fn = tc["function"]["name"]
            try:
                args = json.loads(tc["function"].get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            result = await dispatch_tool(phone, fn, args)
            messages.append(
                {"role": "tool", "tool_call_id": tc["id"], "content": json.dumps(result, ensure_ascii=False)}
            )
    else:
        # se agotaron las iteraciones sin respuesta final
        final_text = final_text or "Permíteme confirmar ese dato y te respondo enseguida. 🙌"

    if not final_text:
        final_text = "¿Me repites por favor? No te entendí bien."
    save_message(phone, "assistant", final_text)
    return final_text


# --------------------------------------------------------------------------- #
# WhatsApp Cloud API
# --------------------------------------------------------------------------- #
async def send_whatsapp_text(to: str, body: str) -> bool:
    if not (WA_ACCESS_TOKEN and WA_PHONE_NUMBER_ID):
        log.warning("WA no configurado; no se envía a %s: %s", to, body[:80])
        return False
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            f"{GRAPH}/{WA_PHONE_NUMBER_ID}/messages",
            headers={"Authorization": f"Bearer {WA_ACCESS_TOKEN}"},
            json={
                "messaging_product": "whatsapp",
                "to": to,
                "type": "text",
                "text": {"body": body[:4096]},
            },
        )
        if r.status_code >= 400:
            log.error("WA send falló %s: %s", r.status_code, r.text)
            return False
    return True


async def download_media_b64(media_id: str) -> tuple[str, str]:
    """Descarga media de Graph y devuelve (data_uri_base64, mime)."""
    async with httpx.AsyncClient(timeout=60) as client:
        meta = await client.get(
            f"{GRAPH}/{media_id}",
            headers={"Authorization": f"Bearer {WA_ACCESS_TOKEN}"},
        )
        meta.raise_for_status()
        info = meta.json()
        url, mime = info["url"], info.get("mime_type", "image/jpeg")
        media = await client.get(url, headers={"Authorization": f"Bearer {WA_ACCESS_TOKEN}"})
        media.raise_for_status()
        b64 = base64.b64encode(media.content).decode()
    return f"data:{mime};base64,{b64}", mime


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@app.get("/webhook")
async def verify(request: Request):
    params = request.query_params
    if params.get("hub.mode") == "subscribe" and params.get("hub.verify_token") == WA_VERIFY_TOKEN:
        return PlainTextResponse(params.get("hub.challenge", ""))
    return PlainTextResponse("forbidden", status_code=403)


CLOSING_MSG = (
    "¡Gracias por probar la demo de Dulces del Alto! 🍬 "
    "Aquí termina este recorrido de muestra. Si quieres seguir, escríbenos de nuevo."
)


@app.post("/webhook")
async def incoming(request: Request, background_tasks: BackgroundTasks):
    # CRÍTICO: devolver 200 a Meta al instante. OpenAI+envío tardan segundos;
    # si Meta no ve 200 en ~5s reintenta y puede desactivar el webhook.
    # Parseo rápido aquí; el trabajo pesado va a background.
    try:
        payload = await request.json()
        for entry in payload.get("entry", []):
            for change in entry.get("changes", []):
                value = change.get("value", {})
                # Estados de entrega (sent/delivered/read): registrar y no procesar.
                for st in value.get("statuses", []):
                    log.info("status wamid=%s -> %s", st.get("id", "?"), st.get("status", "?"))
                # Mensajes entrantes: dedup síncrono aquí (antes de encolar) para
                # que un reintento de Meta no encole el mismo mensaje dos veces;
                # el procesamiento (OpenAI + envío) va a background.
                for m in value.get("messages", []):
                    mid = m.get("id", "")
                    if mid and already_seen(mid):
                        log.info("dedup: mensaje %s ya visto, se ignora", mid)
                        continue
                    background_tasks.add_task(handle_message, m)
    except Exception:  # noqa: BLE001
        log.exception("error procesando webhook")
    return JSONResponse({"status": "ok"})


async def handle_message(m: dict) -> None:
    # Nota: dedup ya se hizo en incoming() antes de encolar esta tarea.
    phone = m.get("from", "")
    if not phone:
        return

    mtype = m.get("type", "unknown")

    # límite de turnos de la demo
    turns = bump_turn(phone)
    if turns > MAX_TURNS:
        log_lead(phone, "mensaje", None, f"[límite {MAX_TURNS} turnos alcanzado]", None)
        await send_whatsapp_text(phone, CLOSING_MSG)
        return

    try:
        if mtype == "text":
            body = m["text"]["body"]
            log_lead(phone, "mensaje", None, body[:200], None)
            reply = await run_agent(phone, body, body)
            await send_whatsapp_text(phone, reply)

        elif mtype == "image":
            caption = m["image"].get("caption", "")
            log_lead(phone, "mensaje", None, f"[imagen] {caption}".strip()[:200], None)
            data_uri, _ = await download_media_b64(m["image"]["id"])
            parts = [
                {"type": "text", "text": caption or "Identifica este dulce y sugiere el más parecido del catálogo."},
                {"type": "image_url", "image_url": {"url": data_uri}},
            ]
            reply = await run_agent(phone, parts, f"[imagen] {caption}".strip())
            await send_whatsapp_text(phone, reply)

        else:
            # audio, sticker, ubicación, etc.
            log_lead(phone, "mensaje", None, f"[{mtype}]", None)
            await send_whatsapp_text(
                phone,
                "Por ahora solo puedo leer *texto* (y fotos de producto). "
                "¿Me escribes tu consulta en un mensaje? 🙏",
            )
    except Exception:  # noqa: BLE001
        log.exception("error atendiendo mensaje de %s", phone)
        await send_whatsapp_text(phone, "Tuvimos un detalle técnico. ¿Me repites tu mensaje?")


# --------------------------------------------------------------------------- #
# Panel para proyector
# --------------------------------------------------------------------------- #
@app.get("/leads", response_class=HTMLResponse)
async def panel():
    conn = db()
    total_eventos = conn.execute("SELECT COUNT(*) c FROM leads").fetchone()["c"]
    contactos = conn.execute("SELECT COUNT(DISTINCT phone) c FROM leads").fetchone()["c"]
    rows = conn.execute("SELECT * FROM leads ORDER BY id DESC LIMIT 200").fetchall()
    conn.close()

    def td(x):
        return "" if x is None else str(x)

    trs = ""
    for r in rows:
        hora = td(r["ts"])[11:19]
        tel4 = td(r["phone"])[-4:]
        total = f'${r["total"]:,.2f}' if r["total"] is not None else ""
        resumen = (td(r["resumen"])[:80]).replace("<", "&lt;").replace(">", "&gt;")
        trs += (
            f"<tr><td>{hora}</td><td>…{tel4}</td><td>{td(r['tipo'])}</td>"
            f"<td>{td(r['clasificacion'])}</td><td class='res'>{resumen}</td>"
            f"<td class='num'>{total}</td></tr>"
        )

    html = f"""<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta http-equiv="refresh" content="5">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dulces del Alto — Leads en vivo</title>
<style>
  :root {{ --bg:#0b0b0d; --accent:#ff4e1c; --fg:#f2f2f4; --muted:#8a8a92; --line:#1e1e22; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--fg);
    font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; padding:32px; }}
  h1 {{ margin:0 0 4px; font-size:20px; letter-spacing:.5px; }}
  h1 span {{ color:var(--accent); }}
  .sub {{ color:var(--muted); margin-bottom:28px; font-size:13px; }}
  .cards {{ display:flex; gap:24px; margin-bottom:32px; flex-wrap:wrap; }}
  .card {{ background:#131316; border:1px solid var(--line); border-radius:16px;
    padding:24px 32px; min-width:220px; }}
  .card .n {{ font-size:64px; font-weight:800; color:var(--accent); line-height:1; }}
  .card .l {{ color:var(--muted); text-transform:uppercase; font-size:12px;
    letter-spacing:1.5px; margin-top:10px; }}
  table {{ width:100%; border-collapse:collapse; font-size:14px; }}
  th,td {{ text-align:left; padding:10px 14px; border-bottom:1px solid var(--line); }}
  th {{ color:var(--muted); text-transform:uppercase; font-size:11px; letter-spacing:1px; }}
  td.num {{ text-align:right; font-variant-numeric:tabular-nums; color:var(--accent); }}
  td.res {{ color:#cfcfd4; }}
  tr:hover td {{ background:#141418; }}
</style></head><body>
  <h1>Dulces del <span>Alto</span> — leads en vivo</h1>
  <div class="sub">Demo · Hundred Agents · auto-refresh 5s · {now_iso()[11:19]}</div>
  <div class="cards">
    <div class="card"><div class="n">{contactos}</div><div class="l">Contactos únicos</div></div>
    <div class="card"><div class="n">{total_eventos}</div><div class="l">Eventos totales</div></div>
  </div>
  <table>
    <thead><tr><th>Hora</th><th>Tel</th><th>Tipo</th><th>Clasificación</th>
      <th>Resumen</th><th class="num">Total</th></tr></thead>
    <tbody>{trs or '<tr><td colspan="6" style="color:#8a8a92">Sin eventos todavía…</td></tr>'}</tbody>
  </table>
</body></html>"""
    return HTMLResponse(html)


@app.get("/")
async def root():
    return {"service": "dulces-del-alto-agent", "panel": "/leads", "webhook": "/webhook"}
