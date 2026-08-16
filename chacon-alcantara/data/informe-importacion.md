# Informe de importación — catálogo Chacón Alcántara S.L.

- **PDF**: `Catalogo Articulos Tarifa 1.pdf`
- **SHA-256**: `08fd02e55fd9d745a288f30fd18b91a6a87b94415e468f0d3e48b18593f5a71a`
- **Generado**: 2026-08-16T14:30:51.160634+00:00

## Recuento

| Métrica | Valor |
|---|---|
| Páginas | 38 |
| Fichas extraídas | 112 |
| Códigos únicos | 90 |
| Registros con código repetido | 22 |
| **Bloqueados para pedido** (`price_conflict`) | **41** |
| Imágenes en el PDF | 110 |
| Marcas distintas | 19 |

## Campos sin informar

Vacío **no** es negativo: son datos que Chacón no ha proporcionado.

| Campo | Fichas sin dato | % |
|---|---|---|
| `cod_barras` | 37 | 33% |
| `gluten` | 97 | 87% |
| `lactosa` | 97 | 87% |
| `observaciones` | 99 | 88% |
| `peso_und_kg` | 0 | 0% |
| `und_caja` | 0 | 0% |
| `tarifa` | 0 | 0% |
| `marca` | 0 | 0% |

## Códigos con tarifas contradictorias

**19 códigos** aparecen más de una vez con precios distintos.
En todos ellos el resto de campos es idéntico: misma descripción, mismo código de
barras, misma marca, mismas unidades por caja y mismo peso. **Solo cambia el precio.**
No es una diferencia de formato: es una contradicción que solo Chacón puede resolver.

| Código | Registros | Tarifas | Páginas | Descripción |
|---|---|---|---|---|
| `2003` | 2 | 4.167 / 5.278 | 3 4 | 1/2 FBRE. LOMO CDO. ADB. C/2P DEL MIO |
| `21446` | 2 | 5.417 / 6.528 | 4 4 | SALAMI EXTRA BLANCO |
| `30101` | 2 | 19.8 / 23.294 | 24 24 | FILETES DE CABALLA A/G 1800 C/ 6 |
| `30201` | 2 | 5.101 / 6.0 | 25 25 | FILETES DE CABALLA A/G 250 C/24 PACK6PZAS |
| `30301` | 2 | 7.149 / 7.946 | 25 26 | FILETES CABALLA RO 550 C/24 A/G |
| `30501` | 2 | 1.817 / 2.471 | 26 26 | FTES. CABALLA 125G. 50 U.C/ 5 PZAS RETR. |
| `30701` | 2 | 11.796 / 13.882 | 27 27 | FILETES DE CABALLA A/G 1000 C/ 12 |
| `3502` | 2 | 4.514 / 4.86 | 34 35 | BARRA LUNCH 1.3 KG.PAMPLONICA |
| `5000` | 2 | 0.633 / 1.278 | 37 38 | CHURROS CONG.450GM. RICARTE |
| `5100` | 2 | 23.118 / 27.941 | 27 28 | MELVA 1800 FILETE DE ALMADRABA RO C/6 |
| `5102` | 2 | 17.034 / 20.588 | 28 28 | MELVA FILETE DE ALMADRABA 1000 C/ 12 |
| `6302` | 2 | 21.0 / 50.694 | 29 29 | LOMITO IBERICO BELLOTA *MARCIAL* |
| `6303` | 2 | 21.0 / 50.0 | 30 30 | LOMO PLATA CEBO CAMPO 50% *MARCIAL* |
| `6304` | 3 | 7.81 / 12.5 / 13.889 | 30 31 31 | SALCHICHON CULAR PLATA IB. *MARCIAL* |
| `6305` | 3 | 7.81 / 12.5 / 13.889 | 31 32 32 | CHORIZO CULAR PLATA IB. *MARCIAL* |
| `6703` | 2 | 6.112 / 7.083 | 8 9 | BACON MOLDE MEDIOS DEL MIO |
| `6803` | 3 | 1.257 / 2.367 / 2.74 | 15 15 15 | CHOPPED CERDO ESP. 350 GRS.CRISMONA |
| `7001` | 2 | 23.125 / 24.306 | 33 34 | QUESO CURADO OCAÑA |
| `8003` | 2 | 14.097 / 16.875 | 35 36 | QUESO "EL HIDALGO" ACEITE GRANDE |

Estos artículos quedan **bloqueados para la confirmación automática de pedidos**
hasta que un administrador elija el registro válido.

## Marcas

| Marca | Fichas |
|---|---|
| DEL MIO | 34 |
| LA TARIFEÑA | 14 |
| MARCIAL CASTRO | 12 |
| CAMPOFRIO | 8 |
| LA GONDOLA | 6 |
| CRISMONA | 5 |
| HORNO CARLOS III | 5 |
| QUESO EL HIDALGO | 5 |
| FRIMANCHA | 4 |
| PAMPLONICA | 4 |
| RICARTE | 3 |
| EL CASERITO | 2 |
| EL POZO | 2 |
| HERMANOS DEL RIO | 2 |
| OCAÑA | 2 |
| ESPIGA REAL | 1 |
| FRABER | 1 |
| LAVEGA | 1 |
| MUÑOZ ROJO | 1 |

## Archivos generados

- `catalogo-normalizado.json` — catálogo con original + normalizado + trazas
- `duplicados.csv` — códigos con tarifas contradictorias
- `campos-vacios.csv` — fichas con campos sin informar
- `tarifas-sospechosas.csv` — precios extremos, pesos a cero y conflictos
