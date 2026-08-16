/* ============================================================
   Formatos interactivos de WhatsApp, encapsulados.

   El resto del código no sabe si el proveedor admite botones. Pide "manda
   estas tres opciones" y este adaptador decide: botones de respuesta, lista
   interactiva, imagen con pie, o texto plano.

   **Toda pantalla tiene su versión en texto.** Y no es un adorno: hace falta
   para el modo simulado, para proveedores que no soporten un formato, y para
   cuando Graph rechaza el interactivo. Si el fallback no existiera, un fallo
   de formato dejaría a la tienda sin respuesta.

   Límites de Meta que no se pueden negociar, y por eso se recortan aquí en
   vez de dejar que la API devuelva 400:
     - 3 botones de respuesta como máximo, título ≤ 20 caracteres
     - lista: ≤ 10 filas por sección, título de fila ≤ 24, descripción ≤ 72
     - cuerpo ≤ 1024, pie de imagen ≤ 1024
   ============================================================ */

const wa = require('../wa/whatsapp');

/** Interactivos activados salvo que se apaguen a propósito. */
const INTERACTIVO = process.env.CHACON_WA_INTERACTIVO !== '0';

/**
 * Recorta al límite de Meta SIN aplastar los saltos de línea: la ficha de un
 * producto tiene su formato en varias líneas y colapsarlas la vuelve
 * ilegible. Solo se normalizan espacios y tabuladores dentro de cada línea.
 */
const corta = (s, n) => {
  const t = String(s == null ? '' : s)
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trimEnd()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

/** Para títulos de botón y de fila, donde un salto de línea no cabe. */
const unaLinea = (s, n) => corta(String(s == null ? '' : s).replace(/\s+/g, ' '), n);

/* ---- construcción de payloads ------------------------------------------ */
/** Hasta 3 botones. Con más, Meta rechaza el mensaje: se pasa a lista. */
function botones(texto, opciones, { pie = null } = {}) {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: corta(texto, 1024) },
      ...(pie ? { footer: { text: unaLinea(pie, 60) } } : {}),
      action: {
        buttons: opciones.slice(0, 3).map((o) => ({
          type: 'reply',
          reply: { id: unaLinea(o.id, 256), title: unaLinea(o.titulo, 20) },
        })),
      },
    },
  };
}

function lista(texto, { boton = 'Ver', secciones = [], pie = null, encabezado = null }) {
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      ...(encabezado ? { header: { type: 'text', text: unaLinea(encabezado, 60) } } : {}),
      body: { text: corta(texto, 1024) },
      ...(pie ? { footer: { text: unaLinea(pie, 60) } } : {}),
      action: {
        button: unaLinea(boton, 20),
        sections: secciones.map((s) => ({
          title: unaLinea(s.titulo, 24),
          rows: s.filas.slice(0, 10).map((f) => ({
            id: unaLinea(f.id, 200),
            title: unaLinea(f.titulo, 24),
            ...(f.descripcion ? { description: unaLinea(f.descripcion, 72) } : {}),
          })),
        })),
      },
    },
  };
}

function imagen(url, pie) {
  return { type: 'image', image: { link: url, caption: corta(pie, 1024) } };
}

const texto = (t) => ({ type: 'text', text: { body: corta(t, 4096) } });

/* ---- versión textual de cada pantalla ---------------------------------- */
/**
 * Lo mismo, escrito. Se usa cuando no hay interactivos y como registro de lo
 * que se enseñó, para poder reproducir una conversación en el simulador.
 */
function aTexto(mensaje) {
  if (mensaje.type === 'text') return mensaje.text.body;
  if (mensaje.type === 'image') return mensaje.image.caption;
  const i = mensaje.interactive;
  const L = [];
  if (i.header?.text) L.push(i.header.text);
  L.push(i.body.text);
  if (i.type === 'button') {
    i.action.buttons.forEach((b, n) => L.push(`${n + 1}. ${b.reply.title}`));
  } else {
    for (const s of i.action.sections) {
      if (s.title) L.push(`— ${s.title} —`);
      s.rows.forEach((f, n) => L.push(`${n + 1}. ${f.title}${f.description ? ` · ${f.description}` : ''}`));
    }
  }
  if (i.footer?.text) L.push(i.footer.text);
  return L.join('\n');
}

/* ---- pantallas concretas ------------------------------------------------ */
/** Los tres accesos rápidos del saludo. Ayudas, no un menú obligatorio. */
function accesosRapidos(saludo) {
  return botones(saludo, [
    { id: 'repetir_pedido', titulo: 'Repetir pedido' },
    { id: 'ver_catalogo', titulo: 'Ver catálogo' },
    { id: 'precios_ofertas', titulo: 'Precios y ofertas' },
  ], { pie: 'También puedes escribirme o mandarme un audio' });
}

