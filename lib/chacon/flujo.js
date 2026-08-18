/* ============================================================
   El recorrido de compra, paso a paso.

   Aquí se decide QUÉ ve el cliente en cada momento. Tres reglas mandan:

   1. **Nunca se le pide una referencia.** El código es un atajo para quien lo
      sabe, jamás un requisito. Si el agente llega a escribir "dime el código",
      el descubrimiento ha fallado.

   2. **El nombre del producto va primero; el código, pequeño y detrás.** Un
      tendero piensa en "el chorizo cular", no en 6305.

   3. **El cliente no ve nuestra estructura.** Nada de "Tarifa 1", "tramo",
      "duplicado del PDF" ni "motor". Se habla de piezas y cajas, que es lo
      que compra.

   Todo lo crítico —producto, cantidad, precio, confirmación— sale de código
   determinista. El modelo solo traduce frases sueltas a intenciones.
   ============================================================ */

const estados = require('./estados');
const descubrimiento = require('./descubrimiento');
const categorias = require('./categorias');
const imagenes = require('./imagenes');
const ofertas = require('./ofertas');
const tarifas = require('./tarifas');
const pedidoLib = require('./pedido');
const repeticion = require('./repeticion');
const repo = require('./repo');
const formato = require('./wa-formato');

const MAX_OPCIONES = 5;

const eur = (n) => (n === null || n === undefined ? null
  : Number(n).toFixed(3).replace(/0+$/, '').replace(/\.$/, '').replace('.', ','));

/**
 * Nombre legible. El catálogo viene de un ERP en mayúsculas y con marcas
 * entre asteriscos —`CHORIZO CULAR PLATA IB. *MARCIAL*`—, que en WhatsApp
 * además se interpretarían como negrita y romperían el formato.
 */
