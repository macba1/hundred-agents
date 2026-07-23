# Landing Coparmex — `/coparmex`

Página pública para la charla de **Coparmex San Miguel el Alto**: captura de leads +
visor de la presentación (PDF). Flujo en **2 pasos**: registro (nombre + correo) →
visor de la presentación. URL final: `https://thehagentic.com/coparmex`.

Integrada al proyecto Node/Vercel existente (funciones serverless en `api/`, estático
en la raíz). No modifica el sitio principal, la conferencia ni los clientes.

## Archivos
| Ruta | Qué es |
|---|---|
| `coparmex/index.html` | Página (2 pasos: registro → visor PDF) |
| `coparmex/presentacion.pdf` | La presentación (16 slides) |
| `coparmex/qr-coparmex.png` | QR 1000×1000 → `/coparmex` (copia también en la raíz del repo) |
| `api/coparmex/lead.js` | POST — guarda lead en Redis (+ notify opcional) |
| `api/coparmex/leads.js` | GET — export CSV (protegido con `ADMIN_TOKEN`) |
| `lib/coparmex.js` | Almacenamiento de leads en Redis |

> El chat/asistente se retiró: no hay `api/coparmex/chat.js`. Tras registrarse, la
> página muestra un texto fijo con el correo de contacto (`info@thehagentic.com`).

Reusa: `lib/notion.js` (`validEmail`) y el mismo Redis (`REDIS_URL`) ya conectado al
proyecto.

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
| `REDIS_URL` | ✅ (ya existe) | — | Guardar leads |
| `ADMIN_TOKEN` | ✅ **nueva** | — | Protege el CSV `/api/coparmex/leads` |
| `LEADS_NOTIFY_WEBHOOK` | opcional | — | POST genérico por cada lead nuevo (Slack/Sheet/etc.) |
| `WA_NOTIFY_TOKEN` | opcional | — | WhatsApp notify: token (= `WA_ACCESS_TOKEN` de whatsapp-demo) |
| `WA_NOTIFY_PHONE_ID` | opcional | — | WhatsApp notify: Phone Number ID de prueba |
| `WA_NOTIFY_TO` | opcional | — | WhatsApp notify: tu celular destino (E.164 sin +) |

## Notificación de leads a tu WhatsApp (opcional, DESACTIVADA)
El código en `api/coparmex/lead.js` ya reenvía cada lead como WhatsApp, pero está
**apagado** hasta que definas las 3 envs `WA_NOTIFY_*`. Para activarlo en Vercel:
```
WA_NOTIFY_TOKEN     = <WA_ACCESS_TOKEN permanente (System User) de whatsapp-demo>
WA_NOTIFY_PHONE_ID  = 1211779025353605
WA_NOTIFY_TO        = <tu celular, formato 5213...>
```
**Caveats del número de PRUEBA de Meta (por eso viene desactivado):**
- Solo envía a números en la **lista de destinatarios autorizados** (tu celular debe estar).
- Solo dentro de la **ventana de 24h**: si no le has escrito al número de prueba en las
  últimas 24h, el envío free-form falla (requeriría plantilla aprobada). Truco para el
  evento: mándale un WhatsApp al número de prueba al empezar → abre la ventana 24h y los
  avisos llegan durante el evento.
- Mete el token permanente en el env de ESTE proyecto (otra superficie de secreto).

Por estos límites, para el evento **el CSV es el canal confiable**. El WhatsApp notify
queda listo para activar si lo quieres, sabiendo lo anterior.

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
- [ ] En Vercel, define `ADMIN_TOKEN` (valor largo y secreto). Verifica que ya exista
      `REDIS_URL`. Opcional: `LEADS_NOTIFY_WEBHOOK`.
- [ ] Sube `coparmex/presentacion.pdf`.
- [ ] Deploy a producción (`master`).
- [ ] Abre `https://thehagentic.com/coparmex` → registra un lead de prueba → pasa al visor.
- [ ] Descarga el CSV con tu `ADMIN_TOKEN` y confirma el lead.
- [ ] Inserta `qr-coparmex.png` (raíz del repo) en la primera y última slide del PPTX.

## Robustez
- El visor usa pdf.js; si falla en un móvil viejo, el botón **Descargar presentación**
  (siempre visible) abre el PDF directo.
- Errores de Redis → mensaje amable al usuario, log interno.
- El registro se cachea en `localStorage`: quien ya se registró entra directo al visor.