/** Las familias, como lista desplegable. */
function menuCategorias(cats, { encabezado = 'Catálogo' } = {}) {
  return lista('¿Qué familia quieres ver?', {
    encabezado,
    boton: 'Ver familias',
    secciones: [{
      titulo: 'Familias',
      filas: cats.map((c) => ({
        id: `cat:${c.clave}`,
        titulo: c.nombre,
        descripcion: `${c.productos} producto${c.productos === 1 ? '' : 's'}`,
      })),
    }],
    pie: 'O dime directamente qué buscas',
  });
}

/**
 * Una página de productos: una imagen por producto cuando está verificada, y
 * al final las acciones. Nunca se mandan 20 imágenes de golpe porque la
 * página ya viene limitada a 4-5.
 */
function paginaDeProductos(pagina, { titulo = null } = {}) {
  const mensajes = [];
  if (titulo) mensajes.push(texto(titulo));

  for (const p of pagina.productos) {
    if (p.imagen_url) mensajes.push(imagen(p.imagen_url, p.texto));
    else mensajes.push(texto(p.texto));
  }

  const acciones = [];
  if (pagina.hay_mas) acciones.push({ id: 'ver_mas', titulo: 'Ver más' });
  acciones.push({ id: 'ver_catalogo', titulo: 'Otras familias' });
  acciones.push({ id: 'ver_carrito', titulo: 'Ver pedido' });

  const pie = pagina.hay_mas
    ? `Te enseño ${pagina.mostrados} de ${pagina.total}. ${pagina.pista}`
    : pagina.pista;
  mensajes.push(botones(pie, acciones));
  return mensajes;
}

/* ---- envío -------------------------------------------------------------- */
/**
 * Manda una pantalla. Si el interactivo falla —proveedor que no lo soporta,
 * formato rechazado— reintenta en texto: peor presentación es mejor que
 * silencio.
 */
async function enviar(cliente, destino, mensajes) {
  const cola = Array.isArray(mensajes) ? mensajes : [mensajes];
  const enviados = [];

  for (const m of cola) {
    if (!INTERACTIVO && m.type !== 'text') {
      const r = await wa.sendTextDetailed(cliente, destino, aTexto(m));
      enviados.push({ tipo: 'text', simplificado: true, ok: r.ok, wamid: r.wamid || null });
      continue;
    }
    const r = await enviarCrudo(cliente, destino, m);
    if (r.ok) { enviados.push({ tipo: m.type, ok: true, wamid: r.wamid || null }); continue; }

    console.warn('[chacon][wa] %s rechazado (%s): se reenvía como texto', m.type, r.status);
    const alt = await wa.sendTextDetailed(cliente, destino, aTexto(m));
    enviados.push({ tipo: 'text', degradado_desde: m.type, ok: alt.ok, wamid: alt.wamid || null });
  }
  return enviados;
}

/** POST directo a Graph para los tipos que `lib/wa/whatsapp.js` no cubre. */
async function enviarCrudo(cliente, destino, mensaje) {
  if (mensaje.type === 'text') return wa.sendTextDetailed(cliente, destino, mensaje.text.body);

  const pnid = cliente.phone_number_id || process.env.CHACON_PHONE_NUMBER_ID
    || process.env.WHATSAPP_PHONE_NUMBER_ID || '';
  const tok = wa.token();
  if (!tok || !pnid) return { ok: false, status: 0, detail: 'sin token o phone_number_id' };

  const r = await fetch(`${wa.GRAPH}/${pnid}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: wa.normalizarDestino(destino),
      ...mensaje,
    }),
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => '')).slice(0, 400);
    return { ok: false, status: r.status, detail };
  }
  const j = await r.json().catch(() => null);
  return { ok: true, status: r.status, wamid: j?.messages?.[0]?.id || null };
}

/**
 * Un clic se traduce a la misma frase que habría escrito la tienda.
 *
 * Así clic, texto y audio entran por el MISMO motor de intenciones: no hay
 * un camino "de botones" que pueda comportarse distinto del escrito, ni que
 * haya que volver a probar por separado.
 */
function textoDeId(id, { categorias = [] } = {}) {
  if (!id) return null;
  if (id.startsWith('cat:')) {
    const clave = id.slice(4);
    const c = categorias.find((x) => x.clave === clave);
    return c ? c.nombre : clave.replace(/_/g, ' ');
  }
  const FRASES = {
    repetir_pedido: 'repite mi último pedido',
    ver_catalogo: 'quiero ver el catálogo',
    precios_ofertas: 'precios y ofertas',
    ver_mas: 'enséñame más',
    ver_carrito: 'quiero revisar mi pedido',
  };
  return FRASES[id] || id.replace(/_/g, ' ');
}

/** Lo que pulsó la tienda, venga de botón o de lista. */
function idPulsado(m) {
  const i = m && m.interactive;
  if (!i) return null;
  if (i.type === 'button_reply') return i.button_reply?.id || null;
  if (i.type === 'list_reply') return i.list_reply?.id || null;
  return null;
}

module.exports = {
  botones, lista, imagen, texto, aTexto, enviar, enviarCrudo, idPulsado, textoDeId,
  unaLinea,
  accesosRapidos, menuCategorias, paginaDeProductos, INTERACTIVO, corta,
};
