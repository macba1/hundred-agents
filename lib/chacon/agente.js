/* ============================================================
   Agente comercial de Chacón.

   Reparto de responsabilidades, sin excepciones:
     - La IA interpreta la intención y redacta.
     - TODA operación crítica la ejecuta código determinista de este módulo:
       buscar en catálogo, añadir al carrito, calcular importes, confirmar.

   El MVP trabaja **solo con la Tarifa 1**, que es la del PDF entregado. Las
   tarifas 2 a 8 están modeladas pero no intervienen.

   El modelo nunca compone un precio ni un importe: `consultas.js` le
   devuelve la frase ya redactada con cifras que salen de un registro real
   del catálogo o de una decisión guardada de un administrador. Si un precio
   no se puede afirmar —los 19 códigos repetidos, la promoción sin
   condiciones—, lo que llega es la negativa exacta, no el precio.
   ============================================================ */

const repo = require('./repo');
const catalogo = require('./catalogo');
const pedidoLib = require('./pedido');
const fabrica = require('./fabrica');
const consultas = require('./consultas');
const repeticion = require('./repeticion');
const navegacion = require('./navegacion');
const carritoNativo = require('./carrito-nativo');

/**
 * Saludo literal. Se fija aquí y no se deja al criterio del modelo: si no,
 * redacta un "¿en qué puedo ayudarte?" genérico que no dice de qué empresa
 * es. La tienda tiene que saber con quién habla desde la primera línea.
 */
const SALUDO =
  '¡Hola! Soy el asistente de pedidos de Chacón Alcántara. ¿Qué necesitas hoy?\n'
  + '1. Repetir último pedido\n'
  + '2. Ver catálogo\n'
  + '3. Precios y ofertas';

/** Con la tienda ya identificada se la saluda por su nombre. */
function saludoPara(cliente) {
  return cliente
    ? SALUDO.replace('¡Hola! Soy el asistente de pedidos de Chacón Alcántara. ¿Qué necesitas hoy?',
                     `Hola, ${cliente.nombre}. ¿Qué necesitas hoy?`)
    : SALUDO;
}

