/* ============================================================
   Enrutador de la conversación guiada.

   Recibe lo que hizo el cliente —un clic, un texto, un audio ya transcrito—
   y devuelve las pantallas que hay que enviarle, moviendo la máquina de
   estados. **Sin LLM.** Todo lo que se resuelve aquí es determinista: el
   producto sale del catálogo, la cantidad de lo que dijo el cliente, el
   precio de la tarifa aprobada.

   Cuando NO puede resolver algo con certeza devuelve `null`, y entonces el
   agente de siempre se encarga con lenguaje natural. Ese es el reparto:
   la interfaz guía, el modelo cubre lo que se sale del guion, y ninguno de
   los dos puede inventar un producto ni mover una cantidad.
   ============================================================ */

const estados = require('./estados');
const flujo = require('./flujo');
const descubrimiento = require('./descubrimiento');
const categorias = require('./categorias');
const catalogo = require('./catalogo');
const pedidoLib = require('./pedido');
const repeticion = require('./repeticion');
const repo = require('./repo');
const formato = require('./wa-formato');
const identificacion = require('./identificacion');
const privacidad = require('./privacidad');
const agenda = require('./clientes');
const intenciones = require('./intenciones');
const fabrica = require('./fabrica');

const norm = descubrimiento.norm;

/** Números escritos, para "ponme tres". */
const NUMEROS = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10, doce: 12, quince: 15, veinte: 20,
};

const ORDINALES = {
  primero: 1, primera: 1, segundo: 2, segunda: 2, tercero: 3, tercera: 3,
  cuarto: 4, cuarta: 4, quinto: 5, quinta: 5, ultimo: -1, ultima: -1,
};

function cantidadDe(texto) {
  const q = norm(texto);
  const num = q.match(/\b(\d+(?:[.,]\d+)?)\b/);
  let cantidad = num ? Number(num[1].replace(',', '.')) : null;
  if (cantidad === null) {
    for (const [p, n] of Object.entries(NUMEROS)) {
      if (new RegExp(`\\b${p}\\b`).test(q)) { cantidad = n; break; }
    }
  }
  let unidad = null;
  if (/\bcajas?\b/.test(q)) unidad = 'caja';
  else if (/\b(piezas?|unidades?|und|uds?)\b/.test(q)) unidad = 'unidad';
  else if (/\bkilos?\b|\bkg\b/.test(q)) unidad = 'kg';
  return { cantidad, unidad };
}

function ordinalDe(texto) {
  const q = norm(texto);
  for (const [p, n] of Object.entries(ORDINALES)) {
    if (new RegExp(`\\b${p}\\b`).test(q)) return n;
  }
  return null;
}

/* ---- añadir con las validaciones de siempre ----------------------------- */
async function anadir(telefono, clienteId, producto, cantidad, unidad) {
  const r = await pedidoLib.anadir(clienteId, {
    producto_id: producto.id, cantidad, unidad_pedido: unidad });
  if (!r.ok) {
    if (r.error === 'unidad_ambigua') {
      await estados.mover(telefono, 'QUANTITY_SELECTION',
        { codigo: producto.codigo, cantidad }, { motivo: 'unidad ambigua' });
      return [formato.botones(
        `¿${cantidad} cajas o ${cantidad} piezas de ${flujo.bonito(producto.descripcion)}?`,
        [{ id: `cant:${producto.codigo}:${cantidad}:caja`, titulo: `${cantidad} cajas` },
         { id: `cant:${producto.codigo}:${cantidad}:unidad`, titulo: `${cantidad} piezas` }])];
    }
    return [formato.texto('No he podido añadirlo. ¿Me lo dices otra vez?')];
  }
  await estados.mover(telefono, 'CART', {}, { motivo: 'producto añadido' });
  return flujo.trasAnadir(r.linea);
}

/** Enseña un producto o pide elegir, según cuántos candidatos haya. */
async function presentar(telefono, res, { titulo = null } = {}) {
  if (res.tipo === 'producto') {
    await estados.mover(telefono, 'QUANTITY_SELECTION',
      { codigo: res.producto.codigo }, { motivo: 'producto identificado' });
    return flujo.fichaProducto(res.producto);
  }
  if (res.tipo === 'familia') {
    const prods = res.candidatos && res.candidatos.length
      ? res.candidatos : descubrimiento.candidatosDeFamilia(
        { tipo: 'categoria', clave: res.clave });
    await estados.mover(telefono, 'PRODUCT_SELECTION',
      { mostrados: prods.map((p) => p.codigo), familia: res.clave },
      { motivo: 'familia abierta' });
    // El nombre puede venir de una subcategoría ("chorizo"): se presenta en
    // lenguaje de cliente, no con la clave interna.
    const etiqueta = flujo.bonito(String(res.nombre || '').replace(/_/g, ' '));
    const cab = res.es_sugerencia
      ? `Te propongo ${etiqueta}. ¿Alguno de estos?`
      : `Esto tengo de ${etiqueta.toLowerCase()}. ¿Cuál te interesa?`;
    return flujo.listaDeProductos(prods, { titulo: cab,
      hayMas: (res.total || prods.length) > flujo.MAX_OPCIONES });
  }
  if (res.tipo === 'varios') {
    await estados.mover(telefono, 'PRODUCT_SELECTION',
      { mostrados: res.candidatos.map((p) => p.codigo) },
      { motivo: 'varios candidatos' });
    return flujo.listaDeProductos(res.candidatos, {
      titulo: titulo || 'Tengo varias opciones. ¿Cuál buscas?',
      hayMas: res.total > res.candidatos.length });
  }
  if (res.tipo === 'no_comercial') {
    // Portes, palés, etiquetas: existen, pero no se venden a una tienda.
    return [formato.botones(
      'Ese no es un artículo que pueda añadir a un pedido. ¿Buscas otra cosa?',
      [{ id: 'ver_familias', titulo: '🥩 Ver familias' },
       { id: 'ver_ofertas', titulo: '🔥 Ver ofertas' }])];
  }
  return null;
}

