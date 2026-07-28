"""
Batería end-to-end de Sanmi Café contra OpenAI real, con webhooks simulados.

Qué es real:  el modelo, las tools, la transcripción del audio, la SQLite, el
              panel y —salvo que pases --sin-notify— el WhatsApp de escalamiento
              que sale al equipo por Meta.
Qué se simula: el POST de Meta al webhook, la descarga de media de Graph y el
              envío de la respuesta al cliente (se captura, no se manda).

Uso:
    python test_sanmi_real.py               # escalados SÍ salen por Meta
    python test_sanmi_real.py --sin-notify  # nada sale por Meta
"""
import os
import sys
import tempfile
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
NOTIFY_REAL = "--sin-notify" not in sys.argv


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

SENT: list[tuple[str, str, str]] = []    # (clave_cliente, destino, cuerpo)
TOOLS_USED: list[tuple[str, dict]] = []  # (nombre_tool, args)
NOTIFICADOS: list[tuple[str, bool]] = [] # (cuerpo, entregado_por_meta)

_real_send = main.send_whatsapp_text
_real_dispatch = main.dispatch_tool


async def capture_send(client, to, body):
    """Al cliente se le captura la respuesta; el aviso al equipo SÍ sale por Meta."""
    SENT.append((client.clave, to, body))
    es_aviso = to in (client.human_notify_wa, client.human_notify_wa_alt)
    if es_aviso and NOTIFY_REAL:
        ok = await _real_send(client, to, body)
        NOTIFICADOS.append((body, ok))
        print(f"   📲 aviso REAL a +{to}: {'ENTREGADO (200)' if ok else 'RECHAZADO'}")
        return ok
    if es_aviso:
        NOTIFICADOS.append((body, False))
    return True


async def spy_dispatch(client, phone, name, args):
    TOOLS_USED.append((name, args))
    return await _real_dispatch(client, phone, name, args)


AUDIO_CACHE: dict[str, bytes] = {}


async def fake_download(media_id):
    data = AUDIO_CACHE[media_id]
    return data, "audio/ogg", len(data)


main.send_whatsapp_text = capture_send
main.dispatch_tool = spy_dispatch
main.download_media = fake_download

client = TestClient(main.app)
_mid = {"n": 0}


def webhook(msg: dict) -> dict:
    value = {
        "messaging_product": "whatsapp",
        "metadata": {"display_phone_number": "15551506096", "phone_number_id": PNID},
        "messages": [msg],
    }
    return {"object": "whatsapp_business_account", "entry": [{"changes": [{"value": value}]}]}


def enviar_texto(phone: str, texto: str) -> str:
    _mid["n"] += 1
    antes = len(SENT)
    print(f"\n  👤 {texto}")
    r = client.post("/webhook", json=webhook(
        {"id": f"wamid.R{_mid['n']}", "from": phone, "type": "text", "text": {"body": texto}}))
    assert r.status_code == 200, r.text
    respuestas = [s for s in SENT[antes:] if s[1] == phone]
    if not respuestas:
        print("  🤖 (sin respuesta)")
        return ""
    reply = respuestas[-1][2]
    print(f"  🤖 {reply}")
    return reply


def enviar_audio(phone: str, fixture: str) -> str:
    _mid["n"] += 1
    media_id = f"media-{_mid['n']}"
    AUDIO_CACHE[media_id] = (BASE_DIR / "fixtures" / fixture).read_bytes()
    antes = len(SENT)
    print(f"\n  👤 🎙️ nota de voz ({fixture}, {len(AUDIO_CACHE[media_id]):,} bytes)")
    r = client.post("/webhook", json=webhook(
        {"id": f"wamid.R{_mid['n']}", "from": phone, "type": "audio",
         "audio": {"id": media_id, "mime_type": "audio/ogg; codecs=opus", "voice": True}}))
    assert r.status_code == 200, r.text
    conn = main.db()
    row = conn.execute(
        "SELECT content FROM messages WHERE client='sanmi' AND phone=? AND role='user' "
        "ORDER BY id DESC LIMIT 1", (phone,)).fetchone()
    conn.close()
    print(f"  📝 {row['content'] if row else '(no transcribió)'}")
    respuestas = [s for s in SENT[antes:] if s[1] == phone]
    if not respuestas:
        print("  🤖 (sin respuesta)")
        return ""
    print(f"  🤖 {respuestas[-1][2]}")
    return respuestas[-1][2]


