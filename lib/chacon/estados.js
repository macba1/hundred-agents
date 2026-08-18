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
     CUSTOMER_IDENTIFICATION  esperando el nombre del negocio
     HUMAN_HANDOFF      derivado a una persona

   `CUSTOMER_IDENTIFICATION` manda sobre todo lo demás: mientras esté activo,
   lo que escriba el cliente es el nombre de su negocio, **nunca** una
   búsqueda de producto. Este bug se vio en producción — "tony tienda"
   acabó en el buscador y contestó "no he encontrado «tony tienda»".

   Por eso existe `slot_pendiente`: cuando hay un dato obligatorio a medias,
   el estado gana al enrutado genérico. Y `estado_previo` guarda de dónde
   veníamos para volver exactamente ahí, sin pasar por HOME ni perder el
   carrito.

   Lo que se guarda en cada estado (`datos`) es lo mínimo para poder seguir:
   nunca el histórico de la charla, que es justo lo que el modelo sí puede
   reconstruir sin riesgo.
   ============================================================ */

const repo = require('./repo');

const ESTADOS = [
  'HOME', 'PRODUCT_DISCOVERY', 'FAMILY_SELECTION', 'PRODUCT_SEARCH',
  'PRODUCT_SELECTION', 'QUANTITY_SELECTION', 'CART', 'CART_EDIT',
  'PRICE_LOOKUP', 'OFFERS', 'REORDER', 'CHECKOUT', 'CONFIRMATION',
  'CUSTOMER_IDENTIFICATION', 'HUMAN_HANDOFF',
];

/** Slots obligatorios. Con uno pendiente, el estado manda sobre el intent. */
const SLOTS = { BUSINESS_NAME: 'BUSINESS_NAME' };

/* Desde CUALQUIER estado se puede tener que identificar al cliente, y desde
   la identificación se vuelve a donde se estaba. Se declara aparte para no
   repetirlo catorce veces y para que no se olvide en el siguiente estado
   nuevo. */
const SIEMPRE = ['CUSTOMER_IDENTIFICATION', 'HUMAN_HANDOFF', 'HOME'];

/**
 * Transiciones permitidas. No es decoración: una transición que no está aquí
 * se rechaza y se registra. Así un intento de saltar de HOME a CONFIRMATION
 * —por un mensaje raro o un clic viejo— no puede crear un pedido.
 */
const TRANSICIONES_BASE = {
  HOME: ['PRODUCT_DISCOVERY', 'FAMILY_SELECTION', 'PRODUCT_SEARCH', 'PRODUCT_SELECTION',
         'QUANTITY_SELECTION', 'PRICE_LOOKUP', 'OFFERS', 'REORDER', 'CART'],
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
  HUMAN_HANDOFF: ['HOME', 'FAMILY_SELECTION', 'PRODUCT_DISCOVERY', 'CART'],
  /* Se vuelve al estado en el que estábamos, así que la identificación puede
     desembocar en cualquiera. Lo que NO puede es crear un pedido: para eso
     hay que pasar por CHECKOUT. */
  CUSTOMER_IDENTIFICATION: ESTADOS.filter((e) => e !== 'CONFIRMATION'),
};

/** Tabla efectiva: a cada estado se le añaden los destinos universales. */
const TRANSICIONES = Object.fromEntries(
  Object.entries(TRANSICIONES_BASE).map(([desde, hacia]) => [
    desde, [...new Set([...hacia, ...SIEMPRE, desde])],
  ]));

/** Estados donde una cantidad suelta ("tres") se entiende sin más contexto. */
const ESPERAN_CANTIDAD = new Set(['QUANTITY_SELECTION']);

/** Estados donde un ordinal ("el segundo") se refiere a lo último mostrado. */
const ESPERAN_ORDINAL = new Set(['PRODUCT_SELECTION', 'PRODUCT_SEARCH',
                                 'FAMILY_SELECTION', 'OFFERS', 'CART_EDIT']);

const VACIO = () => ({
  estado: 'HOME',
  datos: {},
  slot_pendiente: null,
  estado_previo: null,
  intentos_identificar: 0,
  historial: [],
});

/**
 * Campos de BÚSQUEDA que hay que tirar al cambiar de contexto.
 *
 * Se enumera lo que se BORRA, no lo que se conserva: así, cuando alguien
 * añada un campo nuevo de búsqueda, olvidarse de ponerlo aquí deja una fuga
 * visible en las pruebas en vez de un residuo silencioso. El carrito, el
 * cliente y el pedido no viven aquí, así que no se pueden perder por esto.
 */
const CAMPOS_DE_BUSQUEDA = ['mostrados', 'familia', 'subcategoria', 'etiqueta',
                            'offset', 'consulta', 'candidatos', 'codigo',
                            'esperando_cantidad', 'editando'];

function limpiarBusqueda(datos = {}) {
  const out = { ...datos };
  for (const c of CAMPOS_DE_BUSQUEDA) delete out[c];
  return out;
}

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
async function mover(telefono, destino, datos = {}, {
  motivo = null, slot = null, recordarPrevio = false, conservarPrevio = false } = {}) {
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
    slot_pendiente: slot,
    // Al desviarse a identificar, se apunta de dónde veníamos para volver
    // exactamente ahí. Mandar a HOME perdería la búsqueda en curso.
    estado_previo: recordarPrevio ? maquina.estado
      : (conservarPrevio ? maquina.estado_previo : null),
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

/** Deja el estado listo para enseñar FAMILIAS, sin restos de una búsqueda. */
async function entrarEnFamilias(telefono, { motivo = 'ver familias' } = {}) {
  const { ctx, maquina } = await leer(telefono);
  return mover(telefono, 'FAMILY_SELECTION', limpiarBusqueda(maquina.datos),
    { motivo, conservarPrevio: true });
}

module.exports = {
  ESTADOS, TRANSICIONES, TRANSICIONES_BASE, SLOTS, SIEMPRE,
  ESPERAN_CANTIDAD, ESPERAN_ORDINAL, CAMPOS_DE_BUSQUEDA,
  leer, mover, fallaIdentificacion, reiniciar, VACIO,
  limpiarBusqueda, entrarEnFamilias,
};
