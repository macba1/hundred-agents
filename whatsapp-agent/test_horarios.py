"""
Pruebas de "¿están abiertos?" contra la hora simulada.

El agente decide abierto/cerrado con dos insumos: los `horarios` del catálogo y
la línea "Ahora mismo es ..." que main inyecta al system prompt. Aquí fijamos esa
línea para cada escenario y comprobamos la respuesta con OpenAI real.

Uso:  python test_horarios.py
"""
import os
import sys
import tempfile
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent


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
os.environ["DATABASE_PATH"] = os.path.join(tempfile.mkdtemp(), "horarios.db")

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

SANMI = main.CLIENTS["sanmi"]
PNID = SANMI.phone_number_id
SENT: list[tuple[str, str]] = []


async def capture_send(client, to, body):
    SENT.append((to, body))
    return True


main.send_whatsapp_text = capture_send
client = TestClient(main.app)

# (etiqueta, hora simulada, teléfono, qué debe pasar, alternativas aceptadas)
# `alternativas` = basta con que aparezca UNA. El modelo alterna entre 24h y
# 12h ("17:00" / "5:00 pm"), y las dos formas son correctas.
ESCENARIOS = [
    ("jueves 11:00 — cerrado por descanso",
     "jueves 30 de julio de 2026, 11:00 hora local de CDMX",
     "5215551110001", "cerrado (día de descanso), abren el viernes 8:30",
     ["viernes"]),
    ("martes 14:00 — cerrado, horario partido",
     "martes 28 de julio de 2026, 14:00 hora local de CDMX",
     "5215551110002", "cerrado, abren a las 17:00",
     ["17:00", "5:00", "5 pm", "5 de la tarde"]),
    ("martes 18:00 — abierto",
     "martes 28 de julio de 2026, 18:00 hora local de CDMX",
     "5215551110003", "abierto hasta las 22:15",
     []),
    ("sábado 22:20 — cerrado, abren mañana 8:30",
     "sábado 1 de agosto de 2026, 22:20 hora local de CDMX",
     "5215551110004", "cerrado, abren mañana (domingo) 8:30",
     ["8:30"]),
]


def webhook(phone: str, texto: str, mid: str) -> dict:
    value = {
        "messaging_product": "whatsapp",
        "metadata": {"display_phone_number": "15551506096", "phone_number_id": PNID},
        "messages": [{"id": mid, "from": phone, "type": "text", "text": {"body": texto}}],
    }
    return {"object": "whatsapp_business_account", "entry": [{"changes": [{"value": value}]}]}


def main_flow() -> None:
    print(f"Modelo: {main.OPENAI_MODEL}")
    print("Horarios en catálogo:")
    for dia, h in SANMI.catalogo["horarios"].items():
        print(f"  {dia:10} {h}")

    fallos = []
    for i, (etiqueta, ahora, phone, esperado, palabras) in enumerate(ESCENARIOS, 1):
        print("\n" + "=" * 78)
        print(f"{i}) {etiqueta}")
        print("=" * 78)
        print(f"  🕐 hora simulada: {ahora}")
        print(f"  ✔️  esperado: {esperado}")

        main.ahora_local_largo = lambda c, _a=ahora: _a
        antes = len(SENT)
        r = client.post("/webhook", json=webhook(phone, "¿están abiertos?", f"wamid.H{i}"))
        assert r.status_code == 200
        if len(SENT) == antes:
            print("  🤖 (sin respuesta)")
            fallos.append(etiqueta)
            continue
        reply = SENT[-1][1]
        print(f"\n  👤 ¿están abiertos?")
        print(f"  🤖 {reply}")

        bajo = reply.lower()
        abierto_dicho = "abierto" in bajo or "estamos abiertos" in bajo
        cerrado_dicho = "cerrado" in bajo or "cerrada" in bajo or "descanso" in bajo
        debe_abrir = "abierto" in esperado and "cerrado" not in esperado
        ok = abierto_dicho if debe_abrir else cerrado_dicho
        faltantes = [] if (not palabras or any(p in bajo for p in palabras)) else palabras
        if not ok or faltantes:
            print(f"  ❌ FALLA (abierto_dicho={abierto_dicho} cerrado_dicho={cerrado_dicho} "
                  f"no apareció ninguna de={faltantes})")
            fallos.append(etiqueta)
        else:
            print("  ✅ correcto")

    print("\n" + "=" * 78)
    if fallos:
        print("❌ Escenarios con problema:")
        for f in fallos:
            print(f"   - {f}")
        sys.exit(1)
    print("✅ Los 4 escenarios de horario responden correcto.")
    print("=" * 78)


if __name__ == "__main__":
    main_flow()
