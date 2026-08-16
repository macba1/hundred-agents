/* ============================================================
   Agente comercial de Chacón.

   Reparto de responsabilidades, sin excepciones:
     - La IA interpreta la intención y redacta.
     - TODA operación crítica la ejecuta código determinista de este módulo:
       buscar en catálogo, añadir al carrito, calcular importes, confirmar.

   En este MVP el modelo NO ve ninguna cifra económica: `mvp.js` la recorta
   antes de que el resultado de la tool llegue al modelo. Si no la recibe, no
   puede enseñarla ni construir un total a partir de ella. Los precios, las
   tarifas y el IVA siguen calculándose y guardándose para la fase siguiente.
   ============================================================ */

const repo = require('./repo');
const catalogo = require('./catalogo');
const pedidoLib = require('./pedido');
const fabrica = require('./fabrica');
const mvp = require('./mvp');

const MODELO = process.env.CHACON_OPENAI_MODEL || process.env.WA_OPENAI_MODEL || 'gpt-4o';
const MAX_ITERS = Number(process.env.CHACON_MAX_TOOL_ITERS || 8);

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'buscar_productos',
      description: 'Busca en el catálogo por código, código de barras, nombre, marca o texto aproximado. '
        + 'DEBES usarla antes de mencionar cualquier producto. Devuelve candidatos con su producto_id. '
        + 'No devuelve precios: esta versión no los maneja.',
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
      description: 'Devuelve la solicitud de pedido tal y como va: productos, cantidades y unidades. '
        + 'Sin importes.',
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
      candidatos: r.candidatos.map(mvp.productoVisible),
      nota: 'Esta versión no maneja precios: no menciones importes. '
        + 'Disponibilidad pendiente de revisión por Chacón Alcántara: no afirmes que hay stock.',
    };
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
    'Tu único objetivo es que la tienda prepare y envíe una **solicitud de pedido**.',
    'No es un presupuesto, no es una factura y no es una cotización.',
    '',
    '## Nada de dinero',
    'Esta versión **no maneja precios**. No los tienes, no te llegan y no los inventas.',
    'Si el cliente pregunta cuánto cuesta algo o cuánto suma el pedido, responde:',
    '"En este canal preparo la solicitud; los precios te los confirma Chacón Alcántara."',
    'y sigue tomando el pedido. Nunca escribas un importe, un subtotal, un total,',
    'un IVA, una tarifa ni un precio por kilo, ni siquiera aproximado o de memoria.',
    '',
    '## Lo que NUNCA haces',
    '- Inventar productos, stock, pesos, precios o información de alérgenos.',
    '- Escribir cualquier cifra en euros.',
    '- Cambiar cantidades sin llamar a la herramienta del carrito.',
    '- Decir "sí, tenemos" o afirmar disponibilidad: **no tenemos datos de stock**.',
    '- Prometer una fecha de entrega: no la sabes.',
    '- Confirmar un pedido ambiguo, ni sustituir un producto por otro.',
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
    `Catálogo: ${v.pdf} · ${v.fichas} fichas.`,
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

module.exports = { TOOLS, responder, systemPrompt, ejecutar, MODELO };
