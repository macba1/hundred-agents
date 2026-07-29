/* ============================================================
   The agent itself: OpenAI chat loop, tools, and voice transcription.

   Stateless by construction — conversation memory comes in from Redis and
   goes back out on every turn, so any serverless instance can serve any
   message.
   ============================================================ */

const store = require('./store');
const clientsLib = require('./clients');
const catalog = require('./catalog');
const wa = require('./whatsapp');
const { esTest } = require('./testmode');

// WA_OPENAI_MODEL primero: OPENAI_MODEL es del proyecto entero y lo usa también
// el chat del sitio, que corre con otro modelo. No queremos acoplarlos.
const OPENAI_MODEL = process.env.WA_OPENAI_MODEL || process.env.OPENAI_MODEL || 'gpt-4o';
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'whisper-1';
const MAX_TOOL_ITERS = Number(process.env.MAX_TOOL_ITERS || 6);

const AUDIO_MAX_PER_DAY = Number(process.env.AUDIO_MAX_PER_DAY || 5);
const AUDIO_MAX_SECONDS = Number(process.env.AUDIO_MAX_SECONDS || 120);
const AUDIO_MAX_BYTES = Number(process.env.AUDIO_MAX_BYTES || 1024 * 1024);

const PEDIR_TEXTO_LARGO =
  'Ese audio está un poco largo para mí 🙈 ¿Me lo mandas por escrito, o en una nota de voz más cortita (menos de 2 minutos)?';
const PEDIR_TEXTO_FALLO =
  'No logré escuchar bien tu nota de voz. ¿Me escribes tu mensaje por texto, por favor?';
const PEDIR_TEXTO_LIMITE =
  'Por hoy ya no puedo procesar más notas de voz. ¿Me escribes tu mensaje por texto? Con gusto te sigo atendiendo por ahí.';

/* ---- OpenAI ------------------------------------------------- */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'buscar_catalogo',
      description:
        'Busca en el catálogo/menú del negocio por nombre, categoría o SKU. ' +
        'DEBES llamarla antes de mencionar cualquier producto, precio o disponibilidad. ' +
        'Nunca respondas de memoria.',
      parameters: {
        type: 'object',
        properties: {
          consulta: { type: 'string', description: 'Texto a buscar. Vacío = todo el menú.' },
        },
        required: ['consulta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'registrar_pedido',
      description:
        'Registra un pedido/cotización/lead y devuelve un folio. Úsala solo cuando ya tengas el pedido completo.',
      parameters: {
        type: 'object',
        properties: {
          clasificacion: { type: 'string', enum: ['pedido', 'cotizacion', 'duda', 'lead_caliente'] },
          resumen: {
            type: 'string',
            description: 'Productos, cantidades, nombre de quien recoge o dirección, y hora.',
          },
          total: { type: 'number', description: 'Total estimado en MXN si se conoce.' },
          nombre_cliente: {
            type: 'string',
            description: 'Nombre de quien recoge o recibe. Se recuerda para la próxima vez.',
          },
          fuera_de_carta: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Platillos del pedido que NO están en el catálogo y quedan "por confirmar con ' +
              'el equipo". Si incluyes alguno, el equipo se entera automáticamente.',
          },
        },
        required: ['clasificacion', 'resumen'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalar_humano',
      description: 'Escala a una persona del equipo y la notifica por WhatsApp.',
      parameters: {
        type: 'object',
        properties: { motivo: { type: 'string', description: 'Por qué se escala.' } },
        required: ['motivo'],
      },
    },
  },
];

