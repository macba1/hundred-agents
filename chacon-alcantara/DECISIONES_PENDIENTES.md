# Decisiones pendientes — Chacón Alcántara S.L.

Cuestiones que **Chacón debe confirmar**. Mientras una siga abierta, el sistema
pide validación humana o informa de la limitación. **Nunca la inventa.**

Estado: 🔴 bloquea el MVP · 🟠 bloquea el lanzamiento · 🟡 mejora

---

## 🔴 Bloquean el MVP

### D-01 · Qué significa "Tarifa 1"
El PDF da un número por ficha (`3,403`, `21`, `50,694`) sin unidad. Sin esto **no
se puede calcular un subtotal**, que es el núcleo del agente.

- ¿Precio por **kilo**, por **unidad**, por **envase** o por **caja**?
- ¿Es el mismo criterio para todos los artículos, o depende del producto?

Dato de contexto, no conclusión: la mediana de `tarifa / peso_und` es 5,82.
Compatible con precio/unidad en productos de ~1 kg, pero no lo demuestra.

### D-02 · ¿La tarifa incluye IVA?
Y si no lo incluye, **qué tipo aplica a cada producto**. En alimentación en
España conviven varios tipos. Sin esto no hay total válido.

### D-03 · Los 19 códigos con dos precios
19 códigos aparecen 2-3 veces con **tarifas distintas y todo lo demás idéntico**
(misma descripción, mismo EAN, misma marca, mismas unidades/caja, mismo peso).
41 registros bloqueados.

Ver `data/duplicados.csv`. Por cada código hace falta saber **cuál es el precio
vigente**, o si el otro registro debe eliminarse.

Ejemplos del desacuerdo: `6302` 21 € vs 50,694 € · `5000` 0,633 € vs 1,278 € ·
`6803` 2,74 / 2,367 / 1,257 €.

### D-04 · Unidad de pedido por producto
¿Cada artículo se pide por **caja**, por **unidad**, por **kilo**, o depende?
`Und Caja` va de 1 a 98. Un "1" puede significar "se vende suelto" o "la caja
trae una pieza". El agente debe distinguirlo para no confirmar un pedido ambiguo.

### D-05 · A quién y cómo llega el pedido a fábrica
Correo, ERP, hoja de cálculo, panel. Y **quién** lo recibe. El MVP deja la capa
desacoplada, pero necesita un destino para dejar de ser una demo.

---

## 🟠 Bloquean el lanzamiento con clientes reales

### D-06 · Alérgenos sin informar
97 de 112 fichas no traen gluten ni lactosa. El sistema responde *"no tenemos ese
dato registrado, te lo confirma el equipo"* y **nunca** que no lo lleva.

¿Existe esa información en otro sistema? Si no, ¿quién la confirma y en cuánto
tiempo? Es el riesgo más serio del proyecto: una respuesta equivocada aquí es
sanitaria, no comercial.

### D-07 · Stock y disponibilidad
El catálogo no trae stock. Hoy el agente **no puede afirmar que algo esté
disponible**. ¿Hay fuente de stock? ¿O el pedido se acepta siempre sujeto a
confirmación de fábrica?

### D-08 · Pedido mínimo, múltiplos y unidades sueltas
¿Importe o cantidad mínima? ¿Hay artículos que solo se sirven en múltiplos de
caja? ¿Se pueden pedir unidades sueltas?

### D-09 · Tarifas por cliente
¿Todos los clientes tienen "Tarifa 1", o hay tarifas distintas por cliente,
volumen o zona? Si las hay, el catálogo debe versionarse por tarifa.

### D-10 · Reparto
Días, zonas, hora límite de pedido y gastos de envío.

### D-11 · Alta de clientes nuevos
¿Cualquier número puede pedir, o hace falta aprobación? ¿Qué datos son
obligatorios: nombre comercial, CIF, código de cliente, dirección?

### D-12 · Formas de pago y condiciones
Contado, giro, plazo. Y si el agente debe mencionarlas.

---

## 🟡 Mejoras, no bloquean

### D-13 · Descuentos y promociones
No hay ninguno en el catálogo. `OF3900 "SIN CARGO"` a 0,001 € parece un artículo
promocional; conviene confirmarlo y modelarlo como tal en vez de como precio.

### D-14 · Sustituciones
Si falta un producto, ¿puede el agente ofrecer alternativa? Hoy **no lo hace**:
sustituir sin autorización está prohibido.

