"""
Agente de WhatsApp multi-cliente (multi-tenant).

Stack: Python + FastAPI + OpenAI (chat con function calling + visión +
transcripción de audio) + WhatsApp Cloud API (Graph) + SQLite (sin ORM).

Cada cliente vive en clients/<clave>/ con:
    config.json    — phone_number_id, nombre, límites, datos del negocio
    prompt.md      — system prompt del asistente
    catalogo.json  — catálogo/menú consultable por la herramienta buscar_catalogo

El enrutado es por `phone_number_id` del webhook de Meta
(entry[].changes[].value.metadata.phone_number_id).

Servicio autónomo. No toca la estructura Node/Vercel del repo.
Corre con:  uvicorn main:app --host 0.0.0.0 --port 8000
"""

import os
import json
import base64
import sqlite3
import logging
import unicodedata
from pathlib import Path
from dataclasses import dataclass, field
from datetime import datetime, timezone, date
from zoneinfo import ZoneInfo

import httpx
from fastapi import FastAPI, Request, BackgroundTasks
from fastapi.responses import PlainTextResponse, HTMLResponse, JSONResponse

# --------------------------------------------------------------------------- #
# Config global (todo por env). Lo específico de cada cliente va en su config.json
# --------------------------------------------------------------------------- #
BASE_DIR = Path(__file__).resolve().parent
CLIENTS_DIR = BASE_DIR / "clients"

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o")
TRANSCRIBE_MODEL = os.getenv("TRANSCRIBE_MODEL", "whisper-1")

# Nombres nuevos (WHATSAPP_*) con prioridad; fallback a los antiguos (WA_*)
# para no romper .env existentes. Internamente se conservan los nombres WA_*.
WA_ACCESS_TOKEN = os.getenv("WHATSAPP_TOKEN") or os.getenv("WA_ACCESS_TOKEN") or ""
WA_VERIFY_TOKEN = os.getenv("WHATSAPP_VERIFY_TOKEN") or os.getenv("WA_VERIFY_TOKEN") or ""

# phone_number_id global: ya NO se usa para enrutar ni enviar (eso sale de cada
# config.json). Se conserva solo como fallback de envío si un cliente no lo trae.
WA_PHONE_NUMBER_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID") or os.getenv("WA_PHONE_NUMBER_ID") or ""

DB_PATH = os.getenv("DATABASE_PATH") or os.getenv("DB_PATH") or "demo.db"

# Cliente a usar cuando el webhook no trae metadata.phone_number_id.
# Si se omite y solo hay un cliente activo, se usa ese.
DEFAULT_CLIENT = os.getenv("DEFAULT_CLIENT", "")

WHATSAPP_API_VERSION = os.getenv("WHATSAPP_API_VERSION", "v20.0")
GRAPH = f"https://graph.facebook.com/{WHATSAPP_API_VERSION}"

PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "")

MAX_TOOL_ITERS = int(os.getenv("MAX_TOOL_ITERS", "6"))

# --- Voz -------------------------------------------------------------------- #
AUDIO_MAX_PER_DAY = int(os.getenv("AUDIO_MAX_PER_DAY", "5"))
AUDIO_MAX_SECONDS = int(os.getenv("AUDIO_MAX_SECONDS", "120"))
# Corte barato por tamaño antes de transcribir. Una nota de voz de WhatsApp
# (opus ~16 kbps) pesa ~2 KB/s, así que 2 min ≈ 240 KB. Dejamos holgura x4 para
# no rechazar audios legítimos grabados con otro códec; el corte fino por
# duración real se hace después con la respuesta de la transcripción.
AUDIO_MAX_BYTES = int(os.getenv("AUDIO_MAX_BYTES", str(1024 * 1024)))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("wa-agent")

app = FastAPI(title="Agente WhatsApp multi-cliente")


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def today_str() -> str:
    return date.today().isoformat()


DIAS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
         "agosto", "septiembre", "octubre", "noviembre", "diciembre"]


def _tz(nombre: str):
    try:
        return ZoneInfo(nombre)
    except Exception:  # noqa: BLE001
        log.warning("zona horaria desconocida '%s'; se usa la del servidor", nombre)
        return None


def ahora_local(client: "Client") -> str:
    """Fecha/hora corta en la zona del cliente. Ej: '28/07/2026 17:52 (CDMX)'."""
    d = datetime.now(_tz(client.zona_horaria))
    return f"{d:%d/%m/%Y %H:%M} ({client.etiqueta_zona})"


def ahora_local_largo(client: "Client") -> str:
    """Para el system prompt: día de la semana + hora, que el modelo razone horarios."""
    d = datetime.now(_tz(client.zona_horaria))
    return (
        f"{DIAS[d.weekday()]} {d.day} de {MESES[d.month - 1]} de {d.year}, "
        f"{d:%H:%M} hora local de {client.etiqueta_zona}"
    )


