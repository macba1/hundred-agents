# Rediseño de la experiencia de compra — análisis A–H

Todo lo que hay aquí está medido contra el código y los datos reales, no
estimado. Los comandos que producen cada cifra están al pie de cada sección.

---

## A · Cómo funciona hoy

Un mensaje entra por `api/chacon/webhook.js`, se clasifica (texto · audio ·
clic · carrito nativo) y va a `agente.responder()`, que es un bucle de
herramientas sobre GPT con 16 tools. El modelo decide qué llamar; el código
decide qué es verdad.

Lo determinista ya está bien repartido: precios en `tarifas.js`, tramos en
`tramos.js`, carrito en `pedido.js`, ofertas en `ofertas.js`. Nada crítico lo
calcula el modelo.

Lo conversacional **no está estructurado**: no hay estados, no hay flujo. El
prompt tiene 129 líneas y 6.302 caracteres describiendo cuándo usar cada
herramienta. El modelo improvisa el recorrido en cada conversación.

Los componentes interactivos (`botones`, `lista`, `imagen`) existen en
`wa-formato.js` con alternativa textual, pero **ningún cliente real ha
recibido uno todavía**: solo se han ejercitado en pruebas.

---

## B · Problemas, con la evidencia delante

### B.1 La búsqueda se rompe con lenguaje natural

Medido sobre el catálogo real:

| Consulta | Qué devuelve hoy |
|---|---|
| `que salchichones tienes` | **Quesos.** El token `que` casa con `queso` |
| `el chorizo de Marcial` | **75 resultados.** `el` y `de` casan con todo |
| `algo de jamon` | **62 resultados** |
| `choriso cular` | **SALCHICHÓN** cular, no chorizo |
| `chorizo iberico marcial` | 21, y el primero es un **LOMITO** |
| `embutido` | **1 resultado**, habiendo 21 en esa familia |
| `uno sin gluten` | Devuelve `OF3900`, un artículo **bloqueado** |

Cuatro causas, todas de diseño:

1. **No hay palabras vacías.** `que`, `el`, `de`, `algo` se tratan como
   términos de búsqueda. Cuando el AND falla, el OR con esas palabras arrasa.
2. **No hay plural.** `salchichones` no encuentra `SALCHICHON`.
3. **La búsqueda difusa nunca se dispara** si el OR ya encontró algo, así que
   una errata acompañada de una palabra correcta se queda sin corregir.
4. **El ranking cuenta tokens**, sin distinguir el sustantivo principal de un
   adjetivo. Por eso `chorizo iberico marcial` corona un lomito.
5. **No conoce familias ni atributos reales.** `embutido` no abre la familia,
   y `sin gluten` hace coincidencia de texto en vez de mirar el campo.

### B.2 El código es la interfaz de facto

`consultar_precio` y `anadir_al_carrito` funcionan bien con un código y regular
con un nombre. Cuando la búsqueda devuelve 75 candidatos, el modelo no tiene
mejor salida que pedir el código. **Es exactamente lo que la restricción 19
prohíbe.**

### B.3 Los duplicados y los artículos internos se cuelan

La búsqueda devuelve registros crudos: los 19 códigos duplicados salen dos
veces, y `OF3900` aparece en resultados pese a no ser comprable.

### B.4 Ruido conversacional

111 literales de mensaje de más de 60 caracteres. Se explica el mecanismo
—"precio pendiente de confirmar", "importe estimado sobre peso teórico"— en
casi todos, cuando basta una vez al final.

### B.5 Sin estado

No existe un concepto de "estoy eligiendo cantidad". El contexto vive en
`ch:contexto:{telefono}` solo para "el segundo". Un cliente que abandona a
mitad y vuelve no retoma nada.

---

## C · Métrica de partida

Sobre los **88 productos comerciales** (los 133 de tarifa menos internos y
`OF*`), buscando por las dos primeras palabras significativas del nombre:

| | |
|---|--:|
| Encontrado en 1ª posición | 68 · **77 %** |
| Encontrado en top-3 | 84 · **95 %** |
| No encontrado en top-3 | 4 · 5 % |
| Con foto verificada | 80 · **91 %** |