/** Tras dos intentos sin identificar, se ofrece una persona. No se insiste. */
async function noEncontrado(telefono, consulta) {
  const intentos = await estados.fallaIdentificacion(telefono);
  if (intentos >= 2) {
    await estados.mover(telefono, 'HUMAN_HANDOFF', {}, { motivo: 'dos intentos fallidos' });
    return [formato.botones(
      `No consigo dar con «${consulta}». Te paso con Fernando, que lo localiza enseguida.`,
      [{ id: 'hablar_fernando', titulo: '👤 Sí, avísale' },
       { id: 'ver_familias', titulo: '🥩 Ver familias' }])];
  }
  return flujo.menuFamilias(`No he encontrado «${consulta}». ¿Te enseño por familias?`);
}

/* ---- privacidad --------------------------------------------------------- */
/**
 * Enseña el aviso y espera una acción explícita.
 *
 * No vale con que haya escrito "hola": aceptar por el hecho de escribir no es
 * una acción explícita y no se podría demostrar. Se recuerda de dónde venía
 * para no perder el pedido en curso.
 */
async function pedirPrivacidad(telefono, { accionPendiente = null, mensajeInicial = null } = {}) {
  const { maquina } = await estados.leer(telefono);
  await estados.mover(telefono, 'PRIVACY_ONBOARDING',
    { ...maquina.datos,
      ...(accionPendiente ? { accion_pendiente: accionPendiente } : {}),
      ...(mensajeInicial ? { mensaje_inicial: mensajeInicial } : {}) },
    { motivo: 'canal sin autorizar', slot: estados.SLOTS.PRIVACY_ACCEPT,
      recordarPrevio: maquina.estado !== 'PRIVACY_ONBOARDING',
      conservarPrevio: maquina.estado === 'PRIVACY_ONBOARDING' });
  console.log('[chacon][evento] privacy_onboarding_shown tel=%s version=%s',
    telefono, privacidad.VERSION_AVISO);
  return flujo.avisoPrivacidad(privacidad.textoAviso());
}

/** Acepta y sigue: identificar si hace falta, o volver a lo que hacía. */
async function aceptarPrivacidad(telefono, wamid) {
  await privacidad.registrarDecision(telefono, privacidad.ESTADOS.ACEPTADO,
    { accepted_action: 'boton_continuar', wamid });
  const cliente = await repo.clientePorTelefono(telefono);
  if (cliente) {
    await privacidad.vincularCliente(telefono, cliente.id);
    return volverDeIdentificacion(telefono, cliente);
  }

  /* Si en su primer mensaje ya dijo quién es, se aprovecha en vez de
     preguntárselo otra vez. Repetir una pregunta que el cliente ya ha
     contestado es de las cosas que más molestan de un bot. */
  const { maquina } = await estados.leer(telefono);
  const inicial = maquina.datos.mensaje_inicial;
  if (inicial) {
    const posible = identificacion.nombreDeNegocio(inicial);
    if (posible) {
      const r = identificacion.enAgenda(posible);
      if (r.estado === 'encontrado_agenda' || r.estado === 'ambiguo_agenda') {
        await estados.mover(telefono, 'CUSTOMER_IDENTIFICATION', { ...maquina.datos },
          { motivo: 'nombre del primer mensaje', slot: estados.SLOTS.BUSINESS_NAME,
            conservarPrevio: true });
        return resolverNegocio(telefono, posible);
      }
    }
  }
  return pedirIdentificacion(telefono);
}

/* ---- identificación de la tienda ---------------------------------------- */
/**
 * Abre la identificación recordando de dónde veníamos, para poder volver
 * exactamente ahí. Mandar a HOME perdería la búsqueda en curso.
 */
async function pedirIdentificacion(telefono, { reintento = false, accionPendiente = null } = {}) {
  const { maquina } = await estados.leer(telefono);
  /* Los datos de la búsqueda en curso viajan con nosotros: al volver hay que
     poder reponer la misma lista de productos que estaba viendo, no dejarle
     en el menú principal habiendo perdido lo que buscaba. */
  /* Si venimos del aviso de privacidad, el sitio al que hay que volver es el
     que ya guardó el aviso, no el aviso mismo: encadenarlos dejaría al
     cliente de vuelta en la pantalla de privacidad. */
  const encadenado = reintento || maquina.estado === 'PRIVACY_ONBOARDING';
  await estados.mover(telefono, 'CUSTOMER_IDENTIFICATION',
    { ...maquina.datos,
      ...(accionPendiente ? { accion_pendiente: accionPendiente } : {}) },
    { motivo: 'falta identificar la tienda', slot: estados.SLOTS.BUSINESS_NAME,
      recordarPrevio: !encadenado, conservarPrevio: encadenado });
  console.log('[chacon][evento] customer_identification_started tel=%s reintento=%s',
    telefono, reintento);
  return flujo.pedirNegocio({ reintento });
}

