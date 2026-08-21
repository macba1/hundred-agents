# Infraestructura — Hundred Agents

## Estándar

**Toda la infraestructura de Hundred Agents (web, landings, agentes WhatsApp,
paneles) vive en Vercel + Redis, en este repo. Prototipos en otras tecnologías se
archivan en `/archive`. Cualquier excepción requiere decisión explícita de Tony.**

## Qué significa en la práctica

| Necesidad | Cómo se resuelve |
|---|---|
| Sitio, landings, subdominios de cliente | Vercel (estático + Edge Middleware) |
| API y agentes | Vercel Serverless Functions en `api/` |
| Estado (sesiones, leads, dedupe, contadores, rate limit) | Redis (`REDIS_URL`) |
| Secretos | Vercel → Settings → Environment Variables |
| Logs | Vercel → Observability → Logs |

Consecuencias que hay que respetar al escribir código:

- **Sin estado en memoria entre requests.** Una función puede congelarse en
  cuanto responde y la siguiente petición puede caer en otra instancia. Todo
  estado va a Redis.
- **Sin filesystem persistente.** Los datos que el código necesita (prompts,
  catálogos) viajan empaquetados en el deploy; nada se escribe en disco.
- **Nada de trabajo después de responder.** Si hay que hacer algo, se hace antes
  del `res.status(200)`, con `maxDuration` suficiente.
- **Nada de servicios nuevos** (VPS, contenedores, colas gestionadas, otro
  proveedor) sin decisión explícita de Tony.

## `/archive`

Prototipos que ya no están vivos. Se conservan como referencia; no se despliegan
y no reciben mantenimiento. Cada uno con su propio README explicando qué lo
reemplazó.

| Carpeta | Qué era | Reemplazado por |
|---|---|---|
| `archive/fly-deploy/` | Deploy del agente de WhatsApp en Fly.io (contenedor + volumen) | `api/wa/` en Vercel + Redis |

## Estado actual

| Servicio | Ruta | Notas |
|---|---|---|
| Sitio + landings | `/`, `/clientes/<slug>/` | Subdominios vía `middleware.js` |
| Discovery (Gabi) | `api/discovery/*` | Redis vía `lib/discovery/store.js` |
| Leads / chat del sitio | `api/lead.js`, `api/chat.js` | Notion + OpenAI |
| **Agente de WhatsApp** | `api/wa/*` | Redis vía `lib/wa/store.js`; clientes en `lib/wa/clients/` |
| Demos web de agente | `api/demo-chat.js` | `lib/wa/demo.js`: reutiliza prompt y catálogo del cliente, sin Redis ni Meta. Solo clientes con `demo_web: true` (hoy `providencia`) |

El código Python en `whatsapp-agent/` está **deprecado**: sirve como referencia y
para correr las pruebas de regresión offline, pero la versión viva es `api/wa/`.
