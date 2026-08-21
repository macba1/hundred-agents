/* ============================================================
   Adaptador de DEMO WEB para el agente multi-cliente.

   Reutiliza, sin copiarlas, las piezas que ya existen:
     - lib/wa/clients.js   -> config del cliente + system prompt + hora local
     - lib/wa/catalog.js   -> búsqueda de catálogo (acentos, plurales, typos)
     - lib/wa/agent.js     -> la llamada a OpenAI

   Lo único que NO reutiliza es el transporte: aquí no hay Redis, no hay
   Meta y no hay `store`. Eso es deliberado:

     - la demo corre en una reunión, delante del cliente: un fallo de Redis
       no puede tumbarla;
     - `escalar_humano` del agente real MANDA UN WHATSAPP a un número de
       verdad. En una demo eso es un accidente esperando a pasar. Aquí la
       herramienta devuelve el escalamiento como dato y no notifica a nadie;
     - `registrar_pedido` escribe leads en Redis y consume folios de
       producción. Aquí `registrar_lead` solo devuelve la ficha para que la
       landing la pinte.

   El historial viaja en el POST y vuelve en la respuesta: la función es
   pura respecto al estado, que es lo que hace que cualquier instancia
   serverless pueda atender cualquier turno.
   ============================================================ */

const path = require('path');
const clientsLib = require('./clients');
const catalog = require('./catalog');
const agent = require('./agent');

// gpt-4o por defecto y NO OPENAI_MODEL: esa variable vale gpt-4o-mini en el
// proyecto (la usa el chat del sitio) y aquí necesitamos tool-calling fino.
const DEMO_MODEL = process.env.DEMO_OPENAI_MODEL || 'gpt-4o';
const MAX_TOOL_ITERS = Number(process.env.DEMO_MAX_TOOL_ITERS || 6);

/**
 * Tope de turnos de usuario por conversación de demo, y cuántos mensajes del
 * historial se reenvían a OpenAI.
 *
 * La relación entre los dos importa: el historial llega del navegador ya
 * recortado por `sanearHistorial`, así que un MAX_TURNOS por encima de
 * MAX_HISTORIAL/2 sería un tope que no se alcanza nunca — código muerto que
 * aparenta proteger. 18 turnos caben de sobra en una ventana de 40 mensajes.
 */
const MAX_TURNOS = Number(process.env.DEMO_MAX_TURNOS || 18);
const MAX_HISTORIAL = Number(process.env.DEMO_MAX_HISTORIAL || 40);
/** Longitud máxima de un mensaje entrante. */
const MAX_CHARS = Number(process.env.DEMO_MAX_CHARS || 1200);

/* ---- herramientas de la demo -------------------------------- */

