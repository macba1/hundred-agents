# Sanmi Café — cliente del agente de WhatsApp

Cafetería-restaurante en **San Miguel el Alto, Jalisco** (C. Santuario 8, Centro).
Corre con la **carta real** (96 platillos, precios verdaderos) sobre el número de
pruebas de Meta que antes usaba `demo-dulces`.

| | |
|---|---|
| Clave | `sanmi` |
| Estado | activo · `modo_demo: true` |
| `phone_number_id` | `1211779025353605` — **número DEMO de Meta**, prestado |
| Número que ve el cliente | `+1 555-150-6096` (`Test Number` de Meta) |
| Escalamientos a | `+1 650 384 9019` (`human_notify_wa`), verificado en la lista *To* |
| Folios | `SNM-0001`, `SNM-0002`, … |
| Panel | `/leads?client=sanmi` |
| Límites | 60 turnos por contacto · 30 mensajes de memoria · 5 audios/día |

`demo-dulces` quedó **inactivo** con su carpeta intacta: comparte el mismo
`phone_number_id`, y el arranque falla a propósito si los dos están activos.

---

## `modo_demo` — el único interruptor para lanzar

```jsonc
// config.json
"modo_demo": true,
"aviso_demo": "⚠️ Estamos en periodo de pruebas: este pedido es de práctica y no se preparará."
```

Con el flag **activo**, el agente atiende **normal**: toma el pedido completo,
pregunta lo que falte, lo registra y confirma **folio y total**. Lo único que
cambia es que agrega `aviso_demo` al final del mensaje que confirma un pedido.
No escala pedidos por ser periodo de pruebas.

**Para lanzar en real: poner `modo_demo` en `false`.** Nada más. No hay que tocar
`prompt.md` ni el código.

---

## Archivos

| Archivo | Qué contiene | Cuándo se toca |
|---|---|---|
| `config.json` | `phone_number_id`, `modo_demo`, límites, `human_notify_wa`, zona horaria | Al migrar al número real y al lanzar |
| `prompt.md` | Personalidad, guardarraíles, formato de pedido | Si cambia el tono o el alcance |
| `catalogo.json` | **Carta real**: dirección, horarios, domicilio, pagos y 96 platillos con precio | Cuando Sanmi cambie precios o menú |

Los tres se recargan **al reiniciar el proceso**. No hay recarga en caliente.

### Estructura del catálogo

Anidada: `categorias → subcategoría → items`. Cada subcategoría puede traer
`descripcion`, `extras` (con precio) y `sinonimos`. El agente la aplana sola.

```jsonc
"favoritos": {
  "panninis": {
    "descripcion": "Todos servidos con papas o ensalada.",
    "sinonimos": ["pannini", "panini", "sándwich caliente"],
    "items": [ { "nombre": "Pannini Arrachera", "precio": 99 } ]
  }
}
```

`sinonimos` es solo para búsqueda y **no se le manda al modelo**. Existe porque
las subcategorías tienen nombres en inglés (`coffee`, `frias`, `burgers`) y el
cliente escribe en español: sin ellos, "¿qué cafés tienen?" devolvía 1 resultado
en vez de 12.

Los datos del negocio (dirección, horarios, domicilio, pagos, notas) viven en el
**nivel superior de `catalogo.json`** y se inyectan solos al system prompt.
`datos` en `config.json` está vacío a propósito: lo que pongas ahí **sobrescribe**
al catálogo y crea dos versiones del mismo horario.

---

## Pendientes de datos (marcados `VERIFICAR` en `catalogo.json`)

1. **Costo de envío a domicilio** — hoy el agente dice que el equipo lo confirma
   al recibir el pedido, y no inventa cifra.
2. **Horario del jueves** — Google marca distinto que el resto de la semana.

Pagos confirmados con el staff: **efectivo y transferencia**; a domicilio,
efectivo contra entrega. (No tarjeta.)

---

## Migración al número real de Sanmi

> **El único campo que cambia en el código es `phone_number_id` en
> `clients/sanmi/config.json`.** El enrutado del webhook es por ese valor.

### En el panel de Meta (una sola vez)

1. Meta for Developers → la app → **WhatsApp → API Setup**.
2. **Add phone number**: dar de alta el número real de Sanmi Café en el WhatsApp
   Business Account y completar la verificación por SMS/llamada.
3. Registrar el **nombre para mostrar** del negocio y esperar aprobación de Meta.
4. Copiar el **Phone number ID** del número nuevo (el número largo junto al
   teléfono; **no** es el teléfono ni el WABA ID).
5. Cambiar el access token temporal por uno **permanente**: *System User* con
   `whatsapp_business_messaging` + `whatsapp_business_management`.
