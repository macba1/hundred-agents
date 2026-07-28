# Agente de WhatsApp multi-cliente

Servicio **autónomo** (Python + FastAPI). No toca el resto del repo (Node/Vercel).
Agente de WhatsApp con OpenAI `gpt-4o` (function calling + visión + transcripción
de voz), WhatsApp Cloud API (Graph v20.0) y SQLite.

Un solo proceso atiende **varios negocios a la vez**. El enrutado es por el
`phone_number_id` que Meta manda en el webhook.

## Clientes

| Clave | Negocio | Estado | Número | Panel |
|---|---|---|---|---|
| `sanmi` | Sanmi Café (San Miguel el Alto, Jal.) | **activo** — modo demo | número demo de Meta | `/leads?client=sanmi` |
| `demo-dulces` | Dulces del Alto | inactivo | — (cedió el número demo) | `/leads?client=demo-dulces` |

`sanmi` tomó prestado el número demo; `demo-dulces` quedó en pausa con su carpeta
intacta. Ver **[clients/sanmi/README.md](clients/sanmi/README.md)** para la
migración de Sanmi a su número real.

## Estructura

```
whatsapp-agent/
├── main.py                      app FastAPI: webhook, enrutado, tools, voz, panel
├── clients/
│   ├── sanmi/
│   │   ├── config.json          phone_number_id, límites, datos del negocio
│   │   ├── prompt.md            system prompt
│   │   ├── catalogo.json        menú (precios en "REEMPLAZAR")
│   │   └── README.md            migración al número real
│   └── demo-dulces/
│       ├── config.json
│       ├── prompt.md
│       └── catalogo.json
├── fixtures/                    notas de voz de prueba (generadas con TTS)
├── check_config.py              valida env + clientes + enrutado (sin secretos)
├── smoke_test.py                regresión offline (mockea Meta y OpenAI)
├── test_sanmi_real.py           pruebas con OpenAI real, webhooks simulados
└── make_audio_fixture.py        regenera fixtures/*.ogg
```

## Añadir un cliente

1. `mkdir clients/<clave>` con `config.json`, `prompt.md` y `catalogo.json`
   (copia los de `sanmi` como plantilla).
2. Pon su `phone_number_id` y `activo: true`.
3. Reinicia el proceso y corre `python check_config.py`.

Campos de `config.json`:

| Campo | Para qué |
|---|---|
| `clave` | Identificador; se guarda en la columna `client` de la BD |
| `phone_number_id` | **Clave de enrutado.** El número de Meta desde el que contesta |
| `activo` | `false` lo saca de circulación sin borrar nada |
| `human_notify_wa` | A quién se avisa al escalar (E.164 sin `+`) |
| `max_turns` | Turnos por contacto antes del mensaje de cierre |
| `memoria_mensajes` | Mensajes de historial que ve el modelo |
| `folio_prefix` | Prefijo de los folios (`SNM-0001`) |
| `datos` | Horario, dirección, etc. Se inyectan al system prompt |
| `mensaje_cierre` | Texto al agotar `max_turns` |
| `acento_panel` | Color del panel de ese cliente |

> **Dos clientes activos con el mismo `phone_number_id` hacen fallar el arranque
> a propósito.** Enrutar sería adivinar, y adivinar significa contestar en nombre
> del negocio equivocado.

## Setup local

```bash
cd whatsapp-agent
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # rellena tus llaves
python check_config.py      # valida antes de arrancar
uvicorn main:app --host 0.0.0.0 --port 8000
```

O con Docker: `cp .env.example .env && docker compose up --build`

Panel: <http://localhost:8000/leads> (auto-refresh 5s, pestaña por cliente).

## Pruebas

```bash
python check_config.py                    # env + clientes + conflictos de enrutado
python smoke_test.py                      # offline, sin llaves reales
python test_sanmi_real.py                 # OpenAI real; nada sale a Meta
python test_sanmi_real.py --notify-real    # además intenta el aviso real de escalamiento
```

## Voz (todos los clientes)

Audio entrante → descarga de Graph → transcripción con OpenAI → el agente recibe
`[Audio transcrito]: …` → **responde en texto**.

- Modelo por `TRANSCRIBE_MODEL` (default `whisper-1`).
- Máx **5 audios por usuario y día** (tabla `audio_usage`); pasado el límite se
  pide texto con amabilidad.
- Audios de **más de 2 minutos** → se pide texto. Corte barato por tamaño
  (`AUDIO_MAX_BYTES`) antes de transcribir, y corte fino por duración real
  cuando el modelo la reporta (`whisper-1` con `verbose_json`).
- Cualquier fallo de descarga o transcripción → se pide texto, nunca se cae.

## Exponer con cloudflared (para que Meta llegue a tu localhost)

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:8000
```

Tu webhook será `https://<url-que-imprime>/webhook`.

## Configurar el webhook en Meta

1. <https://developers.facebook.com> → tu App → **WhatsApp → Configuration**.
2. **Callback URL** = `https://<tu-url-cloudflared>/webhook`
3. **Verify token** = el valor de `WHATSAPP_VERIFY_TOKEN` en tu `.env`.
4. **Verify and save** (Meta hace un `GET /webhook`; debe responder el challenge).
5. En **Webhook fields**, suscríbete a **messages**.
6. `WHATSAPP_TOKEN` en `.env`; el *Phone number ID* va en el `config.json` del
   cliente, no en `.env`.
7. Añade tu celular como **recipient** de prueba (los números de prueba solo
   escriben a destinatarios dados de alta).

> El token temporal de Meta caduca en ~24 h. Para algo estable usa un *System
> User token* permanente.

## Notas técnicas

- Memoria y sesión **por (cliente, teléfono)**: tablas `messages`, `sessions`.
- Dedup por `message id` (tabla `seen`) — Meta reintenta webhooks.
- El webhook **siempre responde 200** a Meta; el trabajo pesado va a background.
- Un `phone_number_id` presente pero desconocido **no** cae a ningún fallback:
  se ignora y se registra en el log.
- Loop de function calling: máx `MAX_TOOL_ITERS` (6) iteraciones. Tools:
  `buscar_catalogo`, `registrar_pedido`, `escalar_humano`.
- `buscar_catalogo` ignora acentos y plurales ("cafés" encuentra "cafe caliente").
- Migración de BD automática: las tablas viejas de un solo cliente reciben la
  columna `client` (`LEGACY_CLIENT`, default `demo-dulces`) al arrancar.
- Sin ORM: `sqlite3` directo. Dependencias: `fastapi`, `uvicorn`, `httpx`.
