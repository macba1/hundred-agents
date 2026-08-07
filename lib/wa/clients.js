/* ============================================================
   Client registry for the WhatsApp agent.

   Each client lives in lib/wa/clients/<clave>/ with config.json,
   prompt.md and catalogo.json. Routing is by the phone_number_id Meta
   sends in the webhook.

   Serverless notes:
   - Files are read once per cold start and cached on the module. There is
     no mutable per-request state here.
   - The JSONs are require()d so Vercel's tracer bundles them. prompt.md is
     read with fs, which is why vercel.json declares includeFiles for
     lib/wa/clients/**.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const CLIENTS_DIR = path.join(__dirname, 'clients');
const DEFAULT_CLIENT = process.env.DEFAULT_CLIENT || '';
const LEGACY_CLIENT = process.env.LEGACY_CLIENT || 'demo-dulces';

const DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const { flatten, INFO_KEYS } = require('./catalog');

/** Parts of the local time for a IANA zone, without pulling in a date lib. */
function zonedParts(zone) {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
  // weekday index with Monday = 0, to match DIAS
  const wdMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: parts.hour === '24' ? '00' : parts.hour,
    minute: parts.minute,
    weekday: wdMap[parts.weekday] ?? 0,
  };
}

/** "28/07/2026 17:15 (CDMX)" — used in escalation notices. */
function ahoraCorto(client) {
  const p = zonedParts(client.zona_horaria);
  const dd = String(p.day).padStart(2, '0');
  const mm = String(p.month).padStart(2, '0');
  return `${dd}/${mm}/${p.year} ${p.hour}:${p.minute} (${client.etiqueta_zona})`;
}

/** "martes 28 de julio de 2026, 17:15 hora local de CDMX" — used in the prompt. */
function ahoraLargo(client) {
  const p = zonedParts(client.zona_horaria);
  return `${DIAS[p.weekday]} ${p.day} de ${MESES[p.month - 1]} de ${p.year}, ` +
    `${p.hour}:${p.minute} hora local de ${client.etiqueta_zona}`;
}

/**
 * Business facts for the system prompt. The catalog wins because it is also
 * what the tool returns; config.json "datos" only overrides. This keeps a
 * single source of truth for opening hours.
 */
function datosNegocio(client) {
  const base = {};
  for (const k of INFO_KEYS) if (k in client.catalogo) base[k] = client.catalogo[k];
  return { ...base, ...(client.datos || {}) };
}

/**
 * Full system prompt: client prompt + business data + local time + demo notice.
 * @param {object} [opts]
 * @param {boolean} [opts.primerMensaje] true when there is no history for this
 *   contact — a brand new conversation, or one whose Redis session expired
 *   after 48h of silence. Drives the greeting-with-options.
 * @param {object|null} [opts.perfil] stored customer profile, when they have
 *   ordered before: {nombre, pedidos, ultimo_pedido}.
 */