/** Vuelve al estado en el que se quedó, con el carrito intacto. */
async function volverDeIdentificacion(telefono, cliente) {
  const { maquina } = await estados.leer(telefono);
  const pendiente = maquina.datos.accion_pendiente || null;
  const destino = maquina.estado_previo && maquina.estado_previo !== 'CUSTOMER_IDENTIFICATION'
    ? maquina.estado_previo : 'HOME';
  await estados.mover(telefono, destino, maquina.datos || {},
    { motivo: 'identificado, se vuelve donde estaba' });
  console.log('[chacon][evento] customer_identification_success tel=%s cliente=%s vuelve_a=%s',
    telefono, cliente.id, destino);
  await privacidad.vincularCliente(telefono, cliente.id).catch(() => {});

  const saludo = formato.texto(
    `Perfecto, ${String(cliente.nombre).replace(/\.$/, '')}. Seguimos con tu pedido.`);

  /* Si el cliente estaba añadiendo algo cuando le pedimos el nombre, se
     completa ahora. Si no, habría que repetir todo el recorrido. */
  if (pendiente) {
    const seguir = await porClic(telefono, cliente, pendiente);
    if (seguir && seguir.length) return [saludo, ...seguir];
  }
  if (destino === 'CART' || destino === 'CART_EDIT' || destino === 'CHECKOUT') {
    return [saludo, ...(await flujo.verCarrito(cliente.id))];
  }
  if (destino === 'PRODUCT_SELECTION' && (maquina.datos.mostrados || []).length) {
    const prods = maquina.datos.mostrados
      .map((c) => catalogo.todos().find((p) => p.codigo === c)).filter(Boolean);
    if (prods.length) {
      return [saludo, ...flujo.listaDeProductos(prods, { titulo: '¿Seguimos con estos?' })];
    }
  }
  if (destino === 'QUANTITY_SELECTION' && maquina.datos.codigo) {
    const p = catalogo.todos().find((x) => x.codigo === maquina.datos.codigo);
    if (p) return [saludo, ...(await flujo.fichaProducto(p))];
  }
  return [saludo, ...flujo.home(cliente)];
}

/**
 * Trata el mensaje como nombre de negocio. **No toca el catálogo.**
 * Este es el arreglo del bug: con el slot abierto, el dominio es identidad.
 */
async function resolverNegocio(telefono, texto) {
  let nombre = identificacion.nombreDeNegocio(texto);
  /* Un número suelto no es un nombre, pero sí puede ser el código de cliente
     que Chacón les da. Se prueba tal cual antes de rendirse. */
  if (!nombre && /^[A-Za-z0-9-]{1,12}$/.test(String(texto).trim())) {
    nombre = String(texto).trim();
  }
  if (!nombre) {
    console.log('[chacon][evento] customer_identification_retry tel=%s motivo=sin_nombre', telefono);
    return flujo.pedirNegocio({ reintento: true });
  }

  /* Se busca en la AGENDA oficial. Nunca en el catálogo de productos: son
     resolvedores distintos y mezclarlos fue un bug real de producción. */
  const r = identificacion.enAgenda(nombre);

  if (r.estado === 'encontrado_agenda') {
    // No se vincula todavía: primero lo confirma la tienda.
    const { maquina } = await estados.leer(telefono);
    await estados.mover(telefono, 'CUSTOMER_IDENTIFICATION',
      { ...maquina.datos, propuesto: r.cliente_agenda.customer_code },
      { motivo: 'candidato de la agenda', slot: estados.SLOTS.BUSINESS_NAME,
        conservarPrevio: true });
    return flujo.confirmarNegocio(r.cliente_agenda);
  }
  if (r.estado === 'ambiguo_agenda') {
    console.log('[chacon][evento] customer_identification_ambiguous tel=%s n=%s',
      telefono, r.candidatos.length);
    const { maquina } = await estados.leer(telefono);
    await estados.mover(telefono, 'CUSTOMER_IDENTIFICATION',
      { ...maquina.datos, candidatos: r.candidatos.map((c) => c.customer_code) },
      { motivo: 'varios en la agenda', slot: estados.SLOTS.BUSINESS_NAME,
        conservarPrevio: true });
    return flujo.elegirNegocio(r.candidatos);
  }

  console.log('[chacon][evento] customer_identification_failed tel=%s nombre=%j', telefono, nombre);
  const { maquina: mNo } = await estados.leer(telefono);
  await estados.mover(telefono, 'CUSTOMER_IDENTIFICATION',
    { ...mNo.datos, ultimo_nombre: nombre },
    { motivo: 'no está en la agenda', slot: estados.SLOTS.BUSINESS_NAME,
      conservarPrevio: true });
  return flujo.negocioFueraDeAgenda(nombre);
}

/** La tienda confirma cuál es. Solo aquí se ata el teléfono. */
async function confirmarCliente(telefono, codigo) {
  const enAgenda = agenda.porCodigo(codigo);
  if (!enAgenda) return pedirIdentificacion(telefono, { reintento: true });

  /* El centro no se elige por orden de aparición: con varios se deja sin
     resolver y lo decide Fernando cuando haga falta. Son códigos internos
     que el cliente probablemente ni conoce. */
  const centro = agenda.centroDe(enAgenda);
  if (centro.estado === 'sin_resolver') {
    console.log('[chacon][evento] customer_center_unresolved tel=%s code=%s opciones=%j',
      telefono, codigo, centro.opciones);
  }
  const ficha = await identificacion.vincular(enAgenda, telefono,
    { center: centro.center, estadoCentro: centro.estado });
  await privacidad.vincularCliente(telefono, ficha.id).catch(() => {});
  return volverDeIdentificacion(telefono, ficha);
}

