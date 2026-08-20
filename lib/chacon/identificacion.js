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

   **Por defecto solo se atiende a clientes ya existentes.** Vender a una
   cuenta inventada es peor que no vender, así que el comportamiento seguro
   es el que manda en el código.

   Para la demo hay una excepción explícita: con `CHACON_ALTA_LIBRE=1`, un
   negocio que no esté en la lista se da de alta al vuelo y puede seguir
   comprando. Queda marcado con `origen: 'alta_libre_demo'` y en estado
   `pendiente_aprobacion`, para poder distinguir después esas cuentas de las
   reales. En cuanto Chacón entregue su listado, se apaga la variable y las
   altas de demo se revisan una por una.

   Orden de identificación, de más fiable a menos:
     1. el teléfono, que ya identifica a un cliente registrado;
     2. el código de cliente, si lo da;
     3. el nombre, y solo si es inequívoco;
     4. si hay varios parecidos, se pregunta — nunca se elige por el cliente.
   ============================================================ */

const repo = require('./repo');
const agenda = require('./clientes');

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
/**
 * Busca contra la AGENDA oficial de Chacón.
 *
 * Es la única fuente de negocios que pueden identificarse solos. Lo que no
 * esté ahí no es cliente, y ni el modelo ni este módulo pueden inventarle un
 * código.
 */
function enAgenda(texto) {
  const r = agenda.buscar(texto);
  if (r.tipo === 'exacto' || r.tipo === 'probable') {
    return { estado: 'encontrado_agenda', cliente_agenda: r.cliente,
             confianza: r.tipo, otros: r.otros || [] };
  }
  if (r.tipo === 'varios') {
    return { estado: 'ambiguo_agenda', candidatos: r.candidatos };
  }
  return { estado: 'no_en_agenda', motivo: r.motivo || null };
}

/**
 * Crea o actualiza la ficha interna a partir de un cliente de la agenda, y le
 * ata el teléfono.
 *
 * El vínculo se hace contra `customer_code` (+ centro), **nunca** contra la
 * fila del Excel: así una agenda nueva no rompe los vínculos existentes.
 */
async function vincular(clienteAgenda, telefono, { center = null, estadoCentro = null } = {}) {
  const existentes = await repo.listarClientes();
  let ficha = existentes.find((c) => c.customer_code === clienteAgenda.customer_code);

  if (!ficha) {
    ficha = await repo.crearCliente({
      nombre: clienteAgenda.display_name || clienteAgenda.legal_name, telefono });
  }
  ficha.customer_code = clienteAgenda.customer_code;
  ficha.customer_center = center;
  ficha.center_status = estadoCentro || (center ? 'confirmado' : 'sin_resolver');
  ficha.legal_name = clienteAgenda.legal_name;
  ficha.display_name = clienteAgenda.display_name || clienteAgenda.legal_name;
  ficha.nombre = ficha.display_name;
  ficha.estado = 'verificado';               // está en la agenda oficial
  ficha.link_status = 'confirmed';
  ficha.link_source = 'whatsapp_self_identification';
  ficha.linked_at = new Date().toISOString();
  ficha.agenda_version = agenda.versionActiva();
  if (!(ficha.telefonos || []).includes(telefono)) {
    ficha.telefonos = [...(ficha.telefonos || []), telefono];
  }
  await repo.guardarCliente(ficha);
  console.log('[chacon][evento] customer_linked tel=%s code=%s center=%j version=%s',
    telefono, ficha.customer_code, center, ficha.agenda_version);
  return ficha;
}

async function porNombre(nombre) {
  const n = norm(nombre);
  if (!n) return { estado: 'no_encontrado', candidatos: [] };

  const todos = await repo.listarClientes();

  /* Código de cliente: identifica sin ambigüedad y es lo que Chacón usa
     internamente. Se admite tal cual (`CLI-00001`) o solo el número. */
  const comoCodigo = String(nombre).trim().toUpperCase();
  const porCodigo = todos.filter((c) => {
    const id = String(c.id || '').toUpperCase();
    const externo = String(c.codigo_cliente || '').toUpperCase();
    return id === comoCodigo || externo === comoCodigo
      || (/^\d+$/.test(comoCodigo) && (id.endsWith(comoCodigo.padStart(5, '0'))
        || externo === comoCodigo));
  });
  if (porCodigo.length === 1) {
    return { estado: 'encontrado', cliente: porCodigo[0], por: 'codigo_cliente' };
  }
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

/** Para la demo: cualquier nombre entra. Fuera de la demo, nadie entra solo. */
const altaLibre = () => process.env.CHACON_ALTA_LIBRE === '1';

/**
 * Da de alta una tienda con el nombre que dio. Solo en modo demo.
 * Queda `pendiente_aprobacion` y marcada como alta de demo: dar de alta no
 * es aprobar, y estas cuentas hay que repasarlas contra el listado real.
 */
async function registrar(nombre, telefono) {
  const c = await repo.crearCliente({ nombre, telefono });
  c.origen = 'alta_libre_demo';
  await repo.guardarCliente(c);
  return c;
}

module.exports = {
  nombreDeNegocio, porNombre, porTelefono, registrar, altaLibre, norm, PREFIJOS,
  enAgenda, vincular,
};
