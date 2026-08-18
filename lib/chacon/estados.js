/* ============================================================
   Máquina de estados de la conversación.

   El modelo interpreta lo que dice el cliente. **El estado del pedido no lo
   toca.** Qué producto se está eligiendo, en qué unidad, con qué cantidad y
   si está confirmado vive aquí, en Redis, y solo cambia por transiciones
   explícitas. Si el estado dependiera de que el LLM "recuerde" la
   conversación, un mensaje ambiguo podría mover un pedido sin que nadie lo
   pidiera.

   Estados y qué significa estar en cada uno:

     HOME               acaba de entrar; no hay nada en curso
     PRODUCT_DISCOVERY  buscando producto, sin candidato aún
     FAMILY_SELECTION   viendo familias
     PRODUCT_SEARCH     ha escrito una búsqueda y hay resultados
     PRODUCT_SELECTION  hay varios candidatos y toca elegir
     QUANTITY_SELECTION hay UN producto elegido y falta la cantidad
     CART               mirando el pedido
     CART_EDIT          eligiendo qué línea cambiar
     PRICE_LOOKUP       consultando precios, sin intención de añadir
     OFFERS             viendo ofertas
     REORDER            repitiendo un pedido anterior
     CHECKOUT           resumen enseñado, esperando CONFIRMAR
     CONFIRMATION       pedido creado
     HUMAN_HANDOFF      derivado a una persona

   Lo que se guarda en cada estado (`datos`) es lo mínimo para poder seguir:
   nunca el histórico de la charla, que es justo lo que el modelo sí puede
   reconstruir sin riesgo.
   ============================================================ */

const repo = require('./repo');

const ESTADOS = [
  'HOME', 'PRODUCT_DISCOVERY', 'FAMILY_SELECTION', 'PRODUCT_SEARCH',
  'PRODUCT_SELECTION', 'QUANTITY_SELECTION', 'CART', 'CART_EDIT',
  'PRICE_LOOKUP', 'OFFERS', 'REORDER', 'CHECKOUT', 'CONFIRMATION',
  'HUMAN_HANDOFF',
];

/**
 * Transiciones permitidas. No es decoración: una transición que no está aquí
 * se rechaza y se registra. Así un intento de saltar de HOME a CONFIRMATION
 * —por un mensaje raro o un clic viejo— no puede crear un pedido.
 */
const TRANSICIONES = {
  HOME: ['PRODUCT_DISCOVERY', 'FAMILY_SELECTION', 'PRODUCT_SEARCH', 'PRICE_LOOKUP',
         'OFFERS', 'REORDER', 'CART', 'HUMAN_HANDOFF', 'HOME'],
  PRODUCT_DISCOVERY: ['FAMILY_SELECTION', 'PRODUCT_SEARCH', 'PRODUCT_SELECTION',
                      'QUANTITY_SELECTION', 'OFFERS', 'CART', 'HOME', 'HUMAN_HANDOFF'],
  FAMILY_SELECTION: ['PRODUCT_SELECTION', 'QUANTITY_SELECTION', 'FAMILY_SELECTION',
                     'PRODUCT_SEARCH', 'CART', 'HOME', 'HUMAN_HANDOFF'],
  PRODUCT_SEARCH: ['PRODUCT_SELECTION', 'QUANTITY_SELECTION', 'FAMILY_SELECTION',
                   'PRODUCT_SEARCH', 'CART', 'HOME', 'HUMAN_HANDOFF'],
  PRODUCT_SELECTION: ['QUANTITY_SELECTION', 'PRODUCT_SEARCH', 'FAMILY_SELECTION',
                      'PRODUCT_SELECTION', 'CART', 'HOME', 'HUMAN_HANDOFF'],
  QUANTITY_SELECTION: ['CART', 'PRODUCT_DISCOVERY', 'PRODUCT_SEARCH', 'FAMILY_SELECTION',
                       'QUANTITY_SELECTION', 'HOME', 'HUMAN_HANDOFF'],
  CART: ['PRODUCT_DISCOVERY', 'FAMILY_SELECTION', 'PRODUCT_SEARCH', 'PRODUCT_SELECTION',
         'QUANTITY_SELECTION', 'CART_EDIT', 'CHECKOUT', 'OFFERS', 'CART', 'HOME',
         'HUMAN_HANDOFF'],
  CART_EDIT: ['CART', 'QUANTITY_SELECTION', 'CART_EDIT', 'HOME', 'HUMAN_HANDOFF'],
  PRICE_LOOKUP: ['PRODUCT_SELECTION', 'QUANTITY_SELECTION', 'PRICE_LOOKUP',
                 'PRODUCT_SEARCH', 'FAMILY_SELECTION', 'CART', 'HOME', 'HUMAN_HANDOFF'],
  OFFERS: ['PRODUCT_SELECTION', 'QUANTITY_SELECTION', 'OFFERS', 'CART', 'HOME',
           'FAMILY_SELECTION', 'PRODUCT_SEARCH', 'HUMAN_HANDOFF'],
  REORDER: ['CART', 'CHECKOUT', 'CART_EDIT', 'PRODUCT_DISCOVERY', 'PRODUCT_SELECTION',
            'HOME', 'HUMAN_HANDOFF'],
  CHECKOUT: ['CONFIRMATION', 'CART', 'CART_EDIT', 'PRODUCT_DISCOVERY', 'HOME',
             'HUMAN_HANDOFF'],
  CONFIRMATION: ['HOME', 'PRODUCT_DISCOVERY', 'PRODUCT_SELECTION', 'QUANTITY_SELECTION',
                 'REORDER', 'CART', 'HUMAN_HANDOFF'],
  HUMAN_HANDOFF: ['HOME', 'HUMAN_HANDOFF'],
};