/* ---- pedido: ciclo de vida --------------------------------------------- */
/** Empieza un borrador limpio. Nunca arrastra nada del pedido anterior. */
async function empezarNuevo(telefono, clienteId, { abandonando = false } = {}) {
  if (clienteId) {
    if (abandonando) {
      const viejo = await repo.getCarrito(clienteId);
      if ((viejo.lineas || []).length) {
        viejo.estado = estados.PEDIDO.ABANDONED;
        viejo.abandonado_en = new Date().toISOString();
        // Se guarda antes de vaciar: no se destruye trabajo sin dejar rastro.
        await repo.guardarCarrito(viejo);
        console.log('[chacon][evento] draft_abandoned cliente=%s lineas=%s',
          clienteId, viejo.lineas.length);
      }
    }
    await repo.borrarCarrito(clienteId);
  }
  await estados.mover(telefono, 'PRODUCT_DISCOVERY', {}, { motivo: 'pedido nuevo' });
  console.log('[chacon][evento] order_started tel=%s', telefono);
  const h = clienteId ? await flujo.misHabituales(clienteId) : { hay: false };
  return [formato.texto('Perfecto. Empezamos un pedido nuevo.'), ...flujo.comoEmpezar(h.hay)];
}

/** Confirma. Idempotente: dos pulsaciones no crean dos pedidos. */
async function confirmar(telefono, cliente, { wamid = null } = {}) {
  if (!cliente) return pedirIdentificacion(telefono);
  const carrito = await repo.getCarrito(cliente.id);
  if (!(carrito.lineas || []).length) {
    await estados.mover(telefono, 'CART', {}, { motivo: 'nada que confirmar' });
    return flujo.verCarrito(cliente.id);
  }
  /* La clave de idempotencia sale del contenido del carrito, no del wamid:
     así también protege contra el doble clic del cliente, no solo contra el
     doble webhook de Meta. */
  const clave = wamid || `conf:${cliente.id}:${(carrito.lineas || [])
    .map((l) => `${l.codigo}x${l.cantidad}${l.unidad_pedido}`).sort().join('|')}`;

  const r = await pedidoLib.confirmar(cliente.id, { clave_idempotencia: clave });
  if (!r.ok) {
    if (r.error === 'faltan_cajas_o_unidades') {
      return [formato.texto(r.pregunta || '¿Son cajas o piezas?')];
    }
    return flujo.verCarrito(cliente.id);
  }
  if (r.idempotente) {
    console.log('[chacon][evento] order_confirmation_duplicate_blocked tel=%s pedido=%s',
      telefono, r.pedido.id);
  } else {
    console.log('[chacon][evento] order_confirmed tel=%s pedido=%s lineas=%s',
      telefono, r.pedido.id, r.pedido.lineas.length);
    await fabrica.enviar(r.pedido).catch((e) =>
      console.error('[chacon] envío a fábrica:', e.message));
  }
  // El pedido deja de ser carrito activo. El estado queda limpio.
  await estados.mover(telefono, 'ORDER_COMPLETE', {}, { motivo: 'pedido confirmado' });
  return flujo.pedidoConfirmado(r.pedido);
}

/**
 * Traduce una intención global a pantallas. Se llama ANTES del buscador de
 * productos, que es lo que evita el bug de "quiero hacer un pedido nuevo".
 */
async function porIntencion(telefono, cliente, intent, { wamid = null } = {}) {
  const clienteId = cliente ? cliente.id : null;
  const carrito = clienteId ? await repo.getCarrito(clienteId) : { lineas: [] };
  const lineas = carrito.lineas || [];
  const { maquina } = await estados.leer(telefono);

  if (intent === 'START_NEW_ORDER') {
    console.log('[chacon][evento] new_order_requested tel=%s draft=%s', telefono, lineas.length);
    if (lineas.length) {
      await estados.mover(telefono, 'CART', { pregunta_nuevo: true },
        { motivo: 'hay borrador' });
      console.log('[chacon][evento] draft_abandon_prompted tel=%s', telefono);
      return flujo.borradorEnCurso(lineas, { paraNuevo: true });
    }
    return empezarNuevo(telefono, clienteId);
  }
  if (intent === 'START_ORDER') {
    // Con un borrador vivo NO se enseña el carrito sin explicar por qué.
    if (lineas.length && maquina.estado !== 'CART') {
      await estados.mover(telefono, 'CART', {}, { motivo: 'hay borrador' });
      return flujo.borradorEnCurso(lineas);
    }
    if (lineas.length) return flujo.verCarrito(clienteId);
    return empezarNuevo(telefono, clienteId);
  }
  if (intent === 'FINISH_ORDER') return porClic(telefono, cliente, 'terminar_pedido');
  if (intent === 'CONFIRM_ORDER') {
    if (maquina.estado === 'ORDER_COMPLETE') return flujo.pedidoYaConfirmado();
    return confirmar(telefono, cliente, { wamid });
  }
  if (intent === 'CANCEL_ORDER') return porClic(telefono, cliente, 'cancelar_pedido');
  if (intent === 'VIEW_CART') {
    if (maquina.estado === 'ORDER_COMPLETE') return flujo.pedidoYaConfirmado();
    return porClic(telefono, cliente, 'ver_carrito');
  }
  if (intent === 'EDIT_CART') return porClic(telefono, cliente, 'modificar_carrito');
  if (intent === 'REPEAT_ORDER') return porClic(telefono, cliente, 'repetir_pedido');
  if (intent === 'VIEW_OFFERS') return porClic(telefono, cliente, 'ver_ofertas');
  if (intent === 'VIEW_FAMILIES') return porClic(telefono, cliente, 'ver_familias');
  if (intent === 'GO_HOME') {
    await estados.mover(telefono, 'HOME', {}, { motivo: 'volver al menú' });
    return flujo.home(cliente);
  }
  if (intent === 'HUMAN_HANDOFF') return porClic(telefono, cliente, 'hablar_fernando');
  return null;
}

