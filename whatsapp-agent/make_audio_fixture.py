"""
Genera fixtures de audio (notas de voz simuladas) con TTS de OpenAI.

Se usan en test_sanmi_real.py para ejercitar el flujo de voz sin depender de
Meta: el audio se inyecta como si Graph lo hubiera devuelto.

Uso:  python make_audio_fixture.py
Salida: fixtures/*.ogg   (opus, igual que las notas de voz de WhatsApp)
"""
import os
import sys
import httpx
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
OUT_DIR = BASE_DIR / "fixtures"

TTS_MODEL = os.getenv("TTS_MODEL", "tts-1")
TTS_VOICE = os.getenv("TTS_VOICE", "nova")

FIXTURES = {
    "sanmi_pregunta.ogg": (
        "Hola, buenas tardes. Oiga, ¿a qué hora abren mañana? "
        "Y quería preguntar qué cafés calientes tienen, por favor."
    ),
    "sanmi_pedido.ogg": (
        "Buenas, quiero encargar dos capuchinos grandes y unos chilaquiles verdes "
        "para recoger. Va a nombre de Ramiro y paso como a las nueve de la mañana."
    ),
}


def load_env() -> None:
    env = BASE_DIR / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


def main() -> None:
    load_env()
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        sys.exit("Falta OPENAI_API_KEY")

    OUT_DIR.mkdir(exist_ok=True)
    for nombre, texto in FIXTURES.items():
        destino = OUT_DIR / nombre
        r = httpx.post(
            "https://api.openai.com/v1/audio/speech",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "model": TTS_MODEL,
                "voice": TTS_VOICE,
                "input": texto,
                "response_format": "opus",
            },
            timeout=120,
        )
        r.raise_for_status()
        destino.write_bytes(r.content)
        print(f"✅ {destino.relative_to(BASE_DIR)}  ({len(r.content):,} bytes)")
        print(f"   guion: {texto}")


if __name__ == "__main__":
    main()
