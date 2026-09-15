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
/* ---- preguntas sobre un producto ---------------------------------------
   Bug real de producción: "Dame la descripción técnica de la caña de lomo"
   acababa en el buscador de productos, que contestaba "tengo varias
   opciones, ¿cuál buscas?" — y al elegir una salía la tarjeta de compra, no
   la ficha. La pregunta se perdía por el camino.

   Preguntar por un producto NO es buscarlo para comprarlo. Se reconoce como
   intención propia, se queda anotada mientras se desambigua, y se responde
   cuando ya se sabe de qué producto hablamos. */
const CAMPO_PEDIDO = [
  ['alergenos', [
    /\balergen[oa]s?\b/, /\balergic[oa]s?\b/, /\bcelia[ck][oa]s?\b/,
    /\bintoleran/, /\bapto para\b/, /\btrazas\b/,
    /\b(lleva|tiene|contiene|hay)\b[^?]{0,30}\b(gluten|lactosa|soja|huevo|frutos secos|cacahuete|sesamo|mostaza|apio|sulfitos?|altramuz|leche|pescado|crustaceos?|moluscos?)\b/,
    /\b(sin|con)\s+(gluten|lactosa)\b/,
  ]],
  ['conservacion', [
    /\bconserva(cion|r|rse)?\b/, /\bcaduc/, /\bvida util\b/,
    /\bcuanto dura\b/, /\bcomo (se )?(guarda|guardo|almacena)\b/,
    /\bque temperatura\b/, /\brefrigera/, /\bcongela/,
  ]],
  ['ingredientes', [
    /\bingredientes?\b/, /\bcomposicion\b/, /\bde que esta hecho\b/,
    /\bque (lleva|tiene|contiene)\b/, /\bcon que esta hecho\b/,
    /\baditivos?\b/, /\bconservantes?\b/, /\bcolorantes?\b/,
  ]],
  ['modo_empleo', [
    /\bcomo se (usa|prepara|cocina|come)\b/, /\bmodo de empleo\b/,
    /\bse puede comer\b/, /\bhay que cocinar\b/,
  ]],
  // Genérico: quiere la ficha entera, no un dato suelto.
  [null, [
    /\bficha(s)? tecnica(s)?\b/, /\bdescripcion tecnica\b/,
    /\bespecificacion(es)? tecnica(s)?\b/, /\bhoja de producto\b/,
    /\binformacion (tecnica|del producto)\b/, /\bdatos tecnicos\b/,
    /\bmas informacion (de|sobre)\b/, /\bdetalles de\b/,
  ]],
];

/* Palabras de la propia pregunta. Se recortan para quedarse con el producto:
   sin esto, "descripción técnica" se busca en el catálogo y no casa con
   nada. */
const RUIDO_PREGUNTA = new RegExp(
  '\\b(dame|damelo|dime|quiero|necesito|puedes|podrias|me pasas|pasame|'
  + 'mandame|enviame|envia|manda|ver|saber|conocer|consultar|cual es|cuales son|'
  + 'que|de que|como|cuanto|cuanta|tiene|lleva|contiene|hay|es|esta|son|'
  + 'la|el|los|las|un|una|unos|unas|de|del|para|sobre|por favor|porfa|'
  + 'ficha|fichas|tecnica|tecnicas|descripcion|especificacion|especificaciones|'
  + 'hoja|producto|informacion|datos|detalles|ingredientes|composicion|'
  + 'alergenos|alergicos|celiacos|intolerancias|conservacion|conservar|'
  + 'caducidad|vida util|modo|empleo|aditivos|mas|se|sin|con|apto|trazas|'
  // El nombre del alérgeno es parte de la PREGUNTA, no del producto: si se
  // queda dentro, "¿lleva soja?" se busca en el catálogo como "soja".
  + 'gluten|lactosa|soja|huevos?|frutos secos|cacahuetes?|sesamo|mostaza|'
  + 'apio|sulfitos?|altramuz|leche|pescado|crustaceos?|moluscos?)\\b', 'g');

/* Los catorce de declaración obligatoria. Solo estos se contestan como
   "alérgenos"; preguntar por el azúcar o por el pimentón es preguntar por los
   ingredientes, que es otra cosa y otro apartado del documento. */
const ALERGENOS = new RegExp(
  '\\b(gluten|cereal(es)?|trigo|centeno|cebada|avena|espelta|crustaceos?|'
  + 'huevos?|pescado|cacahuetes?|soja|leche|lactosa|frutos secos|'
  + 'frutos de cascara|almendras?|nueces|avellanas?|pistachos?|apio|mostaza|'
  + 'sesamo|sulfitos?|altramuz|moluscos?)\\b');

/* "<producto> lleva <algo>" es una pregunta de composición, y es la forma en
   que se pregunta de verdad: "la caña de lomo lleva azúcar", "el queso lleva
   leche de cabra". El sujeto es el producto y el complemento es lo que se
   busca dentro.

   No confundir con "¿tienes chorizo?", que pregunta si hay existencias: ahí
   el sujeto es Chacón, no el producto, y eso sí va al catálogo. */
const COMPOSICION = /^(.{2,60}?)\s+\b(lleva|tiene|contiene|incluye|trae)\b\s+(.{2,40})$/;

/* Pregunta con el verbo delante: "¿qué lleva el chopped?". */
const COMPOSICION_INVERSA = /\b(que|cuanto|cuanta|cuantos|cuantas)\s+\b(lleva|tiene|contiene|trae)\b\s+(.{2,60})$/;

