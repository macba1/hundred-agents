#!/usr/bin/env python3
"""Genera el feed de catálogo de Meta a partir de nuestra base.

Nuestro catálogo es la fuente única. De aquí salen el catálogo del agente, el
feed de Meta, las imágenes públicas y las familias. Mantener dos catálogos a
mano acaba, siempre, en que el cliente ve un precio que ya no existe.

**El feed va SIN precio, a propósito.** Chacón cobra por kilo y el cliente
pide cajas o unidades: si se pusiera el precio por kilo en la ficha, WhatsApp
lo multiplicaría por el número de cajas y enseñaría un total que no es el que
se va a facturar. El precio es un campo opcional en un catálogo de WhatsApp,
y omitirlo es lo que hace que el carrito diga que la empresa dará el total.
Eso es exactamente el comportamiento de la captura que mandó Fernando.

Lo que NO sale al feed, y por qué:
  - las 8 fichas con imagen `pending_review`  -> una foto equivocada es peor
    que ninguna, y en el catálogo visual la foto ES el producto
  - las 3 fichas sin imagen                   -> Meta exige `image_link`
  - los 19 códigos con precio sin resolver    -> sí salen: sin precio en el
    feed no hay nada que falsear, y la tienda puede pedirlos
  - `OF3900`                                  -> promoción sin condiciones
  - los productos inactivos

Todo lo excluido **sigue disponible por búsqueda conversacional**: el agente
lo encuentra, lo describe y lo añade al pedido aunque no esté en el catálogo
visual.

    python3 chacon-alcantara/import/generar_feed_meta.py \
        --base-url https://www.thehagentic.com
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

RAIZ = Path(__file__).resolve().parents[2]
DATOS = RAIZ / "chacon-alcantara" / "data"

# Columnas del feed de Meta. `price` se omite a propósito (ver el docstring).
COLUMNAS = [
    "id",                  # product_retailer_id = código de Chacón
    "title",
    "description",
    "availability",
    "condition",
    "image_link",
    "link",
    "brand",
    "product_type",        # familia
    "custom_label_0",      # "Tarifa 1"
    "custom_label_1",      # unidades por caja
    "custom_label_2",      # peso aproximado
    "custom_label_3",      # subcategoría
    "custom_label_4",      # estado del precio
]


def titulo(p: dict) -> str:
    """Descripción normalizada, legible, con la marca si no está ya dentro."""
    t = re.sub(r"\s+", " ", p["descripcion"]).strip()
    t = t.title()
    # Las abreviaturas del PDF quedan raras en Title Case.
    for a, b in (("Hra.", "Herradura"), ("Cdo.", "Cocido"), ("Adb.", "Adobado"),
                 ("Fbre.", "Fiambre"), ("Cons.", "Conserva"), ("Cong.", "Congelado"),
                 ("A/G", "en aceite de girasol"), ("Pmta.", "Pimienta"),
                 ("Cort.", "Cortado"), ("Clas.", "Clásica")):
        t = t.replace(a, b)
    marca = (p.get("marca") or "").strip()
    if marca and marca.lower() not in t.lower():
        t = f"{t} — {marca.title()}"
    return t[:200]                       # Meta corta en 200


def descripcion(p: dict, familia: str, precio_kg, pendiente: bool) -> str:
    """Ficha comercial breve. Sin total: se cobra por kilo."""
    L = []
    if p.get("observaciones"):
        L.append(re.sub(r"\s+", " ", p["observaciones"]).strip())
    L.append(f"Familia: {familia}.")
    if p.get("und_caja"):
        L.append(f"Caja de {p['und_caja']} "
                 f"{'unidad' if p['und_caja'] == 1 else 'unidades'}.")
    if p.get("peso_und_kg"):
        peso = str(p["peso_und_kg"]).rstrip("0").rstrip(".").replace(".", ",")
        L.append(f"Peso aproximado por unidad: {peso} kg.")
    if pendiente:
        L.append("Precio pendiente de confirmar por Chacón Alcántara.")
    elif precio_kg is not None:
        L.append(f"Tarifa 1: {str(precio_kg).replace('.', ',')} €/kg, sin IVA.")
    L.append("Se cobra por kilo: el importe final se ajusta al peso real preparado. "
             "Puedes pedirlo por cajas o por unidades.")
    return " ".join(L)[:9999]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", required=True,
                    help="Base pública del sitio, para image_link y link.")
    ap.add_argument("--catalogo", default=str(DATOS / "catalogo-normalizado.json"))
    ap.add_argument("--clasificacion", default=str(DATOS / "clasificacion-productos.json"))
    ap.add_argument("--imagenes", default=str(DATOS / "imagenes.json"))
    ap.add_argument("--salida", default=str(DATOS / "feed-meta.csv"))
    ap.add_argument("--informe", default=str(DATOS / "feed-meta-informe.json"))
    ap.add_argument("--piloto", metavar="CODIGO",
                    help="Genera un feed de UN solo producto, para la prueba piloto.")
    a = ap.parse_args()

    base = a.base_url.rstrip("/")
    catalogo = json.loads(Path(a.catalogo).read_text(encoding="utf-8"))
    clasif = json.loads(Path(a.clasificacion).read_text(encoding="utf-8"))
    imgs = json.loads(Path(a.imagenes).read_text(encoding="utf-8"))

    familias = {c["clave"]: c["nombre"] for c in clasif["categorias"]}
    por_producto = {c["producto_id"]: c for c in clasif["productos"]}
    imagen_de = {r["producto_id"]: r for r in imgs["imagenes"]}

    filas, excluidos = [], []
    vistos = set()

    for p in catalogo["productos"]:
        cod = p["codigo"]
        c = por_producto.get(p["id"], {})
        img = imagen_de.get(p["id"], {})

        def fuera(motivo: str) -> None:
            excluidos.append({"codigo": cod, "producto_id": p["id"],
                              "descripcion": p["descripcion"], "motivo": motivo})

        # Un código sale UNA vez, aunque el PDF lo traiga repetido: el
        # `product_retailer_id` tiene que ser único en el catálogo de Meta.
        if cod in vistos:
            fuera("código repetido en el PDF: ya está en el feed")
            continue
        if p.get("activo") is False:
            fuera("producto inactivo")
            continue
        if p.get("estado") == "promotion_requires_validation":
            fuera("promoción sin condiciones definidas (OF3900)")
            continue
        if img.get("estado") != "verified":
            fuera(f"imagen en estado {img.get('estado', 'sin registro')}: "
                  "en el catálogo visual la foto ES el producto")
            continue

        vistos.add(cod)
        familia = familias.get(c.get("primary_category")
                               if c.get("classification_status") == "auto_confirmado"
                               else "otros", "Otros productos")
        pendiente = bool(p.get("bloqueado_para_calculo_precio"))
        precio_kg = None if pendiente else p.get("tarifa")

        filas.append({
            "id": cod,
            "title": titulo(p),
            "description": descripcion(p, familia, precio_kg, pendiente),
            "availability": "in stock",
            "condition": "new",
            "image_link": f"{base}/api/chacon/imagen?p={quote(p['id'], safe='')}",
            "link": f"{base}/api/chacon/producto?codigo={quote(cod, safe='')}",
            "brand": (p.get("marca") or "Chacón Alcántara")[:100],
            "product_type": familia,
            "custom_label_0": "Tarifa 1",
            "custom_label_1": str(p.get("und_caja") or ""),
            "custom_label_2": (str(p["peso_und_kg"]).rstrip("0").rstrip(".")
                               if p.get("peso_und_kg") else ""),
            "custom_label_3": c.get("subcategory") or "",
            "custom_label_4": "precio_pendiente" if pendiente else "tarifa_1_validada",
        })

    if a.piloto:
        filas = [f for f in filas if f["id"] == a.piloto]
        if not filas:
            sys.exit(f"El código {a.piloto} no llega al feed. Mira el informe: "
                     "puede que su imagen no esté verificada.")

    salida = Path(a.salida if not a.piloto else
                  str(Path(a.salida).with_name(f"feed-meta-piloto-{a.piloto}.csv")))
    with open(salida, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNAS)
        w.writeheader()
        w.writerows(filas)

    motivos: dict[str, int] = {}
    for e in excluidos:
        clave = e["motivo"].split(":")[0]
        motivos[clave] = motivos.get(clave, 0) + 1

    informe = {
        "generado": datetime.now(timezone.utc).isoformat(),
        "base_url": base,
        "sin_precio": True,
        "por_que_sin_precio": (
            "Se cobra por kilo y el cliente pide cajas o unidades. Con precio, "
            "WhatsApp multiplicaría por la cantidad y enseñaría un total que no es "
            "el que se va a facturar. Sin precio, el carrito indica que la empresa "
            "proporcionará el total."),
        "en_el_feed": len(filas),
        "excluidos": len(excluidos),
        "motivos_de_exclusion": motivos,
        "detalle_excluidos": excluidos,
        "nota": ("Todo lo excluido sigue disponible por búsqueda conversacional: "
                 "el agente lo encuentra y lo añade al pedido igual."),
    }
    Path(a.informe).write_text(json.dumps(informe, ensure_ascii=False, indent=2),
                               encoding="utf-8")

    print(f"En el feed: {len(filas)}  ·  excluidos: {len(excluidos)}")
    for m, n in sorted(motivos.items(), key=lambda x: -x[1]):
        print(f"  {n:3d}  {m}")
    print(f"\n{salida}\n{a.informe}")


if __name__ == "__main__":
    main()
