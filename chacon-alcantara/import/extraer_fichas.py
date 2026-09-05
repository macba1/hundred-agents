#!/usr/bin/env python3
"""Importa las fichas técnicas de producto que entrega Chacón Alcántara.

Son documentos del fabricante —El Pozo, Campofrío, Mi Pollo, Marcial…— y cada
uno tiene su propio formato. Aquí NO se interpreta ninguno: se localiza el
apartado por su título y se guarda **el texto tal cual está en el PDF**.

La razón es de seguridad alimentaria, no de estilo. Un alérgeno resumido,
traducido o "mejorado" es un alérgeno que puede quedar mal, y quien lea la
respuesta puede ser celíaco o alérgico a la lactosa. Por eso el pipeline
entero está construido para que sea imposible que un texto llegue al cliente
sin proceder literalmente del documento: se guarda el fragmento, se guarda el
documento del que sale, y un invariante comprueba que el fragmento sigue
estando dentro del original.

Doce de las cincuenta fichas son escaneos sin capa de texto. De esas no se
extrae nada, y así queda registrado: el agente podrá enviar el PDF pero no
afirmará nada sobre su contenido. Preferimos decir "no lo sé, aquí tienes el
documento" antes que adivinar sobre un escaneo.

Igual que tarifas y agenda: versiones inmutables, invariantes y aprobación
explícita. Importar no activa nada.

    python3 chacon-alcantara/import/extraer_fichas.py
    python3 chacon-alcantara/import/extraer_fichas.py --aprobar 1 --por 'Nombre'
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
FUENTE = RAIZ / "chacon-alcantara" / "fuentes" / "fichas"
DESTINO = RAIZ / "chacon-alcantara" / "data" / "fichas"
CATALOGO = RAIZ / "chacon-alcantara" / "data" / "catalogo-normalizado.json"

# Un PDF escaneado tiene capa de texto vacía o casi. Por debajo de este umbral
# no hay nada de lo que fiarse, así que no se extrae ningún campo.
MINIMO_TEXTO = 120

# Cuánto se guarda de un apartado. Suficiente para una lista de ingredientes
# larga, y con tope para que un fallo de maquetación no arrastre media ficha.
MAX_BLOQUE = 900


def sin_tildes(s: str) -> str:
    s = unicodedata.normalize("NFD", str(s))
    return "".join(c for c in s if unicodedata.category(c) != "Mn")


def clave(s: str) -> str:
    """Forma canónica para BUSCAR títulos. El texto guardado no se toca."""
    return re.sub(r"\s+", " ", sin_tildes(s)).strip().upper()


# Cada campo se localiza por los títulos con los que lo rotulan los
# fabricantes. Lo que no case con ninguno, sencillamente no se extrae: es
# mejor un campo ausente que un campo tomado del apartado equivocado.
CAMPOS = {
    "denominacion": [
        r"DENOMINACION (?:COMERCIAL|LEGAL|DEL PRODUCTO)",
        r"DENOMINACION",
        r"NOMBRE DEL PRODUCTO",
    ],
    "ingredientes": [
        r"INGREDIENTES",
        r"COMPOSICION DEL PRODUCTO",
        r"COMPOSICION",
    ],
    "alergenos": [
        r"DECLARACION DE ALERGENOS",
        r"SUSTANCIAS QUE CAUSAN ALERGIAS?[^\n]*",
        r"ALERGENOS E INTOLERANCIAS",
        r"ALERGENOS",
    ],
    "conservacion": [
        r"CONDICIONES DE (?:CONSERVACION|ALMACENAMIENTO)",
        r"CONSERVACION Y (?:VIDA UTIL|CADUCIDAD)",
        r"CONSERVACION",
        r"VIDA UTIL",
        r"CONSUMO PREFERENTE",
    ],
    "presentacion": [
        r"PRESENTACION (?:Y|DEL) [^\n]*",
        r"PRESENTACION",
        r"PESO NETO",
        r"FORMATO",
    ],
    "modo_empleo": [
        r"MODO DE EMPLEO",
        r"INSTRUCCIONES DE USO",
        r"MODO DE PREPARACION",
    ],
}

# La tabla nutricional se ha dejado FUERA a propósito. En un PDF se maqueta
# como tabla, y al extraer el texto en línea los encabezados se separan de sus
# cifras: sale "Proteínas / Sal / 424 / 4,4 / 1,3", que no significa nada y que
# alguien podría leer como si significara algo. Volverá cuando se lea la
# geometría de la tabla, no antes.

# Cualquier título conocido corta el bloque anterior. Sin esto, "ingredientes"
# se llevaría por delante la tabla nutricional que viene detrás.
CORTES = [p for lista in CAMPOS.values() for p in lista] + [
    r"CARACTERISTICAS (?:MICROBIOLOGICAS|FISICO|ORGANOLEPTICAS|QUIMICAS)",
    r"NORMATIVA (?:LEGAL )?(?:VIGENTE|APLICABLE)",
    r"ETIQUETADO", r"REVISADO Y APROBADO", r"CONDICIONES DE TRANSPORTE",
    r"DESTINO FINAL", r"TRATAMIENTO", r"CLASIFICACION", r"MATERIAL",
    r"FICHA TECNICA", r"ESPECIFICACION TECNICA", r"MARCA COMERCIAL",
    r"PRODUCTO FINAL", r"OBSERVACIONES", r"ELABORADO POR", r"FABRICANTE",
]


# ---- control de calidad --------------------------------------------------
# Localizar un título no garantiza que debajo esté lo que promete. En estos
# PDFs el texto de un pie de página o de una tabla contigua se cuela con
# facilidad, y un campo mal capturado es peor que un campo vacío: el vacío se
# nota, el equivocado parece un dato.

# Marcas de que hemos capturado membrete, laboratorio o pie de página.
RUIDO = re.compile(
    r"LABORATORIO [A-Z]|HA EDITADO LA FICHA|CHACON ALCANTARA, S\.?L|"
    r"\bTEL\.?\s*\d|CTRA\.|\bC/|\bCL \b|\d{5}\s*-\s*[A-Z]|"
    r"CODIGO DE BARRAS|EAN\s*13|REVISADO Y APROBADO|"
    r"DATOS DEL FABRICANTE|RAZON SOCIAL", re.IGNORECASE)

# Los catorce alérgenos de declaración obligatoria. Un apartado de alérgenos
# que no nombre ninguno no es un apartado de alérgenos.
ALERGENOS_REALES = re.compile(
    r"GLUTEN|CEREAL|CRUSTACEO|HUEVO|PESCADO|CACAHUETE|SOJA|LECHE|LACTOSA|"
    r"FRUTOS DE CASCARA|FRUTOS SECOS|APIO|MOSTAZA|SESAMO|SULFITO|ALTRAMUZ|"
    r"MOLUSCO|SIN ALERGENOS|NO CONTIENE", re.IGNORECASE)


def descartar(campo: str, texto: str) -> str | None:
    """Motivo por el que este bloque NO se guarda, o None si vale.

    Preferimos quedarnos cortos. Una ficha sin campo hace que el agente diga
    "no lo tengo, aquí está el documento", que es una respuesta correcta. Un
    campo equivocado hace que afirme algo falso sobre comida.
    """
    plano = re.sub(r"\s+", " ", sin_tildes(texto)).strip()

    if len(plano) < 12:
        return "demasiado corto"
    if RUIDO.search(plano):
        return "contiene membrete, laboratorio o pie de página"

    # Muchas mayúsculas seguidas y pocas comas es una tabla, no una frase.
    letras = [c for c in plano if c.isalpha()]
    if letras and sum(1 for c in letras if c.isupper()) / len(letras) > 0.85 \
            and plano.count(",") < 3:
        return "parece una tabla, no un texto"

    if campo == "ingredientes":
        # Una lista de ingredientes enumera. Si no hay comas, no lo es.
        if plano.count(",") < 2:
            return "no enumera ingredientes"
        if re.match(r"^(POSIBILIDAD|RIESGO|CONTAMINACION|DECLARACION)", plano, re.I):
            return "es la tabla de contaminación cruzada, no los ingredientes"

    if campo == "alergenos":
        if not ALERGENOS_REALES.search(plano):
            return "no nombra ningún alérgeno de declaración obligatoria"

    if campo == "conservacion":
        if not re.search(r"\d|TEMPERATURA|REFRIGER|CONGEL|SECO|FRESCO|AMBIENTE",
                         plano, re.I):
            return "no dice ninguna condición concreta"

    return None


def texto_de(pdf: Path) -> tuple[str, int]:
    try:
        import pymupdf
    except ImportError:                                    # pragma: no cover
        sys.exit("Falta pymupdf. Instala con: pip install pymupdf")
    doc = pymupdf.open(pdf)
    try:
        return "\n".join(p.get_text() for p in doc), doc.page_count
    finally:
        doc.close()


def _regex_titulo(patron: str) -> re.Pattern:
    """Un título va en su propia línea, quizá numerado y quizá con dos puntos."""
    return re.compile(
        r"(?:^|\n)[ \t]*(?:\d{1,2}[\.\-\)][ \t]*)?(" + patron + r")[ \t]*[:\.\-]?[ \t]*(?=\n|$)",
        re.IGNORECASE,
    )


_CORTE = re.compile(
    r"(?:^|\n)[ \t]*(?:\d{1,2}[\.\-\)][ \t]*)?(?:" + "|".join(CORTES) + r")[ \t]*[:\.\-]?[ \t]*(?=\n|$)",
    re.IGNORECASE,
)


def bloque(texto: str, patrones: list[str]) -> str | None:
    """El texto que sigue a un título, hasta el siguiente título conocido.

    Devuelve el fragmento LITERAL del PDF. Sin reescribir, sin resumir y sin
    completar: lo único que se hace es recortar espacios sobrantes.
    """
    norm = clave(texto)
    plano = re.sub(r"\s+", " ", sin_tildes(texto))
    # Se busca sobre una versión sin tildes pero con los MISMOS saltos de
    # línea, para poder devolver el tramo exacto del original.
    sin_acentos = sin_tildes(texto)

    for patron in patrones:
        m = _regex_titulo(patron).search(sin_acentos)
        if not m:
            continue
        ini = m.end()
        siguiente = _CORTE.search(sin_acentos, ini)
        fin = siguiente.start() if siguiente else len(sin_acentos)
        # El corte se calcula sobre la versión sin tildes, que conserva la
        # longitud carácter a carácter, así que los índices valen en el original.
        crudo = texto[ini:fin][:MAX_BLOQUE]
        limpio = re.sub(r"[ \t]+", " ", crudo).strip()
        limpio = re.sub(r"\n{3,}", "\n\n", limpio)
        if len(limpio) >= 3:
            return limpio
    return None


def codigo_de(nombre: str) -> str:
    """`0000641.pdf` -> `641`. Los ceros de relleno no son parte del código."""
    return re.sub(r"^0+", "", Path(nombre).stem) or "0"


def codigos_catalogo() -> dict[str, str]:
    """Código normalizado -> descripción, para saber a qué producto va cada ficha."""
    try:
        datos = json.loads(CATALOGO.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    productos = datos.get("productos", datos if isinstance(datos, list) else [])
    out = {}
    for p in productos:
        cod = re.sub(r"^0+", "", str(p.get("codigo", ""))) or "0"
        out.setdefault(cod, p.get("descripcion", ""))
    return out


def construir() -> tuple[list[dict], dict]:
    pdfs = sorted(FUENTE.glob("*.pdf"))
    if not pdfs:
        sys.exit(f"No hay PDFs en {FUENTE}")

    del_catalogo = codigos_catalogo()
    fichas, sin_texto, huerfanas = [], [], []

    for pdf in pdfs:
        texto, paginas = texto_de(pdf)
        cod = codigo_de(pdf.name)
        sha = hashlib.sha256(pdf.read_bytes()).hexdigest()
        escaneada = len(texto.strip()) < MINIMO_TEXTO

        campos, descartados = {}, {}
        if not escaneada:
            for campo, patrones in CAMPOS.items():
                b = bloque(texto, patrones)
                if not b:
                    continue
                motivo = descartar(campo, b)
                if motivo:
                    # Se registra POR QUÉ se tiró, para poder revisarlo después
                    # y para que nadie crea que el campo no estaba en el PDF.
                    descartados[campo] = motivo
                else:
                    campos[campo] = b

        ficha = {
            "product_code": cod,
            "archivo": pdf.name,
            "sha256": sha,
            "bytes": pdf.stat().st_size,
            "paginas": paginas,
            # Sin capa de texto no se afirma nada del contenido: solo se envía
            # el documento y se dice que no tenemos los datos sueltos.
            "sin_capa_texto": escaneada,
            "campos": campos,
            "descartados": descartados,
            "en_catalogo": cod in del_catalogo,
            "descripcion_catalogo": del_catalogo.get(cod),
        }
        fichas.append(ficha)
        if escaneada:
            sin_texto.append(pdf.name)
        if cod not in del_catalogo:
            huerfanas.append({"archivo": pdf.name, "product_code": cod})

    fichas.sort(key=lambda f: f["product_code"])

    cobertura = defaultdict(int)
    tirados = defaultdict(int)
    for f in fichas:
        for campo in f["campos"]:
            cobertura[campo] += 1
        for campo in f.get("descartados", {}):
            tirados[campo] += 1

    resumen = {
        "fichas": len(fichas),
        "con_texto": len(fichas) - len(sin_texto),
        "sin_capa_texto": len(sin_texto),
        "escaneadas": sorted(sin_texto),
        "en_catalogo": sum(1 for f in fichas if f["en_catalogo"]),
        "huerfanas": huerfanas,
        "cobertura_campos": dict(sorted(cobertura.items())),
        "descartados_por_calidad": dict(sorted(tirados.items())),
        "productos_catalogo": len(del_catalogo),
    }
    return fichas, resumen


def invariantes(fichas: list[dict], resumen: dict) -> list[str]:
    """Lo que tiene que ser cierto para poder enseñar esto a un cliente."""
    fallos = []

    for f in fichas:
        if not isinstance(f["product_code"], str) or not f["product_code"]:
            fallos.append(f"código que no es texto: {f['archivo']}")
        if not (FUENTE / f["archivo"]).exists():
            fallos.append(f"el PDF no existe: {f['archivo']}")

        # Un escaneo no puede tener campos: no hay texto del que salieran.
        if f["sin_capa_texto"] and f["campos"]:
            fallos.append(f"{f['archivo']} es un escaneo y trae campos extraídos")

        # LO MÁS IMPORTANTE de este fichero: cada fragmento guardado tiene que
        # seguir estando, palabra por palabra, dentro del PDF del que salió. Si
        # esto falla, algo ha reescrito un texto por el camino y no se puede
        # enseñar a nadie.
        if f["campos"]:
            crudo, _ = texto_de(FUENTE / f["archivo"])
            plano = re.sub(r"\s+", " ", sin_tildes(crudo)).upper()
            for campo, valor in f["campos"].items():
                aguja = re.sub(r"\s+", " ", sin_tildes(valor)).upper().strip()
                if aguja[:80] not in plano:
                    fallos.append(f"{f['archivo']}·{campo}: el texto no está en el PDF")

    codigos = [f["product_code"] for f in fichas]
    repes = {c for c in codigos if codigos.count(c) > 1}
    if repes:
        fallos.append(f"varias fichas para el mismo código: {sorted(repes)}")

    if resumen["fichas"] == 0:
        fallos.append("no se ha importado ninguna ficha")

    return fallos


def estado() -> dict:
    p = DESTINO / "estado.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {"version_activa": None, "versiones": []}


def guardar_estado(e: dict) -> None:
    DESTINO.mkdir(parents=True, exist_ok=True)
    (DESTINO / "estado.json").write_text(
        json.dumps(e, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description="Importa las fichas técnicas de Chacón.")
    ap.add_argument("--aprobar", type=int, help="activa esa versión")
    ap.add_argument("--por", help="quién aprueba (queda registrado)")
    a = ap.parse_args()

    e = estado()

    if a.aprobar is not None:
        if not a.por:
            sys.exit("Aprobar exige --por 'Nombre': la decisión queda firmada.")
        ruta = DESTINO / f"version-{a.aprobar}.json"
        if not ruta.exists():
            sys.exit(f"No existe la versión {a.aprobar}.")
        v = json.loads(ruta.read_text(encoding="utf-8"))
        if v["invariantes_fallidos"]:
            sys.exit(f"La versión {a.aprobar} no pasa sus invariantes.")
        v["approved"] = True
        v["approved_by"] = a.por
        v["approved_at"] = datetime.now(timezone.utc).isoformat()
        ruta.write_text(json.dumps(v, ensure_ascii=False, indent=2), encoding="utf-8")
        e["version_activa"] = a.aprobar
        guardar_estado(e)
        print(f"Fichas v{a.aprobar} ACTIVA (aprobada por {a.por}).")
        return

    fichas, resumen = construir()
    fallos = invariantes(fichas, resumen)

    n = max([v["version"] for v in e["versiones"]], default=0) + 1
    v = {
        "version": n,
        "creada": datetime.now(timezone.utc).isoformat(),
        "source_dir": str(FUENTE.relative_to(RAIZ)),
        "approved": False,
        "approved_by": None,
        "invariantes_fallidos": fallos,
        "resumen": resumen,
        "fichas": fichas,
    }
    DESTINO.mkdir(parents=True, exist_ok=True)
    (DESTINO / f"version-{n}.json").write_text(
        json.dumps(v, ensure_ascii=False, indent=2), encoding="utf-8")
    e["versiones"].append({"version": n, "creada": v["creada"],
                           "fichas": len(fichas), "fallos": len(fallos)})
    guardar_estado(e)

    print(f"Fichas v{n} desde {FUENTE.name}/")
    print(f"  PDFs                     {resumen['fichas']}")
    print(f"  con capa de texto        {resumen['con_texto']}")
    print(f"  escaneados (sin texto)   {resumen['sin_capa_texto']}")
    print(f"  casan con el catálogo    {resumen['en_catalogo']}")
    print(f"  sin producto conocido    {len(resumen['huerfanas'])}")
    print("\n  Campos extraídos:")
    for campo, k in resumen["cobertura_campos"].items():
        print(f"    {campo:14} {k:3}/{resumen['fichas']}")
    if resumen["descartados_por_calidad"]:
        print("\n  Descartados por calidad (mejor vacío que equivocado):")
        for campo, k in resumen["descartados_por_calidad"].items():
            print(f"    {campo:14} {k:3}")

    if fallos:
        print(f"\n⚠️  {len(fallos)} invariantes FALLIDOS:")
        for f in fallos[:12]:
            print(f"    - {f}")
    else:
        print("\nInvariantes: todos en verde.")

    print("\nPENDIENTE. No cambia nada hasta:")
    print(f"  python3 chacon-alcantara/import/extraer_fichas.py --aprobar {n} --por 'Nombre'")


if __name__ == "__main__":
    main()