function bonito(desc) {
  return String(desc || '')
    .replace(/[*_~`]/g, ' ')              // marcas del ERP y formato de WhatsApp
    .replace(/\s+/g, ' ').trim()
    .toLowerCase()
    .replace(/(^|[\s"(/])([a-záéíóúñ0-9])/g, (m, a, b) => a + b.toUpperCase())
    .replace(/\bIb\b\.?/gi, 'Ib.')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+([.,])/g, '$1')
    .trim()
    .slice(0, 70);
}

/** Título corto para una fila de lista (Meta corta en 24). */
const tituloFila = (p) => formato.unaLinea(bonito(p.descripcion), 24);

/** Cómo se nombra un producto en un mensaje: nombre y, detrás, la marca. */
function nombreCompleto(p) {
  const n = bonito(p.descripcion);
  const m = p.marca ? bonito(p.marca) : null;
  return m && !n.toLowerCase().includes(m.toLowerCase()) ? `${n} — ${m}` : n;
}

/* ---- precios en lenguaje de cliente ------------------------------------- */
/**
 * Precio por pieza y por caja, sin nombrar tarifas.
 *
 * Decisión de UX: "Tarifa 1" y "Tarifa 3" son nuestra contabilidad interna.
 * El cliente compra piezas y cajas, así que eso es lo que ve. Los nombres de
 * tarifa siguen en el panel, los logs y el mensaje a Fernando.
 */
async function preciosDe(producto) {
  const out = { pieza: null, caja: null, oferta_pieza: false, oferta_caja: false };
  if (!tarifas.disponible()) {
    const v = await ofertas.precioVigente(producto);
    out.pieza = v.precio_kg;
    out.oferta_pieza = !!v.es_oferta;
    return out;
  }
  const t1 = tarifas.precioDe(producto.codigo, '1');
  const t3 = tarifas.precioDe(producto.codigo, '3');
  if (t1.encontrado && !t1.promotion_rule_required) {
    out.pieza = t1.aplicado_e4 / tarifas.ESCALA;
    out.oferta_pieza = t1.es_oferta;
    out.normal_pieza = t1.normal_e4 !== null ? t1.normal_e4 / tarifas.ESCALA : null;
  }
  if (t3.encontrado && !t3.promotion_rule_required) {
    out.caja = t3.aplicado_e4 / tarifas.ESCALA;
    out.oferta_caja = t3.es_oferta;
    out.normal_caja = t3.normal_e4 !== null ? t3.normal_e4 / tarifas.ESCALA : null;
  }
  return out;
}

function lineasDePrecio(pr) {
  const L = [];
  if (pr.oferta_pieza && pr.normal_pieza) {
    L.push(`Por pieza: *${eur(pr.pieza)} €/kg* 🔥 oferta (habitual ${eur(pr.normal_pieza)})`);
  } else if (pr.pieza !== null) {
    L.push(`Por pieza: *${eur(pr.pieza)} €/kg*`);
  }
  if (pr.caja !== null && pr.caja !== pr.pieza) {
    L.push(pr.oferta_caja && pr.normal_caja
      ? `Por caja: *${eur(pr.caja)} €/kg* 🔥 oferta (habitual ${eur(pr.normal_caja)})`
      : `Por caja: *${eur(pr.caja)} €/kg*`);
  }
  if (!L.length) L.push('Precio pendiente de confirmar con Chacón Alcántara.');
  else L.push('_Precios sin IVA._');
  return L;
}

/* ---- pantallas ---------------------------------------------------------- */
function home(cliente) {
  const saludo = cliente
    ? `Hola, ${cliente.nombre} 👋\n¿Qué necesitas hoy?`
    : '¡Hola! 👋 Soy el asistente de pedidos de Chacón Alcántara.\n¿Qué necesitas hoy?';
  return [formato.lista(saludo, {
    boton: 'Ver opciones',
    secciones: [{
      titulo: 'Qué quieres hacer',
      filas: [
        { id: 'hacer_pedido', titulo: '🛒 Hacer un pedido' },
        { id: 'repetir_pedido', titulo: '🔁 Repetir mi último' },
        { id: 'precios_ofertas', titulo: '💰 Consultar precios' },
        { id: 'ver_ofertas', titulo: '🔥 Ver ofertas' },
        { id: 'ver_carrito', titulo: '📦 Mi pedido' },
        { id: 'hablar_fernando', titulo: '👤 Hablar con Fernando' },
      ],
    }],
    pie: 'O escríbeme directamente qué necesitas',
  })];
}

function comoEmpezar(hayHabituales) {
  const filas = [];
  if (hayHabituales) filas.push({ id: 'mis_habituales', titulo: '⭐ Mis habituales' });
  filas.push({ id: 'ver_familias', titulo: '🥩 Ver por familias' });
  filas.push({ id: 'ver_ofertas', titulo: '🔥 Ver ofertas' });
  filas.push({ id: 'buscar_producto', titulo: '🔎 Buscar un producto' });
  return [formato.lista('¿Cómo quieres empezar?', {
    boton: 'Elegir', secciones: [{ titulo: 'Empezar por', filas }],
    pie: 'También puedes escribirme el nombre',
  })];
}

function menuFamilias(texto = '¿Qué buscas?') {
  const fams = descubrimiento.familiasSugeridas();
  return [formato.lista(texto, {
    boton: 'Ver familias',
    secciones: [{
      titulo: 'Familias',
      filas: fams.map((f) => ({ id: `fam:${f.clave}`, titulo: f.nombre,
                                descripcion: `${f.productos} productos` })),
    }],
    pie: 'O dime el nombre de lo que buscas',
  })];
}

/** Varios candidatos: se enseñan y se pregunta. Nunca se elige por el cliente. */
function listaDeProductos(productos, { titulo, hayMas = false } = {}) {
  const filas = productos.slice(0, MAX_OPCIONES).map((p) => ({
    id: `prod:${p.codigo}`,
    titulo: tituloFila(p),
    descripcion: formato.unaLinea(
      [p.marca ? bonito(p.marca) : null, `Ref. ${p.codigo}`].filter(Boolean).join(' · '), 72),
  }));
  if (hayMas) filas.push({ id: 'ver_mas', titulo: 'Ver más productos' });
  filas.push({ id: 'ver_familias', titulo: 'Ver otras familias' });
  return [formato.lista(titulo, {
    boton: 'Elegir', secciones: [{ titulo: 'Productos', filas }],
    pie: 'Toca uno o dime cuál',
  })];
}

/** Ficha: foto si está verificada, precio en piezas y cajas, y qué hacer. */
async function fichaProducto(producto) {
  const pr = await preciosDe(producto);
  const L = [`*${nombreCompleto(producto)}*`, ''];
  L.push(...lineasDePrecio(pr));
  L.push('');
  if (Number.isFinite(producto.und_caja) && producto.und_caja > 1) {
    L.push(`Caja de ${producto.und_caja} unidades.`);
  }
  if (Number.isFinite(producto.peso_und_kg) && producto.peso_und_kg > 0) {
    L.push(`Pieza de ${eur(producto.peso_und_kg)} kg aprox.`);
  }
  L.push(`_Ref. ${producto.codigo}_`);

  const texto = L.join('\n');
  const url = imagenes.urlVerificada(producto.id);
  const pantallas = [url ? formato.imagen(url, texto) : formato.texto(texto)];
  pantallas.push(formato.botones('¿Cuánto quieres?', [
    { id: `cant:${producto.codigo}:1:unidad`, titulo: '1 pieza' },
    { id: `cant:${producto.codigo}:1:caja`, titulo: '1 caja' },
    { id: `cant:${producto.codigo}:otra`, titulo: 'Otra cantidad' },
  ]));
  return pantallas;
}

function trasAnadir(linea) {
  const cant = linea.unidad_pedido === 'caja'
    ? `${linea.cantidad} caja${linea.cantidad === 1 ? '' : 's'}`
    : `${linea.cantidad} pieza${linea.cantidad === 1 ? '' : 's'}`;
  const precio = linea.precio_kg_sin_iva !== null && linea.precio_kg_sin_iva !== undefined
    ? `\n${eur(linea.precio_kg_sin_iva)} €/kg${linea.es_oferta ? ' 🔥' : ''}` : '';
  return [formato.botones(
    `✅ Añadido\n\n*${bonito(linea.descripcion)}*\n${cant}${precio}`,
    [{ id: 'anadir_otro', titulo: '➕ Añadir otro' },
     { id: 'ver_carrito', titulo: '🛒 Ver pedido' },
     { id: 'terminar_pedido', titulo: '✅ Terminar' }])];
}

/** Carrito legible. Sin explicar el mecanismo en cada línea. */
async function verCarrito(clienteId) {
  const carrito = await repo.getCarrito(clienteId);
  const lineas = carrito.lineas || [];
  if (!lineas.length) {
    return [formato.botones('Tu pedido está vacío todavía.',
      [{ id: 'hacer_pedido', titulo: '🛒 Empezar pedido' },
       { id: 'ver_ofertas', titulo: '🔥 Ver ofertas' }])];
  }
  const L = ['*Tu pedido*', ''];
  let estimado = 0; let todoEstimable = true;
  lineas.forEach((l, n) => {
    const cant = l.unidad_pedido === 'caja'
      ? `${l.cantidad} caja${l.cantidad === 1 ? '' : 's'}`
      : `${l.cantidad} pieza${l.cantidad === 1 ? '' : 's'}`;
    L.push(`${n + 1}. *${bonito(l.descripcion)}*`);
    if (l.precio_kg_sin_iva !== null && l.precio_kg_sin_iva !== undefined) {
      L.push(`   ${cant} · ${eur(l.precio_kg_sin_iva)} €/kg${l.es_oferta ? ' 🔥' : ''}`);
    } else {
      L.push(`   ${cant} · precio a confirmar`);
      todoEstimable = false;
    }
    if (l.importe_estimado_sin_iva) estimado += l.importe_estimado_sin_iva;
    else todoEstimable = false;
  });
  L.push('');
  if (todoEstimable && estimado > 0) {
    L.push(`*Importe estimado: ${eur(Math.round(estimado * 100) / 100)} € sin IVA*`);
    L.push('_Calculado con pesos teóricos; el final depende del peso real._');
  } else {
    L.push('_El importe final lo confirma Chacón según el peso real._');
  }
  return [formato.texto(L.join('\n')),
    formato.botones('¿Qué hacemos?', [
      { id: 'anadir_otro', titulo: '➕ Añadir producto' },
      { id: 'modificar_carrito', titulo: '✏️ Modificar' },
      { id: 'terminar_pedido', titulo: '✅ Confirmar' }])];
}

/** Elegir qué línea tocar, por nombre. Nadie recuerda "elimina el 6305". */
async function editarCarrito(clienteId) {
  const carrito = await repo.getCarrito(clienteId);
  const lineas = carrito.lineas || [];
  if (!lineas.length) return verCarrito(clienteId);
  return [formato.lista('¿Qué quieres cambiar?', {
    boton: 'Elegir',
    secciones: [{
      titulo: 'Tu pedido',
      filas: lineas.slice(0, 9).map((l) => ({
        id: `edit:${l.codigo}`,
        titulo: tituloFila({ descripcion: l.descripcion }),
        descripcion: `${l.cantidad} ${l.unidad_pedido === 'caja' ? 'caja(s)' : 'pieza(s)'}`,
      })).concat([{ id: 'ver_carrito', titulo: 'Volver al pedido' }]),
    }],
  })];
}

/** Ofertas, con nombre y foto. Nadie descubre una oferta por su código. */
async function verOfertas({ filtro = null } = {}) {
  if (!tarifas.disponible()) {
    return [formato.texto('Ahora mismo no tengo ofertas activas registradas.')];
  }
  let ofs = tarifas.ofertasActivas({ tier: '1' });
  if (filtro) {
    const r = descubrimiento.buscar(filtro);
    const permitidos = new Set(
      (r.tipo === 'producto' ? [r.producto] : (r.candidatos || [])).map((p) => p.codigo));
    if (permitidos.size) ofs = ofs.filter((o) => permitidos.has(o.product_code));
  }
  ofs = ofs.filter((o) => descubrimiento.esComprable(o.product_code));
  if (!ofs.length) {
    return [formato.botones(
      filtro ? `No tengo ofertas de ${filtro} ahora mismo.`
        : 'Ahora mismo no tengo ofertas activas.',
      [{ id: 'ver_familias', titulo: '🥩 Ver familias' },
       { id: 'hacer_pedido', titulo: '🛒 Hacer pedido' }])];
  }
  return [formato.lista(`🔥 Tengo ${ofs.length} producto(s) de oferta`, {
    boton: 'Ver ofertas',
    secciones: [{
      titulo: 'En oferta',
      filas: ofs.slice(0, 9).map((o) => ({
        id: `prod:${o.product_code}`,
        titulo: tituloFila({ descripcion: o.product_name }),
        descripcion: formato.unaLinea(
          `${eur(o.oferta_e4 / tarifas.ESCALA)} €/kg`
          + (o.normal_e4 ? ` (antes ${eur(o.normal_e4 / tarifas.ESCALA)})` : ''), 72),
      })),
    }],
    pie: 'Precios sin IVA',
  })];
}

/** Lo que suele pedir, por nombre. Determinista, del propio histórico. */
async function misHabituales(clienteId) {
  const pedidos = await repo.pedidosDeCliente(clienteId, { limite: 20 });
  const h = descubrimiento.habituales(pedidos, { limite: 8 });
  if (!h.length) {
    return { hay: false, pantallas: [formato.botones(
      'Todavía no tengo pedidos tuyos guardados. Empecemos por aquí:',
      [{ id: 'ver_familias', titulo: '🥩 Ver familias' },
       { id: 'ver_ofertas', titulo: '🔥 Ver ofertas' },
       { id: 'buscar_producto', titulo: '🔎 Buscar' }])] };
  }
  return { hay: true, pantallas: [formato.lista('⭐ Lo que sueles pedir', {
    boton: 'Elegir',
    secciones: [{
      titulo: 'Tus habituales',
      filas: h.map((x) => ({
        id: `prod:${x.producto.codigo}`,
        titulo: tituloFila(x.producto),
        descripcion: `Lo has pedido ${x.veces} ${x.veces === 1 ? 'vez' : 'veces'}`,
      })).concat([{ id: 'ver_familias', titulo: 'Ver todo el catálogo' }]),
    }],
  })] };
}

/* ---- identificación de la tienda ---------------------------------------- */
/** Se pregunta el negocio. Nada de catálogo mientras esto esté abierto. */
function pedirNegocio({ reintento = false } = {}) {
  return [formato.texto(reintento
    ? 'Dime otra vez el nombre, por favor. Puede ser como aparece en tus facturas.'
    : 'Para identificar tu cuenta, ¿cómo se llama tu negocio?')];
}

/**
 * No está registrada. **Solo se sirve a clientes existentes**, así que aquí
 * no hay alta automática: o el nombre estaba mal escrito, o hace falta que
 * Chacón dé de alta la cuenta. Nunca se ofrece el catálogo desde aquí: se
 * está resolviendo identidad, no vendiendo.
 */
function negocioNoEncontrado(nombre) {
  return [formato.botones(
    `No encuentro «${nombre}» entre nuestros clientes.\n`
    + 'Puedes darme el nombre tal y como aparece en tus facturas, o tu código de cliente.',
    [{ id: 'reintentar_negocio', titulo: '✏️ Otro nombre' },
     { id: 'hablar_fernando', titulo: '👤 Avisar a Fernando' }])];
}

/** Varios parecidos: se pregunta. Jamás se elige por parecido. */
function negocioAmbiguo(candidatos) {
  return [formato.lista('He encontrado varios negocios parecidos. ¿Cuál es el tuyo?', {
    boton: 'Elegir',
    secciones: [{
      titulo: 'Negocios',
      filas: candidatos.slice(0, 9).map((c) => ({
        id: `cli:${c.id}`, titulo: formato.unaLinea(c.nombre, 24),
        descripcion: formato.unaLinea(c.direccion || c.id, 72),
      })).concat([{ id: 'reintentar_negocio', titulo: 'Ninguno de estos' }]),
    }],
  })];
}

function escalarAFernando(motivo) {
  return [formato.texto(
    'Te paso con Fernando, del equipo de Chacón Alcántara, que te lo resuelve enseguida.'
    + (motivo ? `\n\n_Motivo: ${motivo}_` : ''))];
}

module.exports = {
  home, comoEmpezar, menuFamilias, listaDeProductos, fichaProducto, trasAnadir,
  pedirNegocio, negocioNoEncontrado, negocioAmbiguo,
  verCarrito, editarCarrito, verOfertas, misHabituales, escalarAFernando,
  preciosDe, lineasDePrecio, nombreCompleto, bonito, tituloFila, eur, MAX_OPCIONES,
};
