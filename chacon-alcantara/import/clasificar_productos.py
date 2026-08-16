#!/usr/bin/env python3
"""Propone la familia comercial de cada artículo del catálogo.

Por qué esto vive en un archivo y no en el prompt: si la familia la decidiera
el modelo en cada conversación, dos tiendas verían catálogos distintos el
mismo día y nadie podría corregir un error. La clasificación se calcula una
vez, se revisa y se guarda.

La propuesta sale de la descripción y la marca, con reglas explícitas. Cada
producto queda con uno de estos estados:

  auto_confirmado   una regla fuerte y sin competencia -> se puede usar ya
  pending_review    señales de dos familias, o ninguna clara -> se muestra
                    en "Otros productos" hasta que una persona lo confirme

Un producto dudoso NO se presenta como definitivo. Es preferible que aparezca
en "Otros" a que un cliente busque quesos y le salga un membrillo.

    python3 chacon-alcantara/import/clasificar_productos.py
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

RAIZ = Path(__file__).resolve().parents[2]
DATOS = RAIZ / "chacon-alcantara" / "data"


def norm(s: str) -> str:
    s = unicodedata.normalize("NFD", str(s or "").lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9 ]+", " ", s)


# ---------------------------------------------------------------- categorías
# `aliases` son las palabras con las que una tienda pide la familia. Se usan
# tal cual en la navegación: "enséñame los quesos" -> quesos.
CATEGORIAS = [
    {
        "clave": "embutidos_curados",
        "nombre": "Embutidos curados",
        "display_order": 1,
        "aliases": ["embutido", "embutidos", "curado", "curados", "curada", "curadas",
                    "charcuteria", "vela", "cular"],
    },
    {
        "clave": "jamones_fiambres_cocidos",
        "nombre": "Jamones, fiambres y cocidos",
        "display_order": 2,
        "aliases": ["jamon", "jamones", "fiambre", "fiambres", "cocido", "cocidos",
                    "york", "sandwich", "loncheado"],
    },
    {
        "clave": "salchichas_morcillas_preparados",
        "nombre": "Salchichas, morcillas y preparados cárnicos",
        "display_order": 3,
        "aliases": ["preparado", "preparados", "preparados carnicos", "casqueria"],
    },
    {
        "clave": "quesos",
        "nombre": "Quesos",
        "display_order": 4,
        "aliases": ["queso", "quesos", "queseria", "oveja", "mezcla"],
    },
    {
        "clave": "conservas_pescado",
        "nombre": "Conservas de pescado",
        "display_order": 5,
        "aliases": ["conserva", "conservas", "lata", "latas", "enlatado", "enlatados"],
    },
    {
        "clave": "congelados",
        "nombre": "Congelados",
        "display_order": 6,
        "aliases": ["congelado", "congelados", "congelacion", "ultracongelado"],
    },
    {
        "clave": "panaderia",
        "nombre": "Panadería",
        "display_order": 7,
        "aliases": ["panaderia", "pan", "bolleria", "horno", "reposteria"],
    },
    {
        "clave": "membrillo_dulces",
        "nombre": "Membrillo y dulces",
        "display_order": 8,
        "aliases": ["dulce", "dulces", "postre", "postres", "confiteria"],
    },
    {
        "clave": "otros",
        "nombre": "Otros productos",
        "display_order": 9,
        "aliases": ["otros", "varios", "resto"],
    },
]

# (regex, categoría, subcategoría, peso). Peso 3 = inequívoco.
REGLAS = [
    # --- quesos: la palabra "queso" no aparece en nada que no sea queso ----
    (r"\bqueso", "quesos", "queso", 3),

    # --- conservas de pescado ----------------------------------------------
    (r"\bcaballa\b", "conservas_pescado", "caballa", 3),
    (r"\bmelva\b", "conservas_pescado", "melva", 3),
    (r"\balmadraba\b", "conservas_pescado", "melva", 2),

    # --- membrillo y dulces -------------------------------------------------
    (r"\bmembrillo\b", "membrillo_dulces", "membrillo", 3),
    (r"\bmllo\b", "membrillo_dulces", "membrillo", 3),          # abreviatura del PDF

    # --- panadería ----------------------------------------------------------
    (r"\bviolines?\b", "panaderia", "violines", 3),
    (r"\bochitos\b", "panaderia", "ochitos", 3),
    (r"\brosquillas?\b", "panaderia", "rosquillas", 3),

    # --- congelados (la etiqueta CONG del PDF es explícita) ------------------
    (r"\bcong\b|\bcongelad", "congelados", None, 3),

    # --- salchichas, morcillas y preparados ---------------------------------
    (r"\bsalchichas\b", "salchichas_morcillas_preparados", "salchichas", 3),
    (r"\bmorcilla\b", "salchichas_morcillas_preparados", "morcilla", 3),
    (r"\bhot dog\b", "salchichas_morcillas_preparados", "salchichas", 3),
    (r"\bhamburguesas?\b", "salchichas_morcillas_preparados", "hamburguesas", 2),
    (r"\bcallos\b", "salchichas_morcillas_preparados", "preparados", 3),

    # --- jamones, fiambres y cocidos ----------------------------------------
    (r"\bchopped\b", "jamones_fiambres_cocidos", "chopped", 3),
    (r"\bmortadela\b", "jamones_fiambres_cocidos", "mortadela", 3),
    (r"\bfiambre\b|\bfbre\b", "jamones_fiambres_cocidos", "fiambre", 3),
    (r"\bjamon cocido\b", "jamones_fiambres_cocidos", "jamon_cocido", 3),
    (r"\blunch\b", "jamones_fiambres_cocidos", "lunch", 3),
    (r"\bbacon\b", "jamones_fiambres_cocidos", "bacon", 3),
    (r"\blacon\b", "jamones_fiambres_cocidos", "lacon", 3),
    (r"\bcodillos?\b", "jamones_fiambres_cocidos", "codillo", 2),
    (r"\bcabeza de jabali\b", "jamones_fiambres_cocidos", "fiambre", 3),
    (r"\bmagreta\b", "jamones_fiambres_cocidos", "fiambre", 2),
    (r"\bpaleta\b", "jamones_fiambres_cocidos", "paleta", 2),
    (r"\bcentro de jamon\b|\bcentro jamon\b", "jamones_fiambres_cocidos", "jamon", 1),

    # --- embutidos curados ---------------------------------------------------
    (r"\bchorizo\b", "embutidos_curados", "chorizo", 3),
    (r"\bsalchichon\b", "embutidos_curados", "salchichon", 3),
    (r"\bsalami\b", "embutidos_curados", "salami", 3),
    (r"\blomito\b", "embutidos_curados", "lomo", 3),
    (r"\bcaña de lomo\b|\bcana de lomo\b", "embutidos_curados", "lomo", 3),
    (r"\blomo plata\b", "embutidos_curados", "lomo", 3),
    (r"\bjamon cebo\b|\bjamon iberico\b", "embutidos_curados", "jamon_curado", 3),
    (r"\bpanceta\b", "embutidos_curados", "panceta", 2),
    (r"\bembutido\b", "embutidos_curados", None, 2),
]

# Etiquetas transversales. Un producto puede llevar varias.
ETIQUETAS = [
    (r"\bpollo\b|\bave\b", "pollo"),
    (r"\bpavo\b", "pavo"),
    (r"\biberic|\bbellota\b|\bcebo\b", "iberico"),
    (r"\bqueso", "queso"),
    (r"\bcaballa\b|\bmelva\b|\batun\b|\balmadraba\b", "pescado"),
    (r"\bpicante\b", "picante"),
    (r"\bcong\b|\bcongelad", "congelado"),
    (r"\bcerdo\b|\bchorizo\b|\bsalchichon\b|\blomo\b|\bpanceta\b|\bjamon\b|\bbacon\b"
     r"|\bmorcilla\b|\bchopped\b|\bcodillo", "cerdo"),
]


def clasificar(p: dict) -> dict:
    texto = norm(f"{p['descripcion']} {p.get('marca') or ''}")
    aciertos = []
    for patron, cat, sub, peso in REGLAS:
        if re.search(patron, texto):
            aciertos.append((peso, cat, sub, patron))

    tags = sorted({t for patron, t in ETIQUETAS if re.search(patron, texto)})
    # "Sin lactosa" solo cuando el dato consta: ni se infiere ni se supone.
    if p.get("lactosa") is False or re.search(r"\bsin lactosa\b", texto):
        tags.append("sin_lactosa")
    if p.get("marca"):
        tags.append("marca")

    if not aciertos:
        return {
            "primary_category": "otros", "subcategory": None, "tags": sorted(set(tags)),
            "classification_status": "pending_review",
            "classification_source": "sin_regla",
            "motivo": "ninguna regla reconoce esta descripción",
        }

    aciertos.sort(key=lambda x: -x[0])
    mejor = aciertos[0]
    familias = {a[1] for a in aciertos if a[0] == mejor[0]}

    # Dos familias empatadas con el mismo peso: no se elige a cara o cruz.
    if len(familias) > 1:
        return {
            "primary_category": "otros",
            "subcategory": None,
            "tags": sorted(set(tags)),
            "classification_status": "pending_review",
            "classification_source": "regla_ambigua",
            "motivo": "encaja en " + " y en ".join(sorted(familias)) + ": lo decide una persona",
            "candidatas": sorted(familias),
        }

    estado = "auto_confirmado" if mejor[0] >= 3 else "pending_review"
    return {
        "primary_category": mejor[1],
        "subcategory": mejor[2],
        "tags": sorted(set(tags)),
        "classification_status": estado,
        "classification_source": f"regla:{mejor[3]}",
        "motivo": ("regla inequívoca" if estado == "auto_confirmado"
                   else "señal débil: conviene confirmarlo"),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--catalogo", default=str(DATOS / "catalogo-normalizado.json"))
    ap.add_argument("--salida-json", default=str(DATOS / "clasificacion-productos.json"))
    ap.add_argument("--salida-csv", default=str(DATOS / "clasificacion-productos.csv"))
    a = ap.parse_args()

    catalogo = json.loads(Path(a.catalogo).read_text(encoding="utf-8"))
    por_categoria: dict[str, int] = {c["clave"]: 0 for c in CATEGORIAS}
    filas = []

    for orden, p in enumerate(catalogo["productos"], 1):
        c = clasificar(p)
        por_categoria[c["primary_category"]] += 1
        filas.append({
            "producto_id": p["id"],
            "codigo": p["codigo"],
            "descripcion": p["descripcion"],
            "marca": p.get("marca") or "",
            "primary_category": c["primary_category"],
            "subcategory": c["subcategory"] or "",
            "tags": "|".join(c["tags"]),
            "category_aliases": "",          # se rellena a mano si hace falta
            "display_order": orden,
            "classification_status": c["classification_status"],
            "classification_source": c["classification_source"],
            "classification_reviewed_by": "",
            "motivo": c["motivo"],
        })

    Path(a.salida_csv).write_text("", encoding="utf-8")
    with open(a.salida_csv, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(filas[0].keys()))
        w.writeheader()
        w.writerows(filas)

    salida = {
        "generado": datetime.now(timezone.utc).isoformat(),
        "categorias": CATEGORIAS,
        "resumen": {
            "productos": len(filas),
            "auto_confirmado": sum(1 for f in filas if f["classification_status"] == "auto_confirmado"),
            "pending_review": sum(1 for f in filas if f["classification_status"] == "pending_review"),
            "por_categoria": por_categoria,
        },
        "productos": filas,
    }
    Path(a.salida_json).write_text(json.dumps(salida, ensure_ascii=False, indent=2), encoding="utf-8")

    r = salida["resumen"]
    print(f"Productos: {r['productos']}  ·  confirmados: {r['auto_confirmado']}  ·  a revisar: {r['pending_review']}")
    for c in CATEGORIAS:
        print(f"  {c['nombre']:46s} {por_categoria[c['clave']]}")
    print(f"\n{a.salida_json}\n{a.salida_csv}")


if __name__ == "__main__":
    main()