# --------------------------------------------------------------------------- #
# Registro de clientes
# --------------------------------------------------------------------------- #
@dataclass
class Client:
    clave: str
    nombre: str
    activo: bool
    phone_number_id: str
    human_notify_wa: str
    max_turns: int
    memoria_mensajes: int
    folio_prefix: str
    modo: str
    acento_panel: str
    mensaje_cierre: str
    human_notify_wa_alt: str = ""
    zona_horaria: str = "America/Mexico_City"
    etiqueta_zona: str = "CDMX"
    modo_demo: bool = False
    aviso_demo: str = ""
    datos: dict = field(default_factory=dict)
    prompt: str = ""
    catalogo: dict = field(default_factory=dict)

    @property
    def productos(self) -> list[dict]:
        """Catálogo aplanado (soporta la forma plana y la anidada)."""
        if not hasattr(self, "_productos"):
            object.__setattr__(self, "_productos", aplanar_catalogo(self.catalogo))
        return self._productos  # type: ignore[attr-defined]

    @property
    def datos_negocio(self) -> dict:
        """
        Datos del negocio para el system prompt. El catálogo manda (es la fuente
        que también ve la herramienta); `datos` en config.json puede sobrescribir.
        Así no hay dos versiones del horario contradiciéndose.
        """
        base = {k: self.catalogo[k] for k in CATALOGO_INFO_KEYS if k in self.catalogo}
        base.update(self.datos)
        return base

    @property
    def system_prompt(self) -> str:
        """Prompt del cliente + datos del negocio + hora local + aviso de modo demo."""
        partes = [self.prompt.strip()]
        datos = self.datos_negocio
        if datos:
            lineas = "\n".join(
                f"- {k}: {json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v}"
                for k, v in datos.items()
            )
            partes.append(
                "## DATOS DEL NEGOCIO (fuente de verdad)\n"
                f"{lineas}\n"
                'REGLA DURA: si un dato contiene "REEMPLAZAR" o "PENDIENTE", todavía no está '
                "confirmado. Nunca lo presentes como un hecho. Si el dato trae un valor "
                "provisional puedes mencionarlo, pero SIEMPRE aclarando en la misma frase que "
                "está por confirmar con el equipo. Si no trae valor, dilo y ofrece confirmarlo."
            )
        partes.append(
            f"Ahora mismo es {ahora_local_largo(self)}. "
            "Úsalo para responder si están abiertos o cerrados en este momento."
        )
        if self.modo_demo:
            partes.append(
                "## PERIODO DE PRUEBAS\n"
                "Estamos validando el asistente antes de lanzarlo. Atiendes NORMAL: "
                "tomas el pedido completo, registras con la herramienta y confirmas "
                "folio y total como siempre. NO escales un pedido solo por ser periodo "
                "de pruebas.\n"
                "Lo único que cambia: cuando confirmes un pedido registrado, cierra el "
                "mensaje con esta línea, tal cual y en su propio renglón:\n"
                f"{self.aviso_demo}\n"
                "No la repitas en mensajes que no confirmen un pedido."
            )
        return "\n\n".join(partes)


def _load_one_client(folder: Path) -> Client:
    cfg = json.loads((folder / "config.json").read_text(encoding="utf-8"))
    prompt = (folder / "prompt.md").read_text(encoding="utf-8")
    catalogo_path = folder / "catalogo.json"
    catalogo = json.loads(catalogo_path.read_text(encoding="utf-8")) if catalogo_path.exists() else {}
    clave = cfg.get("clave") or folder.name
    return Client(
        clave=clave,
        nombre=cfg.get("nombre", clave),
        activo=bool(cfg.get("activo", True)),
        phone_number_id=str(cfg.get("phone_number_id", "")),
        human_notify_wa=str(cfg.get("human_notify_wa", "")),
        human_notify_wa_alt=str(cfg.get("human_notify_wa_alt", "")),
        zona_horaria=cfg.get("zona_horaria", "America/Mexico_City"),
        etiqueta_zona=cfg.get("etiqueta_zona", "CDMX"),
        max_turns=int(cfg.get("max_turns", 14)),
        memoria_mensajes=int(cfg.get("memoria_mensajes", 24)),
        folio_prefix=cfg.get("folio_prefix", clave[:3].upper()),
        modo=cfg.get("modo", "demo"),
        modo_demo=bool(cfg.get("modo_demo", False)),
        aviso_demo=cfg.get(
            "aviso_demo",
            "⚠️ Estamos en periodo de pruebas: este pedido es de práctica y no se preparará.",
        ),
        acento_panel=cfg.get("acento_panel", "#ff4e1c"),
        mensaje_cierre=cfg.get(
            "mensaje_cierre",
            "Por hoy aquí termina esta demo. ¡Gracias por escribir!",
        ),
        datos=cfg.get("datos") or {},
        prompt=prompt,
        catalogo=catalogo,
    )


def load_clients() -> tuple[dict[str, Client], dict[str, Client]]:
    """Devuelve (por_clave, por_phone_number_id[solo activos])."""
    por_clave: dict[str, Client] = {}
    por_pnid: dict[str, Client] = {}
    if not CLIENTS_DIR.exists():
        log.error("No existe %s — no hay clientes configurados", CLIENTS_DIR)
        return por_clave, por_pnid

    for folder in sorted(p for p in CLIENTS_DIR.iterdir() if p.is_dir()):
        if not (folder / "config.json").exists():
            continue
        try:
            c = _load_one_client(folder)
        except Exception:  # noqa: BLE001
            log.exception("cliente %s: config inválida, se omite", folder.name)
            continue
        por_clave[c.clave] = c
        if not c.activo:
            log.info("cliente %s (%s) INACTIVO — no recibe tráfico", c.clave, c.nombre)
            continue
        if not c.phone_number_id:
            log.error("cliente %s activo pero sin phone_number_id — no recibirá tráfico", c.clave)
            continue
        if c.phone_number_id in por_pnid:
            # Dos clientes ACTIVOS con el mismo número: enrutar sería adivinar.
            # Fallamos al arrancar en vez de mandar mensajes al cliente equivocado.
            otro = por_pnid[c.phone_number_id]
            raise RuntimeError(
                f"phone_number_id duplicado entre clientes activos: "
                f"'{otro.clave}' y '{c.clave}' comparten {c.phone_number_id}. "
                f"Deja activo=true en solo uno de los dos."
            )
        por_pnid[c.phone_number_id] = c
    return por_clave, por_pnid


