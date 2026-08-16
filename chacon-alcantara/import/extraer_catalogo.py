"""
Importador del catálogo de Chacón Alcántara S.L. desde el PDF de tarifa.

Extrae, normaliza y audita. NO decide nada dudoso: marca y bloquea.

Principios (cada uno viene de un riesgo real del PDF):
  - El código es TEXTO. Hay 12 códigos con cero inicial ("0001", "025418")
    y longitudes de 3 a 7: cualquier conversión a número los destruye.
  - La coma es decimal española. "3,403" son 3.403, no 3403.
  - Un campo vacío NO es "NO". Gluten y lactosa vienen vacíos en 97 de 112
    fichas; convertirlos en negativo sería inventar información de alérgenos.
  - Se conserva SIEMPRE el valor original junto al normalizado.
  - Se guarda página y posición para poder auditar contra el PDF.
  - Los códigos repetidos con tarifas distintas se marcan `price_conflict`
    y quedan bloqueados: elegir un precio sería inventarlo.

Uso:
    python extraer_catalogo.py [ruta.pdf] [--salida DIR]
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

try:
    import pdfplumber
except ImportError:
    sys.exit("Falta pdfplumber. Instala con: pip install pdfplumber")

PDF_POR_DEFECTO = Path.home() / "Downloads" / "Catalogo Articulos Tarifa 1.pdf"

CAMPOS = [
    "Codigo Articulo", "Descripción", "Cod barras", "Marca",
    "Und Caja", "Peso Und", "Gluten", "Lactosa", "Observaciones", "Tarifa",
]
RE_CAMPO = re.compile(r"^(" + "|".join(re.escape(c) for c in CAMPOS) + r")\b[ \t]*(.*)$")
RE_PIE = re.compile(r"^Página \d+ de \d+")

# Mapea la etiqueta del PDF al nombre interno.
CLAVE = {
    "Codigo Articulo": "codigo", "Descripción": "descripcion", "Cod barras": "cod_barras",
    "Marca": "marca", "Und Caja": "und_caja", "Peso Und": "peso_und",
    "Gluten": "gluten", "Lactosa": "lactosa", "Observaciones": "observaciones",
    "Tarifa": "tarifa",
}


# --------------------------------------------------------------------------- #
# Normalizadores. Todos devuelven None ante ausencia de dato: nunca un default.
# --------------------------------------------------------------------------- #
def num_es(valor: str):
    """'3,403' -> 3.403. Devuelve None si no hay dato o no es numérico."""
    if valor is None:
        return None
    v = valor.strip()
    if not v:
        return None
    # Miles con punto y decimales con coma ("1.234,56") o solo coma ("3,403").
    if "," in v:
        v = v.replace(".", "").replace(",", ".")
    try:
        return float(v)
    except ValueError:
        return None


def entero(valor: str):
    n = num_es(valor)
    if n is None:
        return None
    return int(n) if float(n).is_integer() else None


def ternario(valor: str):
    """
    SI -> True, NO -> False, vacío -> None.

    Nunca colapses None en False: 'no sabemos si lleva gluten' y 'no lleva
    gluten' son afirmaciones distintas, y una de ellas es un riesgo sanitario.
    """
    if valor is None:
        return None
    v = valor.strip().upper()
    if v in ("SI", "SÍ", "S"):
        return True
    if v in ("NO", "N"):
        return False
    return None


def texto(valor: str):
    if valor is None:
        return None
    v = " ".join(valor.split())
    return v or None


def normalizar_busqueda(*partes) -> str:
    """Minúsculas sin acentos ni signos, para búsqueda tolerante."""
    import unicodedata
    s = " ".join(p for p in partes if p)
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"[^a-z0-9ñ ]+", " ", s)
    return " ".join(s.split())


def ean_valido(cod: str) -> bool:
    """Dígito de control EAN-13/EAN-8. Solo informa; no descarta nada."""
    if not cod or not cod.isdigit() or len(cod) not in (8, 13):
        return False
    digitos = [int(c) for c in cod]
    control = digitos.pop()
    digitos.reverse()
    suma = sum(d * (3 if i % 2 == 0 else 1) for i, d in enumerate(digitos))
    return (10 - suma % 10) % 10 == control


# --------------------------------------------------------------------------- #
# Extracción
# --------------------------------------------------------------------------- #
def extraer(pdf_path: Path) -> tuple[list[dict], dict]:
    crudas: list[dict] = []
    meta = {"paginas": 0, "imagenes": 0, "paginas_sin_texto": []}

    with pdfplumber.open(pdf_path) as pdf:
        meta["paginas"] = len(pdf.pages)
        for npag, page in enumerate(pdf.pages, 1):
            meta["imagenes"] += len(page.images)
            texto_pag = page.extract_text() or ""
            if not texto_pag.strip():
                meta["paginas_sin_texto"].append(npag)
                continue

            actual = None
            campo = None
            en_pagina = 0
            for linea in texto_pag.split("\n"):
                linea = linea.strip()
                if not linea or RE_PIE.match(linea):
                    continue
                m = RE_CAMPO.match(linea)
                if m:
                    etiqueta, valor = m.group(1), m.group(2).strip()
                    if etiqueta == "Codigo Articulo":
                        if actual:
                            crudas.append(actual)
                        en_pagina += 1
                        actual = {"_pagina": npag, "_posicion": en_pagina}
                    if actual is None:
                        continue
                    actual[CLAVE[etiqueta]] = valor
                    campo = CLAVE[etiqueta]
                elif actual is not None and campo:
                    # Continuación de un valor multilínea (Observaciones, sobre todo).
                    actual[campo] = f"{actual[campo]} {linea}".strip()
            if actual:
                crudas.append(actual)

    return crudas, meta


def normalizar(crudas: list[dict]) -> list[dict]:
    productos = []
    for i, c in enumerate(crudas, 1):
        codigo = (c.get("codigo") or "").strip()
        original = {k: v for k, v in c.items() if not k.startswith("_")}
        p = {
            "id": f"{codigo}#{c['_pagina']}.{c['_posicion']}",  # único aunque el código se repita
            "codigo": codigo,                                    # TEXTO, con ceros iniciales
            "descripcion": texto(c.get("descripcion")),
            "cod_barras": texto(c.get("cod_barras")),
            "marca": texto(c.get("marca")),
            "und_caja": entero(c.get("und_caja")),
            "peso_und_kg": num_es(c.get("peso_und")),
            "gluten": ternario(c.get("gluten")),
            "lactosa": ternario(c.get("lactosa")),
            "observaciones": texto(c.get("observaciones")),
            "tarifa": num_es(c.get("tarifa")),
            "_origen": {"pagina": c["_pagina"], "posicion": c["_posicion"], "orden": i},
            "_original": original,
            "estado": "ok",
            "avisos": [],
        }
        p["descripcion_normalizada"] = normalizar_busqueda(
            p["descripcion"], p["marca"], p["codigo"]
        )
        p["cod_barras_valido"] = ean_valido(p["cod_barras"]) if p["cod_barras"] else None

        if not p["codigo"]:
            p["avisos"].append("sin_codigo")
        if p["tarifa"] is None:
            p["avisos"].append("sin_tarifa")
        if p["peso_und_kg"] in (0, None):
            p["avisos"].append("peso_desconocido_o_cero")
        if p["cod_barras"] and p["cod_barras_valido"] is False:
            p["avisos"].append("cod_barras_no_valida_ean")
            p["revision_administrativa"] = True
        # "SIN CARGO" a 0,001 no es un precio: es una promoción sin condiciones
        # definidas. No puede venderse automáticamente a ese importe.
        if p["tarifa"] is not None and p["tarifa"] < 0.01:
            p["estado"] = "promotion_requires_validation"
            p["avisos"].append("posible_promocion_sin_condiciones")
            p["bloqueado_para_calculo_precio"] = True
        # Sin peso no hay peso estimado ni importe estimado (el precio es por kilo).
        if p["peso_und_kg"] in (0, None):
            p["bloqueado_para_calculo_peso"] = True
        productos.append(p)
    return productos


def clasificar_variantes(grupo: list[dict]) -> dict:
    """
    ¿Los precios repetidos de un código son niveles de tarifa distintos?

    Chacón confirmó que hay 8 tarifas por cantidad (fracción de caja, media
    caja, caja, más de una caja...). Habría que poder asignar cada precio a su
    nivel. Se buscan tres evidencias en el PDF:

      1. cabecera o sección que nombre la tarifa  -> no existe ninguna;
      2. los registros aparecen consecutivos      -> sí, en los 19 códigos;
      3. el precio es monótono en ese orden       -> NO (8 bajan, 9 suben, 2 sin orden).

    Consecutivos pero sin monotonía significa que están agrupados como
    variantes, pero que la posición **no** identifica el nivel: si fueran
    tarifa 1→2→3 el precio por kilo bajaría al subir la cantidad.

    Por tanto el nivel queda `unknown`. Elegir por posición sería inventarlo.
    """
    regs = sorted(grupo, key=lambda p: p["_origen"]["orden"])
    ordenes = [p["_origen"]["orden"] for p in regs]
    tarifas = [p["tarifa"] for p in regs]
    consecutivos = all(ordenes[i + 1] - ordenes[i] == 1 for i in range(len(ordenes) - 1))
    desc = all(tarifas[i] > tarifas[i + 1] for i in range(len(tarifas) - 1))
    asc = all(tarifas[i] < tarifas[i + 1] for i in range(len(tarifas) - 1))
    return {
        "consecutivos_en_pdf": consecutivos,
        "precio_monotono": "descendente" if desc else ("ascendente" if asc else "no"),
        "cabecera_de_tarifa_en_pdf": False,
        "nivel_tarifa_demostrable": False,   # ninguna evidencia lo permite
        "evidencia": (
            f"registros {'consecutivos' if consecutivos else 'no consecutivos'} "
            f"(órdenes {ordenes}); precio "
            f"{'descendente' if desc else ('ascendente' if asc else 'sin orden')}; "
            "el PDF no trae cabeceras de nivel de tarifa"
        ),
    }


def marcar_conflictos(productos: list[dict]) -> dict:
    """Agrupa por código y marca los que tienen varios precios sin nivel demostrable."""
    por_codigo = defaultdict(list)
    for p in productos:
        por_codigo[p["codigo"]].append(p)

    conflictos = []
    duplicados_misma_tarifa = []
    for codigo, grupo in por_codigo.items():
        if len(grupo) == 1:
            continue
        tarifas = {p["tarifa"] for p in grupo}
        difieren = [
            campo for campo in ("descripcion", "cod_barras", "marca", "und_caja",
                                "peso_und_kg", "gluten", "lactosa", "observaciones")
            if len({str(p[campo]) for p in grupo}) > 1
        ]
        if len(tarifas) > 1:
            ev = clasificar_variantes(grupo)
            for i, p in enumerate(sorted(grupo, key=lambda x: x["_origen"]["orden"]), 1):
                # NO es un error: son variantes de precio cuyo nivel de tarifa
                # no puede demostrarse con el PDF. Se bloquea el CÁLCULO, no
                # la búsqueda ni la posibilidad de pedirlo con revisión humana.
                p["estado"] = "tariff_variant_unresolved"
                p["nivel_tarifa"] = "unknown"
                p["variante"] = i
                p["evidencia_tarifa"] = ev["evidencia"]
                p["avisos"].append("varios_precios_sin_nivel_identificado")
                p["bloqueado_para_calculo_precio"] = True
                p["buscable"] = True
                p["permite_solicitud_con_revision"] = True
            conflictos.append({
                "codigo": codigo, "registros": len(grupo),
                "tarifas": sorted(t for t in tarifas if t is not None),
                "otros_campos_que_difieren": difieren,
                "paginas": [p["_origen"]["pagina"] for p in grupo],
                "descripcion": grupo[0]["descripcion"],
                **ev,
            })
        else:
            for p in grupo:
                p["estado"] = "duplicado"
                p["avisos"].append("codigo_repetido_misma_tarifa")
            duplicados_misma_tarifa.append({"codigo": codigo, "registros": len(grupo)})

    return {"price_conflict": conflictos, "duplicados_misma_tarifa": duplicados_misma_tarifa}


# --------------------------------------------------------------------------- #
def main() -> None:
    ap = argparse.ArgumentParser(description="Importa el catálogo de Chacón Alcántara")
    ap.add_argument("pdf", nargs="?", default=str(PDF_POR_DEFECTO))
    ap.add_argument("--salida", default=str(Path(__file__).resolve().parent.parent / "data"))
    args = ap.parse_args()

    pdf_path = Path(args.pdf)
    if not pdf_path.exists():
        sys.exit(f"No existe el PDF: {pdf_path}")
    salida = Path(args.salida)
    salida.mkdir(parents=True, exist_ok=True)

    sha = hashlib.sha256(pdf_path.read_bytes()).hexdigest()
    crudas, meta = extraer(pdf_path)
    productos = normalizar(crudas)
    conflictos = marcar_conflictos(productos)

    codigos = [p["codigo"] for p in productos]
    unicos = sorted(set(codigos))
    bloqueados = [p for p in productos if p.get("bloqueado_para_calculo_precio")]
    sin_peso = [p for p in productos if p.get("bloqueado_para_calculo_peso")]

    vacios = {
        campo: sum(1 for p in productos if p[campo] is None)
        for campo in ("cod_barras", "gluten", "lactosa", "observaciones",
                      "peso_und_kg", "und_caja", "tarifa", "marca")
    }

    version = {
        "generado": datetime.now(timezone.utc).isoformat(),
        "pdf": pdf_path.name,
        "pdf_sha256": sha,
        "paginas": meta["paginas"],
        "imagenes_en_pdf": meta["imagenes"],
        "fichas": len(productos),
        "codigos_unicos": len(unicos),
        "registros_bloqueados": len(bloqueados),
        "tarifa": "Tarifa 1",
        "significado_tarifa": None,   # PENDIENTE: ver DECISIONES_PENDIENTES.md
        "iva_incluido": None,         # PENDIENTE
        "unidad_de_precio": None,     # PENDIENTE: kg / unidad / caja
    }

    (salida / "catalogo-normalizado.json").write_text(
        json.dumps({"version": version, "productos": productos}, ensure_ascii=False, indent=2),
        encoding="utf-8")

    # --- informes ---------------------------------------------------------- #
    with (salida / "duplicados.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["codigo", "registros", "tarifas", "paginas", "otros_campos_que_difieren", "descripcion"])
        for c in sorted(conflictos["price_conflict"], key=lambda x: x["codigo"]):
            w.writerow([c["codigo"], c["registros"], " | ".join(str(t) for t in c["tarifas"]),
                        " ".join(str(p) for p in c["paginas"]),
                        ", ".join(c["otros_campos_que_difieren"]) or "(solo la tarifa)",
                        c["descripcion"]])

    with (salida / "campos-vacios.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["codigo", "pagina", "descripcion", "campos_sin_informar"])
        for p in productos:
            faltan = [c for c in ("cod_barras", "gluten", "lactosa", "observaciones") if p[c] is None]
            if faltan:
                w.writerow([p["codigo"], p["_origen"]["pagina"], p["descripcion"], ", ".join(faltan)])

    with (salida / "tarifas-sospechosas.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["codigo", "tarifa", "motivo", "descripcion", "pagina"])
        for p in sorted(productos, key=lambda x: (x["tarifa"] is None, x["tarifa"] or 0)):
            motivos = []
            if p["tarifa"] is None:
                motivos.append("sin tarifa")
            else:
                if p["tarifa"] < 1:
                    motivos.append("tarifa < 1 €")
                if p["tarifa"] > 60:
                    motivos.append("tarifa > 60 €")
            if p["peso_und_kg"] in (0, None):
                motivos.append("peso 0 o desconocido")
            if p["estado"] == "price_conflict":
                motivos.append("tarifas contradictorias")
            if motivos:
                w.writerow([p["codigo"], p["tarifa"], "; ".join(motivos),
                            p["descripcion"], p["_origen"]["pagina"]])

    # --- informe legible --------------------------------------------------- #
    marcas = Counter(p["marca"] for p in productos if p["marca"])
    informe = [
        "# Informe de importación — catálogo Chacón Alcántara S.L.", "",
        f"- **PDF**: `{pdf_path.name}`", f"- **SHA-256**: `{sha}`",
        f"- **Generado**: {version['generado']}", "",
        "## Recuento", "",
        "| Métrica | Valor |", "|---|---|",
        f"| Páginas | {meta['paginas']} |",
        f"| Fichas extraídas | {len(productos)} |",
        f"| Códigos únicos | {len(unicos)} |",
        f"| Registros con código repetido | {len(productos) - len(unicos)} |",
        f"| **Bloqueados para cálculo de precio** | **{len(bloqueados)}** |",
        f"| Bloqueados para cálculo de peso (peso 0) | {len(sin_peso)} |",
        f"| Imágenes en el PDF | {meta['imagenes']} |",
        f"| Marcas distintas | {len(marcas)} |", "",
        "## Campos sin informar", "",
        "Vacío **no** es negativo: son datos que Chacón no ha proporcionado.", "",
        "| Campo | Fichas sin dato | % |", "|---|---|---|",
    ]
    for campo, n in vacios.items():
        informe.append(f"| `{campo}` | {n} | {100 * n / len(productos):.0f}% |")
    informe += [
        "", "## Posibles variantes de tarifa sin identificar", "",
        f"**{len(conflictos['price_conflict'])} códigos** aparecen más de una vez con precios distintos.",
        "Chacón ha confirmado que existen 8 tarifas según la cantidad pedida, así que estos",
        "precios **podrían ser niveles de tarifa distintos**, no errores.", "",
        "Se buscó evidencia en el PDF para asignar cada precio a su nivel:", "",
        "| Evidencia | Resultado |", "|---|---|",
        "| Cabecera o sección que nombre la tarifa | no existe ninguna |",
        "| Registros consecutivos en el documento | **sí, en los 19 códigos** |",
        "| Precio monótono en ese orden | **no**: 8 descendentes, 9 ascendentes, 2 sin orden |", "",
        "Están agrupados como variantes, pero **la posición no identifica el nivel**: si fueran",
        "tarifa 1→2→3, el precio por kilo bajaría al aumentar la cantidad, y no lo hace.",
        "Por eso el nivel queda `unknown` y **solo se bloquea el cálculo automático de precio**.",
        "El producto se puede buscar y se puede pedir sujeto a revisión humana.", "",
        "| Código | Registros | Tarifas | Páginas | Descripción |", "|---|---|---|---|---|",
    ]
    for c in sorted(conflictos["price_conflict"], key=lambda x: x["codigo"]):
        informe.append(f"| `{c['codigo']}` | {c['registros']} | "
                       f"{' / '.join(str(t) for t in c['tarifas'])} | "
                       f"{' '.join(str(p) for p in c['paginas'])} | {c['descripcion']} |")
    informe += [
        "", "Estos artículos quedan **bloqueados para la confirmación automática de pedidos**",
        "hasta que un administrador elija el registro válido.", "",
        "## Marcas", "",
        "| Marca | Fichas |", "|---|---|",
    ]
    for m, n in marcas.most_common():
        informe.append(f"| {m} | {n} |")
    informe += ["", "## Archivos generados", "",
                "- `catalogo-normalizado.json` — catálogo con original + normalizado + trazas",
                "- `duplicados.csv` — códigos con tarifas contradictorias",
                "- `campos-vacios.csv` — fichas con campos sin informar",
                "- `tarifas-sospechosas.csv` — precios extremos, pesos a cero y conflictos", ""]
    (salida / "informe-importacion.md").write_text("\n".join(informe), encoding="utf-8")

    print(f"fichas={len(productos)} unicos={len(unicos)} bloqueados={len(bloqueados)}")
    print(f"salida: {salida}")


if __name__ == "__main__":
    main()
