# Plantilla de WhatsApp para avisar a Fernando

## El problema, en una frase

WhatsApp solo deja enviar texto libre a alguien que te haya escrito **en las últimas
24 horas**. Fuera de esa ventana, Graph responde **HTTP 200** y el mensaje pasa
después a `failed`. Parece que funciona y no funciona.

Esto ya nos pasó con Sanmi. Por eso el sistema no marca la solicitud como recibida
hasta que llega el estado `delivered` del proveedor, y por eso hace falta una
plantilla aprobada para el primer contacto del día con Fernando.

## Cuándo hace falta

| Situación | Qué llega |
|---|---|
| Fernando escribió al número del agente hace menos de 24 h | El texto libre con la solicitud completa. **No hace falta plantilla.** |
| No ha escrito en 24 h | El texto libre **no llega**. Hace falta plantilla. |

En la práctica: si Fernando responde "ok" al agente una vez al día, la ventana se
reabre y todo el resto del día funciona con texto libre.

## Plantilla a dar de alta

Alta en **Meta Business Manager → WhatsApp Manager → Plantillas de mensaje → Crear**.

| Campo | Valor |
|---|---|
| Nombre | `chacon_nueva_solicitud` |
| Categoría | **Utility** (no Marketing: es una notificación operativa) |
| Idioma | Español (`es`) |

**Cuerpo:**

```
Nueva solicitud de pedido {{1}} de {{2}}.
Recibida el {{3}}. Pendiente de revisión.
Responde a este mensaje para ver el detalle completo.
```

| Variable | Contenido | Ejemplo |
|---|---|---|
| `{{1}}` | ID del pedido | `PED-2026-00042` |
| `{{2}}` | Nombre de la tienda | `Carnicería Pepe` |
| `{{3}}` | Fecha y hora | `16/08/2026 10:14` |

**Ejemplo para la revisión de Meta** (lo piden y rechazan la plantilla si falta):

> Nueva solicitud de pedido PED-2026-00042 de Carnicería Pepe. Recibida el
> 16/08/2026 10:14. Pendiente de revisión. Responde a este mensaje para ver el
> detalle completo.

### Por qué la plantilla no lleva el detalle

Las variables de plantilla no admiten saltos de línea ni listas, así que el pedido
completo no cabe. La plantilla solo **abre la ventana**: cuando Fernando responde
cualquier cosa, el detalle completo se le puede enviar como texto libre.

Tampoco lleva precios: en esta versión no existen.

## Qué falta para activarlo

Hoy el envío por plantilla **no está implementado**: cuando `FACTORY_WHATSAPP_NUMBER`
está configurado, el sistema envía texto libre y registra si el proveedor confirma la
entrega o no. Si empieza a fallar por la ventana de 24 h, se verá en el panel como
`fallido` con el código de error, y se podrá reintentar desde ahí.

Para automatizarlo hace falta, por este orden:

1. **Aprobar la plantilla** en Meta (suele tardar de minutos a 24 h).
2. Confirmar el **número emisor** del agente y ponerlo en `CHACON_WHATSAPP_SENDER_NUMBER`,
   para que la comprobación de "no puede escribirse a sí mismo" tenga efecto.
3. Que Fernando **escriba una vez** al número del agente, para dar de alta la
   conversación y poder probar de extremo a extremo.

Hasta entonces, dejar `FACTORY_WHATSAPP_NUMBER` sin definir mantiene el **modo
simulado**: la solicitud se registra íntegra en el panel y se escribe en el log, sin
enviar nada. Nada se pierde.

## Cómo se comprueba que llegó de verdad

`enviar()` guarda el `wamid` que devuelve Graph y lo asocia al pedido
(`ch:envio:{wamid}`). Cuando el webhook recibe el estado de ese `wamid`:

| Estado del proveedor | Qué se guarda |
|---|---|
| `delivered` / `read` | `entregado: true` — recién ahí cuenta como recibido |
| `failed` | `entregado: false`, estado `fallido`, con el código de error |
| `sent` | Sigue en `aceptado_por_proveedor` |

El panel muestra ese estado por solicitud, con un botón **Reintentar envío** en todo
lo que no esté entregado.
