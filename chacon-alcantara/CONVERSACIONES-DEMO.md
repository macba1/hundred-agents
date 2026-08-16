# Conversaciones de demostración — Chacón Alcántara

> Generadas ejecutando el código real (`scratchpad/demo.js`), no escritas a mano.
> Cada bloque es un mensaje de WhatsApp. El tipo indica el formato enviado.


---

## 1 · Recorrer el catálogo y pedir por posición


**Tienda:** hola

**Agente** _(interactive)_:
```
Hola, Carnicería Pepe. ¿Qué necesitas hoy?
1. Repetir pedido
2. Ver catálogo
3. Precios y ofertas
También puedes escribirme o mandarme un audio
```

**Tienda:** _(pulsa «Ver catálogo»)_

_El clic se traduce a: «quiero ver el catálogo»_

**Agente** _(interactive)_:
```
Catálogo
¿Qué familia quieres ver?
— Familias —
1. Embutidos curados · 21 productos
2. Jamones, fiambres y coc… · 19 productos
3. Salchichas, morcillas y… · 8 productos
4. Quesos · 6 productos
5. Conservas de pescado · 7 productos
6. Congelados · 3 productos
7. Panadería · 6 productos
8. Membrillo y dulces · 6 productos
9. Otros productos · 14 productos
O dime directamente qué buscas
```

**Tienda:** enséñame los quesos

**Agente** _(text)_:
```
Esto tengo en quesos:
```

**Agente** _(image)_:
```
[307002] 1/2 QUESO MEZCLA SEMI SIN LACTOSA PLAZA VIEJA
Precio Tarifa 1: 11,458 €/kg, sin IVA
Caja: 4 unidades
Peso aproximado: 1,5 kg

Puedes pedirlo por cajas o unidades.
```

**Agente** _(image)_:
```
[7001] QUESO CURADO OCAÑA
Precio pendiente de que Chacón Alcántara lo confirme.
Caja: 2 unidades
Peso aproximado: 3 kg

Puedes pedirlo por cajas o unidades.
```

**Agente** _(text)_:
```
[8003] QUESO "EL HIDALGO" ACEITE GRANDE
Precio pendiente de que Chacón Alcántara lo confirme.
Caja: 2 unidades
Peso aproximado: 3,5 kg

Puedes pedirlo por cajas o unidades.
```

**Agente** _(text)_:
```
[8005] QUESO "EL HIDALGO" MINI-ACEITE
Precio Tarifa 1: 17,083 €/kg, sin IVA
Caja: 6 unidades
Peso aproximado: 1 kg

Puedes pedirlo por cajas o unidades.
```

**Agente** _(image)_:
```
[8009] 1/2 QUESO EL HIDALGO OVEJA CURADO
Precio Tarifa 1: 17,014 €/kg, sin IVA
Caja: 4 unidades
Peso aproximado: 1,5 kg

Puedes pedirlo por cajas o unidades.
```

**Agente** _(interactive)_:
```
Te enseño 5 de 6. Puedes responder, por ejemplo: «2 cajas del 0052», «3 unidades del segundo» o decirme el nombre del producto.
1. Ver más
2. Otras familias
3. Ver pedido
```

**Tienda:** ponme dos cajas del segundo

**Agente:**
```
¿Te refieres al código 7001, QUESO CURADO OCAÑA?
```

**Tienda:** sí

**Agente:**
```
He añadido 2 cajas de QUESO CURADO OCAÑA. ¿Quieres seguir viendo quesos, cambiar de familia o revisar el pedido?
```

---

## 2 · Cambiar de familia sin perder el carrito


**Tienda:** ¿qué tienes de pollo?

**Agente** _(text)_:
```
Con etiqueta «pollo» tengo esto:
```

**Agente** _(image)_:
```
[0003] PIEL DE POLLO
Precio Tarifa 1: 3,972 €/kg, sin IVA
Caja: 1 unidad
Peso aproximado: 5 kg

Puedes pedirlo por cajas o unidades.
```

**Agente** _(image)_:
```
[0449] EMBUTIDO DE POLLO DEL MIO
Precio Tarifa 1: 8,625 €/kg, sin IVA
Caja: 1 unidad
Peso aproximado: 0,4 kg

Puedes pedirlo por cajas o unidades.
```

