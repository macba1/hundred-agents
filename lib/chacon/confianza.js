/* ============================================================
   ¿De verdad escribe quien dice ser?

   El agente identifica a la tienda por lo que ella misma cuenta: su nombre o
   su código de cliente. Ninguna de las dos cosas es secreta —el nombre está
   en el rótulo y el código sale impreso en cada albarán—, así que cualquiera
   que las conozca puede escribir desde un teléfono nuevo y pedir en nombre
   de otro. El pedido llegaría a Chacón con toda la pinta de ser legítimo.

   Lo que cierra esto de verdad es que Chacón diga qué teléfono corresponde a
   cada tienda. Esa lista **siembra** la confianza; no la cierra: los números
   cambian, las tiendas añaden el del encargado, y una lista tratada como
   muro dejaría fuera a clientes reales. Por eso aquí nunca se bloquea un
   pedido. Se emite entero y se marca, y quien decide es Chacón.

   Tres niveles, y solo estos tres:

     agenda            el teléfono venía en la lista de Chacón. Nadie
                       pregunta nada y el pedido sale limpio.
     aprobado          un teléfono que se identificó solo y que Chacón
                       verificó después en el panel. Equivale a `agenda`.
     autoidentificado  se identificó solo y nadie lo ha verificado todavía.
                       El pedido SALE, con un aviso que Chacón no puede
                       pasar por alto.

   `autoidentificado` no significa sospechoso: es el caso normal mientras la
   lista de teléfonos esté incompleta. Lo que se marca no es la culpa, es la
   ausencia de comprobación.

   Las señales de riesgo se calculan aquí para que la persona que prepara el
   pedido decida con datos y no con una corazonada. La más fuerte con
   diferencia es `tienda_ya_tiene_telefonos`: que una tienda con números ya
   verificados aparezca de pronto desde uno nuevo es exactamente la forma que
   tendría una suplantación.
   ============================================================ */

const repo = require('./repo');

const NIVELES = {
  AGENDA: 'agenda',
  APROBADO: 'aprobado',
  AUTOIDENTIFICADO: 'autoidentificado',
};

/** Niveles que Chacón ya ha dado por buenos. */
const VERIFICADOS = new Set([NIVELES.AGENDA, NIVELES.APROBADO]);

const esVerificado = (nivel) => VERIFICADOS.has(nivel);

/**
 * Deja los teléfonos en una sola forma para poder compararlos.
 *
 * WhatsApp entrega el remitente como `34696457129`; Chacón los escribirá a
 * mano de siete maneras distintas. Sin normalizar, el mismo número aparece
 * como dos y la lista no sirve de nada.
 *
 * Solo se asume prefijo español cuando el número tiene la forma de un móvil
 * o fijo español de nueve cifras. Cualquier otra cosa se deja tal cual: es
 * preferible no reconocer un número extranjero a inventarle un país.
 */
function normalizarTelefono(valor) {
  const solo = String(valor == null ? '' : valor)
    .replace(/[^\d+]/g, '')
    .replace(/(?!^)\+/g, '');
  if (!solo) return null;
  let n = solo.replace(/^\+/, '');
  n = n.replace(/^00/, '');
  if (/^[6789]\d{8}$/.test(n)) n = `34${n}`;      // nacional sin prefijo
  if (!/^\d{8,15}$/.test(n)) return null;
  return n;
}

/* ---- señales de riesgo --------------------------------------------------- */
/**
 * Qué debería mirar Chacón antes de servir. Ordenadas de más grave a menos:
 * el mensaje se lee en un móvil y la primera línea es la que se lee seguro.
 */
async function señales(telefono, ficha) {
  const out = [];
  const tel = normalizarTelefono(telefono);

  const verificados = (ficha.telefonos_verificados || []);
  if (verificados.length && !verificados.includes(tel)) {
    out.push({
      clave: 'tienda_ya_tiene_telefonos',
      gravedad: 'alta',
      texto: `Esta tienda ya tiene ${verificados.length} teléfono(s) verificado(s) `
        + 'y este no es ninguno de ellos.',
    });
  }

  /* Un mismo teléfono que se ha presentado como dos tiendas distintas no
     tiene explicación inocente frecuente. Se cuenta aparte del pedido para
     que quede constancia aunque nunca llegue a pedir. */
  const reclamadas = await repo.tiendasReclamadasPor(tel).catch(() => []);
  const otras = reclamadas.filter((c) => c !== ficha.customer_code);
  if (otras.length) {
    out.push({
      clave: 'telefono_reclamo_varias_tiendas',
      gravedad: 'alta',
      texto: `Este teléfono también se ha identificado como: ${otras.join(', ')}.`,
    });
  }

  if (!verificados.length) {
    out.push({
      clave: 'tienda_sin_telefono_conocido',
      gravedad: 'media',
      texto: 'Chacón no tiene ningún teléfono registrado para esta tienda.',
    });
  }

  return out;
}

/**
 * Fotografía de la confianza en el momento de confirmar el pedido.
 *
 * Se guarda DENTRO del pedido y no se recalcula después: si Chacón verifica
 * el teléfono mañana, el pedido de hoy debe seguir contando que salió sin
 * verificar. Un pedido es el registro de lo que pasó, no una vista de lo que
 * se sabe ahora.
 */
async function evaluar(telefono, ficha) {
  const nivel = ficha.link_trust || NIVELES.AUTOIDENTIFICADO;
  return {
    nivel,
    verificado: esVerificado(nivel),
    telefono: normalizarTelefono(telefono),
    verificado_por: ficha.trust_verified_by || null,
    verificado_en: ficha.trust_verified_at || null,
    señales: esVerificado(nivel) ? [] : await señales(telefono, ficha),
    evaluado_en: new Date().toISOString(),
  };
}

/**
 * Bloque de aviso para el mensaje que recibe Chacón.
 *
 * Devuelve [] cuando el teléfono está verificado: añadir un sello de "todo
 * correcto" a cada pedido enseña a ignorarlo, y entonces el aviso que sí
 * importa también se ignora.
 */
function avisoParaChacon(verificacion) {
  if (!verificacion || verificacion.verificado) return [];
  const L = [
    '🔒 TELÉFONO SIN VERIFICAR',
    'Esta tienda se ha identificado ella misma y nadie lo ha comprobado '
    + 'todavía. Confirma que el pedido es suyo antes de servirlo.',
  ];
  for (const s of verificacion.señales || []) L.push(`• ${s.texto}`);
  L.push('Verifícalo en el panel, sección Clientes.');
  return L;
}

module.exports = {
  NIVELES, VERIFICADOS, esVerificado, normalizarTelefono,
  señales, evaluar, avisoParaChacon,
};