### D-15 · Cancelación y modificación de pedidos
Hasta cuándo puede un cliente cambiar o anular un pedido ya enviado.

### D-16 · Fichas sin peso
6 fichas con `Peso Und = 0`: `3047` (LOTE), `4316`, `53100P`, `6710`
(HAMBURGUESAS 6 KG), `3909` (SACO 7,5 KG), `OF3900`. Sin peso no se puede
estimar peso total. ¿Es dato faltante o el producto no se pesa?

### D-17 · Códigos de barras
37 fichas sin EAN, y 4 con EAN cuyo dígito de control no cuadra. No impide
operar (la búsqueda por EAN simplemente no los encuentra), pero conviene saber
si falta el dato o está mal.

### D-18 · Imágenes
El PDF trae 110 imágenes. Aún **no se han extraído ni asociado**: hace falta
confirmar que la posición en página identifica la ficha sin ambigüedad antes de
enseñárselas a un cliente. Enviar la foto equivocada es peor que no enviar foto.

---

## Cómo se comporta el sistema mientras esto siga abierto

| Situación | Qué hace el agente |
|---|---|
| Producto con `price_conflict` | Lo muestra, **sin precio**, y avisa de que el equipo confirma el importe. No lo deja confirmar. |
| Alérgeno sin dato | "No tengo ese dato registrado, te lo confirma el equipo". Nunca "no lleva". |
| Sin stock conocido | No afirma disponibilidad. El pedido queda sujeto a confirmación. |
| Cantidad ambigua ("ponme 3") | Pregunta: "¿3 cajas o 3 unidades?" |
| Total con IVA no definido | Muestra base imponible y dice que el IVA lo confirma el equipo. |
| Pedido enviado | Dice **"enviado a Chacón"**, nunca "aceptado por fábrica". |

---

# Actualización — tras las respuestas parciales del cliente

## Resuelto

| # | Confirmado |
|---|---|
| D-01 | **Los precios son por kilo.** El cliente pide por cajas o unidades; se cobra por kilo. |
| D-02 | **Los precios NO incluyen IVA.** El tipo por producto sigue pendiente (ver P-05). |
| D-09 | **Las tarifas dependen de la cantidad, no del cliente.** Todos usan las mismas reglas. |
| D-05 | El pedido va por **WhatsApp a un número operativo de Chacón** (`FACTORY_WHATSAPP_NUMBER`). |
| D-11 | La tienda se identifica **por su nombre**, asociado al teléfono, con ID interno propio. |

## Pendientes que siguen bloqueando el cálculo

### P-01 · Reglas exactas de las 8 tarifas
Confirmado: T1 fracción de caja · T2 media caja · T3 caja completa · T4 más de una caja.
**Falta**: qué son T5, T6, T7 y T8.

### P-02 · Tabla completa de precios por tarifa y producto
El PDF trae **una sola cifra por ficha**. Con 8 niveles hacen falta hasta 8 precios por
artículo. Sin esa tabla, el sistema solo puede usar el precio que hay, y por eso lo
marca como tramo sin nivel conocido.

### P-03 · Definición de fracción y media caja
- ¿Qué cuenta como "fracción de caja"? ¿Cualquier cantidad por debajo de media?
- ¿Cómo se calcula media caja cuando la caja tiene un número impar de piezas?
  Hay artículos con `Und Caja` = 1, 15, 98…

### P-04 · Umbral de la Tarifa 4
"Más de una caja" ¿es a partir de 2 cajas, o hay un mínimo mayor?

**Mientras P-01 a P-04 sigan abiertos**, `elegirNivel()` solo resuelve dos casos sin
ambigüedad —una caja exacta (T3) y más de una caja entera (T4)— y devuelve
`indeterminada` en el resto. Nunca adivina el tramo.

### P-05 · IVA por producto
Sigue sin definirse. En el MVP ya no importa para el flujo: **no se muestra ninguna
cifra económica**. El campo queda preparado para la fase siguiente.

### ~~P-06 · Número de WhatsApp que recibe los pedidos~~ — **RESUELTO**
Destinatario interno: **Fernando**. Su número se configura **solo** por variable de
entorno (`FACTORY_WHATSAPP_NUMBER`), nunca en el código ni en `.env.example`, y
**no se le enseña a las tiendas** ni aparece en el panel: ahí solo sale el nombre
(`FACTORY_CONTACT_NAME`).

Antes de cada envío el sistema comprueba que ese número no coincida con:

