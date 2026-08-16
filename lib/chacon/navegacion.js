/* ============================================================
   Recorrer el catálogo por familias, y recordar lo que se ha enseñado.

   Dos cosas que parecen detalles y no lo son:

   1. **Paginar.** Se enseñan 4-5 productos por vez. Treinta fichas de golpe
      en WhatsApp no se pueden leer ni deshacer, y con foto es peor: son
      treinta mensajes.

   2. **Recordar.** Sin memoria de lo mostrado, "ponme dos del segundo" no se
      puede resolver sin adivinar. Y adivinar un producto en un pedido
      mayorista es un pedido mal servido. Aquí una referencia posicional se
      convierte SIEMPRE en un código real antes de tocar el carrito; si no se
      puede, se pregunta.
   ============================================================ */

const repo = require('./repo');
const catalogo = require('./catalogo');
const categorias = require('./categorias');
const imagenes = require('./imagenes');

const ORDINALES = {
  primero: 1, primera: 1, uno: 1, '1o': 1, '1º': 1, '1ª': 1,
  segundo: 2, segunda: 2, dos: 2, '2o': 2, '2º': 2, '2ª': 2,
  tercero: 3, tercera: 3, tres: 3, '3o': 3, '3º': 3, '3ª': 3,
  cuarto: 4, cuarta: 4, cuatro: 4, '4o': 4, '4º': 4, '4ª': 4,
  quinto: 5, quinta: 5, cinco: 5, '5o': 5, '5º': 5, '5ª': 5,
  ultimo: -1, ultima: -1,
};

const norm = categorias.norm;

/* ---- listado de familias ------------------------------------------------ */
function listarCategorias() {
  return categorias.categorias().map((c) => ({
    clave: c.clave,
    nombre: c.nombre,
    productos: categorias.productosDe(c.clave).length,
  })).filter((c) => c.productos > 0);
}

/* ---- una página de productos -------------------------------------------- */
/**
 * Resuelve qué hay que enseñar y devuelve una página, ya con las fichas
 * redactadas y las fotos que SE PUEDEN mandar (solo `verified`).
 */
async function mostrar(telefono, { consulta = null, vista = null, offset = 0 } = {}) {
  // Lo que alguien haya corregido a mano manda sobre la propuesta automática.
  await categorias.aplicarCorrecciones(repo).catch(() => {});
  let destino = vista;
  let sugerencia = false;

  if (!destino && consulta) {
    const i = categorias.interpretar(consulta);
    if (i.tipo === 'ninguno') {
      return { ok: false, error: 'no_reconocido',
               categorias: listarCategorias(),
               nota: 'No he reconocido ninguna familia. Ofrece la lista de categorías.' };
    }
    destino = { tipo: i.tipo, clave: i.clave, nombre: i.nombre };
    sugerencia = !!i.sugerencia;
  }
  if (!destino) return { ok: false, error: 'sin_destino', categorias: listarCategorias() };

  let lista = [];
  if (destino.tipo === 'categoria') lista = categorias.productosDe(destino.clave);
  else if (destino.tipo === 'subcategoria') lista = categorias.productosDeSubcategoria(destino.clave);
  else if (destino.tipo === 'etiqueta') lista = categorias.productosConEtiqueta(destino.clave);
  else if (destino.tipo === 'mas_barato') {
    lista = (await categorias.masBaratos(50)).map((x) => ({
      producto: x.producto, clasificacion: x.clasificacion }));
  }

  if (!lista.length) {
    return { ok: false, error: 'familia_vacia', vista: destino,
             categorias: listarCategorias(),
             nota: 'No hay productos activos en esa familia. No inventes ninguno.' };
  }

  const pag = categorias.pagina(lista, offset);
  const items = [];
  for (const it of pag.items) {
    const ficha = await categorias.fichaDe(it);
    ficha.imagen_url = imagenes.urlVerificada(it.producto.id);
    ficha.imagen_omitida = ficha.imagen_url ? null : imagenes.motivoSinFoto(it.producto.id);
    items.push(ficha);
  }

  // Se recuerda lo enseñado para poder resolver "el segundo" después.
  const ctx = await repo.getContexto(telefono);
  ctx.mostrados = items.map((f) => ({ codigo: f.codigo, producto_id: f.producto_id,
                                      descripcion: f.descripcion }));
  ctx.vista = destino;
  ctx.offset = pag.offset;
  ctx.siguiente_offset = pag.siguiente_offset;
  await repo.guardarContexto(ctx);

  return {
    ok: true,
    vista: destino,
    es_sugerencia: sugerencia,
    nota_sugerencia: sugerencia
      ? 'Esto es una SUGERENCIA tuya, no una familia del catálogo. Dilo así: '
        + '"te propongo…", y ofrece ver las categorías si no era eso.'
      : null,
    productos: items,
    mostrados: pag.mostrados,
    total: pag.total,
    hay_mas: pag.hay_mas,
    siguiente_offset: pag.siguiente_offset,
    pista: categorias.PISTA_DE_USO,
    nota: 'Enseña estos productos con su texto tal cual. Solo se pueden enviar las '
      + 'fotos con `imagen_url`; si es null, ese producto va solo con texto.',
  };
}

