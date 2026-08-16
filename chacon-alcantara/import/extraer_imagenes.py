#!/usr/bin/env python3
"""Extrae las fotografías del catálogo y las asocia a cada ficha.

Una imagen equivocada es peor que no enseñar ninguna: si el agente le manda a
la tienda la foto de un queso llamándolo chorizo, el error es del proveedor,
no del cliente. Por eso aquí nada se da por bueno por orden de aparición.

Lo que sí se demostró del PDF, y en lo que se apoya la asociación:

  - Cada página tiene 3 fichas en bandas verticales fijas (y ≈ 22 / 232 / 441,
    alto de banda ≈ 210 en una página de 842).
  - La ficha va a la izquierda y su foto a la derecha (x0 > 390). El logotipo
    de la portada está centrado (x0 ≈ 211), por eso se descarta por posición
    y no por tamaño.

La asociación se hace por **solape vertical**, no por orden:

  verified        exactamente una foto en la banda de la ficha
  missing         ninguna foto en esa banda
  conflict        más de una: no se elige, se manda a revisar

Solo se envían por WhatsApp las `verified`. El resto va como texto.

    python3 chacon-alcantara/import/extraer_imagenes.py \
        --pdf "~/Downloads/Catalogo Articulos Tarifa 1.pdf"
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

try:
    import pymupdf
except ImportError:  # pragma: no cover
    try:
        import fitz as pymupdf
    except ImportError:
        sys.exit("Falta PyMuPDF. Instala con: pip install pymupdf")

RAIZ = Path(__file__).resolve().parents[2]
DATOS = RAIZ / "chacon-alcantara" / "data"
IMAGENES = DATOS / "imagenes"

# La columna de fotos. Medido: fichas a la izquierda, fotos desde x≈399.
X_MIN_FOTO = 390.0

# WhatsApp recomprime igualmente; 1280 px de lado mayor es de sobra y mantiene
# el mensaje ligero para tiendas con cobertura mala.
LADO_MAX = 1280


def sanear(producto_id: str) -> str:
    """`0001#1.1` -> `0001_1-1`. Ruta estable ligada al ID interno, no a la
    descripción: la descripción se corrige y rompería las rutas."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", producto_id.replace("#", "_").replace(".", "-"))


def bandas_de_pagina(alto: float, n_fichas: int) -> list[tuple[float, float]]:
    """Divide la página en tantas bandas como fichas tenga.

    Se calcula, no se cablea: si una página trae 2 fichas en vez de 3, las
    bandas se ajustan solas en lugar de descuadrar toda la asociación.
    """
    inicio, fin = 21.8, 651.5           # área útil medida en el PDF
    if n_fichas <= 0:
        return []
    paso = (fin - inicio) / n_fichas
    return [(inicio + i * paso, inicio + (i + 1) * paso) for i in range(n_fichas)]


def banda_de(y_centro: float, bandas: list[tuple[float, float]]) -> int | None:
    for i, (a, b) in enumerate(bandas):
        if a <= y_centro < b:
            return i
    # Una foto puede sobresalir por abajo de la última banda: sigue siendo suya.
    if bandas and y_centro >= bandas[-1][1]:
        return len(bandas) - 1
    return None


def extraer(pdf_path: Path, catalogo_path: Path, salida: Path) -> dict:
    doc = pymupdf.open(pdf_path)
    catalogo = json.loads(catalogo_path.read_text(encoding="utf-8"))

    por_pagina: dict[int, list] = defaultdict(list)
    for p in catalogo["productos"]:
        por_pagina[p["_origen"]["pagina"]].append(p)

    IMAGENES.mkdir(parents=True, exist_ok=True)
    registros: list[dict] = []
    descartadas_por_posicion = 0

    for pagina in sorted(por_pagina):
        page = doc[pagina - 1]
        fichas = sorted(por_pagina[pagina], key=lambda x: x["_origen"]["posicion"])
        bandas = bandas_de_pagina(page.rect.height, len(fichas))

        candidatas: dict[int, list] = defaultdict(list)
        for im in page.get_image_info(hashes=True, xrefs=True):
            x0, y0, x1, y1 = im["bbox"]
            if x0 <= X_MIN_FOTO:
                descartadas_por_posicion += 1      # logotipo de portada
                continue
            idx = banda_de((y0 + y1) / 2, bandas)
            if idx is not None:
                candidatas[idx].append(im)

        for i, ficha in enumerate(fichas):
            fotos = candidatas.get(i, [])
            reg = {
                "producto_id": ficha["id"],
                "codigo": ficha["codigo"],
                "descripcion": ficha["descripcion"],
                "pagina": pagina,
                "posicion": ficha["_origen"]["posicion"],
                "archivo": None,
                "sha256": None,
                "ancho": None,
                "alto": None,
                "bbox": None,
                "estado": "missing",
                "motivo": "no hay ninguna foto en la banda de esta ficha",
                "candidatas": len(fotos),
            }

            if len(fotos) == 1:
                im = fotos[0]
                datos = doc.extract_image(im["xref"])
                bruto = datos["image"]
                nombre = f"{sanear(ficha['id'])}.{datos['ext']}"
                destino = IMAGENES / nombre

                # Reescala solo si hace falta. Reencodar sin motivo degrada.
                pix = pymupdf.Pixmap(doc, im["xref"])
                if max(pix.width, pix.height) > LADO_MAX or pix.n > 4:
                    if pix.n > 4:                       # CMYK -> RGB
                        pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
                    escala = LADO_MAX / max(pix.width, pix.height)
                    if escala < 1:
                        pix = pymupdf.Pixmap(pix, 0)     # quita alfa si lo hay
                        destino = IMAGENES / f"{sanear(ficha['id'])}.jpg"
                        pix.save(destino, jpg_quality=82)
                        bruto = destino.read_bytes()
                    else:
                        destino.write_bytes(bruto)
                else:
                    destino.write_bytes(bruto)

                reg.update({
                    "archivo": f"imagenes/{destino.name}",
                    "sha256": hashlib.sha256(bruto).hexdigest(),
                    "ancho": pix.width, "alto": pix.height,
                    "bbox": [round(v, 1) for v in im["bbox"]],
                    # Una sola candidata en su banda y en la columna correcta:
                    # la geometría no deja alternativa.
                    "estado": "verified",
                    "motivo": "única foto en la banda vertical de la ficha",
                })
            elif len(fotos) > 1:
                reg.update({
                    "estado": "conflict",
                    "motivo": f"{len(fotos)} fotos en la misma banda: no se elige por orden",
                    "bbox": [[round(v, 1) for v in f["bbox"]] for f in fotos],
                })

            registros.append(reg)

    # Una misma foto asignada a dos fichas distintas es sospechosa: puede ser
    # legítima (mismo producto, dos tarifas) o un error de maquetación.
    por_hash: dict[str, list] = defaultdict(list)
    for r in registros:
        if r["sha256"]:
            por_hash[r["sha256"]].append(r)
    for h, grupo in por_hash.items():
        if len(grupo) > 1 and len({g["codigo"] for g in grupo}) > 1:
            for g in grupo:
                g["estado"] = "pending_review"
                g["motivo"] = ("misma foto que " +
                               ", ".join(sorted({x["codigo"] for x in grupo if x is not g})))

    resumen = {
        "generado": datetime.now(timezone.utc).isoformat(),
        "pdf": pdf_path.name,
        "paginas": doc.page_count,
        "descartadas_por_posicion": descartadas_por_posicion,
        "totales": {e: sum(1 for r in registros if r["estado"] == e)
                    for e in ("verified", "pending_review", "conflict", "missing")},
        "imagenes": registros,
    }
    salida.write_text(json.dumps(resumen, ensure_ascii=False, indent=2), encoding="utf-8")
    return resumen