function systemPrompt(client, opts = {}) {
  const partes = [String(client.prompt || '').trim()];

  const datos = datosNegocio(client);
  if (Object.keys(datos).length) {
    const lineas = Object.entries(datos)
      .map(([k, v]) => `- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join('\n');
    partes.push(
      '## DATOS DEL NEGOCIO (fuente de verdad)\n' + lineas + '\n' +
      'REGLA DURA: si un dato contiene "REEMPLAZAR" o "PENDIENTE", todavía no está ' +
      'confirmado. Nunca lo presentes como un hecho. Si el dato trae un valor ' +
      'provisional puedes mencionarlo, pero SIEMPRE aclarando en la misma frase que ' +
      'está por confirmar con el equipo. Si no trae valor, dilo y ofrece confirmarlo.'
    );
  }

  partes.push(
    `Ahora mismo es ${ahoraLargo(client)}. ` +
    'Úsalo para responder si están abiertos o cerrados en este momento.'
  );

  const perfil = opts.perfil;
  const esRecurrente = !!(perfil && (perfil.nombre || perfil.ultimo_pedido));

  // El DATO del cliente conocido va en TODOS los turnos: "¿te preparo lo mismo?"
  // se responde en el turno siguiente, cuando ya no es el primer mensaje.
  if (esRecurrente) {
    const u = perfil.ultimo_pedido || {};
    partes.push(
      '## CLIENTE CONOCIDO\n' +
      (perfil.nombre ? `Se llama **${perfil.nombre}**. ` : '') +
      (perfil.pedidos ? `Lleva ${perfil.pedidos} pedido(s) con nosotros.` : '') +
      (u.resumen
        ? `\n\nSU ÚLTIMO PEDIDO (${u.folio}) fue exactamente esto:\n${u.resumen}` +
          (u.total != null ? `\nTotal: $${u.total}.` : '')
        : '') +
      '\n\nSi el cliente dice "lo mismo", "lo de siempre", "igual que la otra vez" ' +
      'o similar, se refiere a ESA lista de arriba y a nada más. Sus variantes ya ' +
      'están elegidas: no vuelvas a preguntar "¿verdes o rojos?" si ahí dice ' +
      '"Verdes". Vuelve a pasar cada platillo por `buscar_catalogo` para ' +
      're-verificar el precio (pueden haber cambiado) y sigue el flujo normal ' +
      'desde "¿algo más?". Nunca sustituyas un platillo por otro.'
    );
  }

  if (!opts.primerMensaje) {
    partes.push(
      'La conversación YA está en curso: no vuelvas a saludar ni a presentarte, ' +
      'y no repitas el menú de opciones. Contesta directo a lo que acaban de decir.'
    );
  } else if (esRecurrente) {
    partes.push(
      'ESTE ES EL PRIMER MENSAJE y es un cliente conocido. **NO uses el saludo ' +
      'con las 3 opciones.** Salúdalo por su nombre y ofrécele lo mismo de la ' +
      'última vez, en una o dos líneas. Por ejemplo:\n' +
      `"¡Hola${perfil.nombre ? ', ' + perfil.nombre : ''}! ¿Te preparo lo mismo de la última vez?"\n` +
      'Si dice que no, entonces sí manda el saludo con las 3 opciones. ' +
      'Si su primer mensaje ya trae un pedido o pregunta concreta, atiéndelo directo.'
    );
  } else {
    partes.push(
      'ESTE ES EL PRIMER MENSAJE de la conversación (o el cliente llevaba más ' +
      'de 48h sin escribir), y es alguien de quien no tenemos historial. Aplica la ' +
      'sección "Saludo inicial": si el cliente solo saludó, manda el saludo con las ' +
      '3 opciones tal cual. Si ya trajo un pedido o una pregunta concreta, ' +
      'sáltate el saludo y atiende directo.'
    );
  }

  if (client.modo_demo) {
    partes.push(
      '## PERIODO DE PRUEBAS\n' +
      'Estamos validando el asistente antes de lanzarlo. Atiendes NORMAL: ' +
      'tomas el pedido completo, registras con la herramienta y confirmas ' +
      'folio y total como siempre. NO escales un pedido solo por ser periodo ' +
      'de pruebas.\n' +
      'Lo único que cambia: cuando confirmes un pedido registrado, cierra el ' +
      'mensaje con esta línea, tal cual y en su propio renglón:\n' +
      client.aviso_demo + '\n' +
      'No la repitas en mensajes que no confirmen un pedido.'
    );
  }

  return partes.join('\n\n');
}

function loadOne(clave) {
  const dir = path.join(CLIENTS_DIR, clave);
  // require() so Vercel's tracer bundles the JSON; fs for the markdown.
  const cfg = require(path.join(dir, 'config.json'));
  let catalogo = {};
  try { catalogo = require(path.join(dir, 'catalogo.json')); } catch { catalogo = {}; }
  const prompt = fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8');

  const client = {
    clave: cfg.clave || clave,
    nombre: cfg.nombre || clave,
    activo: cfg.activo !== false,
    phone_number_id: String(cfg.phone_number_id || ''),
    // Acepta un número o una lista: al sumar probadores del staff, todos
    // reciben el escalamiento sin tocar código.
    human_notify_wa: Array.isArray(cfg.human_notify_wa)
      ? cfg.human_notify_wa.map(String).filter(Boolean)
      : (cfg.human_notify_wa ? [String(cfg.human_notify_wa)] : []),
    human_notify_wa_alt: String(cfg.human_notify_wa_alt || ''),
    max_turns: Number(cfg.max_turns || 14),
    memoria_mensajes: Number(cfg.memoria_mensajes || 24),
    // Tope de notas de voz por persona y día. 5 dejaba a un cliente tirado a
    // media orden: cinco audios son UNA conversación de pedido normal.
    audio_max_dia: Number(cfg.audio_max_dia || process.env.AUDIO_MAX_PER_DAY || 30),
    folio_prefix: cfg.folio_prefix || clave.slice(0, 3).toUpperCase(),
    modo_demo: !!cfg.modo_demo,
    aviso_demo: cfg.aviso_demo ||
      '⚠️ Estamos en periodo de pruebas: este pedido es de práctica y no se preparará.',
    zona_horaria: cfg.zona_horaria || 'America/Mexico_City',
    etiqueta_zona: cfg.etiqueta_zona || 'CDMX',
    acento_panel: cfg.acento_panel || '#ff4e1c',
    mensaje_cierre: cfg.mensaje_cierre ||
      'Por hoy aquí termina esta demo. ¡Gracias por escribir!',
    datos: cfg.datos || {},
    prompt,
    catalogo,
  };
  client.productos = flatten(catalogo);
  return client;
}

let _cache = null;

/** Load every client. Cached per cold start; throws on routing ambiguity. */
function load() {
  if (_cache) return _cache;

  const byClave = {};
  const byPnid = {};
  const errores = [];

  let dirs = [];
  try {
    dirs = fs.readdirSync(CLIENTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch (err) {
    errores.push(`No se pudo leer ${CLIENTS_DIR}: ${err.message}`);
  }

  for (const clave of dirs) {
    let c;
    try {
      c = loadOne(clave);
    } catch (err) {
      errores.push(`cliente ${clave}: ${err.message}`);
      continue;
    }
    byClave[c.clave] = c;
    if (!c.activo) continue;
    if (!c.phone_number_id) {
      errores.push(`cliente ${c.clave} activo pero sin phone_number_id`);
      continue;
    }
    if (byPnid[c.phone_number_id]) {
      // Two live clients on one number: routing would be a guess, and a guess
      // means answering on behalf of the wrong business.
      throw new Error(
        `phone_number_id duplicado entre clientes activos: ` +
        `'${byPnid[c.phone_number_id].clave}' y '${c.clave}' comparten ` +
        `${c.phone_number_id}. Deja activo=true en solo uno.`
      );
    }
    byPnid[c.phone_number_id] = c;
  }

  _cache = { byClave, byPnid, errores };
  return _cache;
}

/**
 * phone_number_id -> client. A present-but-unknown id resolves to null
 * instead of falling back: answering as the wrong business is worse than
 * not answering. The fallback only covers payloads with no metadata.
 */
function resolve(phoneNumberId) {
  const { byClave, byPnid } = load();
  if (phoneNumberId) return byPnid[phoneNumberId] || null;
  if (DEFAULT_CLIENT && byClave[DEFAULT_CLIENT]) return byClave[DEFAULT_CLIENT];
  const activos = Object.values(byClave).filter((c) => c.activo);
  return activos.length === 1 ? activos[0] : null;
}

function get(clave) { return load().byClave[clave] || null; }
function all() { return Object.values(load().byClave); }

module.exports = {
  load, resolve, get, all,
  systemPrompt, datosNegocio, ahoraCorto, ahoraLargo, zonedParts,
  LEGACY_CLIENT, CLIENTS_DIR,
};