const MODELO = process.env.CHACON_OPENAI_MODEL || process.env.WA_OPENAI_MODEL || 'gpt-4o';
const MAX_ITERS = Number(process.env.CHACON_MAX_TOOL_ITERS || 8);

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'buscar_productos',
      description: 'Busca en el catálogo por código, código de barras, nombre, marca o texto aproximado. '
        + 'DEBES usarla antes de mencionar cualquier producto. Devuelve candidatos con su producto_id. '
        + 'Para dar un precio usa `consultar_precio`, no esta.',
      parameters: {
        type: 'object',
        properties: { consulta: { type: 'string', description: 'Lo que busca el cliente.' } },
        required: ['consulta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ver_categorias',
      description: 'Lista las familias del catálogo con cuántos productos tiene cada una. '
        + 'Úsala para "ver catálogo", "¿qué tienes?" o cuando no reconozcas lo que pide.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ver_productos',
      description: 'Enseña productos de una familia, subcategoría o etiqueta. Acepta lenguaje '
        + 'natural: "quesos", "embutidos", "chorizos", "de pollo", "sin lactosa", "lo más barato". '
        + 'Devuelve 4-5 cada vez con su ficha ya redactada. NO la llames varias veces seguidas '
        + 'para enseñar más: para eso está `ver_mas_productos`.',
      parameters: {
        type: 'object',
        properties: {
          consulta: { type: 'string', description: 'Lo que pidió el cliente, tal cual.' },
        },
        required: ['consulta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ver_mas_productos',
      description: 'Siguiente página de la familia que le acabas de enseñar. Para "ver más", '
        + '"enséñame más", "sigue".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'identificar_producto',
      description: 'Convierte lo que dijo el cliente en un producto real del catálogo. '
        + 'OBLIGATORIA antes de `anadir_al_carrito` cuando se refiera a algo por su posición '
        + '("el segundo", "el primero"), por un demostrativo ("ese", "el de la foto") o por el '
        + 'nombre. Si devuelve `pregunta`, hazla y NO añadas nada.',
      parameters: {
        type: 'object',
        properties: {
          referencia: { type: 'string', description: 'Lo que dijo el cliente: "el segundo", "el 0052", "el chorizo de pincho".' },
        },
        required: ['referencia'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resolver_cajas_o_unidades',
      description: 'Aplica "cajas" o "unidades" a las líneas que llegaron del catálogo de '
        + 'WhatsApp sin esa información. Úsala cuando el cliente conteste a la pregunta de '
        + 'si son cajas o unidades. Sin `codigo` se aplica a todas las pendientes.',
      parameters: {
        type: 'object',
        properties: {
          unidad: { type: 'string', enum: ['caja', 'unidad'] },
          codigo: { type: 'string', description: 'Solo si la respuesta es para un producto concreto.' },
        },
        required: ['unidad'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_precio',
      description: 'Precio vigente de Tarifa 1 de un producto. Úsala SIEMPRE que el cliente '
        + 'pregunte cuánto cuesta algo, aunque lo nombre de forma aproximada o con erratas. '
        + 'Si además pregunta por una caja o una unidad, pasa `cantidad` y `unidad` para que '
        + 'calcule la estimación. Devuelve `respuesta_exacta`: repítela, no la recalcules.',
      parameters: {
        type: 'object',
        properties: {
          consulta: { type: 'string', description: 'Código, EAN o nombre tal y como lo dijo el cliente.' },
          cantidad: { type: 'number', description: 'Solo si pregunta por un importe concreto.' },
          unidad: { type: 'string', enum: ['caja', 'unidad', 'kg'] },
        },
        required: ['consulta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_ofertas',
      description: 'Ofertas activas y validadas. Úsala para "¿qué ofertas tienes?", '
        + '"¿hay algo en promoción?", "¿qué tienes más barato?". Devuelve `respuesta_exacta`. '
        + 'Un precio bajo NO es una oferta: solo vale lo que devuelva esta herramienta.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'repetir_pedido',
      description: 'Copia un pedido anterior a un carrito nuevo y aplica los cambios que pida '
        + 'el cliente ("lo mismo", "el doble", "sin el salami", "dos cajas más de X"). '
        + 'NO lo envía: después debes enseñar el resumen y pedir una confirmación nueva.',
      parameters: {
        type: 'object',
        properties: {
          pedido_id: { type: 'string', description: 'Omítelo para el último pedido.' },
          modificaciones: {
            type: 'array',
            description: 'Cambios sobre las líneas copiadas.',
            items: {
              type: 'object',
              properties: {
                accion: { type: 'string', enum: ['multiplicar', 'quitar', 'cambiar', 'anadir'] },
                factor: { type: 'number', description: 'Solo para multiplicar ("el doble" = 2).' },
                producto_id: { type: 'string' },
                codigo: { type: 'string' },
                cantidad: { type: 'number' },
                unidad_pedido: { type: 'string', enum: ['caja', 'unidad', 'kg'] },
              },
              required: ['accion'],
            },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ver_historial_pedidos',
      description: 'Pedidos anteriores de esta tienda, con fecha e identificador. '
        + 'Úsala si el cliente se refiere a un pedido concreto ("el de la semana pasada").',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'anadir_al_carrito',
      description: 'Añade una línea. Requiere el producto_id EXACTO devuelto por buscar_productos '
        + 'y la unidad ("caja" o "unidad"). Si el cliente no dijo cuál, pregunta antes: no adivines.',
      parameters: {
        type: 'object',
        properties: {
          producto_id: { type: 'string' },
          cantidad: { type: 'number' },
          unidad_pedido: { type: 'string', enum: ['caja', 'unidad', 'kg'] },
          observaciones: { type: 'string' },
        },
        required: ['producto_id', 'cantidad', 'unidad_pedido'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cambiar_cantidad',
      description: 'Cambia la cantidad de una línea. Cantidad 0 la elimina.',
      parameters: {
        type: 'object',
        properties: { producto_id: { type: 'string' }, cantidad: { type: 'number' } },
        required: ['producto_id', 'cantidad'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ver_carrito',
      description: 'Devuelve el pedido tal y como va: productos, cantidades, unidades, precios de '
        + 'Tarifa 1 e importes estimados. Úsala antes de pedir la confirmación.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'identificar_tienda',
      description: 'Registra o confirma el nombre comercial de la tienda para este teléfono. '
        + 'Si hay varias tiendas parecidas, devuelve las candidatas y NO elige.',
      parameters: {
        type: 'object',
        properties: { nombre: { type: 'string' }, contacto: { type: 'string' }, direccion: { type: 'string' } },
        required: ['nombre'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirmar_pedido',
      description: 'Confirma la solicitud y la envía al canal interno de Chacón. Úsala SOLO cuando '
        + 'el cliente haya escrito CONFIRMAR de forma inequívoca y ya le hayas enseñado el resumen.',
      parameters: {
        type: 'object',
        properties: { observaciones: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_alergenos',
      description: 'Consulta gluten o lactosa de un producto. Devuelve la respuesta exacta que debes dar.',
      parameters: {
        type: 'object',
        properties: { producto_id: { type: 'string' }, alergeno: { type: 'string', enum: ['gluten', 'lactosa'] } },
        required: ['producto_id', 'alergeno'],
      },
    },
  },
];

/* ---- ejecución determinista de las tools ------------------------------- */
async function ejecutar(ctx, nombre, args) {
  const { telefono } = ctx;

  if (nombre === 'buscar_productos') {
    const r = catalogo.buscar(args.consulta || '');
    return {
      tipo_busqueda: r.tipo,
      total: r.total,
      candidatos: r.candidatos.map(catalogo.paraMostrar),
      sugerencias: r.sugerencias || [],
      nota: 'Disponibilidad pendiente de revisión por Chacón Alcántara: no afirmes que hay stock. '
        + 'Para dar un precio llama a consultar_precio.',
    };
  }

  // Consultar precios y ofertas no exige tener identificada la tienda: es la
  // pregunta más frecuente y pedir el nombre antes sería un peaje absurdo.
  if (nombre === 'consultar_precio') {
    return consultas.consultarPrecio(args.consulta || '', {
      cantidad: Number.isFinite(args.cantidad) ? args.cantidad : null,
      unidad: args.unidad || null,
    });
  }
  if (nombre === 'consultar_ofertas') {
    return consultas.consultarOfertas();
  }
  if (nombre === 'ver_categorias') {
    return { categorias: navegacion.listarCategorias(),
             nota: 'Ofrécelas como lista. No inventes familias que no estén aquí.' };
  }
  if (nombre === 'ver_productos') {
    const r = await navegacion.mostrar(telefono, { consulta: args.consulta || '' });
    ctx.ultimaVista = r.ok ? r.vista : ctx.ultimaVista;
    return r;
  }
  if (nombre === 'ver_mas_productos') {
    return navegacion.mas(telefono);
  }
  if (nombre === 'resolver_cajas_o_unidades') {
    return carritoNativo.resolverModalidad(ctx.clienteId, telefono,
      args.unidad, { codigo: args.codigo || null });
  }
  if (nombre === 'identificar_producto') {
    return navegacion.resolverReferencia(telefono, args.referencia || '');
  }

  if (nombre === 'identificar_tienda') {
    const existente = await repo.clientePorTelefono(telefono);
    if (existente) {
      ctx.clienteId = existente.id;
      return { ya_registrado: true, cliente: existente,
               nota: 'Este teléfono ya está asociado a esta tienda. Confirma con el cliente si el nombre no coincide.' };
    }
    const similares = await repo.buscarClientesPorNombre(args.nombre);
    if (similares.length) {
      // No se elige por nombre: podrían ser tiendas distintas con nombre parecido.
      return { requiere_aclaracion: true, candidatas: similares.map((c) => ({ id: c.id, nombre: c.nombre })),
               nota: 'Hay tiendas con nombre parecido. Pregunta cuál es, o pide un dato más.' };
    }
    const nuevo = await repo.crearCliente({
      nombre: args.nombre, telefono, contacto: args.contacto || null, direccion: args.direccion || null });
    ctx.clienteId = nuevo.id;
    return { creado: true, cliente: nuevo,
             nota: 'Alta registrada como pendiente de aprobación por Chacón.' };
  }

  if (!ctx.clienteId) {
    return { error: 'tienda_no_identificada',
             nota: 'Antes de operar con el carrito hay que saber el nombre de la tienda. Pregúntaselo.' };
  }

  if (nombre === 'anadir_al_carrito') {
    return pedidoLib.anadir(ctx.clienteId, {
      producto_id: args.producto_id, cantidad: args.cantidad,
      unidad_pedido: args.unidad_pedido, observaciones: args.observaciones || null });
  }
  if (nombre === 'cambiar_cantidad') {
    return pedidoLib.cambiarCantidad(ctx.clienteId, { producto_id: args.producto_id, cantidad: args.cantidad });
  }
  if (nombre === 'ver_carrito') {
    return pedidoLib.ver(ctx.clienteId);
  }
  if (nombre === 'ver_historial_pedidos') {
    const previos = await repeticion.historial(ctx.clienteId, { limite: 10 });
    if (!previos.length) {
      return { hay_historial: false, respuesta_exacta: repeticion.MENSAJE_SIN_HISTORIAL,
               nota: 'Responde EXACTAMENTE esa frase. No reconstruyas pedidos que no tienes.' };
    }
    return {
      hay_historial: true,
      pedidos: previos.map((p) => ({
        pedido_id: p.id, fecha: p.creado, lineas: (p.lineas || []).length,
        productos: (p.lineas || []).map((l) => `${l.codigo} ${l.descripcion}`).slice(0, 8) })),
    };
  }
  if (nombre === 'repetir_pedido') {
    const r = await repeticion.preparar(ctx.clienteId, {
      pedido_id: args.pedido_id || null, modificaciones: args.modificaciones || [] });
    if (!r.ok) return r;
    // El aviso de cambio de precio va redactado: que no lo improvise el modelo.
    const carrito = await pedidoLib.ver(ctx.clienteId);
    return { ...r, carrito, aviso_cambios_de_precio: repeticion.textoCambios(r.cambios_de_precio) };
  }
  if (nombre === 'consultar_alergenos') {
    const p = catalogo.porId(args.producto_id);
    if (!p) return { error: 'producto_inexistente' };
    const texto = catalogo.textoAlergeno(p, args.alergeno);
    const conocido = p[args.alergeno] !== null && p[args.alergeno] !== undefined;
    if (!conocido) ctx.consultasAlergenoSinDato.push({ producto_id: p.id, codigo: p.codigo, alergeno: args.alergeno });
    return { respuesta_exacta: texto, dato_disponible: conocido,
             nota: 'Responde EXACTAMENTE esto. No infieras por el tipo de producto ni por la marca.' };
  }
  if (nombre === 'confirmar_pedido') {
    // Un carrito del catálogo puede traer cantidades sin saber si son cajas o
    // unidades. Confirmarlo así mandaría a Fernando un pedido que nadie puede
    // preparar. Se bloquea aquí, en código, no confiando en el prompt.
    const ctxNav = await repo.getContexto(telefono);
    const pend = ctxNav.pendientes_de_modalidad || [];
    if (pend.length) {
      return {
        ok: false, error: 'faltan_cajas_o_unidades',
        pendientes: pend,
        pregunta: carritoNativo.preguntaDeModalidad(pend),
        nota: 'No se puede confirmar hasta saber si son cajas o unidades. Pregúntalo.',
      };
    }
    const r = await pedidoLib.confirmar(ctx.clienteId, {
      clave_idempotencia: ctx.claveIdempotencia, observaciones: args.observaciones || null });
    if (!r.ok) return r;
    const envio = await fabrica.enviar(r.pedido, { urlPanel: ctx.urlPanel || null });
    ctx.pedidoConfirmado = r.pedido;
    return {
      ok: true, pedido_id: r.pedido.id,
      // Nunca el número ni el nombre del destinatario interno: la tienda no
      // debe saber a quién le llega ni por qué canal.
      envio_interno: { registrado: true, entregado: false, simulado: !!envio.simulado },
      mensaje_exacto_para_el_cliente: pedidoLib.MENSAJE_RECEPCION,
      nota: 'Responde EXACTAMENTE ese mensaje. No digas que el pedido está aceptado, preparado ni '
        + 'disponible, ni des una fecha de entrega, ni menciones a quién se ha enviado internamente.',
    };
  }
  return { error: `herramienta_desconocida:${nombre}` };
}

/* ---- prompt ------------------------------------------------------------ */
function systemPrompt(ctx) {
  const v = catalogo.version();
  return [
    'Eres el asistente comercial de **Chacón Alcántara S.L.**, distribución mayorista de',
    'alimentación (carnes, embutidos, quesos, conservas, congelados) en Aldea Quintana,',
    'La Carlota, Córdoba. Atiendes por WhatsApp a TIENDAS que te compran producto.',
    '',
    'Lo que más te van a pedir: **recorrer el catálogo por familias**, **repetir el pedido',
    'anterior** y **consultar precios y ofertas**. Después, preparar un pedido nuevo.',
    '',
    '## Saludo',
    'Si el primer mensaje es solo un saludo ("hola", "buenas", "?"), responde EXACTAMENTE esto,',
    'sin cambiar una palabra:',
    '',
    saludoPara(ctx.cliente),
    '',
    'Son atajos, no un menú obligatorio: el cliente puede escribir o mandar un audio con lo',
    'que quiera en cualquier momento, y tú le atiendes sin obligarle a elegir un número.',
    '',
    'Si el primer mensaje ya trae una pregunta o un pedido, **sáltate el saludo** y atiende directo.',
    'El cliente puede escribir libremente: no le exijas elegir un número.',
    '',
    '## Precios',
    'Trabajas **solo con la Tarifa 1**, que es la vigente. Los precios son **por kilo y sin',
    'IVA**. No menciones que existen otras tarifas.',
    '',
    'Para cualquier precio llama a `consultar_precio` y **repite su `respuesta_exacta`**.',
    'Nunca escribas una cifra que no venga de una herramienta, ni sumes, multipliques o',
    'conviertas tú: el cálculo lo hace el código. Si te pregunta por una caja o una unidad,',
    'pásale `cantidad` y `unidad` a la herramienta y deja que ella estime.',
    '',
    'Un importe de caja o unidad es siempre una **estimación**: se cobra por kilo y el',
    'importe final depende del peso real que prepare Chacón. Dilo así siempre.',
    '',
    'Si un producto tiene el precio pendiente de confirmar, di **exactamente** lo que',
    'devuelva la herramienta. **No enseñes dos precios ni dejes elegir entre ellos.**',
    '',
    '## Ofertas',
    'Solo existen las que devuelva `consultar_ofertas`. Un precio bajo **no es una oferta**,',
    'y un artículo promocional sin condiciones definidas tampoco. Si no hay ninguna activa,',
    'responde exactamente la frase que devuelva la herramienta.',
    '',
    '## Repetir un pedido',
    'Si dice "lo mismo que la última vez", "repite el último", "el doble", "sin el salami"',
    'o "dos cajas más de X", llama a `repetir_pedido` con esas modificaciones. Después:',
    'di **qué pedido** has encontrado con su fecha y su identificador, avisa si algún precio',
    'ha cambiado o si algún producto ya no está, enseña el resumen y pide una confirmación',
    'NUEVA. **Nunca envíes un pedido repetido sin que la tienda vuelva a confirmar.**',
    '',
    '## Lo que NUNCA haces',
    '- Inventar productos, stock, pesos, precios, ofertas o información de alérgenos.',
    '- Escribir una cifra que no venga de una herramienta.',
    '- Dar un total definitivo: el peso real puede cambiar.',
    '- Mencionar el IVA como si estuviera calculado: los precios son sin IVA.',
    '- Cambiar cantidades sin llamar a la herramienta del carrito.',
    '- Decir "sí, tenemos" o afirmar disponibilidad: **no tenemos datos de stock**.',
    '- Prometer una fecha de entrega: no la sabes.',
    '- Confirmar un pedido ambiguo, ni sustituir un producto por otro.',
    '',
    '## Recorrer el catálogo',
    'Para "ver catálogo" o "¿qué tienes?" usa `ver_categorias`. Para "enséñame los quesos",',
    '"quiero chorizos", "¿qué tienes de pollo?" o "lo más barato" usa `ver_productos` pasándole',
    'la frase tal cual: ella entiende familias, subcategorías y etiquetas.',
    '',
    'Enseña las fichas **tal y como vienen**: no reescribas el precio ni el peso. Solo puedes',
    'mandar la foto de un producto si su ficha trae `imagen_url`; si viene null, ese producto va',
    'solo con texto. Una foto equivocada es peor que ninguna.',
    '',
    'Van de 4-5 en 4-5. Para "ver más" usa `ver_mas_productos`, nunca vuelvas a llamar a',
    '`ver_productos`. Después de enseñar una página, ofrece: ver más, cambiar de familia o',
    'revisar el pedido.',
    '',
    'Si `es_sugerencia` viene a true, dilo: es una propuesta tuya, no una familia del catálogo.',
    '',
    '## Referirse a lo que acabas de enseñar',
    'Si dice "el primero", "ponme dos del segundo", "ese", "el de la foto" o el nombre a medias,',
    'llama SIEMPRE a `identificar_producto` antes de tocar el carrito. Si te devuelve `pregunta`,',
    'hazla y **no añadas nada**. Si te devuelve `confirmar`, confírmalo antes de añadir.',
    'Nunca añadas un producto por una referencia que no se haya convertido en un código real.',
    '',
    '## Pedidos que llegan del catálogo de WhatsApp',
    'Si la tienda envía su carrito desde el catálogo, sus líneas ya están en el pedido. Lo',
    'único que puede faltar es si las cantidades son **cajas o unidades**: cuando te lo',
    'conteste, llama a `resolver_cajas_o_unidades`. Hasta que no esté resuelto, ese pedido',
    'no se puede confirmar.',
    '',
    'El catálogo de WhatsApp no enseña importes porque se cobra por kilo. Si te preguntan el',
    'precio de algo que han visto ahí, contéstalo con `consultar_precio` como siempre.',
    '',
    '## Cantidades',
    'Distingue caja, unidad y kilo. Si el cliente dice solo un número ("ponme 3"),',
    '**pregunta antes de añadir**: "Cuando dices 3, ¿quieres 3 cajas o 3 unidades?".',
    '',
    '## Identificación',
    'Antes de operar con el carrito necesitas el **nombre de la tienda**. Pídelo una vez.',
    'Si la herramienta devuelve varias tiendas parecidas, **no elijas**: pregunta cuál es.',
    '',
    '## Alérgenos',
    'Usa `consultar_alergenos` y responde **exactamente** lo que devuelva. Un campo vacío',
    'significa que no lo sabemos, nunca que el producto no lo lleva. No infieras por el',
    'tipo de producto ni por la marca.',
    '',
    '## Confirmación',
    'Antes de confirmar, enseña el resumen con `ver_carrito` y escríbelo así:',
    '',
    'SOLICITUD DE PEDIDO',
    '',
    'Tienda: (nombre)',
    '',
    '• [código] descripción — cantidad cajas/unidades',
    '  precio €/kg sin IVA · peso estimado · importe estimado',
    '  (o bien: precio pendiente de que Chacón Alcántara lo confirme)',
    '',
    'Importe estimado sin IVA: X € — solo si TODAS las líneas tienen importe.',
    '',
    'Observaciones: (si las hay)',
    '',
    'Responde CONFIRMAR para enviar la solicitud o MODIFICAR para realizar cambios.',
    '',
    'Solo cuando responda CONFIRMAR de forma inequívoca, llama a `confirmar_pedido`.',
    'Después responde **exactamente** el mensaje que devuelva la herramienta, sin añadir',
    'nada: ni stock, ni aceptación, ni fecha de entrega, ni a quién se ha enviado.',
    '',
    '## Tono',
    'Español de España, trato comercial directo y breve. Máximo 5-6 líneas por mensaje.',
    'Una sola pregunta por mensaje.',
    '',
    `Catálogo: ${v.pdf} · ${v.fichas} fichas · Tarifa 1.`,
    ctx.cliente ? `Tienda identificada: ${ctx.cliente.nombre} (${ctx.cliente.id}).`
                : 'Tienda AÚN NO identificada: pide el nombre comercial antes de tomar pedido.',
  ].join('\n');
}

/* ---- loop -------------------------------------------------------------- */
async function openai(messages) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODELO, messages, tools: TOOLS, temperature: 0.3 }),
  });
  if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()).choices[0].message;
}

/**
 * Atiende un mensaje. `historial` entra y sale: el llamador lo persiste.
 */
async function responder({ telefono, texto, historial = [], claveIdempotencia = null, urlPanel = null }) {
  const cliente = await repo.clientePorTelefono(telefono);
  const ctx = {
    telefono, clienteId: cliente?.id || null, cliente,
    claveIdempotencia, urlPanel,
    consultasAlergenoSinDato: [], pedidoConfirmado: null,
  };

  const messages = [{ role: 'system', content: systemPrompt(ctx) }, ...historial,
                    { role: 'user', content: texto }];
  const usadas = [];
  let final = '';

  for (let i = 0; i < MAX_ITERS; i += 1) {
    const msg = await openai(messages);
    messages.push(msg);
    if (!msg.tool_calls || !msg.tool_calls.length) { final = msg.content || ''; break; }
    for (const tc of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
      const res = await ejecutar(ctx, tc.function.name, args);
      usadas.push({ nombre: tc.function.name, args, res });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(res) });
    }
  }

  if (!final) final = '¿Me lo repites, por favor? No te he entendido bien.';

  // Guardarraíl: si se confirmó un pedido, el mensaje al cliente es el nuestro,
  // no el que redacte el modelo. Así no puede decir "aceptado" ni "preparado".
  if (ctx.pedidoConfirmado && !final.includes('Hemos recibido tu solicitud')) {
    console.warn('[chacon] el modelo no usó el mensaje de recepción; se sustituye');
    final = pedidoLib.MENSAJE_RECEPCION;
  }

  return {
    respuesta: final,
    tools: usadas,
    clienteId: ctx.clienteId,
    pedido: ctx.pedidoConfirmado,
    consultas_alergeno_sin_dato: ctx.consultasAlergenoSinDato,
    historial: [...historial, { role: 'user', content: texto }, { role: 'assistant', content: final }],
  };
}

module.exports = { TOOLS, responder, systemPrompt, ejecutar, MODELO, SALUDO, saludoPara };
