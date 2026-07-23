# Landing Coparmex — `/coparmex`

Página pública para la charla de **Coparmex San Miguel el Alto**: captura de leads +
visor de la presentación (PDF) + agente de bienvenida. URL final:
`https://thehagentic.com/coparmex`.

Integrada al proyecto Node/Vercel existente (funciones serverless en `api/`, estático
en la raíz). No modifica el sitio principal, la conferencia ni los clientes.

## Archivos
| Ruta | Qué es |
|---|---|
| `coparmex/index.html` | Página (3 estados: registro → presentación → chat) |
| `coparmex/presentacion.pdf` | **Lo subes tú** (ver abajo) |
| `coparmex/qr-coparmex.png` | QR 1000×1000 → `/coparmex` (copia también en la raíz del repo) |
| `api/coparmex/lead.js` | POST — guarda lead en Redis |
| `api/coparmex/leads.js` | GET — export CSV (protegido con `ADMIN_TOKEN`) |
| `api/coparmex/chat.js` | POST — agente OpenAI + rate limit por IP |
| `lib/coparmex.js` | Almacenamiento de leads en Redis |

Reusa: `lib/discovery/ratelimit.js` (rate limit), `lib/notion.js` (`validEmail`), y el
mismo Redis (`REDIS_URL`) ya conectado al proyecto.

## Almacenamiento de leads — decisión
**Redis** (`REDIS_URL`), que ya está provisionado en el proyecto y con la dependencia
`redis` instalada. Es lo más simple que funciona: cero setup nuevo, aguanta 50-100
registros concurrentes y permite exportar CSV directo. Los leads se guardan en la lista
`coparmex:leads`.

## Variables de entorno (Vercel → Settings → Environment Variables)
> El repo ignora todo `.env*` por política de seguridad, así que la referencia
> autoritativa de envs es esta tabla (no hay `.env.example` versionado).

| Variable | Obligatoria | Default | Uso |
|---|---|---|---|
| `OPENAI_API_KEY` | ✅ (ya existe) | — | Chat del agente |
| `OPENAI_MODEL` | opcional | `gpt-4o-mini` | Modelo del chat |
| `REDIS_URL` | ✅ (ya existe) | — | Guardar leads + rate limit |
| `ADMIN_TOKEN` | ✅ **nueva** | — | Protege el CSV `/api/coparmex/leads` |
| `LEADS_NOTIFY_WEBHOOK` | opcional | — | POST por cada lead nuevo (Slack/Sheet/etc.) |

## Cómo subir el PDF
1. Nombra tu archivo **`presentacion.pdf`**.
2. Colócalo en `coparmex/presentacion.pdf` (misma carpeta que `index.html`).
3. Commit + deploy. Queda en `https://thehagentic.com/coparmex/presentacion.pdf`.
4. La página lo renderiza con pdf.js (slides navegables, se ve en celular vertical).
   Si aún no existe, la página muestra un aviso amable en vez de romperse.

## Descargar los leads (CSV)
```
https://thehagentic.com/api/coparmex/leads?token=TU_ADMIN_TOKEN
```
Descarga `coparmex-leads.csv` (columnas: ts, name, email, consent, ip, ua).
Sin token válido → 401.

## Checklist de deploy
- [ ] En Vercel, define `ADMIN_TOKEN` (valor largo y secreto). Verifica que ya existan
      `OPENAI_API_KEY` y `REDIS_URL`. Opcional: `OPENAI_MODEL`, `LEADS_NOTIFY_WEBHOOK`.
- [ ] Sube `coparmex/presentacion.pdf`.
- [ ] Deploy a producción (merge de la rama `coparmex-landing` a `master`).
- [ ] Abre `https://thehagentic.com/coparmex` → registra un lead de prueba → verás el
      visor y el chat.
- [ ] Descarga el CSV con tu `ADMIN_TOKEN` y confirma el lead.
- [ ] Inserta `qr-coparmex.png` (raíz del repo) en la primera y última slide del PPTX.

## Rate limit y robustez
- `/api/coparmex/chat`: 30 req/hora por IP (fail-open si el store falla).
- Errores de OpenAI/Redis → mensaje amable al usuario, log interno, siempre responde.
- El registro se cachea en `localStorage`: quien ya se registró entra directo al visor.
