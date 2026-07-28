"""
Pruebas REALES de Sanmi Café contra OpenAI (chat + transcripción), con webhooks
simulados y sin enviar mensajes al cliente por Meta.

Qué es real:  el modelo, las tools, la transcripción del audio, la SQLite y el panel.
Qué se simula: el POST de Meta al webhook, la descarga de media de Graph y el
               envío de la respuesta al cliente (se captura, no se manda).

Aviso de red: con --notify-real SÍ se envía un WhatsApp de verdad al número de
escalamiento configurado en clients/sanmi/config.json. Sin esa bandera no sale
ningún mensaje por Meta.

Uso:
    python test_sanmi_real.py                # todo capturado, nada sale a Meta
    python test_sanmi_real.py --notify-real  # además intenta el aviso real de escalamiento
"""
import os
import sys


import tempfile
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
NOTIFY_REAL = "--notify-real" in sys.argv


def load_env() -> None:
    env = BASE_DIR / ".env"
    if not env.exists():
        sys.exit("Falta .env")
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ[k.strip()] = v.strip()


load_env()
if not os.getenv("OPENAI_API_KEY"):
    sys.exit("Falta OPENAI_API_KEY en .env")

# DB temporal aislada ANTES de importar main (no tocamos demo.db)
os.environ["DATABASE_PATH"] = os.path.join(tempfile.mkdtemp(), "sanmi_real.db")

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

SANMI = main.CLIENTS["sanmi"]
PNID = SANMI.phone_number_id

SENT: list[tuple[str, str, str]] = []   # (clave_cliente, destino, cuerpo)
TOOLS_USED: list[tuple[str, dict]] = []  # (nombre_tool, args)

_real_send = main.send_whatsapp_text
_real_dispatch = main.dispatch_tool


async def capture_send(client, to, body):
    SENT.append((client.clave, to, body))
    # El aviso de escalamiento va al equipo, no al cliente: ahí sí probamos Meta.
    if NOTIFY_REAL and to in (client.human_notify_wa, "5213471053350"):
        ok = await _real_send(client, to, body)
        print(f"   ↪ envío REAL a Meta hacia +{to}: {'ENTREGADO' if ok else 'RECHAZADO'}")
        return ok
    return True


async def spy_dispatch(client, phone, name, args):
    TOOLS_USED.append((name, args))
    return await _real_dispatch(client, phone, name, args)


AUDIO_CACHE: dict[str, bytes] = {}


async def fake_download(media_id):
    """Simula Graph: devuelve el fixture de audio que corresponde al media_id."""
    data = AUDIO_CACHE[media_id]
    return data, "audio/ogg", len(data)


main.send_whatsapp_text = capture_send
main.dispatch_tool = spy_dispatch
main.download_media = fake_download

client = TestClient(main.app)
_mid = {"n": 0}


def webhook(msg: dict, pnid: str = PNID) -> dict:
    value = {
        "messaging_product": "whatsapp",
        "metadata": {"display_phone_number": "15551506096", "phone_number_id": pnid},
        "messages": [msg],
    }
    return {
        "object": "whatsapp_business_account",
        "entry": [{"changes": [{"value": value}]}],
    }


def enviar_texto(phone: str, texto: str, pnid: str = PNID) -> str:
    _mid["n"] += 1
    antes = len(SENT)
    print(f"\n  👤 +{phone}: {texto}")
    r = client.post("/webhook", json=webhook(
        {"id": f"wamid.REAL{_mid['n']}", "from": phone, "type": "text", "text": {"body": texto}}, pnid))
    assert r.status_code == 200, r.text
    if len(SENT) == antes:
        print("  🤖 (sin respuesta — el webhook no enrutó a ningún cliente)")
        return ""
    reply = SENT[-1][2]
    print(f"  🤖 {SENT[-1][0]}: {reply}")
    return reply


def enviar_audio(phone: str, fixture: str, pnid: str = PNID) -> str:
    _mid["n"] += 1
    media_id = f"media-{_mid['n']}"
    AUDIO_CACHE[media_id] = (BASE_DIR / "fixtures" / fixture).read_bytes()
    antes = len(SENT)
    print(f"\n  👤 +{phone}: 🎙️ nota de voz ({fixture}, {len(AUDIO_CACHE[media_id]):,} bytes)")
    r = client.post("/webhook", json=webhook(
        {"id": f"wamid.REAL{_mid['n']}", "from": phone, "type": "audio",
         "audio": {"id": media_id, "mime_type": "audio/ogg; codecs=opus", "voice": True}}, pnid))
    assert r.status_code == 200, r.text
    if len(SENT) == antes:
        print("  🤖 (sin respuesta)")
        return ""
    conn = main.db()
    row = conn.execute(
        "SELECT content FROM messages WHERE client='sanmi' AND phone=? AND role='user' ORDER BY id DESC LIMIT 1",
        (phone,)).fetchone()
    conn.close()
    print(f"  📝 transcripción → {row['content'] if row else '(no hubo)'}")
    reply = SENT[-1][2]
    print(f"  🤖 {SENT[-1][0]}: {reply}")
    return reply


def titulo(t: str) -> None:
    print("\n" + "=" * 74)
    print(t)
    print("=" * 74)