const CAMPOS_LEAD = [
  'nombre', 'empresa', 'ciudad', 'estado', 'pais', 'tipo_negocio',
  'productos_interes', 'volumen_aproximado', 'telefono', 'email',
  'contacto_preferido', 'resumen',
];

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'buscar_catalogo',
      description:
        'Busca en el catálogo de Dulces prOvidenCia por nombre, categoría o presentación. ' +
        'DEBES llamarla antes de mencionar cualquier producto, presentación o dato de ' +
        'la empresa. Nunca respondas de memoria. Consulta vacía = catálogo completo.',
      parameters: {
        type: 'object',
        properties: {
          consulta: { type: 'string', description: 'Texto a buscar. Vacío = todo el catálogo.' },
        },
        required: ['consulta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'registrar_lead',
      description:
        'Registra un prospecto cualificado para que lo reciba el equipo comercial. ' +
        'Úsala SOLO cuando ya tengas al menos nombre, negocio o empresa, ciudad y el ' +
        'interés concreto. Manda únicamente lo que la persona te haya dicho: no ' +
        'rellenes campos que no sepas.',
      parameters: {
        type: 'object',
        properties: {
          nombre: { type: 'string', description: 'Nombre de la persona.' },
          empresa: { type: 'string', description: 'Empresa o nombre del negocio.' },
          ciudad: { type: 'string' },
          estado: { type: 'string', description: 'Estado o provincia.' },
          pais: { type: 'string' },
          tipo_negocio: {
            type: 'string',
            description: 'tienda, mayorista, distribuidor, cadena, exportador, consumidor final, otro.',
          },
          productos_interes: {
            type: 'array', items: { type: 'string' },
            description: 'Productos o categorías del catálogo que le interesan.',
          },
          volumen_aproximado: { type: 'string', description: 'Solo si lo mencionó.' },
          telefono: { type: 'string' },
          email: { type: 'string' },
          contacto_preferido: { type: 'string', description: 'WhatsApp, llamada, correo…' },
          prioridad: {
            type: 'string', enum: ['alta', 'media', 'por_valorar'],
            description: 'alta si hay volumen, cadena o urgencia declarada.',
          },
          resumen: { type: 'string', description: 'Una o dos frases sobre qué necesita.' },
        },
        required: ['nombre', 'resumen'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalar_humano',
      description:
        'Marca la conversación para que la retome una persona del equipo comercial. ' +
        'Obligatoria cuando piden precio, descuento, crédito, cobertura concreta, ' +
        'fichas técnicas o certificados, cuando hay una queja, o cuando piden ' +
        'explícitamente hablar con un vendedor.',
      parameters: {
        type: 'object',
        properties: {
          motivo: { type: 'string', description: 'Qué pidió exactamente y por qué se escala.' },
          categoria: {
            type: 'string',
            enum: ['precio', 'descuento', 'credito', 'cobertura', 'pedido_grande',
              'queja', 'ficha_tecnica', 'peticion_humano', 'otro'],
          },
        },
        required: ['motivo'],
      },
    },
  },
];

/* ---- ejecución de herramientas (sin efectos externos) -------- */

function limpiarLead(args) {
  const lead = {};
  for (const k of CAMPOS_LEAD) {
    const v = args[k];
    if (Array.isArray(v)) {
      const arr = v.map((x) => String(x).trim()).filter(Boolean);
      if (arr.length) lead[k] = arr;
    } else if (v != null && String(v).trim()) {
      lead[k] = String(v).trim();
    }
  }
  const prio = ['alta', 'media', 'por_valorar'];
  lead.prioridad = prio.includes(args.prioridad) ? args.prioridad : 'por_valorar';
  return lead;
}

/**
 * Cuántos de los campos que Ventas pidió llegaron. Es lo que la landing pinta
 * como "completitud" de la ficha, y también lo que enseña en la reunión qué
 * datos se están capturando de verdad.
 */
function completitud(lead) {
  const esperados = ['nombre', 'empresa', 'ciudad', 'estado', 'pais', 'tipo_negocio',
    'productos_interes', 'volumen_aproximado', 'telefono', 'email'];
  const presentes = esperados.filter((k) => lead[k] != null);
  return { presentes, faltantes: esperados.filter((k) => !lead[k]), total: esperados.length };
}

async function dispatch(client, estado, name, args) {
  try {
    if (name === 'buscar_catalogo') {
      const r = catalog.buscar(client, args.consulta || '');
      estado.busquedas.push({ consulta: String(args.consulta || ''), total: r.total_coincidencias });
      return r;
    }

    if (name === 'registrar_lead') {
      const lead = limpiarLead(args);
      // El folio es visual: identifica la ficha en la pantalla de la demo.
      // No consume el contador de folios de producción (eso vive en Redis y
      // aquí no se toca) y por eso lleva el prefijo DEMO.
      const folio = `${client.folio_prefix}-DEMO-${String(estado.leads.length + 1).padStart(2, '0')}`;
      const ficha = { folio, ...lead, completitud: completitud(lead) };
      estado.leads.push(ficha);
      return {
        folio,
        registrado: true,
        entorno: 'demostracion',
        aviso_para_el_modelo:
          'Ficha creada para la pantalla de la demostración. El equipo comercial de ' +
          'Dulces prOvidenCia NO ha recibido ningún mensaje: estamos en demo. Puedes ' +
          'decir que le pasas la información al equipo comercial, pero NO prometas ' +
          'tiempos de respuesta ni digas que ya lo llamaron.',
        campos_capturados: ficha.completitud.presentes,
        campos_pendientes: ficha.completitud.faltantes,
      };
    }

    if (name === 'escalar_humano') {
      const motivo = String(args.motivo || '');
      const categoria = String(args.categoria || 'otro');
      estado.escalamientos.push({ motivo, categoria });
      return {
        escalado: true,
        notificado_a_humano: false,
        entorno: 'demostracion',
        categoria,
        motivo,
        aviso_para_el_modelo:
          'Queda marcado para el equipo comercial en la pantalla de la demostración. ' +
          'NO se ha enviado ningún WhatsApp ni correo a nadie. Dilo como "se lo paso al ' +
          'equipo comercial", sin prometer cuándo responden.',
      };
    }

    return { error: `herramienta desconocida: ${name}` };
  } catch (err) {
    console.error('[demo] herramienta', name, 'falló:', err.message);
    return { error: err.message };
  }
}

/* ---- saneado del historial que llega del navegador ----------- */

/**
 * El historial viene del cliente, así que se trata como entrada hostil: solo
 * user/assistant, solo texto, longitud acotada y sin roles inventados (un
 * `role: "system"` colado desde el navegador sería un secuestro del prompt).
 */
function sanearHistorial(historial) {
  if (!Array.isArray(historial)) return [];
  const out = [];
  for (const m of historial) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
    if (!role) continue;
    const content = String(m.content || '').slice(0, MAX_CHARS).trim();
    if (!content) continue;
    out.push({ role, content });
  }
  return out.slice(-MAX_HISTORIAL);
}

