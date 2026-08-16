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
