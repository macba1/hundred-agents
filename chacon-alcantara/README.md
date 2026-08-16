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