CLIENTS, CLIENTS_BY_PNID = load_clients()


def resolve_client(phone_number_id: str | None) -> Client | None:
    """
    phone_number_id del webhook -> cliente.

    Un phone_number_id PRESENTE pero desconocido NO cae al fallback: sería
    contestar en nombre del cliente equivocado. El fallback existe solo para
    payloads sin metadata (tests, herramientas de simulación).
    """
    if phone_number_id:
        return CLIENTS_BY_PNID.get(phone_number_id)
    if DEFAULT_CLIENT and DEFAULT_CLIENT in CLIENTS:
        return CLIENTS[DEFAULT_CLIENT]
    activos = [c for c in CLIENTS.values() if c.activo]
    if len(activos) == 1:
        return activos[0]
    return None


# --------------------------------------------------------------------------- #
# SQLite
# --------------------------------------------------------------------------- #
def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


LEGACY_CLIENT = os.getenv("LEGACY_CLIENT", "demo-dulces")


def _cols(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def init_db() -> None:
    conn = db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS seen (
            message_id TEXT PRIMARY KEY,
            ts         TEXT
        );
        CREATE TABLE IF NOT EXISTS messages (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            client  TEXT NOT NULL DEFAULT '',
            phone   TEXT NOT NULL,
            role    TEXT NOT NULL,
            content TEXT NOT NULL,
            ts      TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            client TEXT NOT NULL DEFAULT '',
            phone  TEXT NOT NULL,
            turns  INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (client, phone)
        );
        CREATE TABLE IF NOT EXISTS leads (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            client        TEXT NOT NULL DEFAULT '',
            ts            TEXT NOT NULL,
            phone         TEXT NOT NULL,
            tipo          TEXT NOT NULL,
            clasificacion TEXT,
            resumen       TEXT,
            total         REAL,
            folio         TEXT
        );
        CREATE TABLE IF NOT EXISTS audio_usage (
            client TEXT NOT NULL,
            phone  TEXT NOT NULL,
            dia    TEXT NOT NULL,
            n      INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (client, phone, dia)
        );
        """
    )

    # --- migración de DBs creadas antes del multi-cliente -------------------- #
    if "client" not in _cols(conn, "messages"):
        conn.execute(f"ALTER TABLE messages ADD COLUMN client TEXT NOT NULL DEFAULT '{LEGACY_CLIENT}'")
        log.info("migración: messages.client añadida (filas viejas -> %s)", LEGACY_CLIENT)
    if "client" not in _cols(conn, "leads"):
        conn.execute(f"ALTER TABLE leads ADD COLUMN client TEXT NOT NULL DEFAULT '{LEGACY_CLIENT}'")
        log.info("migración: leads.client añadida (filas viejas -> %s)", LEGACY_CLIENT)
    if "client" not in _cols(conn, "sessions"):
        # sessions tenía PRIMARY KEY(phone); hay que reconstruir la tabla.
        conn.executescript(
            f"""
            ALTER TABLE sessions RENAME TO sessions_old;
            CREATE TABLE sessions (
                client TEXT NOT NULL DEFAULT '',
                phone  TEXT NOT NULL,
                turns  INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (client, phone)
            );
            INSERT INTO sessions(client, phone, turns)
                SELECT '{LEGACY_CLIENT}', phone, turns FROM sessions_old;
            DROP TABLE sessions_old;
            """
        )
        log.info("migración: sessions reconstruida con PK(client, phone)")

    conn.executescript(
        """
        CREATE INDEX IF NOT EXISTS idx_messages_client_phone ON messages(client, phone, id);
        CREATE INDEX IF NOT EXISTS idx_leads_client ON leads(client, id);
        """
    )
    conn.commit()
    conn.close()


init_db()


# ---- memoria / sesión ------------------------------------------------------ #
def load_history(client: str, phone: str, limit: int) -> list[dict]:
    conn = db()
    rows = conn.execute(
        "SELECT role, content FROM messages WHERE client=? AND phone=? ORDER BY id DESC LIMIT ?",
        (client, phone, limit),
    ).fetchall()
    conn.close()
    return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]


def save_message(client: str, phone: str, role: str, content: str) -> None:
    conn = db()
    conn.execute(
        "INSERT INTO messages(client, phone, role, content, ts) VALUES (?,?,?,?,?)",
        (client, phone, role, content, now_iso()),
    )
    conn.commit()
    conn.close()


def bump_turn(client: str, phone: str) -> int:
    conn = db()
    conn.execute(
        "INSERT INTO sessions(client, phone, turns) VALUES (?,?,1) "
        "ON CONFLICT(client, phone) DO UPDATE SET turns = turns + 1",
        (client, phone),
    )
    conn.commit()
    turns = conn.execute(
        "SELECT turns FROM sessions WHERE client=? AND phone=?", (client, phone)
    ).fetchone()["turns"]
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


def log_lead(client: str, phone: str, tipo: str, clasificacion=None, resumen=None, total=None, folio=None) -> int:
    conn = db()
    cur = conn.execute(
        "INSERT INTO leads(client, ts, phone, tipo, clasificacion, resumen, total, folio) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (client, now_iso(), phone, tipo, clasificacion, resumen, total, folio),
    )
    conn.commit()
    lead_id = cur.lastrowid
    conn.close()
    return lead_id


def bump_audio_usage(client: str, phone: str) -> int:
    """Incrementa y devuelve cuántos audios lleva hoy este teléfono."""
    conn = db()
    conn.execute(
        "INSERT INTO audio_usage(client, phone, dia, n) VALUES (?,?,?,1) "
        "ON CONFLICT(client, phone, dia) DO UPDATE SET n = n + 1",
        (client, phone, today_str()),
    )
    conn.commit()
    n = conn.execute(
        "SELECT n FROM audio_usage WHERE client=? AND phone=? AND dia=?",
        (client, phone, today_str()),
    ).fetchone()["n"]
    conn.close()
    return n


# --------------------------------------------------------------------------- #
# Herramientas (function calling)
# --------------------------------------------------------------------------- #
def _norm(s: str) -> str:
    """Minúsculas sin acentos: 'Café' y 'cafe' deben empatar."""
    return "".join(
        c for c in unicodedata.normalize("NFD", str(s).lower())
        if unicodedata.category(c) != "Mn"
    )


def _variantes(token: str) -> list[str]:
    """Token + formas sin plural ('cafes'->'cafe', 'frappes'->'frappe')."""
    v = [token]
    if len(token) > 4 and token.endswith("es"):
        v.append(token[:-2])
    if len(token) > 3 and token.endswith("s"):
        v.append(token[:-1])
    return v


MAX_CATALOGO_RESULTS = int(os.getenv("MAX_CATALOGO_RESULTS", "24"))

# Claves de nivel superior del catálogo que describen al negocio (no productos).
CATALOGO_INFO_KEYS = (
    "direccion", "ubicacion", "telefono", "horarios", "horario_humano",
    "domicilio", "pagos", "envios", "notas_generales", "info",
    "estado_menu", "notas_precios",
)


def aplanar_catalogo(cat: dict) -> list[dict]:
    """
    Normaliza a una lista plana de productos. Acepta las dos formas:

      plana   : {"productos": [ {...} ]}
      anidada : {"categorias": {<categoria>: {<subcategoria>: {
                    "descripcion": ..., "extras": {...}, "items": [ {...} ]}}}}

    La descripción y los extras de la subcategoría se heredan a cada item, para
    que una sola coincidencia le dé al modelo todo lo que necesita cotizar.
    """
    if cat.get("productos"):
        return [dict(p) for p in cat["productos"]]

    out: list[dict] = []
    for categoria, subs in (cat.get("categorias") or {}).items():
        if not isinstance(subs, dict):
            continue
        for sub, body in subs.items():
            if not isinstance(body, dict):
                continue
            desc_grupo = body.get("descripcion")
            extras = body.get("extras")
            sinonimos = body.get("sinonimos")
            for item in body.get("items") or []:
                if not isinstance(item, dict):
                    continue
                p = dict(item)
                p["categoria"] = categoria.replace("_", " ")
                p["subcategoria"] = sub.replace("_", " ")
                if sinonimos:
                    # Solo para búsqueda: la subcategoría puede llamarse "coffee"
                    # y el cliente escribir "¿qué cafés tienen?".
                    p["_sinonimos"] = sinonimos
                if desc_grupo:
                    # No pisamos la descripción propia del item.
                    p["descripcion_grupo"] = desc_grupo
                if extras:
                    p["extras"] = extras
                out.append(p)
    return out


def tool_buscar_catalogo(client: Client, consulta: str) -> dict:
    cat = client.catalogo or {}
    productos = client.productos
    tokens = [_norm(t) for t in (consulta or "").split() if t.strip()]

    def hay(p: dict) -> str:
        campos = [
            str(p.get(k, ""))
            for k in ("nombre", "categoria", "subcategoria", "sku",
                      "descripcion", "descripcion_grupo")
        ]
        extras = p.get("extras")
        if isinstance(extras, dict):
            campos += list(extras.keys())
        elif isinstance(extras, list):
            campos += [str(x) for x in extras]
        campos += [
            str(x) for x in
            (p.get("opciones") or []) + (p.get("tamanos") or []) + (p.get("_sinonimos") or [])
        ]
        return _norm(" ".join(campos))

    def coincide(tok: str, texto: str) -> bool:
        return any(v in texto for v in _variantes(tok))

    if not tokens:
        matches = list(productos)
    else:
        matches = [p for p in productos if all(coincide(t, hay(p)) for t in tokens)]
        # fallback: si el AND por tokens no encontró nada, prueba OR laxo
        if not matches:
            matches = [p for p in productos if any(coincide(t, hay(p)) for t in tokens)]

        # Relevancia: lo que empata en el NOMBRE va primero. Sin esto, "pannini
        # arrachera" puede devolver antes un platillo que solo menciona
        # "arrachera" en su descripción, y el modelo cotiza el equivocado.
        def rango(p: dict) -> tuple[int, int]:
            nombre = _norm(p.get("nombre", ""))
            en_nombre = sum(1 for t in tokens if coincide(t, nombre))
            return (-en_nombre, 0 if en_nombre == len(tokens) else 1)

        matches.sort(key=rango)

    total = len(matches)
    recortado = total > MAX_CATALOGO_RESULTS
    out = {
        "negocio": cat.get("negocio", client.nombre),
        "moneda": cat.get("moneda", "MXN"),
        # Los campos con "_" son solo de búsqueda: no se le mandan al modelo.
        "coincidencias": [
            {k: v for k, v in p.items() if not k.startswith("_")}
            for p in matches[:MAX_CATALOGO_RESULTS]
        ],
        "total_coincidencias": total,
        "productos_en_carta": len(productos),
    }
    if recortado:
        out["aviso"] = (
            f"Se muestran {MAX_CATALOGO_RESULTS} de {total} coincidencias. "
            "Afina la búsqueda si necesitas el resto."
        )
    for k in CATALOGO_INFO_KEYS:
        if k in cat:
            out[k] = cat[k]
    return out


def tool_registrar_pedido(client: Client, phone: str, clasificacion: str, resumen: str, total=None) -> dict:
    valid = {"pedido", "cotizacion", "duda", "lead_caliente"}
    if clasificacion not in valid:
        clasificacion = "duda"
    try:
        total_val = float(total) if total is not None else None
    except (TypeError, ValueError):
        total_val = None
    lead_id = log_lead(client.clave, phone, clasificacion, clasificacion, resumen, total_val)
    folio = f"{client.folio_prefix}-{lead_id:04d}"
    conn = db()
    conn.execute("UPDATE leads SET folio=? WHERE id=?", (folio, lead_id))
    conn.commit()
    conn.close()
    return {"folio": folio, "clasificacion": clasificacion, "total": total_val}


def aviso_escalamiento(client: Client, phone: str, motivo: str) -> str:
    """🔔 <negocio> — <fecha/hora CDMX> — escalado de <teléfono>: <motivo>"""
    return (
        f"🔔 {client.nombre} — {ahora_local(client)} — "
        f"escalado de +{phone}: {motivo}"
    )


async def tool_escalar_humano(client: Client, phone: str, motivo: str) -> dict:
    log_lead(client.clave, phone, "escalado", "lead_caliente", motivo, None, None)
    aviso = aviso_escalamiento(client, phone, motivo)
    entregado = False
    if client.human_notify_wa:
        entregado = await send_whatsapp_text(client, client.human_notify_wa, aviso)
        if not entregado and client.human_notify_wa_alt:
            log.warning("escalado: reintentando aviso con human_notify_wa_alt")
            entregado = await send_whatsapp_text(client, client.human_notify_wa_alt, aviso)
    if not entregado:
        log.error("escalado de +%s NO se pudo notificar al equipo (%s)", phone, client.clave)
    return {"escalado": True, "notificado_a_humano": entregado, "motivo": motivo}


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "buscar_catalogo",
            "description": (
                "Busca en el catálogo/menú del negocio por nombre, categoría o SKU. "
                "DEBES llamarla antes de mencionar cualquier producto, precio o disponibilidad. "
                "Nunca respondas de memoria."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "consulta": {"type": "string", "description": "Texto a buscar (producto, categoría o sku). Vacío = todo."}
                },
                "required": ["consulta"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "registrar_pedido",
            "description": "Registra un pedido/cotización/lead y devuelve un folio. Úsala solo cuando ya tengas el pedido completo.",
            "parameters": {
                "type": "object",
                "properties": {
                    "clasificacion": {
                        "type": "string",
                        "enum": ["pedido", "cotizacion", "duda", "lead_caliente"],
                    },
                    "resumen": {
                        "type": "string",
                        "description": "Resumen del pedido: productos, cantidades, nombre de quien recoge y hora de recolección si aplica.",
                    },
                    "total": {"type": "number", "description": "Total estimado en MXN si se conoce."},
                },
                "required": ["clasificacion", "resumen"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "escalar_humano",
            "description": "Escala a una persona del equipo y la notifica por WhatsApp.",
            "parameters": {
                "type": "object",
                "properties": {"motivo": {"type": "string", "description": "Por qué se escala."}},
                "required": ["motivo"],
            },
        },
    },
]


async def dispatch_tool(client: Client, phone: str, name: str, args: dict) -> dict:
    try:
        if name == "buscar_catalogo":
            return tool_buscar_catalogo(client, args.get("consulta", ""))
        if name == "registrar_pedido":
            return tool_registrar_pedido(
                client, phone, args.get("clasificacion", "duda"), args.get("resumen", ""), args.get("total")
            )
        if name == "escalar_humano":
            return await tool_escalar_humano(client, phone, args.get("motivo", ""))
        return {"error": f"herramienta desconocida: {name}"}
    except Exception as e:  # noqa: BLE001
        log.exception("tool %s falló", name)
        return {"error": str(e)}


# --------------------------------------------------------------------------- #
# OpenAI (REST directo vía httpx — sin SDK extra)
# --------------------------------------------------------------------------- #
async def openai_chat(messages: list[dict]) -> dict:
    async with httpx.AsyncClient(timeout=60) as http:
        r = await http.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            json={"model": OPENAI_MODEL, "messages": messages, "tools": TOOLS, "temperature": 0.4},
        )
        r.raise_for_status()
        return r.json()


async def openai_transcribe(audio: bytes, mime: str) -> dict:
    """Transcribe audio con OpenAI. Devuelve el JSON crudo de la API."""
    ext = {
        "audio/ogg": "ogg", "audio/opus": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a",
        "audio/mp4a-latm": "m4a", "audio/aac": "m4a", "audio/amr": "amr", "audio/wav": "wav",
        "audio/x-wav": "wav", "audio/webm": "webm",
    }.get(mime.split(";")[0].strip().lower(), "ogg")

    data = {"model": TRANSCRIBE_MODEL, "language": "es"}
    # whisper-1 soporta verbose_json (trae duración real). Los modelos
    # gpt-4o-*-transcribe solo soportan json/text.
    if TRANSCRIBE_MODEL == "whisper-1":
        data["response_format"] = "verbose_json"

    async with httpx.AsyncClient(timeout=120) as http:
        r = await http.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            data=data,
            files={"file": (f"audio.{ext}", audio, mime.split(";")[0].strip() or "audio/ogg")},
        )
        r.raise_for_status()
        return r.json()


async def run_agent(client: Client, phone: str, user_content, memory_text: str) -> str:
    """
    user_content: string (texto) o lista de partes (visión).
    memory_text : representación en texto para persistir en memoria.
    """
    history = load_history(client.clave, phone, client.memoria_mensajes)
    messages = [{"role": "system", "content": client.system_prompt}] + history
    messages.append({"role": "user", "content": user_content})
    save_message(client.clave, phone, "user", memory_text)

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
            result = await dispatch_tool(client, phone, fn, args)
            messages.append(
                {"role": "tool", "tool_call_id": tc["id"], "content": json.dumps(result, ensure_ascii=False)}
            )
    else:
        final_text = final_text or "Permíteme confirmar ese dato y te respondo enseguida. 🙌"

    if not final_text:
        final_text = "¿Me repites por favor? No te entendí bien."
    save_message(client.clave, phone, "assistant", final_text)
    return final_text


# --------------------------------------------------------------------------- #
# WhatsApp Cloud API
# --------------------------------------------------------------------------- #
async def send_whatsapp_text(client: Client, to: str, body: str) -> bool:
    pnid = client.phone_number_id or WA_PHONE_NUMBER_ID
    if not (WA_ACCESS_TOKEN and pnid):
        log.warning("WA no configurado; no se envía a %s: %s", to, body[:80])
        return False
    async with httpx.AsyncClient(timeout=30) as http:
        r = await http.post(
            f"{GRAPH}/{pnid}/messages",
            headers={"Authorization": f"Bearer {WA_ACCESS_TOKEN}"},
            json={
                "messaging_product": "whatsapp",
                "recipient_type": "individual",
                "to": to,
                "type": "text",
                "text": {"body": body[:4096]},
            },
        )
        if r.status_code >= 400:
            log.error("WA send falló %s -> %s: %s", to, r.status_code, r.text)
            return False
    return True


async def download_media(media_id: str) -> tuple[bytes, str, int]:
    """Descarga media de Graph. Devuelve (bytes, mime, file_size_declarado)."""
    async with httpx.AsyncClient(timeout=90) as http:
        meta = await http.get(
            f"{GRAPH}/{media_id}",
            headers={"Authorization": f"Bearer {WA_ACCESS_TOKEN}"},
        )
        meta.raise_for_status()
        info = meta.json()
        url = info["url"]
        mime = info.get("mime_type", "application/octet-stream")
        size = int(info.get("file_size") or 0)
        media = await http.get(url, headers={"Authorization": f"Bearer {WA_ACCESS_TOKEN}"})
        media.raise_for_status()
    return media.content, mime, size


async def download_media_b64(media_id: str) -> tuple[str, str]:
    """Igual que download_media pero como data URI (para visión)."""
    content, mime, _ = await download_media(media_id)
    if mime == "application/octet-stream":
        mime = "image/jpeg"
    return f"data:{mime};base64,{base64.b64encode(content).decode()}", mime


# --------------------------------------------------------------------------- #
# Voz: audio entrante -> transcripción -> agente
# --------------------------------------------------------------------------- #
PEDIR_TEXTO_LARGO = (
    "Ese audio está un poco largo para mí 🙈 ¿Me lo mandas por escrito, "
    "o en una nota de voz más cortita (menos de 2 minutos)?"
)
PEDIR_TEXTO_FALLO = (
    "No logré escuchar bien tu nota de voz. ¿Me escribes tu mensaje por texto, por favor?"
)
PEDIR_TEXTO_LIMITE = (
    "Por hoy ya no puedo procesar más notas de voz. ¿Me escribes tu mensaje por texto? "
    "Con gusto te sigo atendiendo por ahí."
)


async def transcribir_audio(client: Client, phone: str, media_id: str) -> tuple[str | None, str]:
    """
    Devuelve (texto_transcrito, motivo). Si texto es None, `motivo` es el mensaje
    que hay que enviarle al cliente.
    """
    usados = bump_audio_usage(client.clave, phone)
    if usados > AUDIO_MAX_PER_DAY:
        log.info("audio: %s/%s superó el límite diario (%s)", client.clave, phone, AUDIO_MAX_PER_DAY)
        return None, PEDIR_TEXTO_LIMITE

    try:
        content, mime, size = await download_media(media_id)
    except Exception:  # noqa: BLE001
        log.exception("audio: fallo descargando media %s", media_id)
        return None, PEDIR_TEXTO_FALLO

    peso = size or len(content)
    if peso > AUDIO_MAX_BYTES:
        log.info("audio: %s bytes supera AUDIO_MAX_BYTES=%s", peso, AUDIO_MAX_BYTES)
        return None, PEDIR_TEXTO_LARGO

    try:
        data = await openai_transcribe(content, mime)
    except Exception:  # noqa: BLE001
        log.exception("audio: fallo transcribiendo con %s", TRANSCRIBE_MODEL)
        return None, PEDIR_TEXTO_FALLO

    dur = data.get("duration")
    if dur is not None and float(dur) > AUDIO_MAX_SECONDS:
        log.info("audio: duración %.1fs supera AUDIO_MAX_SECONDS=%s", float(dur), AUDIO_MAX_SECONDS)
        return None, PEDIR_TEXTO_LARGO

    texto = (data.get("text") or "").strip()
    if not texto:
        return None, PEDIR_TEXTO_FALLO
    return texto, ""


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@app.get("/webhook")
async def verify(request: Request):
    params = request.query_params
    if params.get("hub.mode") == "subscribe" and params.get("hub.verify_token") == WA_VERIFY_TOKEN:
        return PlainTextResponse(params.get("hub.challenge", ""))
    return PlainTextResponse("forbidden", status_code=403)


@app.post("/webhook")
async def incoming(request: Request, background_tasks: BackgroundTasks):
    # CRÍTICO: devolver 200 a Meta al instante. OpenAI+envío tardan segundos;
    # si Meta no ve 200 en ~5s reintenta y puede desactivar el webhook.
    # Parseo rápido + enrutado aquí; el trabajo pesado va a background.
    try:
        payload = await request.json()
        for entry in payload.get("entry", []):
            for change in entry.get("changes", []):
                value = change.get("value", {})
                pnid = (value.get("metadata") or {}).get("phone_number_id")

                for st in value.get("statuses", []):
                    log.info("status wamid=%s -> %s", st.get("id", "?"), st.get("status", "?"))

                mensajes = value.get("messages", [])
                if not mensajes:
                    continue

                client = resolve_client(pnid)
                if client is None:
                    log.error("webhook sin cliente para phone_number_id=%s — se ignoran %d mensajes", pnid, len(mensajes))
                    continue

                # Dedup síncrono ANTES de encolar: un reintento de Meta no debe
                # encolar el mismo mensaje dos veces.
                for m in mensajes:
                    mid = m.get("id", "")
                    if mid and already_seen(mid):
                        log.info("dedup: mensaje %s ya visto, se ignora", mid)
                        continue
                    background_tasks.add_task(handle_message, client, m)
    except Exception:  # noqa: BLE001
        log.exception("error procesando webhook")
    return JSONResponse({"status": "ok"})


async def handle_message(client: Client, m: dict) -> None:
    # Nota: dedup ya se hizo en incoming() antes de encolar esta tarea.
    phone = m.get("from", "")
    if not phone:
        return

    mtype = m.get("type", "unknown")

    turns = bump_turn(client.clave, phone)
    if turns > client.max_turns:
        log_lead(client.clave, phone, "mensaje", None, f"[límite {client.max_turns} turnos alcanzado]", None)
        await send_whatsapp_text(client, phone, client.mensaje_cierre)
        return

    try:
        if mtype == "text":
            body = m["text"]["body"]
            log_lead(client.clave, phone, "mensaje", None, body[:200], None)
            reply = await run_agent(client, phone, body, body)
            await send_whatsapp_text(client, phone, reply)

        elif mtype in ("audio", "voice"):
            log_lead(client.clave, phone, "mensaje", None, "[audio]", None)
            media_id = (m.get(mtype) or {}).get("id", "")
            texto, aviso = await transcribir_audio(client, phone, media_id)
            if texto is None:
                await send_whatsapp_text(client, phone, aviso)
                return
            log.info("audio transcrito (%s/%s): %s", client.clave, phone, texto[:120])
            log_lead(client.clave, phone, "mensaje", None, f"[audio] {texto}"[:200], None)
            marcado = f"[Audio transcrito]: {texto}"
            reply = await run_agent(client, phone, marcado, marcado)
            await send_whatsapp_text(client, phone, reply)

        elif mtype == "image":
            caption = m["image"].get("caption", "")
            log_lead(client.clave, phone, "mensaje", None, f"[imagen] {caption}".strip()[:200], None)
            data_uri, _ = await download_media_b64(m["image"]["id"])
            parts = [
                {"type": "text", "text": caption or "Identifica lo que aparece en la foto y relaciónalo con el catálogo."},
                {"type": "image_url", "image_url": {"url": data_uri}},
            ]
            reply = await run_agent(client, phone, parts, f"[imagen] {caption}".strip())
            await send_whatsapp_text(client, phone, reply)

        else:
            # sticker, ubicación, contacto, documento, etc.
            log_lead(client.clave, phone, "mensaje", None, f"[{mtype}]", None)
            await send_whatsapp_text(
                client,
                phone,
                "Por ahora puedo leer *texto*, *notas de voz* y *fotos*. "
                "¿Me escribes tu consulta? 🙏",
            )
    except Exception:  # noqa: BLE001
        log.exception("error atendiendo mensaje de %s (%s)", phone, client.clave)
        await send_whatsapp_text(client, phone, "Tuvimos un detalle técnico. ¿Me repites tu mensaje?")


# --------------------------------------------------------------------------- #
# Panel para proyector
# --------------------------------------------------------------------------- #
@app.get("/leads", response_class=HTMLResponse)
async def panel(client: str = ""):
    sel = CLIENTS.get(client)
    acento = sel.acento_panel if sel else "#ff4e1c"
    titulo = sel.nombre if sel else "Todos los clientes"

    conn = db()
    if client:
        total_eventos = conn.execute("SELECT COUNT(*) c FROM leads WHERE client=?", (client,)).fetchone()["c"]
        contactos = conn.execute("SELECT COUNT(DISTINCT phone) c FROM leads WHERE client=?", (client,)).fetchone()["c"]
        rows = conn.execute("SELECT * FROM leads WHERE client=? ORDER BY id DESC LIMIT 200", (client,)).fetchall()
    else:
        total_eventos = conn.execute("SELECT COUNT(*) c FROM leads").fetchone()["c"]
        contactos = conn.execute("SELECT COUNT(DISTINCT phone) c FROM leads").fetchone()["c"]
        rows = conn.execute("SELECT * FROM leads ORDER BY id DESC LIMIT 200").fetchall()
    conn.close()

    def td(x):
        return "" if x is None else str(x)

    def esc(x):
        return td(x).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    trs = ""
    for r in rows:
        hora = td(r["ts"])[11:19]
        tel4 = td(r["phone"])[-4:]
        total = f'${r["total"]:,.2f}' if r["total"] is not None else ""
        trs += (
            f"<tr><td>{hora}</td><td>{esc(r['client'])}</td><td>…{tel4}</td><td>{esc(r['tipo'])}</td>"
            f"<td>{esc(r['clasificacion'])}</td><td>{esc(r['folio'])}</td>"
            f"<td class='res'>{esc(td(r['resumen'])[:80])}</td>"
            f"<td class='num'>{total}</td></tr>"
        )

    tabs = f'<a href="/leads" class="{"on" if not client else ""}">Todos</a>'
    for c in CLIENTS.values():
        estado = "" if c.activo else " ·inactivo"
        tabs += f'<a href="/leads?client={c.clave}" class="{"on" if client == c.clave else ""}">{esc(c.nombre)}{estado}</a>'

    html = f"""<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta http-equiv="refresh" content="5">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(titulo)} — Leads en vivo</title>
