# Agente de WhatsApp multi-cliente — ⚠️ DEPRECADO

> **La versión viva es `api/wa/` (Vercel + Redis).** Ver [`INFRA.md`](../INFRA.md).
>
> Este servicio Python ya **no se despliega**. Se conserva por dos razones:
> es la referencia de la lógica del agente, y sus pruebas (`smoke_test.py`,
> `test_sanmi_real.py`, `test_horarios.py`) siguen sirviendo para validar
> prompts y catálogos contra OpenAI real sin tocar producción.
>
> **Los datos de cliente vivos están en `lib/wa/clients/`.** Los de aquí
> (`whatsapp-agent/clients/`) son la copia histórica: si editas un catálogo o un
> prompt, edítalo en `lib/wa/clients/`.
>
> | Antes (Python) | Ahora (Vercel) |
> |---|---|
> | `uvicorn main:app` | `api/wa/webhook.js` |
> | SQLite `demo.db` | Redis (`REDIS_URL`), `lib/wa/store.js` |
> | `/webhook` | `https://www.thehagentic.com/api/wa/webhook` |
> | `/leads?token=` | `/api/wa/leads?token=` |
> | `/health` | `/api/wa/health` |
> | túnel cloudflared | dominio de producción, 24/7 |

Servicio **autónomo** (Python + FastAPI). No toca el resto del repo (Node/Vercel).
Agente de WhatsApp con OpenAI `gpt-4o` (function calling + visión + transcripción
de voz), WhatsApp Cloud API (Graph v20.0) y SQLite.

Un solo proceso atiende **varios negocios a la vez**. El enrutado es por el
`phone_number_id` que Meta manda en el webhook.

## Clientes

| Clave | Negocio | Estado | Número | Panel |
|---|---|---|---|---|
| `sanmi` | Sanmi Café (San Miguel el Alto, Jal.) | **activo** · `modo_demo: true` · carta real, 96 platillos | número demo de Meta | `/leads?client=sanmi` |
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
| `datos` | Sobrescribe los datos del negocio en el system prompt. Vacío = manda `catalogo.json` |
| `modo_demo` | `true`: el agente atiende normal pero agrega `aviso_demo` al confirmar un pedido |
| `aviso_demo` | La línea que se agrega en modo demo |
| `zona_horaria` / `etiqueta_zona` | Para "¿están abiertos?" y la hora de los escalamientos |
| `mensaje_cierre` | Texto al agotar `max_turns` |
| `acento_panel` | Color del panel de ese cliente |

### Catálogo: dos formas soportadas

```jsonc
// plana
{ "productos": [ { "nombre": "...", "precio": 99 } ] }

// anidada — categorias → subcategoría → items
{ "categorias": { "favoritos": { "panninis": {
    "descripcion": "Servidos con papas o ensalada.",
    "extras":    { "Queso extra": 15 },
    "sinonimos": ["pannini", "panini", "sándwich caliente"],
    "items":     [ { "nombre": "Pannini Arrachera", "precio": 99 } ] } } } }
```

`buscar_catalogo` aplana la anidada sola y hereda `descripcion`/`extras` a cada
item. `sinonimos` es solo para búsqueda (no se le manda al modelo): sirve cuando
la subcategoría se llama `coffee` y el cliente escribe "¿qué cafés tienen?".

Las claves de negocio del nivel superior (`direccion`, `horarios`, `domicilio`,
`pagos`, `telefono`, `notas_generales`) se inyectan al system prompt **y** las
devuelve la herramienta — una sola fuente, sin horarios contradictorios.

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

## Deploy 24/7 (Fly.io)

Para que el staff pruebe durante semanas hace falta una URL fija que no dependa
de una laptop encendida. `fly.toml` + `deploy_fly.sh` dejan eso listo.

```bash
FLY_API_TOKEN=... ./deploy_fly.sh
```

El script instala `flyctl` si falta, crea la app y un volumen de 1 GB para la
SQLite, sube los secretos desde `.env` (nunca se hornean en la imagen), despliega
e imprime las URLs. La máquina **no se suspende** (`auto_stop_machines = false`):
Meta necesita respuesta en menos de 5 s y un cold start rompería el webhook.

Después, registrar el webhook sin entrar al panel de Meta:

```bash
python set_meta_webhook.py https://sanmi-whatsapp-agent.fly.dev/webhook
```

Esto necesita `META_APP_SECRET` en `.env`: Meta exige un *App access token* para
`/{app-id}/subscriptions` y el token de System User no alcanza.

Logs: `flyctl logs --app sanmi-whatsapp-agent`

> **El panel es público junto con el webhook.** `PANEL_TOKEN` es obligatorio en
> cualquier despliegue: `/leads` responde 403 sin él. Sin la variable, el panel
> queda abierto y el arranque lo avisa en el log.

## Exponer con cloudflared (solo para pruebas locales)

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