/** Siguiente página de lo último que se enseñó. */
async function mas(telefono) {
  const ctx = await repo.getContexto(telefono);
  if (!ctx.vista) {
    return { ok: false, error: 'sin_vista_previa',
             categorias: listarCategorias(),
             nota: 'Todavía no le has enseñado ninguna familia. Ofrécele las categorías.' };
  }
  return mostrar(telefono, { vista: ctx.vista, offset: ctx.siguiente_offset || 0 });
}

/* ---- referencias a lo mostrado ------------------------------------------ */
/**
 * Convierte "el segundo", "el 0052" o "el chorizo de pincho" en un producto
 * real. Devuelve `{ ok:false, pregunta }` si queda cualquier duda: no se
 * añade nada al carrito por una referencia ambigua.
 */
async function resolverReferencia(telefono, texto) {
  const q = norm(texto);
  const ctx = await repo.getContexto(telefono);
  const mostrados = ctx.mostrados || [];

  // 1. Un código explícito gana sobre todo lo demás.
  const porCodigo = (texto.match(/\b[0-9A-Za-z]{3,8}\b/g) || [])
    .map((t) => catalogo.todos().find((p) => p.codigo.toLowerCase() === t.toLowerCase()))
    .filter(Boolean);
  if (porCodigo.length === 1) {
    return { ok: true, producto_id: porCodigo[0].id, codigo: porCodigo[0].codigo,
             descripcion: porCodigo[0].descripcion, por: 'codigo_explicito' };
  }

  // 2. Referencia posicional a lo que se acaba de enseñar.
  let pos = null;
  for (const [palabra, n] of Object.entries(ORDINALES)) {
    if (new RegExp(`\\b${palabra}\\b`).test(q)) { pos = n; break; }
  }
  if (pos !== null) {
    if (!mostrados.length) {
      return { ok: false, error: 'sin_contexto',
               pregunta: '¿De cuál me hablas? Dime el código o el nombre del producto.' };
    }
    const idx = pos === -1 ? mostrados.length - 1 : pos - 1;
    const m = mostrados[idx];
    if (!m) {
      return { ok: false, error: 'fuera_de_rango',
               pregunta: `Solo te he enseñado ${mostrados.length} productos. ¿Cuál de ellos?` };
    }
    // Aunque haya contexto, se confirma: una posición mal contada es un
    // producto equivocado en el pedido.
    return { ok: true, producto_id: m.producto_id, codigo: m.codigo,
             descripcion: m.descripcion, por: 'posicion',
             confirmar: `¿Te refieres al código ${m.codigo}, ${m.descripcion}?` };
  }

  // 3. "ese", "eso", "el de la foto": solo vale si enseñamos UNO.
  if (/\b(ese|esa|eso|este|esta|el de la foto|la de la foto|el anterior)\b/.test(q)) {
    if (mostrados.length === 1) {
      const m = mostrados[0];
      return { ok: true, producto_id: m.producto_id, codigo: m.codigo,
               descripcion: m.descripcion, por: 'unico_mostrado' };
    }
    return { ok: false, error: 'referencia_ambigua',
             candidatos: mostrados,
             pregunta: 'Te he enseñado varios. ¿Cuál de ellos? Dime el código o la posición.' };
  }

  // 4. Por nombre, primero entre lo mostrado y luego en todo el catálogo.
  const entreMostrados = mostrados.filter((m) => norm(m.descripcion).includes(q) && q.length >= 4);
  if (entreMostrados.length === 1) {
    const m = entreMostrados[0];
    return { ok: true, producto_id: m.producto_id, codigo: m.codigo,
             descripcion: m.descripcion, por: 'nombre_entre_mostrados' };
  }
  const busqueda = catalogo.buscar(texto);
  if (busqueda.candidatos.length === 1) {
    const p = busqueda.candidatos[0];
    return { ok: true, producto_id: p.id, codigo: p.codigo, descripcion: p.descripcion,
             por: 'busqueda_unica' };
  }
  if (busqueda.candidatos.length > 1) {
    return { ok: false, error: 'varios_candidatos',
             candidatos: busqueda.candidatos.slice(0, 5).map((p) => ({
               producto_id: p.id, codigo: p.codigo, descripcion: p.descripcion })),
             pregunta: '¿Cuál de estos es? Dime el código.' };
  }
  return { ok: false, error: 'no_encontrado',
           pregunta: 'No he encontrado ese producto. ¿Me dices el código o el nombre completo?' };
}

module.exports = { listarCategorias, mostrar, mas, resolverReferencia, ORDINALES };