/* ---- clics -------------------------------------------------------------- */
async function porClic(telefono, cliente, id) {
  const clienteId = cliente ? cliente.id : null;

  if (id === 'privacidad_si') return aceptarPrivacidad(telefono, null);
  if (id === 'privacidad_no') {
    await privacidad.registrarDecision(telefono, privacidad.ESTADOS.RECHAZADO,
      { accepted_action: 'boton_ahora_no' });
    await estados.mover(telefono, 'HOME', {}, { motivo: 'no autoriza el canal' });
    return flujo.privacidadRechazada();
  }
  if (id === 'marketing_si' || id === 'marketing_no') {
    await privacidad.fijarMarketing(telefono, id === 'marketing_si');
    return [formato.texto(id === 'marketing_si'
      ? 'Anotado. Te avisaremos de las ofertas.'
      : 'Anotado, no te mandaremos promociones. Puedes seguir pidiendo igual.')];
  }
  if (id.startsWith('cliente_si:')) return confirmarCliente(telefono, id.slice(11));
  if (id === 'reintentar_negocio') return pedirIdentificacion(telefono, { reintento: true });
  if (id === 'alta_negocio') {
    /* Ya no existe el alta libre: la agenda de Chacón es la que dice quién es
       cliente. Si llega este botón de una conversación vieja, se vuelve a
       preguntar en vez de crear una cuenta que nadie ha autorizado. */
    return pedirIdentificacion(telefono, { reintento: true });
  }
  if (id.startsWith('cli:')) {
    const c = await repo.clientePorId(id.slice(4));
    if (!c) return pedirIdentificacion(telefono, { reintento: true });
    if (!(c.telefonos || []).includes(telefono)) {
      c.telefonos = [...(c.telefonos || []), telefono];
      await repo.guardarCliente(c);
    }
    return volverDeIdentificacion(telefono, c);
  }

  if (id === 'hacer_pedido') {
    await estados.mover(telefono, 'PRODUCT_DISCOVERY', {}, { motivo: 'hacer pedido' });
    const h = clienteId ? await flujo.misHabituales(clienteId) : { hay: false };
    return flujo.comoEmpezar(h.hay);
  }
  if (id === 'mis_habituales' && clienteId) {
    await estados.mover(telefono, 'PRODUCT_SELECTION', {}, { motivo: 'habituales' });
    return (await flujo.misHabituales(clienteId)).pantallas;
  }
  if (id === 'ver_familias' || id === 'buscar_producto') {
    /* Se limpia el contexto de búsqueda ANTES de pintar. Sin esto, los
       resultados de un "salchichón" anterior sobrevivían y la pantalla de
       familias acababa enseñando productos. */
    await estados.entrarEnFamilias(telefono, { motivo: id });
    return id === 'buscar_producto'
      ? [formato.texto('Dime qué buscas: el nombre, la marca o el tipo de producto.')]
      : flujo.menuFamilias();
  }
  if (id.startsWith('fam:')) {
    const clave = id.slice(4);
    const prods = descubrimiento.deFamilia(clave);
    const nombre = (categorias.categorias().find((c) => c.clave === clave) || {}).nombre || clave;
    await estados.mover(telefono, 'PRODUCT_SELECTION',
      { mostrados: prods.map((p) => p.codigo), familia: clave, offset: 0 },
      { motivo: 'familia elegida' });
    return flujo.listaDeProductos(prods, { titulo: `${nombre}. ¿Cuál te interesa?`,
      hayMas: prods.length > flujo.MAX_OPCIONES });
  }
  if (id === 'ver_mas') {
    const { maquina } = await estados.leer(telefono);
    const clave = maquina.datos.familia;
    if (!clave) return flujo.menuFamilias();
    const prods = descubrimiento.deFamilia(clave);
    const offset = (maquina.datos.offset || 0) + flujo.MAX_OPCIONES;
    const pagina = prods.slice(offset, offset + flujo.MAX_OPCIONES);
    if (!pagina.length) return flujo.menuFamilias('Ya te he enseñado todos. ¿Otra familia?');
    await estados.mover(telefono, 'PRODUCT_SELECTION',
      { mostrados: pagina.map((p) => p.codigo), familia: clave, offset },
      { motivo: 'siguiente página' });
    return flujo.listaDeProductos(pagina, { titulo: '¿Y alguno de estos?',
      hayMas: offset + pagina.length < prods.length });
  }
  if (id.startsWith('prod:')) {
    const p = catalogo.todos().find((x) => x.codigo === id.slice(5));
    if (!p) return [formato.texto('Ese producto ya no está disponible.')];
    await estados.mover(telefono, 'QUANTITY_SELECTION', { codigo: p.codigo },
      { motivo: 'producto elegido' });
    return flujo.fichaProducto(p);
  }
  if (id.startsWith('cant:')) {
    const [, codigo, cant, unidad] = id.split(':');
    const p = catalogo.todos().find((x) => x.codigo === codigo);
    if (!p) return [formato.texto('Ese producto ya no está disponible.')];
    if (cant === 'otra') {
      const { maquina: previa } = await estados.leer(telefono);
      await estados.mover(telefono, 'QUANTITY_SELECTION',
        { codigo, esperando_cantidad: true, editando: previa.estado === 'CART_EDIT' },
        { motivo: 'cantidad libre' });
      return [formato.texto(`¿Cuántas quieres de ${flujo.bonito(p.descripcion)}? `
        + 'Dime el número y si son cajas o piezas.')];
    }
    /* Sin tienda identificada no se puede añadir nada. Lo pide el flujo
       guiado —no el agente— para que el estado quede en
       CUSTOMER_IDENTIFICATION y la respuesta no acabe en el buscador. La
       acción se guarda para retomarla en cuanto sepamos quién es. */
    if (!clienteId) return pedirIdentificacion(telefono, { accionPendiente: id });
    const { maquina } = await estados.leer(telefono);
    if (maquina.estado === 'CART_EDIT') {
      /* Corregir una cantidad REEMPLAZA la línea. Si se sumara, "cámbiala a
         3" sobre una línea de 1 dejaría 4, que es justo lo que el cliente no
         ha pedido. */
      await pedidoLib.cambiarCantidad(clienteId, {
        producto_id: p.id, cantidad: Number(cant), unidad_pedido: unidad });
      await estados.mover(telefono, 'CART', {}, { motivo: 'cantidad corregida' });
      return flujo.verCarrito(clienteId);
    }
    return anadir(telefono, clienteId, p, Number(cant), unidad);
  }
  if (id === 'ver_carrito' && clienteId) {
    await estados.mover(telefono, 'CART', {}, { motivo: 'ver carrito' });
    return flujo.verCarrito(clienteId);
  }
  if (id === 'anadir_otro') {
    await estados.mover(telefono, 'PRODUCT_DISCOVERY', {}, { motivo: 'añadir otro' });
    const h = clienteId ? await flujo.misHabituales(clienteId) : { hay: false };
    return flujo.comoEmpezar(h.hay);
  }
  if (id === 'modificar_carrito' && clienteId) {
    await estados.mover(telefono, 'CART_EDIT', {}, { motivo: 'modificar' });
    return flujo.editarCarrito(clienteId);
  }
  if (id.startsWith('edit:') && clienteId) {
    const codigo = id.slice(5);
    await estados.mover(telefono, 'CART_EDIT', { codigo }, { motivo: 'línea elegida' });
    const carrito = await repo.getCarrito(clienteId);
    const l = (carrito.lineas || []).find((x) => x.codigo === codigo);
    if (!l) return flujo.verCarrito(clienteId);
    return [formato.botones(`*${flujo.bonito(l.descripcion)}*\n${l.cantidad} `
      + `${l.unidad_pedido === 'caja' ? 'caja(s)' : 'pieza(s)'}`, [
      { id: `quitar:${codigo}`, titulo: '🗑 Quitar' },
      { id: `cant:${codigo}:otra`, titulo: '✏️ Cambiar cantidad' },
      { id: 'ver_carrito', titulo: '↩️ Volver' }])];
  }
  if (id.startsWith('quitar:') && clienteId) {
    const codigo = id.slice(7);
    const carrito = await repo.getCarrito(clienteId);
    const l = (carrito.lineas || []).find((x) => x.codigo === codigo);
    if (l) await pedidoLib.quitar(clienteId, { producto_id: l.producto_id });
    await estados.mover(telefono, 'CART', {}, { motivo: 'línea quitada' });
    return flujo.verCarrito(clienteId);
  }
  if (id === 'ver_ofertas') {
    await estados.mover(telefono, 'OFFERS', {}, { motivo: 'ofertas' });
    return flujo.verOfertas();
  }
  if (id === 'precios_ofertas') {
    await estados.mover(telefono, 'PRICE_LOOKUP', {}, { motivo: 'precios' });
    return [formato.texto('Dime de qué producto quieres el precio: '
      + 'su nombre, la marca o el tipo.')];
  }
  if (id === 'repetir_pedido' && clienteId) {
    await estados.mover(telefono, 'REORDER', {}, { motivo: 'repetir' });
    const r = await repeticion.preparar(clienteId, {});
    if (!r.ok) return [formato.botones(repeticion.MENSAJE_SIN_HISTORIAL,
      [{ id: 'ver_familias', titulo: '🥩 Ver familias' },
       { id: 'ver_ofertas', titulo: '🔥 Ver ofertas' }])];
    const pantallas = await flujo.verCarrito(clienteId);
    const aviso = repeticion.textoCambios(r.cambios_de_precio);
    return aviso ? [formato.texto(aviso), ...pantallas] : pantallas;
  }
  if (id === 'terminar_pedido' && clienteId) {
    const carrito = await repo.getCarrito(clienteId);
    if (!(carrito.lineas || []).length) return flujo.verCarrito(clienteId);
    await estados.mover(telefono, 'CHECKOUT', {}, { motivo: 'checkout' });
    carrito.estado = estados.PEDIDO.CHECKOUT_PENDING;
    await repo.guardarCarrito(carrito);
    console.log('[chacon][evento] checkout_started tel=%s lineas=%s', telefono, carrito.lineas.length);
    // Con botones: sin ellos no había forma de cerrar el pedido.
    return flujo.pedirConfirmacion(carrito, cliente);
  }
  if (id === 'confirmar_pedido') return confirmar(telefono, cliente);
  if (id === 'nuevo_pedido' || id === 'nuevo_pedido_si') {
    return empezarNuevo(telefono, clienteId, { abandonando: id === 'nuevo_pedido_si' });
  }
  if (id === 'continuar_pedido' && clienteId) {
    await estados.mover(telefono, 'CART', {}, { motivo: 'continuar borrador' });
    console.log('[chacon][evento] order_resumed tel=%s', telefono);
    return flujo.verCarrito(clienteId);
  }
  if (id === 'cancelar_pedido' && clienteId) {
    const c = await repo.getCarrito(clienteId);
    if (!(c.lineas || []).length) return flujo.verCarrito(clienteId);
    return flujo.confirmarCancelacion();
  }
  if (id === 'cancelar_si' && clienteId) {
    const c = await repo.getCarrito(clienteId);
    c.estado = estados.PEDIDO.CANCELLED;
    c.cancelado_en = new Date().toISOString();
    await repo.guardarCarrito(c);
    await repo.borrarCarrito(clienteId);
    await estados.mover(telefono, 'HOME', {}, { motivo: 'pedido cancelado' });
    console.log('[chacon][evento] order_cancelled tel=%s', telefono);
    return [formato.texto('Pedido cancelado.'), ...flujo.home(cliente)];
  }
  if (id === 'ir_home') {
    await estados.mover(telefono, 'HOME', {}, { motivo: 'menú' });
    return flujo.home(cliente);
  }
  if (id === 'hablar_fernando') {
    await estados.mover(telefono, 'HUMAN_HANDOFF', {}, { motivo: 'lo pidió el cliente' });
    return flujo.escalarAFernando(null);
  }
  return null;
}

