# Catálogo nativo de WhatsApp — diagnóstico y puesta en marcha

## 1 · Diagnóstico de la cuenta · `Fallido`

Ejecutado contra Graph el 2026-08-16 desde `/api/chacon/diagnostico`:

| Dato | Valor |
|---|---|
| `phone_number_id` | `1211779025353605` |
| Número | **+1 555-150-6096** |
| `verified_name` | **`Test Number`** |
| `code_verification_status` | `NOT_VERIFIED` |
| `is_official_business_account` | `false` |
| `messaging_limit_tier` | `TIER_250` |
| `whatsapp_commerce_settings` | **`{"data": []}`** — no existen |
| Permisos del token | `whatsapp_business_management`, `whatsapp_business_messaging`, `public_profile` |
| Permisos que faltan | **`business_management`**, **`catalog_management`** |
| WABA | no legible con este token |
| Catálogos conectados | no legible sin WABA |

### Conclusión

**El catálogo y el carrito nativos no se pueden activar en este número.** Es el
número de demostración compartido de Meta. No es un problema de configuración:
no hay ajuste que se lo añada.

Tres cosas fallan a la vez, y cada una bastaría por sí sola:

1. Es un número de prueba. `whatsapp_commerce_settings` viene vacío porque el
   número no admite comercio.
2. El token no tiene `catalog_management` ni `business_management`, así que ni
   siquiera puede crear o conectar un catálogo.
3. Sin acceso al WABA no se puede saber a qué Business Portfolio pertenece ni
   conectarle nada.

No he usado un catálogo de prueba ajeno ni he mezclado productos de Sanmi.

## 2 · Qué hace falta, en orden

Todo esto lo tiene que hacer **el propietario de la cuenta de Meta**. No son
pasos de programación y no los puedo hacer yo.

1. **Un número propio de Chacón**, no el de prueba. Alta en WhatsApp Manager y
   verificación por SMS o llamada.
2. **Verificación del negocio** (Business Verification) en el Business
   Portfolio. El comercio en WhatsApp la exige. Suele pedir CIF y documentación
   de la sociedad; tarda de días a semanas.
3. **Aceptar las políticas de comercio** de WhatsApp en Commerce Manager.
4. **Crear un catálogo nuevo** en Commerce Manager, tipo *E-commerce*, solo
   para Chacón Alcántara.
5. **Conectarlo al WABA** desde WhatsApp Manager → Catálogo.
6. **Activar el carrito** en los ajustes de comercio del número.
7. **Regenerar el token** con `catalog_management` y `business_management`
   añadidos, y actualizar `WHATSAPP_TOKEN` en Vercel.
8. Volver a lanzar `/api/chacon/diagnostico` y comprobar que
   `commerce_settings` ya trae `is_cart_enabled: true`.

Hasta el paso 8, el agente conversacional sigue funcionando igual: catálogo por
familias, fotos, precios, ofertas, repetición de pedidos y voz. Lo único que no
existe es la ficha nativa de Meta.

## 3 · El precio y el mensaje «La empresa proporcionará el precio total»

**Verdicto: `No verificado`.** No he podido reproducirlo porque no hay número
con comercio. Lo que sí está establecido:

- El precio es un **campo opcional** en un catálogo de WhatsApp.
- El feed que genero **va sin precio a propósito**, y esa es la única forma de
  no enseñar un total falso.

El motivo es aritmético, no estético. Chacón cobra **por kilo** y la tienda pide
**cajas**. Si la ficha llevara `8,194 €`, WhatsApp multiplicaría por el número de
cajas y enseñaría un total que no es el que se va a facturar — y que además
cambia con el peso real de cada pieza. Cualquier precio que pusiéramos ahí sería
mentira. Por eso el feed no lleva ninguno, y por eso no uso `0 €`, `0,001 €` ni
el precio por kilo disfrazado de precio unitario.

**Lo que hay que comprobar en la prueba piloto** es si WhatsApp, con productos
sin precio, muestra exactamente el texto de la captura de Fernando o uno
equivalente. Si en vez de eso rechazara el producto por falta de precio, la
decisión vuelve a ti: no hay un precio honesto que poner.

El agente sigue respondiendo el precio cuando se lo preguntan:

> El precio de Tarifa 1 de [producto] es X €/kg, sin IVA.

## 4 · El feed

Se genera desde nuestra base, que es la fuente única:

```
python3 chacon-alcantara/import/generar_feed_meta.py --base-url https://www.thehagentic.com
```

