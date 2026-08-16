# Agente comercial de WhatsApp — Chacón Alcántara S.L.

Distribución mayorista de alimentación (Aldea Quintana, La Carlota, Córdoba).
Las tiendas consultan catálogo, arman su carrito y envían un pedido estructurado
a fábrica por WhatsApp.

**Estado: Fase 1 completada.** Catálogo importado y auditado. La aplicación
todavía no existe — ver `DECISIONES_PENDIENTES.md`, hay 5 bloqueantes.

## Fase 1 — importación y auditoría del catálogo

```bash
pip install pdfplumber
python import/extraer_catalogo.py                     # usa ~/Downloads/Catalogo Articulos Tarifa 1.pdf
python import/extraer_catalogo.py ruta.pdf --salida data/
```

Genera en `data/`:

| Archivo | Qué contiene |
|---|---|
| `catalogo-normalizado.json` | 112 fichas: valor original + normalizado + traza a página/posición |
| `informe-importacion.md` | recuento, campos vacíos, conflictos, marcas |
| `duplicados.csv` | 19 códigos con tarifas contradictorias |
| `campos-vacios.csv` | fichas con datos sin informar |
| `tarifas-sospechosas.csv` | precios extremos, pesos a cero, conflictos |

### Invariantes que el importador garantiza

Cada uno responde a un riesgo real de este PDF:

- **El código es texto.** 12 códigos llevan cero inicial (`0001`, `025418`) y las
  longitudes van de 3 a 7. Cualquier conversión a número los destruye.
- **Coma decimal española.** `3,403` → `3.403`.
- **Vacío no es "NO".** Gluten y lactosa vienen vacíos en 97 de 112 fichas.
  Se guardan como `null`, nunca como `false`: "no sabemos" y "no lleva" son
  afirmaciones distintas, y una es un riesgo sanitario.
- **Nada se fusiona ni se descarta.** Los códigos repetidos se conservan todos,
  marcados `price_conflict` y bloqueados para pedido.
- **Se conserva el original.** Cada ficha lleva `_original` y `_origen`
  (página y posición) para poder auditar contra el PDF.
- **No se inventan códigos de barras.** Se valida el dígito EAN y se informa,
  pero no se corrige.

## Lo que aún no existe

Base de datos, carrito, agente, panel, integración con fábrica. La arquitectura
propuesta y el plan por fases están en `docs/arquitectura.md`.

---

## Fase 2 — agente, carrito y pedidos (implementado)

```
lib/chacon/
  repo.js        capa de repositorio: toda la persistencia pasa por aquí
  catalogo.js    catálogo versionado + búsqueda (código, EAN, texto, difusa)
  precios.js     modelo de 8 tarifas + cálculo por kilo, sin IVA
  pedido.js      carrito persistente + confirmación + máquina de estados
  fabrica.js     salida a Chacón (WhatsApp o simulado), desacoplada
  agente.js      loop de OpenAI con herramientas deterministas
api/chacon/
  webhook.js     entrada de WhatsApp (firma, dedupe, cortacircuitos)
  panel.js       panel interno con token
```

### Cómo probarlo ahora mismo

```bash
node scripts/chacon-smoke.js     # pruebas de Chacón, sin credenciales
node scripts/wa-smoke.js         # regresión de Sanmi: debe seguir en verde
```

Panel (con `PANEL_TOKEN`): `/api/chacon/panel?token=…&v=pedidos|catalogo|conflictos|clientes|config`

### Qué garantiza el código, no el prompt

| Garantía | Dónde |
|---|---|
| No se puede añadir un producto que no exista | `pedido.anadir` exige `producto_id` del catálogo |
| Una cantidad ambigua no se añade: se pregunta | `pedido.anadir` → `unidad_ambigua` |
| Los importes los calcula código, nunca el modelo | `precios.calcularLinea` |
| Nunca se muestra un total con IVA | `precios.totalizar` devuelve `iva: null` |
| Un pedido ambiguo no se confirma | `pedido.validarParaConfirmar` |
| Confirmar dos veces no crea dos pedidos | idempotencia por `wamid` |
| El precio confirmado no cambia si se reimporta el catálogo | copia exacta en el pedido |
| El agente no puede decir "aceptado" | el mensaje al cliente lo sustituye el código |
| El pedido interno no se manda a la tienda | `fabrica.enviar` lo rechaza |

### Estados del pedido

`solicitud_en_preparacion` → `pendiente_confirmacion_cliente` → **`enviada_a_chacon`**
→ `pendiente_de_revision` → `aceptada` · `necesita_cambios` → `preparada` → `enviada`
→ `entregada` · `cancelada`

**El agente solo puede llegar hasta `enviada_a_chacon`.** Lo único que le dice a la
tienda es: *"Hemos recibido tu solicitud de pedido correctamente. Chacón Alcántara la
revisará y realizará el envío lo antes posible."*

### Migrar a PostgreSQL

Toda la persistencia pasa por `lib/chacon/repo.js`. Escribir otra implementación de sus
métodos —clientes, carritos, pedidos, config— cambia el motor sin tocar carrito, precios
ni pedidos.