/** Estados donde una cantidad suelta ("tres") se entiende sin más contexto. */
const ESPERAN_CANTIDAD = new Set(['QUANTITY_SELECTION']);

/** Estados donde un ordinal ("el segundo") se refiere a lo último mostrado. */
const ESPERAN_ORDINAL = new Set(['PRODUCT_SELECTION', 'PRODUCT_SEARCH',
                                 'FAMILY_SELECTION', 'OFFERS', 'CART_EDIT']);

const VACIO = () => ({
  estado: 'HOME',
  datos: {},
  intentos_identificar: 0,
  historial: [],
});

async function leer(telefono) {
  const ctx = await repo.getContexto(telefono);
  const s = ctx.maquina && ESTADOS.includes(ctx.maquina.estado) ? ctx.maquina : VACIO();
  return { ctx, maquina: s };
}

/**
 * Mueve la conversación. Devuelve el estado resultante.
 *
 * Una transición no permitida NO lanza: se queda donde estaba y lo registra.
 * Reventar aquí dejaría al cliente sin respuesta por un clic caducado.
 */
async function mover(telefono, destino, datos = {}, { motivo = null } = {}) {
  const { ctx, maquina } = await leer(telefono);
  const permitidas = TRANSICIONES[maquina.estado] || [];

  if (!ESTADOS.includes(destino)) {
    console.error('[chacon][fsm] estado inexistente:', destino);
    return maquina;
  }
  if (!permitidas.includes(destino)) {
    console.warn('[chacon][fsm] %s -> %s no permitida (%s): se mantiene',
      maquina.estado, destino, motivo || 'sin motivo');
    return maquina;
  }

  const nueva = {
    estado: destino,
    // Los datos se REEMPLAZAN, no se acumulan: arrastrar el producto de una
    // búsqueda anterior es como se acaba añadiendo lo que nadie pidió.
    datos: { ...datos },
    intentos_identificar: destino === 'PRODUCT_DISCOVERY' || destino === 'PRODUCT_SEARCH'
      ? (maquina.intentos_identificar || 0)
      : 0,
    historial: [...(maquina.historial || []),
                { de: maquina.estado, a: destino, ts: new Date().toISOString(), motivo }]
      .slice(-20),
  };
  ctx.maquina = nueva;
  await repo.guardarContexto(ctx);
  return nueva;
}

/** Suma un intento fallido de identificar producto. A los 2, toca escalar. */
async function fallaIdentificacion(telefono) {
  const { ctx, maquina } = await leer(telefono);
  maquina.intentos_identificar = (maquina.intentos_identificar || 0) + 1;
  ctx.maquina = maquina;
  await repo.guardarContexto(ctx);
  return maquina.intentos_identificar;
}

async function reiniciar(telefono) {
  const { ctx } = await leer(telefono);
  ctx.maquina = VACIO();
  await repo.guardarContexto(ctx);
  return ctx.maquina;
}

module.exports = {
  ESTADOS, TRANSICIONES, ESPERAN_CANTIDAD, ESPERAN_ORDINAL,
  leer, mover, fallaIdentificacion, reiniciar, VACIO,
};
