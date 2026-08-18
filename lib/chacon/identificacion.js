/* ============================================================
   Identificar la tienda que escribe.

   Bug real de producción que origina este módulo: el agente preguntaba
   "¿cómo se llama tu tienda?", el cliente contestaba "tony tienda" y esa
   respuesta acababa en el buscador de productos, que contestaba "no he
   encontrado «tony tienda»". La pregunta la hacía un componente y la
   respuesta la recogía otro.

   La regla que lo evita, y que no depende del prompt: **mientras haya un
   slot pendiente, el estado manda sobre el enrutado genérico.** Con
   `CUSTOMER_IDENTIFICATION` activo, lo que llega es un nombre de negocio y
   no se toca el catálogo.

   Orden de identificación, de más fiable a menos:
     1. el teléfono, que ya identifica a un cliente registrado;
     2. el nombre, y solo si es inequívoco;
     3. si hay varios parecidos, se pregunta — nunca se elige por el cliente.
   ============================================================ */

const repo = require('./repo');

/* Muletillas con las que la gente contesta a "¿cómo se llama tu negocio?".
   Se recortan para quedarse con el nombre: "el nombre de mi tienda es Tony
   Tienda" -> "Tony Tienda". */
const PREFIJOS = [
  /^\s*(?:el\s+)?nombre\s+(?:de\s+)?(?:mi|la|el)?\s*(?:tienda|negocio|empresa|comercio)\s*(?:es|se\s+llama)?\s*[:,-]?\s*/i,
  /^\s*(?:mi|la|el)\s+(?:tienda|negocio|empresa|comercio)\s*(?:es|se\s+llama)\s*[:,-]?\s*/i,
  /^\s*(?:somos|soy|se\s+llama|es)\s+/i,
  /^\s*(?:me\s+llamo|nos\s+llamamos)\s+/i,
  /^\s*(?:la\s+)?(?:tienda|negocio|empresa)\s*[:,-]\s*/i,
];

const SOBRAN = /[.!¡?¿]+\s*$/;

/**
 * Saca el nombre del negocio de una frase.
 * Devuelve null si lo que queda no parece un nombre.
 */
function nombreDeNegocio(texto) {
  let t = String(texto || '').trim();
  if (!t) return null;

  let cambiado = true;
  while (cambiado) {
    cambiado = false;
    for (const re of PREFIJOS) {
      const antes = t;
      t = t.replace(re, '');
      if (t !== antes) { cambiado = true; break; }
    }
  }
  t = t.replace(SOBRAN, '').replace(/\s+/g, ' ').trim();

  // Un nombre de negocio no es una sola letra ni una parrafada.
  if (t.length < 2 || t.length > 80) return null;
  // Ni un número suelto: eso sería un código, y aquí no se piden códigos.
  if (/^\d+$/.test(t)) return null;
  return t;
}

/** Normaliza para comparar nombres sin acentos ni mayúsculas. */
const norm = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Resuelve un cliente por nombre.
 *
 * Nunca se asigna por parecido flojo: una coincidencia dudosa metería el
 * pedido de una tienda en la cuenta de otra.
 */
async function porNombre(nombre) {
  const n = norm(nombre);
  if (!n) return { estado: 'no_encontrado', candidatos: [] };

  const todos = await repo.listarClientes();
  const exactos = todos.filter((c) => norm(c.nombre) === n);
  if (exactos.length === 1) return { estado: 'encontrado', cliente: exactos[0] };
  if (exactos.length > 1) return { estado: 'ambiguo', candidatos: exactos };

  // Contención: uno contiene al otro. Sigue exigiendo unicidad.
  const parecidos = todos.filter((c) => {
    const cn = norm(c.nombre);
    return cn.includes(n) || n.includes(cn);
  });
  if (parecidos.length === 1) return { estado: 'encontrado', cliente: parecidos[0] };
  if (parecidos.length > 1) return { estado: 'ambiguo', candidatos: parecidos.slice(0, 5) };

  return { estado: 'no_encontrado', candidatos: [] };
}

/** El teléfono es la vía fiable: si ya está registrado, no se pregunta nada. */
async function porTelefono(telefono) {
  const c = await repo.clientePorTelefono(telefono);
  return c ? { estado: 'encontrado', cliente: c, por: 'telefono' } : { estado: 'desconocido' };
}

/**
 * Da de alta la tienda con el nombre que dio, asociada a su teléfono.
 * Queda pendiente de aprobación: dar de alta no es aprobar.
 */
async function registrar(nombre, telefono) {
  return repo.crearCliente({ nombre, telefono });
}

module.exports = { nombreDeNegocio, porNombre, porTelefono, registrar, norm, PREFIJOS };
