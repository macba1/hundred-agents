# Dulces del Alto — Agente de ventas WhatsApp (DEMO)

Servicio **autónomo** (Python + FastAPI). No toca el resto del repo (Node/Vercel).
Agente de ventas por WhatsApp con OpenAI `gpt-4o` (function calling + visión),
WhatsApp Cloud API (Graph v20.0) y SQLite.

## Archivos
| Archivo | Qué es |
|---|---|
| `main.py` | App FastAPI: webhook, loop de function calling, panel |
| `catalogo.json` | Catálogo (editable, sin tocar código) |
| `prompt_agente.md` | System prompt (editable, sin tocar código) |
| `.env.example` | Variables de entorno |
| `smoke_test.py` | Prueba de humo offline (mockea Meta + OpenAI) |
| `Dockerfile` / `docker-compose.yml` | Para levantar el servicio |

## Setup local
```bash
cd whatsapp-agent
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # rellena tus llaves
uvicorn main:app --host 0.0.0.0 --port 8000
```
O con Docker:
```bash
cp .env.example .env        # rellena tus llaves
docker compose up --build
```

Panel para proyector: <http://localhost:8000/leads> (auto-refresh 5s).

## Prueba de humo (sin llaves reales)
```bash
python smoke_test.py
```
Simula un POST de webhook con texto, fuerza el loop de tools (busca catálogo →
registra pedido → responde), verifica dedup, memoria SQLite, folio y panel.

## Exponer con cloudflared (para que Meta llegue a tu localhost)
```bash
# instala cloudflared (macOS): brew install cloudflared
cloudflared tunnel --url http://localhost:8000
```
Copia la URL pública que imprime (ej. `https://algo-al-azar.trycloudflare.com`).
Tu webhook será:  `https://<esa-url>/webhook`

## Configurar el webhook en Meta
1. <https://developers.facebook.com> → tu App → **WhatsApp → Configuration**.
2. **Callback URL** = `https://<tu-url-cloudflared>/webhook`
3. **Verify token** = el mismo valor de `WA_VERIFY_TOKEN` en tu `.env`.
4. Clic **Verify and save** (Meta hace un `GET /webhook`; debe responder el challenge).
5. En **Webhook fields** suscríbete a **messages**.
6. Copia a tu `.env`:
   - `WA_PHONE_NUMBER_ID` (WhatsApp → API Setup → *Phone number ID*)
   - `WA_ACCESS_TOKEN` (token temporal de prueba o token de sistema permanente)
7. Añade tu número de celular como **recipient** de prueba y mándale un WhatsApp
   al número de prueba de Meta.

> El token temporal de Meta caduca en ~24h. Para la demo genera uno nuevo antes,
> o usa un *System User token* permanente.

## Guion de demo (5 min, para proyector)
Ten `/leads` abierto en pantalla grande. Desde tu celular al número de prueba:

1. **Precio menudeo** — "¿A cómo la cajeta de 250g?"
   → el agente llama `buscar_catalogo` y da precio real (nunca inventa). Aparece
   evento en el panel.
2. **Mayoreo automático** — "Ocupo 30 jamoncillos clásicos"
   → aplica precio de mayoreo al pasar la cantidad y lo dice.
3. **Cotización + folio** — "Sí, mándame cotización de 24 frascos de cajeta"
   → cotiza con partidas/subtotal/envío/total, registra pedido y da **folio DA-XXXX**.
4. **Agotado + alternativa** — "¿Tienes cocada con rompope?"
   → dice que está agotada y ofrece la cocada tradicional.
5. **Visión** — manda una **foto** de un dulce típico
   → lo identifica y sugiere lo más parecido del catálogo con precio.
6. **Escalamiento** — "Quiero precio de distribuidor / crédito a 30 días"
   → NO lo autoriza, escala a humano y avisa por WhatsApp a `HUMAN_NOTIFY_WA`.
7. **Cierre de demo** — al llegar a `MAX_TURNS` (14) manda mensaje de cierre.

Cierra mostrando el panel: contactos únicos, eventos y la tabla de leads en vivo.

## Notas técnicas
- Memoria por número (últimos ~24 mensajes) en SQLite (`messages`).
- Dedup por `message id` (tabla `seen`) — Meta reintenta webhooks.
- El webhook **siempre responde 200** a Meta (try/except); los errores van al log.
- Loop de function calling: máx 5 iteraciones; tools: `buscar_catalogo`,
  `registrar_pedido`, `escalar_humano`.
- Sin ORM: `sqlite3` directo. Dependencias: `fastapi`, `uvicorn`, `httpx`.
