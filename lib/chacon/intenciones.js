/* ============================================================
   Intenciones globales de navegación y pedido.

   Bug real de producción que origina este módulo: "Quiero hacer un pedido
   nuevo" acababa en el buscador de productos y contestaba "no consigo dar con
   «Quiero hacer un pedido nuevo»". No existía ninguna capa que reconociera
   órdenes de navegación, así que todo lo que no fuese un saludo o un menú
   caía al catálogo.

   Regla que lo evita: **una intención global se resuelve ANTES que cualquier
   búsqueda**, y el buscador de productos deja de ser el destino por defecto
   de todo lo que no encaje en otro sitio.

   Deliberadamente determinista y conservador. Confirmar un pedido es
   irreversible, así que `CONFIRM_ORDER` solo se reconoce en frases
   inequívocas: un "vale" suelto no cierra un pedido.
   ============================================================ */

const norm = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();

/*
 * El orden importa: la primera que casa gana. `START_NEW_ORDER` va antes que
 * `START_ORDER` porque "quiero hacer un pedido nuevo" contiene "hacer un
 * pedido" y si no, se lo comería la genérica.
 */
const REGLAS = [
  ['START_NEW_ORDER', [
    /\b(pedido|compra)\s+(nuevo|distinto|diferente)\b/,
    /\bnuevo\s+pedido\b/,
    /\botro\s+pedido\b/,
    /\bpedido\s+otra\s+vez\b/,
    /\b(hacer|empezar|iniciar|crear|empecemos|empezamos)\b.*\b(otro|nuevo)\b.*\b(pedido|compra)\b/,
    /\b(otro|nuevo)\b.*\b(hacer|empezar)\b.*\bpedido\b/,
    /\b(pedir|comprar)\b.*\b(otra vez|de nuevo|nuevamente)\b/,
    /\bempecemos\s+otro\b/,
  ]],
  ['REPEAT_ORDER', [
    /\brepet(ir|ime|eme)\b/,
    /\b(lo\s+)?mismo\s+que\s+(la\s+)?(ultima|otra)\s+vez\b/,
    /\blo\s+de\s+siempre\b/,
    /\blo\s+de\s+la\s+(ultima|otra)\s+vez\b/,
    /\b(mi\s+)?(ultimo|anterior)\s+pedido\b(?!.*\b(ver|consultar)\b)/,
  ]],
  ['CONFIRM_ORDER', [
    /^confirmar?(\s+(el\s+)?pedido)?$/,
    /^s[ií],?\s+confirm(o|ar|alo)\b/,
    /\bconfirm(o|ar|alo)\s+(el\s+)?pedido\b/,
    /^confirmado$/,
  ]],
  ['CANCEL_ORDER', [
    /\bcancelar?\s+(el\s+)?pedido\b/,
    /\banular\s+(el\s+)?pedido\b/,
    /^cancelar$/,
  ]],
  ['FINISH_ORDER', [
    /\b(terminar|finalizar|cerrar|acabar)\s+(el\s+)?pedido\b/,
    /^(ya\s+)?(esta|estaria|estamos)\b\s*$/,
    /^eso\s+es\s+todo$/,
    /^nada\s+mas$/,
    /\bno\s+quiero\s+nada\s+mas\b/,
    /^listo$/,
    /^terminar$/,
  ]],
  ['VIEW_CART', [
    /\b(ver|mira|muestra|ensena|consultar)\b.*\b(mi\s+)?(pedido|carrito|cesta)\b/,
    /^(mi\s+)?(pedido|carrito|cesta)$/,
    /\bque\s+(llevo|tengo)\b/,
    /\bcomo\s+va\s+(mi\s+)?pedido\b/,
  ]],
  ['EDIT_CART', [
    /\bmodificar\s+(el\s+)?pedido\b/,
    /\bcambiar\s+(algo|el pedido)\b/,
    /\bquitar\s+(un\s+)?producto\b/,
  ]],
  ['START_ORDER', [
    /\b(hacer|empezar|iniciar|crear)\s+(un\s+)?pedido\b/,
    /\bquiero\s+(hacer\s+)?(un\s+)?pedido\b/,
    /\bnecesito\s+(hacer\s+)?(un\s+)?pedido\b/,
    /^pedido$/,
    /^(quiero\s+)?(pedir|comprar)$/,
    /\bvoy\s+a\s+(hacer\s+un\s+)?pedi(r|do)\b/,
  ]],
  ['VIEW_OFFERS', [
    /\b(ver|que|hay|tienes|teneis)\b.*\bofertas?\b/,
    /^ofertas?$/,
    /\bpromocion(es)?\b/,
  ]],
  ['GO_HOME', [
    /^(menu|inicio|principal|volver|atras|salir)$/,
    /\bvolver\s+al\s+(menu|inicio)\b/,
  ]],
  ['HUMAN_HANDOFF', [
    /\bhablar\s+con\s+(fernando|alguien|una?\s+persona)\b/,
    /\bque\s+me\s+llame\b/,
    /\bavisa(d|r)?\s+a\s+fernando\b/,
  ]],
  ['VIEW_FAMILIES', [
    /^(ver\s+)?(otras\s+)?familias?$/,
    /^categorias?$/,
    /^ver\s+catalogo$/,
    /\bver\s+el\s+catalogo\b/,
  ]],
];

/**
 * Frases que NUNCA deben llegar al buscador de productos aunque no encajen
 * en ninguna intención concreta. Sin esta lista, un "vale" o un "gracias"
 * acababa buscándose en el catálogo y contestando que no existe.
 */
const NO_ES_PRODUCTO = [
  /^(hola|buenas|hey|buenos dias|buenas tardes|buenas noches)\b/,
  /^(gracias|muchas gracias|ok|vale|perfecto|genial|de acuerdo|entendido)\b\s*$/,
  /^(si|no|sip|nop|claro)\b\s*$/,
  /^(adios|hasta luego|chao|nos vemos)\b/,
  /\bpedido\b/,          // cualquier frase sobre "pedido" es navegación, no producto
  /\bcarrito\b/,
];

/**
 * Reconoce una intención global. Devuelve null si no hay ninguna clara: en
 * ese caso el mensaje sigue su camino normal.
 */
function reconocer(texto) {
  const q = norm(texto);
  if (!q) return null;
  for (const [intent, patrones] of REGLAS) {
    for (const re of patrones) {
      if (re.test(q)) return { intent, por: re.source.slice(0, 40) };
    }
  }
  return null;
}

/** ¿Esto puede ser razonablemente un producto? */
function pareceProducto(texto) {
  const q = norm(texto);
  if (!q || q.length < 3) return false;
  if (reconocer(texto)) return false;
  return !NO_ES_PRODUCTO.some((re) => re.test(q));
}

module.exports = { reconocer, pareceProducto, norm, REGLAS, NO_ES_PRODUCTO };