Salida: `data/feed-meta.csv` + `data/feed-meta-informe.json`.

**81 productos en el feed, 31 registros excluidos:**

| Motivo | Registros |
|---|--:|
| Código repetido en el PDF (ya está en el feed una vez) | 20 |
| Imagen en `pending_review` | 7 |
| Imagen `missing` | 3 |
| `OF3900`, promoción sin condiciones | 1 |

`product_retailer_id` = **código de Chacón**. Es la pieza que une los dos
mundos: lo que vuelve en el carrito es ese código y con él se valida contra
nuestro catálogo.

Lo excluido **sigue disponible por búsqueda conversacional**. Una tienda puede
pedir un queso que no está en el catálogo visual; simplemente no lo ve como
ficha con foto.

### Prueba piloto

```
python3 chacon-alcantara/import/generar_feed_meta.py \
  --base-url https://www.thehagentic.com --piloto 0052
```

Genera `feed-meta-piloto-0052.csv` con un solo artículo — *Chorizo Pincho Del
Mío*, caja de 1 unidad, ~3 kg, foto verificada. Es el que hay que subir primero.

**Criterios de aceptación del piloto**, tal y como los pediste:

- [ ] El producto muestra su imagen y su descripción.
- [ ] El cliente puede añadirlo al carrito.
- [ ] El carrito **no** presenta un total.
- [ ] WhatsApp indica que Chacón proporcionará el importe.
- [ ] El webhook recibe código y cantidad → se comprueba en los logs con
      `[chacon] carrito nativo de …`.

## 5 · Cómo se carga y se actualiza

**Carga inicial** — Commerce Manager → Catálogo → *Artículos* → *Añadir
artículos* → *Subir archivo* → `feed-meta.csv` → revisar el diagnóstico de Meta.

**Actualizaciones** — subir el CSV regenerado sobre el mismo catálogo. Meta
actualiza por `id`, así que los productos conservan su historial.

**Programado**, recomendado en cuanto el piloto valide: Commerce Manager →
*Fuentes de datos* → *Feed programado* apuntando a una URL que sirva el CSV, con
frecuencia diaria.

**Cómo saber si Meta aceptó la actualización**: Commerce Manager → *Fuentes de
datos* → última subida. Muestra artículos procesados, actualizados y rechazados
con el motivo. Un rechazo típico será una `image_link` que no responde: se
comprueba abriendo la URL de la imagen en el navegador.

**No se mantienen dos catálogos a mano.** Todo sale de
`catalogo-normalizado.json` + `clasificacion-productos.json` + `imagenes.json`:
el catálogo del agente, el feed de Meta, las imágenes públicas, las familias,
los precios de Tarifa 1 y los estados activo/inactivo. Editar productos a mano
en Commerce Manager los dejaría desincronizados en la siguiente subida.

## 6 · Qué ya está construido y probado

Aunque el catálogo nativo no se pueda activar todavía, la recepción **está
implementada y probada** (`lib/chacon/carrito-nativo.js`, 15 comprobaciones):

- El webhook reconoce el mensaje `order` y extrae `catalog_id`,
  `product_retailer_id`, cantidad, precio y moneda recibidos, `wamid`, teléfono
  y fecha.
- Cada código se valida contra nuestro catálogo. **El nombre y el precio que
  manda Meta se guardan como traza y no se usan nunca**: el precio se recalcula
  siempre con el nuestro.
- Caja o unidad: si la caja trae una sola unidad no se pregunta; si trae varias,
  sí. Un pedido ambiguo **no se puede confirmar** — está bloqueado en código.
- Idempotente por `wamid`: un carrito repetido no duplica líneas.
- El carrito original se conserva íntegro en el pedido, como prueba de qué pidió
  la tienda antes de que nadie interpretara nada.
- Convive con lo pedido por texto o por voz en el mismo carrito.

## 7 · Payload que se espera

Este es el mensaje que WhatsApp envía al pulsar «Realizar pedido», y el que
procesa el webhook. **Todavía no se ha recibido uno real** — no puede haberlo
sin catálogo conectado:

```json
{
  "from": "34600111222",
  "id": "wamid.HBgL...",
  "timestamp": "1755374400",
  "type": "order",
  "order": {
    "catalog_id": "1234567890",
    "text": "",
    "product_items": [
      { "product_retailer_id": "0052", "quantity": 2,
        "item_price": 8.194, "currency": "EUR" }
    ]
  }
}
```

En cuanto llegue el primero, aparecerá completo en los logs de producción bajo
`[chacon] carrito nativo de …`.