**Agente** _(image)_:
```
[SP01] SALCHICHAS AVE MINI DEL MIO
Precio Tarifa 1: 7,722 €/kg, sin IVA
Caja: 1 unidad
Peso aproximado: 2 kg

Puedes pedirlo por cajas o unidades.
```

**Agente** _(image)_:
```
[1100] HOT DOG DE POLLO
Precio Tarifa 1: 1,282 €/kg, sin IVA
Caja: 4 unidades
Peso aproximado: 1 kg

Puedes pedirlo por cajas o unidades.
```

**Agente** _(image)_:
```
[1106] SALCHICHAS DE POLLO MINI 400GM
Precio Tarifa 1: 2,361 €/kg, sin IVA
Caja: 12 unidades
Peso aproximado: 0,4 kg

Puedes pedirlo por cajas o unidades.
```

**Agente** _(interactive)_:
```
Puedes responder, por ejemplo: «2 cajas del 0052», «3 unidades del segundo» o decirme el nombre del producto.
1. Otras familias
2. Ver pedido
```

**Tienda:** ver más

**Agente** _(interactive)_:
```
Puedes responder, por ejemplo: «2 cajas del 0052», «3 unidades del segundo» o decirme el nombre del producto.
1. Otras familias
2. Ver pedido
```

**Tienda:** revisar pedido

**Agente:**
```
SOLICITUD DE PEDIDO

Tienda: Carnicería Pepe

• [7001] QUESO CURADO OCAÑA OCAÑA — 2 cajas (2 uds/caja)
  Precio pendiente de que Chacón Alcántara lo confirme.

1 línea(s) sin importe estimado: Chacón Alcántara confirmará su precio o su peso. No te doy un total todavía.

Responde CONFIRMAR para enviar la solicitud o MODIFICAR para realizar cambios.
```

---

## 3 · Precio con estimación, y precio en conflicto


**Tienda:** ¿a cuánto está la piel de pollo?

**Agente:**
```
El precio de Tarifa 1 de PIEL DE POLLO es 3,972 €/kg, sin IVA. Código 0003 · marca DEL MIO · 1 uds/caja · 5 kg por unidad.
```

**Tienda:** ¿y cuánto vale una caja?

**Agente:**
```
El precio de Tarifa 1 de PIEL DE POLLO es 3,972 €/kg, sin IVA. Código 0003 · marca DEL MIO · 1 uds/caja · 5 kg por unidad. Cada caja contiene 1 pieza de aproximadamente 5 kg. Con un precio de 3,972 €/kg, el importe estimado de la caja sería 19,86 € sin IVA. El importe final se ajustará al peso real.
```

**Tienda:** ¿a cuánto está el 6302?

**Agente:**
```
Tengo dos precios registrados para este producto y necesito que Chacón Alcántara confirme cuál está vigente. Puedo añadirlo a tu solicitud y Fernando revisará el precio.
```

**Tienda:** ¿qué ofertas tienes?

**Agente:**
```
Ahora mismo no tengo ninguna oferta activa registrada. Si quieres, puedo preparar tu pedido o consultar el precio de cualquier producto.
```

---

## 4 · Referencia ambigua: no se adivina


**Agente** _(text)_:
```
En embutidos curados tengo:
```

**Agente** _(image)_:
```
[0052] CHORIZO PINCHO 1,5 KG APROX. DEL MIO
Precio Tarifa 1: 8,194 €/kg, sin IVA
Caja: 1 unidad
Peso aproximado: 3 kg

Puedes pedirlo por cajas o unidades.
```

**Agente** _(image)_:
```
[0053] CHORIZO PICANTE HRA. DEL MÍO
Precio Tarifa 1: 8,264 €/kg, sin IVA
Caja: 1 unidad
Peso aproximado: 3 kg

Puedes pedirlo por cajas o unidades.
```

**Agente** _(image)_:
```
[0072] 1/2 CAÑA DE LOMO REDONDA DEL MIO
Precio Tarifa 1: 14,931 €/kg, sin IVA
Caja: 8 unidades
Peso aproximado: 0,8 kg

Puedes pedirlo por cajas o unidades.
```

