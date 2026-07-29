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

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
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
  });
  return { folio, clasificacion, total };
}

function avisoEscalamiento(client, phone, motivo) {
  return `🔔 ${client.nombre} — ${clientsLib.ahoraCorto(client)} — escalado de +${phone}: ${motivo}`;
}

async function toolEscalarHumano(client, phone, args) {
  const motivo = String(args.motivo || '');
  await store.addLead(client.clave, {
    phone, tipo: 'escalado', clasificacion: 'lead_caliente', resumen: motivo, total: null, folio: null,
  });

  const aviso = avisoEscalamiento(client, phone, motivo);
  let entregado = false;
  if (client.human_notify_wa) {
    entregado = await wa.sendText(client, client.human_notify_wa, aviso);
    if (!entregado && client.human_notify_wa_alt) {
      console.warn('[wa] escalado: reintentando con human_notify_wa_alt');
      entregado = await wa.sendText(client, client.human_notify_wa_alt, aviso);
    }
  }
  if (!entregado) console.error('[wa] escalado de', phone, 'NO se pudo notificar');
  return { escalado: true, notificado_a_humano: entregado, motivo };
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
  const messages = [{ role: 'system', content: clientsLib.systemPrompt(client) }]
    .concat(session.history)
    .concat([{ role: 'user', content: userContent }]);

  session.history.push({ role: 'user', content: memoryText });

  let finalText = '';
  for (let i = 0; i < MAX_TOOL_ITERS; i += 1) {
    const data = await openaiChat(messages);
    const msg = data.choices[0].message;
    messages.push(msg);

    const calls = msg.tool_calls;
    if (!calls || !calls.length) {
      finalText = msg.content || '';
      break;
    }
    for (const tc of calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
      const result = await dispatchTool(client, phone, tc.function.name, args);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
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
    });
    await wa.sendText(client, phone, client.mensaje_cierre);
    return;
  }

  const session = await store.getSession(client.clave, phone);

  try {
    if (tipo === 'text') {
      const body = m.text.body;
      await store.addLead(client.clave, {
        phone, tipo: 'mensaje', clasificacion: null, resumen: body.slice(0, 200), total: null, folio: null,
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
        resumen: `[audio] ${texto}`.slice(0, 200), total: null, folio: null,
      });
      const marcado = `[Audio transcrito]: ${texto}`;
      const reply = await runAgent(client, phone, marcado, marcado, session);
      await store.saveSession(client.clave, phone, session, client.memoria_mensajes);
      await wa.sendText(client, phone, reply);
      return;
    }

    // sticker, ubicación, contacto, documento, imagen…
    await store.addLead(client.clave, {
      phone, tipo: 'mensaje', clasificacion: null, resumen: `[${tipo}]`, total: null, folio: null,
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