/* ---- un turno ----------------------------------------------- */

/**
 * Ejecuta un turno de la demo web.
 *
 * @param {object} client   cliente cargado por lib/wa/clients.js
 * @param {object} entrada  {mensaje, historial}
 * @returns {Promise<{respuesta, historial, leads, escalamientos, busquedas, limite}>}
 */
async function turno(client, entrada = {}) {
  const mensaje = String(entrada.mensaje || '').slice(0, MAX_CHARS).trim();
  if (!mensaje) throw Object.assign(new Error('mensaje vacío'), { code: 'mensaje_vacio' });

  const historial = sanearHistorial(entrada.historial);
  const turnosUsuario = historial.filter((m) => m.role === 'user').length;
  if (turnosUsuario >= MAX_TURNOS) {
    return {
      respuesta: client.mensaje_cierre,
      historial: historial.concat([
        { role: 'user', content: mensaje },
        { role: 'assistant', content: client.mensaje_cierre },
      ]),
      leads: [], escalamientos: [], busquedas: [], limite: true,
    };
  }

  const primerMensaje = historial.length === 0;
  // perfil: null a propósito. El "cliente conocido" del agente de WhatsApp se
  // apoya en Redis, y la demo web no tiene identidad persistente.
  const system = clientsLib.systemPrompt(client, { primerMensaje, perfil: null });

  const messages = [{ role: 'system', content: system }]
    .concat(historial)
    .concat([{ role: 'user', content: mensaje }]);

  const estado = { leads: [], escalamientos: [], busquedas: [] };
  let finalText = '';

  const iterar = async () => {
    const data = await agent.openaiChat(messages, { tools: TOOLS, model: DEMO_MODEL });
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
      const result = await dispatch(client, estado, tc.function.name, args);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
    return true;
  };

  for (let i = 0; i < MAX_TOOL_ITERS; i += 1) {
    if (!await iterar()) break;
  }

  /*
   * Guardarraíl doble. En una demo delante del cliente, un asistente que
   * promete "se lo paso al equipo" y no marca nada es peor que uno que no
   * promete: en producción el prospecto se queda esperando a nadie.
   *
   * 1) Promesa detectada en el texto. Se busca la MENCIÓN al equipo por un
   *    lado y el verbo de traspaso por otro, sin exigir que vayan juntos ni
   *    en un orden: "El precio lo da el equipo comercial. Se lo paso para
   *    que se lo coticen" tiene las dos mitades en frases distintas, y la
   *    versión anterior —que pedía verbo + 'equipo' a menos de 60 caracteres—
   *    la dejaba pasar.
   *
   * 2) Tema que SIEMPRE escala aunque el modelo no prometa nada. Precio,
   *    descuento, stock, crédito y cobertura concreta son justamente los
   *    datos que no tenemos: si contestó sin marcar, hay que marcarlo.
   */
  const MENCIONA_EQUIPO = /\b(equipo comercial|equipo de ventas|área comercial|un vendedor|el vendedor|nuestro equipo|el equipo)\b/i;
  // Raíces, no conjugaciones. Enumerar formas ("se lo paso", "he pasado") dejaba
  // escapar "voy a pasar tu información", que es exactamente la misma promesa.
  const VERBO_TRASPASO = /\b(pas[aoeáé]|pasar|compart|canaliz|traslad|turn[aoe]|report|deriv|escal|coticen|contacten|confirmen|confirman)[a-záéíóúñ]*/i;
  const TEMA_ESCALABLE = /\b(precio|precios|costo|cuesta|cuánto vale|cotiza|tarifa|mayoreo|descuento|promoci|crédito|credito|plazo|stock|existencia|disponibilidad|inventario|envían|envian|env[ií]o|cobertura|export|distribuy[ea]n a|llegan a)\b/i;

  const prometio = MENCIONA_EQUIPO.test(finalText) && VERBO_TRASPASO.test(finalText);
  const temaCaliente = TEMA_ESCALABLE.test(mensaje);
  const sinMarcar = !estado.escalamientos.length && !estado.leads.length;

  if ((prometio || temaCaliente) && sinMarcar) {
    const motivo = prometio ? 'prometió pasar al equipo' : 'tema que siempre escala';
    console.warn('[demo] %s sin marcarlo. cliente=%s', motivo, client.clave);
    messages.push({
      role: 'system',
      content: prometio
        ? 'ALTO: le dijiste que se lo pasarías al equipo comercial, pero no llamaste ni a ' +
          'escalar_humano ni a registrar_lead, así que no quedó marcado en ningún lado. ' +
          'Llama AHORA a la herramienta que corresponda explicando exactamente qué pidió, ' +
          'y vuelve a escribir tu respuesta.'
        : 'ALTO: te preguntaron por un tema que SIEMPRE tiene que llegar a una persona ' +
          '(precio, descuento, crédito, disponibilidad o cobertura concreta) y no llamaste ' +
          'ni a escalar_humano ni a registrar_lead. Llama AHORA a la que corresponda ' +
          'explicando exactamente qué pidió, y vuelve a escribir tu respuesta sin inventar ' +
          'el dato que falta.',
    });
    for (let i = 0; i < 3; i += 1) {
      if (!await iterar()) break;
    }
  }

  if (!finalText) finalText = '¿Me lo repite, por favor? No alcancé a entenderle.';

  return {
    respuesta: finalText,
    historial: historial.concat([
      { role: 'user', content: mensaje },
      { role: 'assistant', content: finalText },
    ]).slice(-MAX_HISTORIAL),
    leads: estado.leads,
    escalamientos: estado.escalamientos,
    busquedas: estado.busquedas,
    limite: false,
  };
}