async function openaiChat(messages) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: OPENAI_MODEL, messages, tools: TOOLS, temperature: 0.4 }),
  });
  if (!r.ok) throw new Error(`openai chat ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const EXT_BY_MIME = {
  'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/mp4a-latm': 'm4a', 'audio/aac': 'm4a', 'audio/amr': 'amr', 'audio/wav': 'wav',
  'audio/x-wav': 'wav', 'audio/webm': 'webm',
};

async function openaiTranscribe(buffer, mime) {
  const base = String(mime).split(';')[0].trim().toLowerCase();
  const ext = EXT_BY_MIME[base] || 'ogg';

  const form = new FormData();
  form.append('model', TRANSCRIBE_MODEL);
  form.append('language', 'es');
  // Only whisper-1 supports verbose_json, which is what reports real duration.
  if (TRANSCRIBE_MODEL === 'whisper-1') form.append('response_format', 'verbose_json');
  form.append('file', new Blob([buffer], { type: base || 'audio/ogg' }), `audio.${ext}`);

  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!r.ok) throw new Error(`openai transcribe ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

/* ---- tools -------------------------------------------------- */
function folioDe(client, id) {
  return `${client.folio_prefix}-${String(id).padStart(4, '0')}`;
}

async function toolRegistrarPedido(client, phone, args) {
  const valid = new Set(['pedido', 'cotizacion', 'duda', 'lead_caliente']);
  const clasificacion = valid.has(args.clasificacion) ? args.clasificacion : 'duda';
  const total = Number.isFinite(Number(args.total)) ? Number(args.total) : null;

  // The id has to exist before the record is written, so the folio lands in
  // the same single write. Two writes would show the lead twice in the panel.
  const id = await store.nextId(client.clave);
  const folio = folioDe(client, id);
  await store.pushLead(client.clave, {
    id,
    client: client.clave,
    ts: new Date().toISOString(),
    phone,
    tipo: clasificacion,
    clasificacion,
    resumen: String(args.resumen || ''),
    total,
    folio,
    test: esTest(phone),
  });

  // Si el pedido lleva algo fuera de carta, el equipo se entera SIEMPRE. Antes
  // dependía de que el modelo se acordara de llamar a escalar_humano, y en una
  // prueba real prometió "te lo confirma el equipo" sin avisar a nadie.
  const fuera = (args.fuera_de_carta || []).map(String).filter(Boolean);
  let escalado = null;
  if (fuera.length) {
    escalado = await toolEscalarHumano(client, phone, {
      motivo: `Pedido ${folio}: el cliente pidió ${fuera.join(', ')}, ` +
        `que no está en la carta. Falta confirmar disponibilidad y precio.`,
    });
  }

  // Perfil del cliente: sobrevive a la sesión, por eso al volver se le puede
  // saludar por su nombre y ofrecerle lo de la última vez.
  const previo = await store.getPerfil(client.clave, phone);
  await store.savePerfil(client.clave, phone, {
    nombre: String(args.nombre_cliente || '').trim() || (previo && previo.nombre) || null,
    pedidos: ((previo && previo.pedidos) || 0) + 1,
    ultimo_pedido: {
      folio, total, ts: new Date().toISOString(),
      resumen: String(args.resumen || ''),
      fuera_de_carta: fuera,
    },
  });

  return {
    folio,
    clasificacion,
    total,
    fuera_de_carta: fuera,
    equipo_notificado: escalado ? escalado.notificado_a_humano : null,
  };
}

function avisoEscalamiento(client, phone, motivo) {
  return `🔔 ${client.nombre} — ${clientsLib.ahoraCorto(client)} — escalado de +${phone}: ${motivo}`;
}

async function toolEscalarHumano(client, phone, args) {
  const motivo = String(args.motivo || '');
  await store.addLead(client.clave, {
    phone, tipo: 'escalado', clasificacion: 'lead_caliente', resumen: motivo,
    total: null, folio: null, test: esTest(phone),
  });

  const aviso = avisoEscalamiento(client, phone, motivo);

  // Un número del rango de pruebas nunca despierta a nadie por WhatsApp.
  if (esTest(phone)) {
    console.log('[wa][TEST] escalado simulado, no se notifica:', aviso);
    return { escalado: true, notificado_a_humano: false, es_prueba: true, motivo };
  }

  const destinos = client.human_notify_wa || [];
  const entregados = [];

  for (const destino of destinos) {
    if (await wa.sendText(client, destino, aviso)) entregados.push(destino);
  }
  // El alt solo entra si NINGUNO recibió: es un formato alternativo del mismo
  // número, no un destinatario extra.
  if (!entregados.length && client.human_notify_wa_alt) {
    console.warn('[wa] escalado: reintentando con human_notify_wa_alt');
    if (await wa.sendText(client, client.human_notify_wa_alt, aviso)) {
      entregados.push(client.human_notify_wa_alt);
    }
  }
  if (!entregados.length) console.error('[wa] escalado de', phone, 'NO se pudo notificar');
  else if (entregados.length < destinos.length) {
    console.warn('[wa] escalado entregado solo a', entregados.length, 'de', destinos.length);
  }
  return {
    escalado: true,
    notificado_a_humano: entregados.length > 0,
    notificados: entregados.length,
    motivo,
  };
}

async function dispatchTool(client, phone, name, args) {
  try {
    if (name === 'buscar_catalogo') return catalog.buscar(client, args.consulta || '');
    if (name === 'registrar_pedido') return await toolRegistrarPedido(client, phone, args);
    if (name === 'escalar_humano') return await toolEscalarHumano(client, phone, args);
    return { error: `herramienta desconocida: ${name}` };
  } catch (err) {
    console.error('[wa] tool', name, 'falló:', err.message);
    return { error: err.message };
  }
}

/* ---- agent loop --------------------------------------------- */
/**
 * Run one turn. `session` comes from Redis and is mutated in place with the
 * new history; the caller persists it.
 */
async function runAgent(client, phone, userContent, memoryText, session) {
  // Sin historial = conversación nueva, o sesión expirada tras 48h de silencio.
  // Es lo que dispara el saludo con opciones.
  const primerMensaje = session.history.length === 0;
  // El perfil solo hace falta al abrir conversación: dentro de una charla en
  // curso el historial ya lleva el nombre y el pedido.
  const perfil = primerMensaje ? await store.getPerfil(client.clave, phone) : null;
  const system = clientsLib.systemPrompt(client, { primerMensaje, perfil });

  const messages = [{ role: 'system', content: system }]
    .concat(session.history)
    .concat([{ role: 'user', content: userContent }]);

  session.history.push({ role: 'user', content: memoryText });

  let finalText = '';
  let folioEmitido = null;

  const iterar = async () => {
    const data = await openaiChat(messages);
    const msg = data.choices[0].message;
    messages.push(msg);

    const calls = msg.tool_calls;
    if (!calls || !calls.length) {
      finalText = msg.content || '';
      return false;
    }
    for (const tc of calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
      const result = await dispatchTool(client, phone, tc.function.name, args);
      if (tc.function.name === 'registrar_pedido' && result && result.folio) {
        folioEmitido = result.folio;
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
    return true;
  };

  for (let i = 0; i < MAX_TOOL_ITERS; i += 1) {
    if (!await iterar()) break;
  }

  // Guardarraíl: el modelo llegó a redactar un ticket ("— folio …") sin haber
  // llamado a registrar_pedido. El cliente se iría con un pedido confirmado que
  // no existe en ningún lado. Se le devuelve el error y se le da un intento más.
  const pareceTicket = /folio/i.test(finalText) && /\$\s*\d/.test(finalText);
  if (pareceTicket && !folioEmitido) {
    console.error('[wa] ticket sin registrar_pedido; se fuerza el registro. phone=%s', phone);
    messages.push({
      role: 'system',
      content:
        'ALTO: acabas de redactar una confirmación de pedido con folio, pero NO ' +
        'llamaste a registrar_pedido, así que ese folio no existe y el pedido no ' +
        'quedó guardado. Llama AHORA a registrar_pedido con el pedido completo ' +
        '(incluye nombre_cliente) y vuelve a escribir la confirmación usando el ' +
        'folio real que te devuelva. Si te falta algún dato, pregúntalo en vez de ' +
        'confirmar.',
    });
    for (let i = 0; i < 3; i += 1) {
      if (!await iterar()) break;
    }
  }

  if (!finalText) finalText = '¿Me repites por favor? No te entendí bien.';
  session.history.push({ role: 'assistant', content: finalText });
  return finalText;
}

/* ---- voice --------------------------------------------------- */
/** @returns {{texto: string|null, aviso: string}} texto null => send `aviso`. */
async function transcribirAudio(client, phone, mediaId) {
  const dia = new Intl.DateTimeFormat('en-CA', {
    timeZone: client.zona_horaria, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  const usados = await store.bumpAudio(client.clave, phone, dia);
  if (usados > AUDIO_MAX_PER_DAY) {
    console.log('[wa] audio: límite diario alcanzado', client.clave, phone);
    return { texto: null, aviso: PEDIR_TEXTO_LIMITE };
  }

  let media;
  try {
    media = await wa.downloadMedia(mediaId);
  } catch (err) {
    console.error('[wa] audio: fallo descargando', err.message);
    return { texto: null, aviso: PEDIR_TEXTO_FALLO };
  }

  if (media.size > AUDIO_MAX_BYTES) {
    console.log('[wa] audio:', media.size, 'bytes supera AUDIO_MAX_BYTES');
    return { texto: null, aviso: PEDIR_TEXTO_LARGO };
  }

  let data;
  try {
    data = await openaiTranscribe(media.buffer, media.mime);
  } catch (err) {
    console.error('[wa] audio: fallo transcribiendo', err.message);
    return { texto: null, aviso: PEDIR_TEXTO_FALLO };
  }

  if (data.duration != null && Number(data.duration) > AUDIO_MAX_SECONDS) {
    console.log('[wa] audio: duración', data.duration, 's supera el máximo');
    return { texto: null, aviso: PEDIR_TEXTO_LARGO };
  }

  const texto = String(data.text || '').trim();
  if (!texto) return { texto: null, aviso: PEDIR_TEXTO_FALLO };
  return { texto, aviso: '' };
}

/* ---- message handling ---------------------------------------- */
/** Process one inbound message end to end and reply over Graph. */
async function handleMessage(client, m) {
  const phone = m.from;
  if (!phone) return;
  const tipo = m.type || 'unknown';

  const turns = await store.bumpTurn(client.clave, phone, client.memoria_mensajes);
  if (turns > client.max_turns) {
    await store.addLead(client.clave, {
      phone, tipo: 'mensaje', clasificacion: null,
      resumen: `[límite ${client.max_turns} turnos alcanzado]`, total: null, folio: null,
      test: esTest(phone),
    });
    await wa.sendText(client, phone, client.mensaje_cierre);
    return;
  }

  const session = await store.getSession(client.clave, phone);

  try {
    if (tipo === 'text') {
      const body = m.text.body;
      await store.addLead(client.clave, {
        phone, tipo: 'mensaje', clasificacion: null, resumen: body.slice(0, 200),
        total: null, folio: null, test: esTest(phone),
      });
      const reply = await runAgent(client, phone, body, body, session);
      await store.saveSession(client.clave, phone, session, client.memoria_mensajes);
      await wa.sendText(client, phone, reply);
      return;
    }

    if (tipo === 'audio' || tipo === 'voice') {
      const mediaId = (m[tipo] || {}).id || '';
      const { texto, aviso } = await transcribirAudio(client, phone, mediaId);
      if (!texto) { await wa.sendText(client, phone, aviso); return; }
      console.log(`[wa] audio transcrito (${client.clave}/${phone}):`, texto.slice(0, 120));
      await store.addLead(client.clave, {
        phone, tipo: 'mensaje', clasificacion: null,
        resumen: `[audio] ${texto}`.slice(0, 200), total: null, folio: null, test: esTest(phone),
      });
      const marcado = `[Audio transcrito]: ${texto}`;
      const reply = await runAgent(client, phone, marcado, marcado, session);
      await store.saveSession(client.clave, phone, session, client.memoria_mensajes);
      await wa.sendText(client, phone, reply);
      return;
    }

    // sticker, ubicación, contacto, documento, imagen…
    await store.addLead(client.clave, {
      phone, tipo: 'mensaje', clasificacion: null, resumen: `[${tipo}]`,
      total: null, folio: null, test: esTest(phone),
    });
    await wa.sendText(
      client, phone,
      'Por ahora puedo leer *texto* y *notas de voz*. ¿Me escribes tu consulta? 🙏'
    );
  } catch (err) {
    console.error('[wa] error atendiendo a', phone, `(${client.clave}):`, err.stack || err.message);
    await wa.sendText(client, phone, 'Tuvimos un detalle técnico. ¿Me repites tu mensaje?');
  }
}

module.exports = {
  handleMessage, runAgent, dispatchTool, transcribirAudio,
  openaiChat, openaiTranscribe, avisoEscalamiento, folioDe,
  TOOLS, OPENAI_MODEL, TRANSCRIBE_MODEL,
  AUDIO_MAX_PER_DAY, AUDIO_MAX_SECONDS, AUDIO_MAX_BYTES,
};