def main_flow() -> None:
    print(f"Modelo chat: {main.OPENAI_MODEL} · transcripción: {main.TRANSCRIBE_MODEL}")
    print(f"Cliente activo para pnid {PNID}: {main.resolve_client(PNID).nombre}")
    print(f"Envío real de escalamiento a Meta: {'SÍ (--notify-real)' if NOTIFY_REAL else 'no (capturado)'}")

    # --- a) identidad ------------------------------------------------------- #
    titulo("a) El número demo responde como Sanmi Café (no como Dulces del Alto)")
    r = enviar_texto("5213331110001", "hola, buenas tardes ¿con quién tengo el gusto?")
    assert r, "no hubo respuesta"
    bajo = r.lower()
    assert "dulce" not in bajo and "cajeta" not in bajo, "¡respondió como el cliente viejo!"

    enviar_texto("5213331110001", "¿eres un bot?")

    # --- b) horarios y catálogo --------------------------------------------- #
    titulo("b) Horarios y menú vía catálogo")
    TOOLS_USED.clear()
    enviar_texto("5213331110002", "¿a qué hora abren?")
    enviar_texto("5213331110002", "¿qué cafés tienen?")
    usadas = [t for t, _ in TOOLS_USED]
    print(f"\n  🔧 tools llamadas: {usadas}")
    assert "buscar_catalogo" in usadas, "no consultó el catálogo para hablar del menú"

    # --- c) pedido para recoger --------------------------------------------- #
    titulo("c) Pedido para recoger completo → folio")
    TOOLS_USED.clear()
    ped = "5213331110003"
    enviar_texto(ped, "buenos días, quiero hacer un pedido para recoger")
    enviar_texto(ped, "dos capuchinos grandes y una orden de chilaquiles verdes")
    enviar_texto(ped, "va a nombre de Ramiro y paso por él a las 9:15 de la mañana")
    usadas = [t for t, _ in TOOLS_USED]
    print(f"\n  🔧 tools llamadas: {usadas}")

    conn = main.db()
    pedidos = conn.execute(
        "SELECT folio, clasificacion, resumen FROM leads WHERE client='sanmi' AND folio IS NOT NULL ORDER BY id"
    ).fetchall()
    conn.close()
    print("\n  📋 folios registrados:")
    for p in pedidos:
        print(f"     {p['folio']}  [{p['clasificacion']}]  {p['resumen']}")
    assert pedidos, "no se registró ningún pedido con folio"

    r = client.get("/leads", params={"client": "sanmi"})
    assert r.status_code == 200
    visibles = [p["folio"] for p in pedidos if p["folio"] in r.text]
    print(f"  🖥️  /leads?client=sanmi muestra: {visibles}")
    assert visibles, "el folio no aparece en el panel"

    # --- d) escalamiento ----------------------------------------------------- #
    titulo("d) Facturación → escalar_humano")
    TOOLS_USED.clear()
    enviar_texto("5213331110004", "quiero factura de mi consumo de ayer")
    usadas = [t for t, _ in TOOLS_USED]
    print(f"\n  🔧 tools llamadas: {usadas}")
    for t, a in TOOLS_USED:
        if t == "escalar_humano":
            print(f"  📨 motivo: {a.get('motivo')}")
    avisos = [s for s in SENT if s[1] == SANMI.human_notify_wa]
    if avisos:
        print(f"  📲 aviso al equipo (+{SANMI.human_notify_wa}):")
        print("     " + avisos[-1][2].replace("\n", "\n     "))
    assert "escalar_humano" in usadas, "no escaló facturación a un humano"

    # --- d2) intento de pedido real en modo demo ----------------------------- #
    titulo("d2) Intento de pedido REAL con dirección/pago en modo demo")
    TOOLS_USED.clear()
    enviar_texto("5213331110005",
                 "quiero que me lo manden a mi casa en Calle Hidalgo 25, colonia Centro, "
                 "y les paso los datos de mi tarjeta para pagar ahorita")
    print(f"\n  🔧 tools llamadas: {[t for t, _ in TOOLS_USED]}")

    # --- e) audio ------------------------------------------------------------ #
    titulo("e) Nota de voz → transcripción → respuesta")
    TOOLS_USED.clear()
    enviar_audio("5213331110006", "sanmi_pregunta.ogg")
    print(f"\n  🔧 tools llamadas: {[t for t, _ in TOOLS_USED]}")
    enviar_audio("5213331110007", "sanmi_pedido.ogg")

    # --- f) aislamiento del cliente inactivo --------------------------------- #
    titulo("f) Aislamiento: ningún evento quedó bajo demo-dulces")
    conn = main.db()
    por_cliente = conn.execute("SELECT client, COUNT(*) c FROM leads GROUP BY client").fetchall()
    audios = conn.execute("SELECT phone, n FROM audio_usage WHERE client='sanmi'").fetchall()
    conn.close()
    for row in por_cliente:
        print(f"  {row['client']}: {row['c']} eventos")
    print(f"  audios usados hoy: {[(a['phone'][-4:], a['n']) for a in audios]}")
    assert all(row["client"] == "sanmi" for row in por_cliente), "se escribieron eventos con otro cliente"

    print("\n" + "=" * 74)
    print("✅ Todas las pruebas de Sanmi Café pasaron.")
    print("=" * 74)


if __name__ == "__main__":
    main_flow()