/* ---- catálogo para la landing -------------------------------- */

/**
 * Proyección del catálogo pensada para pintarlo: categorías -> productos, con
 * la imagen local que acompaña a cada uno. La landing la consume por HTTP en
 * vez de duplicar el JSON, para que el chat y la vitrina no se puedan
 * desincronizar: si el catálogo cambia, cambian los dos a la vez.
 *
 * `_imagen` es un campo interno (el prefijo `_` hace que catalog.publicFields
 * lo esconda del modelo): al agente no le sirve una ruta de archivo.
 */
function vitrina(client, base) {
  // Rutas ABSOLUTAS, no relativas. En providencia.thehagentic.com el
  // middleware no toca las rutas con extensión, así que un `assets/…`
  // relativo se pediría a la raíz del subdominio y daría 404. Con el
  // prefijo de config.json la petición cae directamente en el archivo.
  const raiz = base || client.base_web || '';
  const cat = client.catalogo || {};
  const categorias = [];
  for (const [nombre, subs] of Object.entries(cat.categorias || {})) {
    const productos = [];
    let descripcion = '';
    for (const body of Object.values(subs || {})) {
      if (!body || typeof body !== 'object') continue;
      if (!descripcion && body.descripcion) descripcion = body.descripcion;
      for (const item of body.items || []) {
        productos.push({
          nombre: item.nombre,
          descripcion: item.descripcion || '',
          presentaciones: item.presentaciones || [],
          imagen: item._imagen ? raiz + 'assets/img/producto/' + item._imagen : null,
        });
      }
    }
    categorias.push({
      clave: nombre,
      nombre: nombre.replace(/_/g, ' '),
      descripcion,
      imagen: `${raiz}assets/img/categoria/${nombre}.webp`,
      productos,
    });
  }
  return {
    negocio: cat.negocio || client.nombre,
    ubicacion: cat.ubicacion || '',
    direccion: cat.direccion || '',
    telefonos: cat.tel_llamadas || '',
    email: cat.email || '',
    horarios: cat.horarios || {},
    empresa: cat.empresa || {},
    aviso_precios: cat.notas_precios || '',
    categorias,
    total_productos: categorias.reduce((n, c) => n + c.productos.length, 0),
  };
}

module.exports = {
  turno, vitrina, sanearHistorial, limpiarLead, completitud, dispatch,
  TOOLS, DEMO_MODEL, MAX_TURNOS, MAX_HISTORIAL, MAX_CHARS, CAMPOS_LEAD,
  CLIENTS_DIR: path.join(__dirname, 'clients'),
};