/* ---- texto libre -------------------------------------------------------- */
async function porTexto(telefono, cliente, texto) {
  const clienteId = cliente ? cliente.id : null;
  const q = norm(texto);
  const { maquina } = await estados.leer(telefono);

  /* Pedir la baja de promociones se atiende SIEMPRE, en cualquier estado y
     sin condiciones: retirar un permiso comercial no puede depender de estar
     en el sitio correcto de un menú. Y no afecta a los pedidos. */
  if (privacidad.pideBajaMarketing(texto)) {
    await privacidad.fijarMarketing(telefono, false, { source: 'peticion_del_cliente' });
    return [formato.texto('Hecho, no te mandaremos más ofertas por aquí. '
      + 'Puedes seguir haciendo pedidos con normalidad.')];
  }

  // El aviso de privacidad va antes que nada: mientras esté abierto, lo único
  // que se espera es que diga si continúa.
  if (maquina.estado === 'PRIVACY_ONBOARDING'
      && maquina.slot_pendiente === estados.SLOTS.PRIVACY_ACCEPT) {
    if (/^(s[ií]|vale|ok|acepto|continuar|adelante|de acuerdo)\b/i.test(String(texto).trim())) {
      return aceptarPrivacidad(telefono, null);
    }
    if (/^(no|ahora no|todav[ií]a no)\b/i.test(String(texto).trim())) {
      await privacidad.registrarDecision(telefono, privacidad.ESTADOS.RECHAZADO,
        { accepted_action: 'texto_no' });
      await estados.mover(telefono, 'HOME', {}, { motivo: 'no autoriza el canal' });
      return flujo.privacidadRechazada();
    }
    return flujo.avisoPrivacidad(privacidad.textoAviso());
  }

  /* PRIORIDAD ABSOLUTA: con un dato obligatorio pendiente, el estado manda
     sobre el enrutado genérico. Mientras esperamos el nombre del negocio,
     "tony tienda" es un nombre de negocio y punto — no una búsqueda de
     producto. Este es el bug que se vio en producción y por eso la
     comprobación va aquí arriba, antes que cualquier otra cosa. */
  if (maquina.estado === 'CUSTOMER_IDENTIFICATION'
      && maquina.slot_pendiente === estados.SLOTS.BUSINESS_NAME) {
    const r = await resolverNegocio(telefono, texto);
    return Array.isArray(r) ? r : r.pantallas;
  }

  // Saludo suelto: se vuelve al inicio.
  if (/^(hola|buenas|hey|buenos dias|buenas tardes|holaa+)\b/.test(q) && q.length < 25) {
    await estados.mover(telefono, 'HOME', {}, { motivo: 'saludo' });
    return flujo.home(cliente);
  }

  /* Intención global. Va lo PRIMERO tras los slots obligatorios: antes había
     reglas sueltas aquí —"acaba en la palabra pedido", "empieza por ofertas"—
     que se pisaban entre sí. "terminar pedido" terminaba en la palabra
     "pedido", así que la regla del carrito se lo comía y nunca llegaba al
     checkout. Una sola capa, con un orden declarado, en `intenciones.js`. */
  const intencion = intenciones.reconocer(texto);
  if (intencion) {
    console.log('[chacon][intent] tel=%s intent=%s estado=%s',
      telefono, intencion.intent, maquina.estado);
    const r = await porIntencion(telefono, cliente, intencion.intent);
    if (r) return r;
  }

  // Un ordinal sobre lo último mostrado: "el segundo".
  const ord = ordinalDe(q);
  if (ord !== null && estados.ESPERAN_ORDINAL.has(maquina.estado)) {
    const mostrados = maquina.datos.mostrados || [];
    const codigo = ord === -1 ? mostrados[mostrados.length - 1] : mostrados[ord - 1];
    const p = codigo && catalogo.todos().find((x) => x.codigo === codigo);
    if (p) {
      await estados.mover(telefono, 'QUANTITY_SELECTION', { codigo: p.codigo },
        { motivo: 'elegido por posición' });
      return flujo.fichaProducto(p);
    }
  }

  // Una cantidad cuando ya hay un producto elegido: "una caja", "tres".
  const { cantidad, unidad } = cantidadDe(q);
  if (maquina.estado === 'QUANTITY_SELECTION' && maquina.datos.codigo && cantidad !== null) {
    const p = catalogo.todos().find((x) => x.codigo === maquina.datos.codigo);
    if (p && clienteId && maquina.datos.editando && unidad) {
      await pedidoLib.cambiarCantidad(clienteId, {
        producto_id: p.id, cantidad, unidad_pedido: unidad });
      await estados.mover(telefono, 'CART', {}, { motivo: 'cantidad corregida' });
      return flujo.verCarrito(clienteId);
    }
    if (p && clienteId) {
      // Sin unidad expresada no se asume ninguna: se pregunta.
      if (!unidad) {
        return [formato.botones(
          `¿${cantidad} cajas o ${cantidad} piezas?`,
          [{ id: `cant:${p.codigo}:${cantidad}:caja`, titulo: `${cantidad} cajas` },
           { id: `cant:${p.codigo}:${cantidad}:unidad`, titulo: `${cantidad} piezas` }])];
      }
      return anadir(telefono, clienteId, p, cantidad, unidad);
    }
  }

  /* Guardarraíl: el buscador de productos NO es el cajón de sastre. Si la
     frase no puede ser razonablemente un producto, se ofrece ayuda en vez de
     contestar "no he encontrado «vale»". */
  if (!intenciones.pareceProducto(texto)) {
    await estados.mover(telefono, 'HOME', {}, { motivo: 'frase no es producto' });
    return flujo.home(cliente);
  }

  // Búsqueda de producto. El corazón: nunca se pide una referencia.
  const pedidos = clienteId ? await repo.pedidosDeCliente(clienteId, { limite: 20 }) : [];
  const historico = pedidos.flatMap((p) => (p.lineas || []).map((l) => l.codigo));
  const res = descubrimiento.buscar(texto, { historico });

  if (res.tipo === 'nada') return noEncontrado(telefono, texto.trim().slice(0, 40));

  // Si venía con cantidad y el producto es inequívoco, se añade de una vez.
  if (res.tipo === 'producto' && cantidad !== null && unidad && clienteId) {
    return anadir(telefono, clienteId, res.producto, cantidad, unidad);
  }
  return presentar(telefono, res);
}