| Coincidencia | Qué hace |
|---|---|
| El teléfono de la tienda | No envía. Sería una fuga de datos y no llegaría a fábrica. |
| El número emisor del agente (`CHACON_WHATSAPP_SENDER_NUMBER`) | **No lo intenta** y muestra una advertencia de configuración en el panel. Un número no puede escribirse a sí mismo. |

Sin `FACTORY_WHATSAPP_NUMBER` definido, el envío queda en **modo simulado** y se
registra igual en el pedido.

**Pendiente antes de operar de verdad**: la ventana de 24 horas de WhatsApp. Si
Fernando no ha escrito al número del agente en las últimas 24 h, el mensaje libre
no le llega —Graph devuelve 200 y luego el estado pasa a `failed`—. Hace falta una
plantilla aprobada. Ver `PLANTILLA_WHATSAPP.md`.

### P-07 · Stock
Sin fuente. El agente **nunca afirma disponibilidad**; la interfaz de stock está
preparada para conectarla después.

### P-08 · Alérgenos
Sin fuente adicional. 97 de 112 fichas sin dato. Las consultas sin dato se registran
en el log para que alguien las conteste.

### P-09 a P-16
Pedido mínimo · días y zonas de reparto · hora límite · gastos de transporte ·
sustituciones · promociones y artículos sin cargo · proceso interno de aceptación y
modificación · responsable de comunicar la fecha de entrega.

## Los 19 códigos repetidos: reanalizados

Ya **no** se tratan como error. Se buscó en el PDF evidencia para asignar cada precio a
un nivel de tarifa:

| Evidencia | Resultado |
|---|---|
| Cabecera o sección que nombre la tarifa | no existe ninguna |
| Registros consecutivos en el documento | **sí, en los 19 códigos** |
| Precio monótono en ese orden | **no**: 8 descendentes, 9 ascendentes, 2 sin orden |

Están agrupados como variantes, pero la posición **no identifica el nivel**: si fueran
T1→T2→T3, el precio por kilo bajaría al aumentar la cantidad, y no lo hace.

Por eso quedan como **`tariff_variant_unresolved`** con `nivel_tarifa: "unknown"` y la
evidencia guardada en cada registro. **Se pueden buscar y pedir**; lo único bloqueado es
el cálculo automático del precio.


---

# Actualización — MVP simplificado

El objetivo de esta primera versión **no es cotizar**. Es que una tienda prepare y
envíe por WhatsApp una **solicitud de pedido estructurada**.

## Qué deja de intervenir

Precios, tarifas, subtotales, IVA, importes estimados y conversión de cajas a euros
**siguen calculándose y guardándose**, pero se recortan antes de llegar al modelo y a
la tienda (`lib/chacon/mvp.js`). Si el modelo no recibe una cifra, no puede enseñarla
ni construir un total con ella.

Poner `CHACON_MOSTRAR_PRECIOS=1` los devuelve al flujo cuando estén confirmados, sin
tocar la lógica de negocio.

## Qué deja de bloquear

| Antes | Ahora |
|---|---|
| Los 19 códigos con varios precios no podían valorarse | **Se piden con normalidad.** Siguen marcados `tariff_variant_unresolved` internamente y salen como aviso en el mensaje a Fernando. |
| Las 6 fichas sin peso bloqueaban el importe | **Se piden con normalidad.** El peso sigue registrado como desconocido. |
| `OF3900` promocional | Se pide con normalidad, con aviso interno. |

## Qué sigue bloqueando, igual que antes

- Una cantidad sin unidad ("ponme 3") → se pregunta caja o unidad, no se adivina.
- Un producto que no existe en el catálogo.
- Una tienda sin nombre.
- Un carrito vacío.
- Afirmar stock, aceptación o fecha de entrega.
- Afirmar que algo no lleva un alérgeno cuando el dato no consta.

## Decisiones que dejan de ser urgentes

D-01 a D-04, D-08, D-09, D-16 y P-01 a P-05 **ya no bloquean el MVP**: sin cálculo
económico no hacen falta para tomar una solicitud. Siguen abiertas y vuelven a ser
necesarias en cuanto se quiera valorar el pedido.

Las que **siguen bloqueando el lanzamiento con clientes reales** son las de riesgo,
no las de dinero: **D-06 (alérgenos sin informar)**, D-07 (stock), D-10 (reparto),
D-11 (alta de clientes) y D-18 (imágenes).
