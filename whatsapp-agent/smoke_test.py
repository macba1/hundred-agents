"""
Prueba de humo (offline) — simula POSTs de webhook multi-cliente.

- Mockea OpenAI (fuerza el loop: 1) llama buscar_catalogo, 2) registra, 3) responde).
- Mockea la llamada a Meta (captura lo que se "enviaría" al cliente).
- Mockea la transcripción de audio.
- Ejercita: enrutado por phone_number_id, dedup, memoria SQLite por cliente,
  function calling, folio con prefijo del cliente, límite de audios y panel
  /leads?client=

Corre offline, sin llaves reales:   python smoke_test.py
"""
import os
import json
import tempfile

# DB temporal aislada ANTES de importar main
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "smoke.db")
os.environ.setdefault("OPENAI_API_KEY", "test")
os.environ.setdefault("WA_VERIFY_TOKEN", "verify-123")
os.environ.setdefault("WHATSAPP_TOKEN", "test-token")

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

SENT = []  # capturamos mensajes "enviados" a WhatsApp


async def fake_send(client, to, body):
    SENT.append((client.clave, to, body))
    print(f"  📤 [{client.clave}] WhatsApp → +{to}: {body!r}")
    return True


# Guion de OpenAI: primero pide catálogo, luego registra, luego responde.
_openai_calls = {"n": 0}


async def fake_openai(messages):
    _openai_calls["n"] += 1
    if _openai_calls["n"] == 1:
        print("  🤖 OpenAI (turno 1): pide tool buscar_catalogo('capuchino')")
        return {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "type": "function",
                                "function": {
                                    "name": "buscar_catalogo",
                                    "arguments": json.dumps({"consulta": "capuchino"}),
                                },
                            }
                        ],
                    }
                }
            ]
        }
    if _openai_calls["n"] == 2:
        tool_msgs = [m for m in messages if m.get("role") == "tool"]
        assert tool_msgs, "no llegó el resultado de la tool al modelo"
        cat = json.loads(tool_msgs[-1]["content"])
        assert cat["total_coincidencias"] >= 1, "buscar_catalogo no encontró capuchino"
        assert cat["negocio"] == "Sanmi Café", f"catálogo equivocado: {cat['negocio']}"
        print(f"  🤖 OpenAI (turno 2): recibió {cat['total_coincidencias']} coincidencias; registra pedido")
        return {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_2",
                                "type": "function",
                                "function": {
                                    "name": "registrar_pedido",
                                    "arguments": json.dumps(
                                        {
                                            "clasificacion": "pedido",
                                            "resumen": "2 capuchinos grandes, recoge Ana, 5:30 pm",
                                        }
                                    ),
                                },
                            }
                        ],
                    }
                }
            ]
        }
    print("  🤖 OpenAI (turno 3): responde al cliente con folio")
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "Listo, quedan 2 capuchinos grandes para recoger a las 5:30 pm. ☕",
                }
            }
        ]
    }


async def fake_transcribe(audio, mime):
    return {"text": "Hola, ¿a qué hora abren mañana?", "duration": 4.2}


async def fake_download(media_id):
    return b"\x00" * 2048, "audio/ogg", 2048


SANMI_PNID = main.CLIENTS["sanmi"].phone_number_id


def wh(msg: dict, pnid: str = SANMI_PNID) -> dict:
    return {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "changes": [
                    {
                        "value": {
                            "messaging_product": "whatsapp",
                            "metadata": {"phone_number_id": pnid},
                            "messages": [msg],
                        }
                    }
                ]
            }
        ],
    }