def mosaico(resumen: dict, destino: Path) -> None:
    """Mosaico de control: código, descripción, foto asignada y página.

    Sirve para que una persona confirme de un vistazo que cada foto es la que
    toca. Es la única forma de pasar de `pending_review` a `verified` sin
    adivinar.
    """
    COLORES = {"verified": "#2f8f4e", "pending_review": "#c08a2a",
               "conflict": "#c0392b", "missing": "#6b7280"}
    tarjetas = []
    for r in sorted(resumen["imagenes"], key=lambda x: (x["estado"] != "conflict",
                                                        x["estado"] != "pending_review",
                                                        x["pagina"], x["posicion"])):
        foto = (f'<img src="{r["archivo"]}" loading="lazy" alt="">' if r["archivo"]
                else '<div class="sin">sin foto</div>')
        tarjetas.append(f"""<figure class="c">
  {foto}
  <figcaption>
    <b>[{r['codigo']}]</b> {r['descripcion']}<br>
    <span class="e" style="background:{COLORES[r['estado']]}">{r['estado']}</span>
    <span class="m">pág. {r['pagina']} · pos. {r['posicion']}</span><br>
    <span class="m">{r['motivo']}</span>
  </figcaption>
</figure>""")

    t = resumen["totales"]
    destino.write_text(f"""<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Chacón Alcántara — control de imágenes</title>
<style>
 body{{font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;background:#111418;color:#e8eaee;margin:0;padding:26px}}
 h1{{font-size:19px;margin:0 0 4px}} .sub{{color:#8b8f9a;margin-bottom:20px}}
 .g{{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:15px}}
 .c{{margin:0;background:#181c22;border:1px solid #262a31;border-radius:9px;overflow:hidden}}
 .c img{{width:100%;height:175px;object-fit:contain;background:#fff;display:block}}
 .sin{{height:175px;display:flex;align-items:center;justify-content:center;color:#6b7280;background:#0d1013}}
 figcaption{{padding:9px 11px;font-size:12px}}
 .e{{display:inline-block;padding:1px 7px;border-radius:4px;color:#fff;font-size:10px;margin:4px 6px 3px 0}}
 .m{{color:#8b8f9a;font-size:11px}}
</style></head><body>
<h1>Control de imágenes — {resumen['pdf']}</h1>
<div class="sub">{t['verified']} verificadas · {t['pending_review']} a revisar ·
 {t['conflict']} en conflicto · {t['missing']} sin foto ·
 {resumen['descartadas_por_posicion']} descartadas por posición (logotipo).
 <b>Solo se envían por WhatsApp las verificadas.</b></div>
<div class="g">{''.join(tarjetas)}</div>
</body></html>""", encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--catalogo", default=str(DATOS / "catalogo-normalizado.json"))
    ap.add_argument("--salida", default=str(DATOS / "imagenes.json"))
    ap.add_argument("--mosaico", default=str(DATOS / "mosaico-imagenes.html"))
    a = ap.parse_args()

    resumen = extraer(Path(a.pdf).expanduser(), Path(a.catalogo), Path(a.salida))
    mosaico(resumen, Path(a.mosaico))

    t = resumen["totales"]
    print(f"Fichas procesadas: {len(resumen['imagenes'])}")
    for estado in ("verified", "pending_review", "conflict", "missing"):
        print(f"  {estado:16s} {t[estado]}")
    print(f"  descartadas por posición (logotipo): {resumen['descartadas_por_posicion']}")
    print(f"\n{a.salida}\n{a.mosaico}")


if __name__ == "__main__":
    main()