**Agente** _(image)_:
```
[21446] SALAMI EXTRA BLANCO
Precio pendiente de que Chacón Alcántara lo confirme.
Caja: 2 unidades
Peso aproximado: 1,85 kg

Puedes pedirlo por cajas o unidades.
```

**Agente** _(image)_:
```
[4315] SALCHICHON CASERO PRIMERA
Precio Tarifa 1: 2,888 €/kg, sin IVA
Caja: 6 unidades
Peso aproximado: 0,33 kg

Puedes pedirlo por cajas o unidades.
```

**Agente** _(interactive)_:
```
Te enseño 5 de 21. Puedes responder, por ejemplo: «2 cajas del 0052», «3 unidades del segundo» o decirme el nombre del producto.
1. Ver más
2. Otras familias
3. Ver pedido
```

**Tienda:** ponme ese

**Agente:**
```
Te he enseñado varios. ¿Cuál de ellos? Dime el código o la posición.
```

**Tienda:** el 0052

**Agente:**
```
Perfecto: 0052 — CHORIZO PINCHO 1,5 KG APROX. DEL MIO. ¿Cuántas cajas o unidades?
```

---

## 5 · Audio con cantidad ambigua


**Tienda:** _(nota de voz)_ «Ponme dos cajas del chorizo de pincho y tres del salami blanco»

**Agente:**
```
🎤 Te he entendido: «Ponme dos cajas del chorizo de pincho y tres del salami blanco»
```

**Agente:**
```
He añadido 2 cajas de CHORIZO PINCHO 1,5 KG APROX. DEL MIO.
Para el SALAMI EXTRA BLANCO, Cuando dices 3, ¿quieres 3 cajas o 3 unidades?
```

**Tienda:** cajas

---

## 6 · Cierre y confirmación


**Tienda:** revisar pedido

**Agente:**
```
SOLICITUD DE PEDIDO

Tienda: Carnicería Pepe

• [7001] QUESO CURADO OCAÑA OCAÑA — 2 cajas (2 uds/caja)
  Precio pendiente de que Chacón Alcántara lo confirme.
• [0052] CHORIZO PINCHO 1,5 KG APROX. DEL MIO DEL MIO — 2 cajas (1 uds/caja)
  8,194 €/kg sin IVA · ~6 kg · importe estimado 49,16 €
• [21446] SALAMI EXTRA BLANCO DEL MIO — 3 cajas (2 uds/caja)
  Precio pendiente de que Chacón Alcántara lo confirme.

2 línea(s) sin importe estimado: Chacón Alcántara confirmará su precio o su peso. No te doy un total todavía.

Responde CONFIRMAR para enviar la solicitud o MODIFICAR para realizar cambios.
```

**Tienda:** CONFIRMAR

**Agente:**
```
Hemos recibido tu solicitud de pedido correctamente. Chacón Alcántara la revisará y realizará el envío lo antes posible.
```

### Lo que recibe Fernando

```
📦 NUEVA SOLICITUD DE PEDIDO

Pedido: PED-2026-00001
Tienda: Carnicería Pepe
Teléfono: +34600111222
Fecha: 16/8/26, 21:40

Productos con precio confirmado:
• [0052] CHORIZO PINCHO 1,5 KG APROX. DEL MIO DEL MIO — 2 cajas (1 uds/caja) · 8,194 €/kg · ~6 kg · ~49,16 €

⚠️ Productos con precio PENDIENTE de confirmar:
• [7001] QUESO CURADO OCAÑA OCAÑA — 2 cajas (2 uds/caja)
• [21446] SALAMI EXTRA BLANCO DEL MIO — 3 cajas (2 uds/caja)

Sin importe estimado: 2 línea(s) sin precio confirmado.
IVA no calculado.

Observaciones:
Sin observaciones

⚠️ Avisos internos:
• [7001] tiene varios precios en el catálogo: tarifa por confirmar.
• [21446] tiene varios precios en el catálogo: tarifa por confirmar.

Estado: pendiente de revisión por Chacón Alcántara.
```