/**
 * Punto de entrada. Devuelve pantallas, o `null` si esto no lo resuelve el
 * flujo guiado y tiene que entrar el agente conversacional.
 */
async function manejar({ telefono, cliente, tipo, valor }) {
  try {
    /* Sin canal autorizado no se automatiza nada. Las únicas excepciones son
       los propios botones del aviso y la petición de baja de promociones,
       que tienen que funcionar siempre. */
    const esBotonAviso = tipo === 'clic'
      && ['privacidad_si', 'privacidad_no', 'hablar_fernando'].includes(valor);
    if (!esBotonAviso && !(tipo === 'texto' && privacidad.pideBajaMarketing(valor))) {
      if (!(await privacidad.canalAutorizado(telefono))) {
        const { maquina } = await estados.leer(telefono);
        if (maquina.estado === 'PRIVACY_ONBOARDING'
            && maquina.slot_pendiente === estados.SLOTS.PRIVACY_ACCEPT
            && tipo === 'texto') {
          return await porTexto(telefono, cliente, valor);
        }
        /* Se guarda lo que escribió: si ya dijo quién es —"hola soy carnicería
           el chino y quiero hacer un pedido"— no hay que volver a
           preguntárselo después de aceptar el aviso. */
        return await pedirPrivacidad(telefono, {
          accionPendiente: tipo === 'clic' ? valor : null,
          mensajeInicial: tipo === 'texto' ? valor : null });
      }
    }
    if (tipo === 'clic') return await porClic(telefono, cliente, valor);
    if (tipo === 'texto') return await porTexto(telefono, cliente, valor);
    return null;
  } catch (err) {
    console.error('[chacon][router] %s: %s', tipo, err.stack || err.message);
    return null;                      // que lo intente el agente
  }
}

module.exports = {
  manejar, porClic, porTexto, cantidadDe, ordinalDe,
  pedirIdentificacion, resolverNegocio, volverDeIdentificacion, pedirPrivacidad, aceptarPrivacidad,
  confirmarCliente,
  NUMEROS, ORDINALES,
};