/** Saludo de cortesía al principio. No cambia lo que se pide detrás. */
/* Las formas largas van PRIMERO: con "buenas" delante, "buenas tardes" se
   recortaba a "tardes" y eso pasaba a tratarse como el producto. */
const SALUDO = /^\s*(buenos dias|buenas tardes|buenas noches|hola+|buenas|hey|oye|perdona|disculpa)\b[\s,.:;!¡]*/i;

const sinSaludo = (texto) => String(texto || '').replace(SALUDO, '').trim();

/** ¿Lo que se pregunta es un alérgeno declarado, o un ingrediente normal? */
const campoSegunLoBuscado = (loBuscado) => (ALERGENOS.test(loBuscado)
  ? 'alergenos' : 'ingredientes');

/**
 * ¿Es una pregunta sobre un producto? Devuelve qué se pregunta y sobre qué.
 *
 *   { campo: 'alergenos'|'ingredientes'|…|null, producto: 'caña de lomo' }
 *
 * `campo: null` significa que quiere la ficha entera. `producto: ''` que
 * preguntó sin decir de cuál —"¿lleva gluten?"— y hay que mirar de qué se
 * estaba hablando.
 *
 * Se reconoce por la FORMA de la pregunta y no por una lista de palabras. La
 * lista siempre se queda corta: "azúcar" no es un alérgeno declarado y por
 * eso "la caña de lomo lleva azúcar" acabó tratándose como un saludo.
 */
function fichaPedida(texto) {
  const q = norm(sinSaludo(texto));
  if (!q) return null;

  // Comprar es comprar, y manda sobre cualquier lectura de pregunta.
  if (reconocer(q)) return null;

  /* Con el verbo delante —"¿qué lleva el chopped?"— el producto va detrás.
     Se mira PRIMERO: si no, "que" se tomaría como el nombre del producto. */
  const mi = q.match(COMPOSICION_INVERSA);
  if (mi) {
    const producto = mi[3].replace(RUIDO_PREGUNTA, ' ').replace(/\s+/g, ' ').trim();
    return { campo: 'ingredientes', producto };
  }

  /* Forma "<producto> lleva <algo>". Es la más informativa: dice el producto
     Y lo que se busca dentro. */
  const m = q.match(COMPOSICION);
  if (m && !/^(tienes|teneis|hay|tenéis|me|nos|quiero|dame|ponme)\b/.test(m[1])) {
    const producto = m[1].replace(RUIDO_PREGUNTA, ' ').replace(/\s+/g, ' ').trim();
    return { campo: campoSegunLoBuscado(m[3]), producto, buscado: m[3].trim() };
  }

  for (const [campo, patrones] of CAMPO_PEDIDO) {
    if (!patrones.some((re) => re.test(q))) continue;
    const producto = q.replace(RUIDO_PREGUNTA, ' ').replace(/\s+/g, ' ').trim();
    return { campo, producto };
  }
  return null;
}

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

/* ---- ¿esto es una pregunta? --------------------------------------------
   No hace falta saber QUÉ pregunta: basta con saber que lo es, para que la
   conteste el modelo —que tiene el historial y entiende "y el queso?"— en vez
   de la capa de reglas, que necesitaría una regla nueva por cada forma de
   preguntar. Las reglas se quedan para lo que no puede improvisarse: el
   carrito, los precios, la identidad y el estado del pedido. */
const INTERROGATIVAS = /^(que|cual|cuales|cuanto|cuanta|cuantos|cuantas|como|donde|cuando|por que|porque|quien|hay|tiene|tienes|teneis|lleva|llevan|contiene|es|son|se puede|puedo|podria)\b/;

/* Continuación: "y el queso?", "¿y ese?". Sin producto ni verbo, solo tiene
   sentido mirando lo anterior — que es justo lo que el modelo sí tiene. */
const CONTINUACION = /^(y|pero|entonces|vale y|ah y)\b.{0,40}$/;

/**
 * ¿El cliente está preguntando algo, en vez de pidiendo algo?
 *
 * Deliberadamente amplio para preguntas y estricto para órdenes: una compra
 * mal leída como pregunta solo cuesta una respuesta de más, pero una pregunta
 * mal leída como compra mete producto en el pedido.
 */
function esPregunta(texto) {
  const q = norm(sinSaludo(texto));
  if (!q) return false;

  // Comprar, confirmar o cancelar mandan siempre: no son preguntas.
  if (reconocer(q)) return false;
  if (/^(ponme|pon|dame|quiero|necesito|anade|añade|agrega|mete|sirveme)\b/.test(q)) return false;

  if (/\?/.test(String(texto))) return true;
  if (INTERROGATIVAS.test(q)) return true;
  if (CONTINUACION.test(q)) return true;
  return !!fichaPedida(texto);
}

/** ¿Esto puede ser razonablemente un producto? */
function pareceProducto(texto) {
  const q = norm(texto);
  if (!q || q.length < 3) return false;
  if (reconocer(texto)) return false;
  return !NO_ES_PRODUCTO.some((re) => re.test(q));
}

module.exports = {
  reconocer, pareceProducto, fichaPedida, esPregunta, sinSaludo, norm,
  REGLAS, NO_ES_PRODUCTO, CAMPO_PEDIDO, SALUDO,
};
