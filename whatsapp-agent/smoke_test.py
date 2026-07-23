"""
Prueba de humo — simula un POST de webhook con un mensaje de texto.

- Mockea OpenAI (fuerza el loop: 1) llama buscar_catalogo, 2) responde texto).
- Mockea la llamada a Meta (captura lo que se "enviaría" al cliente).
- Ejercita: dedup, memoria SQLite, function calling, registro de lead, panel /leads.

Corre offline, sin llaves reales:   python smoke_test.py
"""
import os
import json
import tempfile

# DB temporal aislada ANTES de importar main
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "smoke.db")
os.environ.setdefault("OPENAI_API_KEY", "test")
os.environ.setdefault("WA_VERIFY_TOKEN", "verify-123")

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

SENT = []  # capturamos mensajes "enviados" a WhatsApp


async def fake_send(to, body):
    SENT.append((to, body))
    print(f"  📤 WhatsApp → +{to}: {body!r}")
    return True


# Guion de OpenAI: primero pide catálogo, luego responde.
_openai_calls = {"n": 0}


async def fake_openai(messages):
    _openai_calls["n"] += 1
    if _openai_calls["n"] == 1:
        print("  🤖 OpenAI (turno 1): pide tool buscar_catalogo('cajeta')")
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
                                    "arguments": json.dumps({"consulta": "cajeta"}),
                                },
                            }
                        ],
                    }
                }
            ]
        }
    # turno 2: ya tiene el resultado de la tool -> registra pedido
    if _openai_calls["n"] == 2:
        # verificamos que el resultado de la tool llegó al contexto
        tool_msgs = [m for m in messages if m.get("role") == "tool"]
        assert tool_msgs, "no llegó el resultado de la tool al modelo"
        cat = json.loads(tool_msgs[-1]["content"])
        assert cat["total_coincidencias"] >= 1, "buscar_catalogo no encontró cajeta"
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
                                            "clasificacion": "cotizacion",
                                            "resumen": "24 frascos cajeta 250g menudeo",
                                            "total": 1392,
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
                    "content": (
                        "¡Va! Te armo la cotización de Cajeta 250g:\n"
                        "24 frascos x $58 = $1,392 MXN\n"
                        "Envío local gratis desde $1,500. Vigencia 3 días.\n"
                        "Folio de tu solicitud registrado. ¿Confirmo el pedido? 🙂"
                    ),
                }
            }
        ]
    }


def main_flow():
    main.openai_chat = fake_openai
    main.send_whatsapp_text = fake_send

    client = TestClient(main.app)

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

    print("\n=== 2) POST /webhook con mensaje de texto ===")
    webhook_payload = {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "changes": [
                    {
                        "value": {
                            "messaging_product": "whatsapp",
                            "messages": [
                                {
                                    "id": "wamid.TEST123",
                                    "from": "5213339876543",
                                    "type": "text",
                                    "text": {"body": "hola, cuánto la cajeta de 250g por 24 piezas?"},
                                }
                            ],
                        }
                    }
                ]
            }
        ],
    }
    r = client.post("/webhook", json=webhook_payload)
    print(f"  status={r.status_code} body={r.text}  (siempre 200 a Meta)")
    assert r.status_code == 200
    assert SENT, "no se envió respuesta al cliente"

    print("\n=== 3) Dedup — mismo message id no re-procesa ===")
    before = len(SENT)
    client.post("/webhook", json=webhook_payload)
    print(f"  mensajes enviados antes={before} después={len(SENT)}  (esperado igual)")
    assert len(SENT) == before, "el dedup falló"

    print("\n=== 4) Tipo no soportado (audio) → pide texto ===")
    audio_payload = {
        "entry": [
            {
                "changes": [
                    {
                        "value": {
                            "messages": [
                                {"id": "wamid.AUDIO1", "from": "5213339876543", "type": "audio", "audio": {"id": "a1"}}
                            ]
                        }
                    }
                ]
            }
        ]
    }
    client.post("/webhook", json=audio_payload)
    print(f"  último enviado: {SENT[-1][1]!r}")
    assert "texto" in SENT[-1][1].lower()

    print("\n=== 5) Estado en SQLite ===")
    conn = main.db()
    leads = conn.execute("SELECT tipo, clasificacion, resumen, total, folio FROM leads ORDER BY id").fetchall()
    msgs = conn.execute("SELECT role, content FROM messages ORDER BY id").fetchall()
    conn.close()
    print("  leads:")
    for l in leads:
        print(f"    - tipo={l['tipo']:9} clas={l['clasificacion']} folio={l['folio']} total={l['total']} :: {l['resumen']}")
    print("  memoria (messages):")
    for m in msgs:
        print(f"    - {m['role']:9}: {m['content'][:70]}")
    folios = [l["folio"] for l in leads if l["folio"]]
    assert folios and folios[0].startswith("DA-"), "no se generó folio DA-XXXX"

    print("\n=== 6) Panel /leads (proyector) ===")
    r = client.get("/leads")
    print(f"  status={r.status_code}, contiene acento #ff4e1c: {'#ff4e1c' in r.text}, "
          f"contadores: {'Contactos únicos' in r.text}")
    assert r.status_code == 200 and "#ff4e1c" in r.text

    print("\n✅ Flujo completo OK. Respuesta final al cliente:")
    print("   " + SENT[0][1].replace("\n", "\n   "))


if __name__ == "__main__":
    main_flow()
