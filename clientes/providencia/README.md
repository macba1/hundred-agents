# Dulces prOvidenCia — demo comercial

Demo **funcional** (no un mockup) del asistente comercial de WhatsApp que
Dulces prOvidenCia podría poner en producción en la Fase 1. Preparada para la
reunión de validación: el cliente prueba el agente, ve cómo llega un lead
cualificado y después recorre con nosotros las decisiones que faltan.

## URLs

| Dónde | URL |
|---|---|
| Local | `http://localhost:4321/clientes/providencia/` (ver *Correr en local*) |
| Producción (funciona ya) | `https://www.thehagentic.com/clientes/providencia/` |
| Producción (subdominio) | `https://providencia.thehagentic.com` — **falta un paso de DNS**, ver abajo |

## Qué compone la demo

```
clientes/providencia/
  index.html                  estructura de la página
  assets/css/providencia.css  paleta y componentes (azul #0e539c y naranja
                              #f79233 del logotipo real de Providencia)
  assets/js/agente.js         simulador de WhatsApp -> POST /api/demo-chat
  assets/js/catalogo.js       vitrina "Lo que el agente ya conoce"
  assets/js/validacion.js     wizard "Validemos juntos el alcance"
  assets/img/                 fotos de producto descargadas de su web y
                              convertidas a WebP (2 MB en total, sin hotlinks)

lib/wa/clients/providencia/
  config.json                 el cliente, con demo_web:true y activo:false
  prompt.md                   system prompt: reglas duras + cualificación
  catalogo.json               7 categorías, 19 productos, sin un solo precio

lib/wa/demo.js                adaptador de demo web (sin Redis, sin Meta)
api/demo-chat.js              GET vitrina · POST un turno del agente
```

## Arquitectura, en una frase

`api/demo-chat.js` → `lib/wa/demo.js` → reutiliza `lib/wa/clients.js`
(system prompt, datos del negocio, hora local de México), `lib/wa/catalog.js`
(búsqueda tolerante a acentos, plurales y faltas de ortografía) y la llamada a
OpenAI de `lib/wa/agent.js`.

Lo único que **no** reutiliza es el transporte, y es a propósito:

- `escalar_humano` del agente real **manda un WhatsApp a un número de verdad**.
  En una demo delante del cliente eso es un accidente esperando a pasar: aquí la
  herramienta devuelve el escalamiento como dato y no notifica a nadie.
- `registrar_pedido` escribe en Redis y consume folios de producción. Aquí
  `registrar_lead` solo devuelve la ficha que pinta la landing, con folio
  `PRV-DEMO-01`.
- Sin Redis, un corte del store no tumba la demo a media reunión.

El historial de la conversación viaja en el POST y vuelve en la respuesta: el
endpoint es sin estado, así que cualquier instancia serverless puede atender
cualquier turno. El historial que llega del navegador se sanea (`sanearHistorial`):
solo `user`/`assistant`, longitud acotada — un `role:"system"` colado desde el
navegador sería un secuestro del prompt.

`OPENAI_API_KEY` se queda en el servidor. El navegador nunca la ve.

## El subdominio: qué falta exactamente

`middleware.js` ya enruta `providencia.thehagentic.com` → `/clientes/providencia/`
(está en `CLIENT_SLUGS`). Lo que falta es DNS, y **no se puede hacer desde el repo**:

1. **No hay wildcard.** `thehagentic.com` usa los nameservers de Squarespace
   (`nsa1..4.squarespacedns.com`), no los de Vercel. Cada subdominio existe porque
   tiene su propio CNAME: `sanmi` y `architect` apuntan cada uno a su
   `<hash>.vercel-dns-016.com`. `providencia` hoy no resuelve a nada.

2. **Paso 1 — dar de alta el dominio en el proyecto** (genera el CNAME concreto):

   ```
   vercel domains add providencia.thehagentic.com hundred-agents
   ```

   o en Vercel → proyecto `hundred-agents` → Settings → Domains → Add.

3. **Paso 2 — crear el registro en Squarespace DNS**: un `CNAME` con host
   `providencia` apuntando al valor exacto que devuelva el paso 1.

Mientras tanto la demo **ya funciona** en
`https://www.thehagentic.com/clientes/providencia/`, que es la misma página.

> Por eso todas las rutas de assets son **absolutas** (`/clientes/providencia/...`).
> El matcher del middleware excluye cualquier ruta con punto, así que en el
> subdominio un `assets/img/x.webp` relativo se pediría a la raíz y daría 404.
> `lib/wa/demo.js` construye las rutas de imagen con `base_web` de `config.json`.

## Correr en local

```
node -r ./scripts/env-local.js scripts/demo-server.js
```

`scripts/env-local.js` toma `OPENAI_API_KEY` del primer `.env` que encuentre
(`.env.local`, `.env`, `whatsapp-agent/.env`) sin sobreescribir el entorno. Sin
clave la página carga y el catálogo se ve, pero el chat responde 502 diciéndolo.

## Pruebas

```
node scripts/providencia-smoke.js        # offline, sin gastar tokens
node -r ./scripts/env-local.js scripts/providencia-acceptance.js   # habla con OpenAI
```

El smoke cubre enrutado, catálogo, adaptador, endpoint, ausencia de secretos en
el frontend y **ausencia de regresiones** en Sanmi, demo-dulces, Chacón y el
sitio. Las de aceptación son los casos A–N del brief: que no invente precios, que
no afirme stock, que no prometa envío a Dallas, que escale los descuentos, que
cualifique a un distribuidor, que aguante una inyección de prompt.

## Lo que sigue siendo provisional

El agente **no tiene** —y no puede improvisar— ninguno de estos datos:

precios · tarifas de mayoreo · SKU · EAN · mínimos de compra · escalas por
volumen · promociones · descuentos · inventario · stock · zonas de entrega ·
costos de envío · tiempos de entrega · crédito · condiciones de pago ·
distribuidores por zona · listado de Amazon y Mercado Libre · fichas técnicas ·
alérgenos por producto · certificados por producto · política de muestras.

Están marcados como NO CONFIRMADO en `catalogo.json` y son exactamente lo que
pide el bloque "Materiales" del wizard de validación.

Además, **horario de sábado y domingo**: la web no lo publica. El catálogo lo
dice explícitamente y el agente ofrece confirmarlo.

## Pasar esto a WhatsApp real

No es automático. Hacen falta las dos cosas, no una:

1. En `config.json`: poner el `phone_number_id` del número de Dulces
   prOvidenCia y `activo: true`.
2. Apuntar el webhook de Meta a `/api/wa/webhook`.

Antes de eso hay que revisar la lista de NO CONFIRMADOS de arriba y decidir, con
el cliente, quién recibe los leads (`human_notify_wa`, hoy vacío a propósito).
Ojo: el agente de producción usa `registrar_pedido`/`escalar_humano`, que sí
escriben en Redis y sí mandan WhatsApp.
