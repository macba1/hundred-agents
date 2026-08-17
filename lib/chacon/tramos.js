/* ============================================================
   Selección del tramo de tarifa. Determinista, en código.

   La regla comercial de Chacón:
     tarifa 1  fracción pequeña o unidades sueltas
     tarifa 2  media caja
     tarifa 3  una caja completa
     tarifa 4  más de una caja

   Esto NO puede estar en el prompt. Si el modelo eligiera el tramo, el mismo
   pedido podría facturarse a dos precios distintos en dos conversaciones. Se
   calcula aquí, con la cantidad y las unidades por caja, y punto.

   Discrepancia real que hay que conservar, no tapar:
     - El PDF llama a la tarifa 4 **"+ 2 CAJAS"**.
     - La instrucción comercial escrita dice **"más de una caja"**.
   No son lo mismo: con 2 cajas exactas, una lectura da tarifa 3 y la otra
   tarifa 4. Para el MVP se aplica la instrucción explícita —tarifa 4 en
   cuanto se pase de una caja— y el panel enseña la advertencia hasta que
   Fernando confirme cuál manda. Las dos evidencias quedan guardadas.

   Los umbrales viven en UMBRALES para poder moverlos sin tocar el motor.
   ============================================================ */

/**
 * Fracción de caja a partir de la cual aplica cada tramo.
 * Se leen de entorno para poder ajustarlos sin desplegar código.
 */
const UMBRALES = {
  // Menos de media caja -> tarifa 1.
  media_caja: Number(process.env.CHACON_UMBRAL_MEDIA_CAJA || 0.5),
  // Una caja exacta -> tarifa 3.
  caja_completa: Number(process.env.CHACON_UMBRAL_CAJA_COMPLETA || 1),
  /*
   * A partir de cuántas cajas aplica la tarifa 4.
   * 1 = "más de una caja" (instrucción comercial, la que usa el MVP).
   * 2 = "+ 2 CAJAS" (etiqueta literal del PDF).
   */
  cajas_para_tarifa_4: Number(process.env.CHACON_UMBRAL_TARIFA_4 || 1),
};

/** La discrepancia, en un objeto, para que el panel la enseñe tal cual. */
const ADVERTENCIA_TARIFA_4 = {
  clave: 'umbral_tarifa_4',
  etiqueta_pdf: '+ 2 CAJAS',
  instruccion_comercial: 'más de una caja',
  aplicado_en_el_mvp: 'más de una caja',
  umbral_actual: UMBRALES.cajas_para_tarifa_4,
  pendiente_de: 'Fernando',
  por_que_importa: 'Con 2 cajas exactas, la etiqueta del PDF daría tarifa 3 y la '
    + 'instrucción comercial da tarifa 4. Son precios distintos.',
};

/**
 * Elige el tramo.
 *
 * @param {object} p
 * @param {number} p.cantidad          lo que pidió el cliente
 * @param {'caja'|'unidad'|'kg'} p.unidadPedido
 * @param {number|null} p.unidadesPorCaja
 * @returns {{tier:string|null, determinado:boolean, motivo:string,
 *            cajas:number|null, unidades:number|null, falta?:string}}
 */
function elegirTramo({ cantidad, unidadPedido, unidadesPorCaja = null, umbrales = UMBRALES }) {
  const cant = Number(cantidad);
  if (!Number.isFinite(cant) || cant <= 0) {
    return { tier: null, determinado: false, cajas: null, unidades: null,
             motivo: 'la cantidad no es válida', falta: 'cantidad_valida' };
  }

  // Pedir por kilos no dice nada del tramo: el tramo va por cajas.
  if (unidadPedido === 'kg') {
    return { tier: null, determinado: false, cajas: null, unidades: null,
             motivo: 'pedido en kilos: el tramo se decide por cajas o unidades',
             falta: 'cajas_o_unidades' };
  }

  // Cajas completas: no hace falta saber cuántas unidades trae la caja.
  if (unidadPedido === 'caja') {
    if (!Number.isInteger(cant)) {
      // "media caja" pedida como 0,5 cajas sí es interpretable.
      const frac = cant;
      if (frac < umbrales.media_caja) {
        return { tier: '1', determinado: true, cajas: cant, unidades: null,
                 motivo: `${frac} de caja: por debajo de media caja` };
      }
      if (frac < umbrales.caja_completa) {
        return { tier: '2', determinado: true, cajas: cant, unidades: null,
                 motivo: `${frac} de caja: desde media y menos de una` };
      }
    }
    if (cant === 1) {
      return { tier: '3', determinado: true, cajas: 1, unidades: unidadesPorCaja,
               motivo: 'una caja completa' };
    }
    if (cant > umbrales.cajas_para_tarifa_4) {
      return { tier: '4', determinado: true, cajas: cant,
               unidades: unidadesPorCaja ? cant * unidadesPorCaja : null,
               motivo: `${cant} cajas: más de una caja` };
    }
    return { tier: '3', determinado: true, cajas: cant, unidades: unidadesPorCaja,
             motivo: `${cant} caja(s): no supera el umbral de la tarifa 4` };
  }

  // Unidades: sin saber cuántas trae la caja, no hay proporción que calcular.
  if (unidadPedido === 'unidad') {
    if (!Number.isFinite(unidadesPorCaja) || unidadesPorCaja <= 0) {
      return { tier: null, determinado: false, cajas: null, unidades: cant,
               motivo: 'no consta cuántas unidades trae la caja de este artículo',
               falta: 'unidades_por_caja' };
    }
    const cajas = cant / unidadesPorCaja;
    if (cajas < umbrales.media_caja) {
      return { tier: '1', determinado: true, cajas, unidades: cant,
               motivo: `${cant} de ${unidadesPorCaja} por caja: menos de media caja` };
    }
    if (cajas < umbrales.caja_completa) {
      return { tier: '2', determinado: true, cajas, unidades: cant,
               motivo: `${cant} de ${unidadesPorCaja} por caja: desde media y menos de una` };
    }
    if (cajas === umbrales.caja_completa) {
      return { tier: '3', determinado: true, cajas, unidades: cant,
               motivo: `${cant} unidades: una caja exacta` };
    }
    if (cajas > umbrales.cajas_para_tarifa_4) {
      return { tier: '4', determinado: true, cajas, unidades: cant,
               motivo: `${cant} unidades: más de una caja` };
    }
    return { tier: '3', determinado: true, cajas, unidades: cant,
             motivo: `${cant} unidades: no supera el umbral de la tarifa 4` };
  }

  return { tier: null, determinado: false, cajas: null, unidades: null,
           motivo: `unidad de pedido desconocida: ${unidadPedido}`,
           falta: 'cajas_o_unidades' };
}

module.exports = { elegirTramo, UMBRALES, ADVERTENCIA_TARIFA_4 };