6. **Configuration → Webhook**: misma URL y mismo *verify token*
   (`WHATSAPP_VERIFY_TOKEN`), con el campo **`messages`** suscrito. El webhook es
   uno solo para toda la app y sirve para todos los números.

### En el repo

7. Editar `clients/sanmi/config.json`:

   ```jsonc
   {
     "phone_number_id": "<PHONE_NUMBER_ID_REAL_DE_SANMI>",  // ÚNICO cambio obligatorio
     "modo_demo": false                                     // quita el aviso de pruebas
   }
   ```

8. Subir el token permanente a `.env` (`WHATSAPP_TOKEN`).
9. Reiniciar y validar:

   ```bash
   python check_config.py     # sanmi ACTIVO con el número real, calidad GREEN
   python smoke_test.py       # regresión offline
   curl localhost:8000/health # "clientes": sanmi con el phone_number_id nuevo
   ```

10. Mandar un mensaje real desde otro teléfono y confirmar que aparece en
    `/leads?client=sanmi`.

### Reactivar `demo-dulces` (opcional)

Con Sanmi en su número propio, el número demo queda libre:
`clients/demo-dulces/config.json` → `"activo": true`. Ya no hay conflicto.

### Qué NO hay que tocar

- El código (`main.py`) — el enrutado ya es por `phone_number_id`.
- `WHATSAPP_VERIFY_TOKEN` ni la URL del webhook.
- La base de datos: el historial queda bajo `client='sanmi'`. Para empezar limpio:

  ```sql
  DELETE FROM leads    WHERE client='sanmi';
  DELETE FROM messages WHERE client='sanmi';
  DELETE FROM sessions WHERE client='sanmi';
  ```

---

## `human_notify_wa` — funcionando

`+1 650 384 9019`, dado de alta y verificado en la lista *To* de Meta. Verificado
end-to-end el 2026-07-28: envío real **HTTP 200**.

Formato del aviso:

```
🔔 Sanmi Café — 28/07/2026 17:15 (CDMX) — escalado de +5215550000005: El cliente
solicita una malteada de lotus, que no está en el menú. Quiere saber si es
posible prepararla.
```

Si el primario falla, el agente reintenta solo con `human_notify_wa_alt`
(`523471053350`, que hoy NO está en la lista *To* y por eso rebota con
`(#131030) Recipient phone number not in allowed list`).

Con el número real de Sanmi esa restricción desaparece: los números productivos
escriben a cualquier destinatario.

---

## Onboarding de probadores del staff

Mientras Sanmi use el **número demo de Meta**, este solo puede escribirle a
destinatarios dados de alta a mano. Por cada persona del staff hay **dos cosas**,
y son independientes:

### A. Para que pueda CONVERSAR con el agente (obligatorio)
Su número tiene que estar en la lista *To* de Meta. Sin esto, el agente recibe su
mensaje pero **la respuesta rebota** con `(#131030) Recipient phone number not in
allowed list`.

> Abrir **https://developers.facebook.com/apps/1383723313727744/whatsapp-business/wa-dev-console/**
> → sección **To** → *Manage phone number list* → **Add phone number** → escribir
> el número con lada país (`+52 …`) → confirmar el código que le llega por WhatsApp
> a esa persona.

Meta permite hasta 5 destinatarios de prueba. Si el staff es más grande, hay que
migrar al número real de Sanmi (ver arriba), donde no existe esta restricción.

### B. Para que RECIBA los escalamientos (opcional)
`human_notify_wa` acepta un número o una lista. Todos los de la lista reciben el
aviso:

```jsonc
// config.json
"human_notify_wa": ["16503849019", "523471109971", "523471053350"]
```

> **México va sin el 1: `52` + 10 dígitos.** El `wa_id` canónico que devuelve
> Meta sí lleva el 1 (`5213471109971`), pero Graph **solo acepta como input la
> forma sin él** y lo añade solo. Mandarle el canónico devuelve
> `(#131030) Recipient phone number not in allowed list` — un error que culpa a
> la lista de autorizados cuando el número está perfectamente autorizado.
> `lib/wa/whatsapp.js` ya normaliza al enviar, así que da igual cómo lo escribas
> aquí; pero al depurar a mano, usa `52` + 10.

Ojo: un número solo recibe el escalamiento si además está en la lista *To* del
paso A. Si no, el envío rebota y el log lo marca con `NO se pudo notificar`.

Tras editar el `config.json` hay que **redesplegar** (los catálogos y configs
viajan en el bundle).

## Probar

```bash
python check_config.py                    # configuración y enrutado
python smoke_test.py                      # regresión offline, sin llaves
python test_sanmi_real.py                 # batería a-g; los escalados SÍ salen por Meta
python test_sanmi_real.py --sin-notify    # igual, pero nada sale por Meta
python make_audio_fixture.py              # regenera fixtures/*.ogg con TTS
```
