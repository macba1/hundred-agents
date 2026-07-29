# ARCHIVADO — deploy del agente de WhatsApp en Fly.io

**No se despliega. No recibe mantenimiento.** Se conserva solo como referencia.

## Qué era

Un plan para correr `whatsapp-agent/` (Python + FastAPI + SQLite) como contenedor
24/7 en Fly.io, con volumen persistente y URL fija `*.fly.dev`.

Nunca llegó a desplegarse: requería una cuenta y un método de pago nuevos.

## Por qué se archivó

Contradice el estándar de [`INFRA.md`](../../INFRA.md): toda la infraestructura
vive en **Vercel + Redis**, sin servicios nuevos.

## Qué lo reemplaza

`api/wa/` — el mismo agente portado a funciones serverless en el proyecto de
Vercel que ya existe, con el estado en el Redis ya provisionado.

| Antes (Fly) | Ahora (Vercel) |
|---|---|
| Contenedor 24/7 | Funciones serverless |
| SQLite en volumen | Redis (`REDIS_URL`) |
| `https://<app>.fly.dev/webhook` | `https://www.thehagentic.com/api/wa/webhook` |
| `/leads?token=` | `/api/wa/leads?token=` |
| `flyctl logs` | Vercel → Observability → Logs |
| ~US$3–5/mes extra | US$0 extra |

## Contenido

| Archivo | Qué hacía |
|---|---|
| `fly.toml` | App, región, volumen, health check, máquina sin suspensión |
| `deploy_fly.sh` | Instalaba flyctl, creaba app y volumen, subía secretos, desplegaba |
| `Dockerfile` | Imagen del servicio Python |
| `docker-compose.yml` | Levantar el servicio en local |
| `.dockerignore` | Evitaba hornear `.env` y la SQLite en la imagen |