<style>
  :root {{ --bg:#0b0b0d; --accent:{acento}; --fg:#f2f2f4; --muted:#8a8a92; --line:#1e1e22; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--fg);
    font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; padding:32px; }}
  h1 {{ margin:0 0 4px; font-size:20px; letter-spacing:.5px; }}
  h1 span {{ color:var(--accent); }}
  .sub {{ color:var(--muted); margin-bottom:20px; font-size:13px; }}
  .tabs {{ display:flex; gap:8px; flex-wrap:wrap; margin-bottom:28px; }}
  .tabs a {{ color:var(--muted); text-decoration:none; border:1px solid var(--line);
    padding:6px 14px; border-radius:999px; font-size:13px; }}
  .tabs a.on {{ color:#0b0b0d; background:var(--accent); border-color:var(--accent); font-weight:600; }}
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
  <h1>{esc(titulo)} — <span>leads en vivo</span></h1>
  <div class="sub">Hundred Agents · auto-refresh 5s · {now_iso()[11:19]}</div>
  <div class="tabs">{tabs}</div>
  <div class="cards">
    <div class="card"><div class="n">{contactos}</div><div class="l">Contactos únicos</div></div>
    <div class="card"><div class="n">{total_eventos}</div><div class="l">Eventos totales</div></div>
  </div>
  <table>
    <thead><tr><th>Hora</th><th>Cliente</th><th>Tel</th><th>Tipo</th><th>Clasificación</th>
      <th>Folio</th><th>Resumen</th><th class="num">Total</th></tr></thead>
    <tbody>{trs or '<tr><td colspan="8" style="color:#8a8a92">Sin eventos todavía…</td></tr>'}</tbody>
  </table>
</body></html>"""
    return HTMLResponse(html)


@app.get("/health")
async def health():
    db_ok = False
    leads = pedidos = escalados = 0
    try:
        conn = db()
        conn.execute("SELECT 1")
        leads = conn.execute("SELECT COUNT(*) c FROM leads").fetchone()["c"]
        pedidos = conn.execute(
            "SELECT COUNT(*) c FROM leads WHERE tipo IN ('pedido','cotizacion')"
        ).fetchone()["c"]
        escalados = conn.execute("SELECT COUNT(*) c FROM leads WHERE tipo='escalado'").fetchone()["c"]
        conn.close()
        db_ok = True
    except Exception:  # noqa: BLE001
        log.exception("healthcheck DB falló")

    config = {
        "openai_api_key": bool(OPENAI_API_KEY),
        "whatsapp_token": bool(WA_ACCESS_TOKEN),
        "whatsapp_verify_token": bool(WA_VERIFY_TOKEN),
    }
    clientes = [
        {
            "clave": c.clave,
            "nombre": c.nombre,
            "activo": c.activo,
            "phone_number_id": c.phone_number_id,
            "productos_catalogo": len(c.catalogo.get("productos", [])),
            "human_notify_wa": bool(c.human_notify_wa),
            "max_turns": c.max_turns,
            "memoria_mensajes": c.memoria_mensajes,
        }
        for c in CLIENTS.values()
    ]
    activos = [c for c in clientes if c["activo"]]
    ready = db_ok and all(config.values()) and bool(activos)
    return {
        "status": "ok" if ready else "degraded",
        "app": "up",
        "database": "ok" if db_ok else "error",
        "graph_api_version": WHATSAPP_API_VERSION,
        "public_base_url": PUBLIC_BASE_URL or None,
        "config_present": config,
        "modelos": {"chat": OPENAI_MODEL, "transcripcion": TRANSCRIBE_MODEL},
        "voz": {"max_por_dia": AUDIO_MAX_PER_DAY, "max_segundos": AUDIO_MAX_SECONDS},
        "clientes": clientes,
        "counters": {"leads": leads, "pedidos": pedidos, "escalados": escalados},
    }


@app.get("/")
async def root():
    return {
        "service": "whatsapp-agent-multicliente",
        "clientes_activos": [c.clave for c in CLIENTS.values() if c.activo],
        "panel": "/leads",
        "webhook": "/webhook",
        "health": "/health",
        "public_base_url": PUBLIC_BASE_URL or None,
    }