def main_flow():
    main.openai_chat = fake_openai
    main.send_whatsapp_text = fake_send
    main.openai_transcribe = fake_transcribe
    main.download_media = fake_download

    client = TestClient(main.app)

    print("\n=== 0) Registro de clientes ===")
    for c in main.CLIENTS.values():
        print(f"  - {c.clave:12} activo={c.activo!s:5} pnid={c.phone_number_id} folio={c.folio_prefix}-")
    assert "sanmi" in main.CLIENTS and "demo-dulces" in main.CLIENTS
    assert main.CLIENTS["sanmi"].activo and not main.CLIENTS["demo-dulces"].activo
    assert main.resolve_client(SANMI_PNID).clave == "sanmi", "el número demo debe enrutar a sanmi"

    print("\n=== 1) Verificación GET /webhook (Meta) ===")
    r = client.get(
        "/webhook",
        params={"hub.mode": "subscribe", "hub.verify_token": "verify-123", "hub.challenge": "CHALLENGE42"},
    )
    print(f"  status={r.status_code} body={r.text!r}  (esperado 200 / 'CHALLENGE42')")
    assert r.status_code == 200 and r.text == "CHALLENGE42"

    r = client.get("/webhook", params={"hub.mode": "subscribe", "hub.verify_token": "MAL", "hub.challenge": "x"})
    print(f"  token malo → status={r.status_code}  (esperado 403)")
    assert r.status_code == 403

    print("\n=== 2) POST /webhook con texto (enruta a sanmi) ===")
    payload = wh(
        {
            "id": "wamid.TEST123",
            "from": "5213339876543",
            "type": "text",
            "text": {"body": "quiero 2 capuchinos grandes para recoger a las 5:30, a nombre de Ana"},
        }
    )
    r = client.post("/webhook", json=payload)
    print(f"  status={r.status_code} body={r.text}  (siempre 200 a Meta)")
    assert r.status_code == 200
    assert SENT and SENT[0][0] == "sanmi", "no se atendió como sanmi"

    print("\n=== 3) Dedup — mismo message id no re-procesa ===")
    before = len(SENT)
    client.post("/webhook", json=payload)
    print(f"  mensajes enviados antes={before} después={len(SENT)}  (esperado igual)")
    assert len(SENT) == before, "el dedup falló"

    print("\n=== 4) Audio → transcripción → agente ===")
    client.post("/webhook", json=wh({"id": "wamid.AUDIO1", "from": "5213339876543", "type": "audio", "audio": {"id": "a1"}}))
    conn = main.db()
    umsg = conn.execute(
        "SELECT content FROM messages WHERE client='sanmi' AND role='user' ORDER BY id DESC LIMIT 1"
    ).fetchone()["content"]
    conn.close()
    print(f"  memoria del usuario: {umsg!r}")
    assert umsg.startswith("[Audio transcrito]:"), "el audio no llegó marcado al agente"

    print("\n=== 5) Límite de audios por día ===")
    for i in range(2, 8):
        client.post("/webhook", json=wh({"id": f"wamid.AUDIO{i}", "from": "5213339876543", "type": "audio", "audio": {"id": f"a{i}"}}))
    print(f"  último enviado: {SENT[-1][2]!r}")
    assert "no puedo procesar más notas de voz" in SENT[-1][2], "no se aplicó el límite de 5 audios/día"

    print("\n=== 6) phone_number_id desconocido → se ignora (no contesta por nadie) ===")
    before = len(SENT)
    client.post("/webhook", json=wh({"id": "wamid.OTRO", "from": "5210000000000", "type": "text", "text": {"body": "hola"}}, pnid="999999999"))
    print(f"  enviados antes={before} después={len(SENT)}  (esperado igual)")
    assert len(SENT) == before, "un phone_number_id desconocido no debe contestar"

    print("\n=== 7) Estado en SQLite ===")
    conn = main.db()
    leads = conn.execute("SELECT client, tipo, clasificacion, resumen, folio FROM leads ORDER BY id").fetchall()
    conn.close()
    for l in leads[:8]:
        print(f"    - [{l['client']}] tipo={l['tipo']:9} folio={l['folio']} :: {(l['resumen'] or '')[:50]}")
    folios = [l["folio"] for l in leads if l["folio"]]
    assert folios and folios[0].startswith("SNM-"), f"folio esperado SNM-XXXX, salió {folios[:1]}"
    assert all(l["client"] == "sanmi" for l in leads), "hay leads sin cliente sanmi"

    print("\n=== 8) Panel /leads?client=sanmi ===")
    r = client.get("/leads", params={"client": "sanmi"})
    print(f"  status={r.status_code} · título Sanmi: {'Sanmi Café' in r.text} · folio visible: {folios[0] in r.text}")
    assert r.status_code == 200 and "Sanmi Café" in r.text and folios[0] in r.text

    r = client.get("/leads", params={"client": "demo-dulces"})
    print(f"  demo-dulces (inactivo, sin eventos): status={r.status_code} · vacío: {'Sin eventos todavía' in r.text}")
    assert "Sin eventos todavía" in r.text

    print("\n✅ Flujo multi-cliente OK. Primera respuesta enviada:")
    print("   " + SENT[0][2].replace("\n", "\n   "))


if __name__ == "__main__":
    main_flow()