Los 4 fallos son variantes de tamaño del mismo artículo (`6803`/`6804`
chopped, `30101`/`30301`/`30701` caballa, `8003`/`8009` queso Hidalgo). No es
un fallo de descubrimiento: es **desambiguación**, y la solución es
enseñarlas juntas y dejar elegir, no afinar el ranking.

**Conclusión: el catálogo es navegable sin código; lo que falla es entender
cómo habla el cliente.**

---

## D · Componentes de WhatsApp

Qué soporta de verdad nuestra integración hoy:

| Componente | Estado | Uso previsto |
|---|---|---|
| Texto | ✅ en producción | fichas, resúmenes |
| Botones de respuesta (≤3) | ✅ implementado, **sin probar con cliente real** | home, cantidad, tras añadir |
| Lista interactiva (≤10 filas/sección) | ✅ implementado, sin probar | familias, resultados, editar carrito |
| Imagen con pie | ✅ implementado, sin probar | ficha de producto |
| Alternativa 100 % textual | ✅ probada | modo simulado y si Graph rechaza |
| Catálogo/carrito nativo | ❌ **bloqueado por la cuenta** | requiere número propio verificado |

Límites de Meta que condicionan el diseño: **3 botones**, título ≤ 20
caracteres; lista de **10 filas** por sección, título ≤ 24, descripción ≤ 72.
Eso obliga a paginar familias de 21 productos y descarta enseñar 25 de golpe.

---

## E · Decisión de UX sobre las tarifas

**El cliente no debe ver "Tarifa 1" ni "Tarifa 3".** Son nuestra estructura
interna y la restricción 18 lo prohíbe. Un tendero no compra "tarifa 3":
compra una caja.

Se sustituye por la unidad que entiende:

```
Por pieza:  15,278 €/kg
Por caja:   12,500 €/kg   ← te sale mejor
```

Los nombres de tarifa se conservan en logs, panel y mensaje a Fernando, donde
sí son útiles.

---

## F · Búsqueda: reglas primero, LLM solo para interpretar

La separación es la de la restricción 25: **lenguaje del cliente →
interpretación → búsqueda en catálogo real → producto real**.

El LLM traduce "ese chorizo ibérico grande de Marcial" a entidades
(`producto=chorizo`, `marca=marcial`, `atributo=iberico`). **Nunca elige el
producto.** La selección la hace `descubrimiento.js` con ranking determinista
sobre el catálogo, y siempre devuelve un `producto_id` real o ninguno.

Sin embeddings en el MVP: con 88 productos y un vocabulario cerrado, el coste
y la opacidad no se pagan. Reglas + fuzzy + alias resuelven esto mejor y se
pueden depurar.

Umbral de confianza y cuándo preguntar:

| Situación | Qué hace |
|---|---|
| Un candidato claramente por delante | lo propone y sigue |
| 2-5 candidatos próximos | los enseña y **pregunta** |
| >5 candidatos | ofrece afinar por familia o marca |
| 0 candidatos | sugiere familias, no pide código |
| 2 intentos sin identificar | **ofrece hablar con Fernando** |

---

## G · Aliases

Se construyen de fuentes controladas, nunca aprendidos solos de una
conversación (restricción 27):

1. Nombre del catálogo, tokenizado y sin palabras vacías.
2. Marca.
3. Familia y subcategoría ya clasificadas.
4. Formas cortas derivadas del nombre (`chorizo cular` → `cular`).
5. Vocabulario controlado, revisable en el panel.

Un alias propuesto por el uso queda **pendiente de validación**; no entra en
la búsqueda hasta que una persona lo aprueba.

---

## H · Plan por fases

| Fase | Qué | Verificable con |
|---|---|---|
| **1** | Capa de descubrimiento: palabras vacías, plurales, familias, marcas, atributos reales, ranking con confianza, sin duplicados ni internos | batería de consultas reales |
| **2** | Máquina de estados explícita y persistida | pruebas de transición |
| **3** | Home guiado y flujo de pedido con componentes nativos | conversación E2E sin códigos |
| **4** | Ficha de producto, cantidad, carrito y edición | pruebas de carrito |
| **5** | Habituales, ofertas por familia, handoff | pruebas de histórico |
| **6** | Auditoría de copies y métricas | recuento de mensajes |

La prueba de aceptación del punto 37 —cliente que no conoce ninguna
referencia completa un pedido— cierra la fase 4.