def folios_de(phone: str) -> list[dict]:
    conn = main.db()
    rows = conn.execute(
        "SELECT folio, clasificacion, resumen, total FROM leads "
        "WHERE client='sanmi' AND phone=? AND folio IS NOT NULL ORDER BY id", (phone,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def titulo(t: str) -> None:
    print("\n" + "=" * 78)
    print(t)
    print("=" * 78)


def main_flow() -> None:
    print(f"Modelo: {main.OPENAI_MODEL} · transcripción: {main.TRANSCRIBE_MODEL}")
    print(f"Cliente para pnid {PNID}: {SANMI.nombre} · modo_demo={SANMI.modo_demo}")
    print(f"Carta cargada: {len(SANMI.productos)} platillos")
    print(f"Hora local: {main.ahora_local_largo(SANMI)}")
    print(f"Avisos de escalado por Meta: {'SÍ, reales' if NOTIFY_REAL else 'no (--sin-notify)'}")

    # ---------------------------------------------------------------- a) ---- #
    titulo("a) ¿Están abiertos? (contra la hora actual)")
    TOOLS_USED.clear()
    enviar_texto("5215550000001", "¿están abiertos?")
    print(f"\n  🔧 tools: {[t for t, _ in TOOLS_USED]}")

    # ---------------------------------------------------------------- b) ---- #
    titulo("b) ¿Dónde están?")
    enviar_texto("5215550000002", "¿dónde están?")

    # ---------------------------------------------------------------- c) ---- #
    titulo("c) ¿Qué me recomiendas?")
    TOOLS_USED.clear()
    enviar_texto("5215550000003", "¿qué me recomiendas?")
    print(f"\n  🔧 tools: {[t for t, _ in TOOLS_USED]}")

    # ---------------------------------------------------------------- d) ---- #
    titulo("d) Pedido completo a domicilio → folio + total 129 + aviso de pruebas")
    TOOLS_USED.clear()
    ped = "5215550000004"
    guion = [
        "quiero un pannini de arrachera y un americano para enviar a Javier Mina 27, pago en efectivo",
        "no, eso es todo",
        "sí, en efectivo contra entrega. Javier Mina 27, a nombre de Javier",
        "sí, confírmalo por favor",
    ]
    ultima = ""
    for turno in guion:
        ultima = enviar_texto(ped, turno)
        if folios_de(ped):
            break
    print(f"\n  🔧 tools: {[t for t, _ in TOOLS_USED]}")
    fol = folios_de(ped)
    print("\n  📋 registrado:")
    for f in fol:
        print(f"     {f['folio']}  [{f['clasificacion']}]  total={f['total']}  {f['resumen']}")
    assert fol, "(d) no cerró con folio"
    assert fol[-1]["total"] == 129, f"(d) total esperado 129, salió {fol[-1]['total']}"
    assert SANMI.aviso_demo in ultima, "(d) falta el aviso de periodo de pruebas"
    print("  ✅ folio + total 129 + aviso de periodo de pruebas")

    # ---------------------------------------------------------------- e) ---- #
    titulo("e) Fuera de carta: malteada de lotus → escala y el aviso sale por Meta")
    TOOLS_USED.clear()
    avisos_antes = len(NOTIFICADOS)
    fuera = "5215550000005"
    enviar_texto(fuera, "¿tienes malteada de lotus?")
    if "escalar_humano" not in [t for t, _ in TOOLS_USED]:
        enviar_texto(fuera, "¿me la pueden hacer aunque no esté en la carta? pregúntale al equipo")
    print(f"\n  🔧 tools: {[t for t, _ in TOOLS_USED]}")
    nuevos = NOTIFICADOS[avisos_antes:]
    for cuerpo, ok in nuevos:
        print(f"  📲 aviso enviado ({'200 OK' if ok else 'no entregado'}): {cuerpo}")
    assert "escalar_humano" in [t for t, _ in TOOLS_USED], "(e) no escaló"
    if NOTIFY_REAL:
        assert nuevos and nuevos[-1][1], "(e) el aviso de escalado no se entregó por Meta"

    # ---------------------------------------------------------------- f) ---- #
    titulo("f) Tema ajeno → redirección de una línea")
    TOOLS_USED.clear()
    r = enviar_texto("5215550000006", "hazme un resumen de la revolución mexicana")
    print(f"\n  🔧 tools: {[t for t, _ in TOOLS_USED]}")
    print(f"  líneas de la respuesta: {len([l for l in r.splitlines() if l.strip()])}")
    for palabra in ("madero", "zapata", "villa", "1910", "porfirio"):
        assert palabra not in r.lower(), f"(f) respondió el tema ajeno (mencionó '{palabra}')"

    # ---------------------------------------------------------------- g) ---- #
    titulo("g) Nota de voz → transcripción → respuesta")
    TOOLS_USED.clear()
    enviar_audio("5215550000007", "sanmi_pregunta.ogg")
    print(f"\n  🔧 tools: {[t for t, _ in TOOLS_USED]}")

    # -------------------------------------------------------------- panel --- #
    titulo("Panel /leads?client=sanmi")
    r = client.get("/leads", params={"client": "sanmi"})
    assert r.status_code == 200
    folio_d = fol[-1]["folio"]
    conn = main.db()
    escalados = conn.execute(
        "SELECT phone, resumen FROM leads WHERE client='sanmi' AND tipo='escalado'").fetchall()
    por_tipo = conn.execute(
        "SELECT tipo, COUNT(*) c FROM leads WHERE client='sanmi' GROUP BY tipo").fetchall()
    conn.close()
    print(f"  eventos por tipo: {[(t['tipo'], t['c']) for t in por_tipo]}")
    print(f"  pedido (d)  {folio_d} visible en el panel: {folio_d in r.text}")
    print(f"  escalado (e) del +{fuera} en el panel: {any(e['phone'] == fuera for e in escalados)}")
    for e in escalados:
        print(f"     escalado +{e['phone']}: {e['resumen']}")
    assert folio_d in r.text, "el folio de (d) no aparece en el panel"
    assert any(e["phone"] == fuera for e in escalados), "el escalado de (e) no aparece en el panel"

    print("\n" + "=" * 78)
    print("✅ Batería a-g completa.")
    print("=" * 78)


if __name__ == "__main__":
    main_flow()
