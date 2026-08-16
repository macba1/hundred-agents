/* ============================================================
   Salida de la solicitud de pedido hacia Chacón Alcántara.

   Adaptador desacoplado: hoy WhatsApp interno (o simulado), mañana ERP,
   correo o Google Sheet sin tocar la lógica de pedidos.

   Tres cosas fáciles de equivocar, y por eso están en código y no en el
   prompt:

   1. El número que RECIBE la solicitud es una variable de entorno
      (`FACTORY_WHATSAPP_NUMBER`). Nunca va escrito aquí, y nunca se le
      enseña a la tienda.
   2. Ese número no puede ser el de la tienda (sería una fuga de datos y
      además no llegaría a fábrica) ni el número emisor del propio agente
      (WhatsApp no permite que un número se escriba a sí mismo).
   3. Que Graph conteste 200 significa **aceptado**, no entregado. El
      pedido no se marca como recibido hasta que llega el estado
      `delivered` por el webhook. Esto ya nos mordió una vez con Sanmi:
      HTTP 200 y luego `failed` por la ventana de 24 horas.
   ============================================================ */

const wa = require('../wa/whatsapp');
const repo = require('./repo');

const MAX_INTENTOS = Number(process.env.CHACON_ENVIO_MAX_INTENTOS || 3);

const soloDigitos = (s) => String(s || '').replace(/[^0-9]/g, '');

/** Destinatario interno. Solo por variable de entorno. */
function destino() {
  return soloDigitos(process.env.FACTORY_WHATSAPP_NUMBER);
}

/** Nombre del responsable receptor. Se usa en el panel, nunca con la tienda. */
function nombreDestinatario() {
  return process.env.FACTORY_CONTACT_NAME || 'Responsable de pedidos';
}

/** Número desde el que responde el agente, si está configurado. */
function remitente() {
  return soloDigitos(process.env.CHACON_WHATSAPP_SENDER_NUMBER);
}

function modo() {
  if (!destino()) return 'simulado_sin_destino';
  if (!wa.token()) return 'simulado_sin_credenciales';
  return 'whatsapp';
}

/**
 * Comprueba la configuración ANTES de intentar nada. Devuelve el motivo por
 * el que no se debe enviar, o null si se puede.
 */
function revisarConfiguracion({ telefonoTienda = null } = {}) {
  const to = destino();
  if (!to) return null;                 // sin destino -> modo simulado, no es un error
  if (to === remitente()) {
    return {
      codigo: 'destino_igual_al_numero_emisor',
      aviso: 'FACTORY_WHATSAPP_NUMBER coincide con el número de WhatsApp Business del agente. '
        + 'Un número no puede enviarse mensajes a sí mismo: configura un número distinto.',
    };
  }
  const tel = soloDigitos(telefonoTienda);
  if (tel && to === tel) {
    return {
      codigo: 'destino_igual_al_telefono_del_cliente',
      aviso: 'El destinatario interno coincide con el teléfono de la tienda. No se envía.',
    };
  }
  return null;
}

/* ---- mensaje interno ---------------------------------------------------- */
/** Fecha legible en horario peninsular, que es donde está Chacón. */
function fechaLegible(iso) {
  try {
    return new Intl.DateTimeFormat('es-ES', {
      dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Madrid',
    }).format(new Date(iso));
  } catch { return iso; }
}

function cantidadTexto(l) {
  if (l.unidad_pedido === 'caja') return `${l.cantidad} caja${l.cantidad === 1 ? '' : 's'}`;
  if (l.unidad_pedido === 'kg') return `${l.cantidad} kg`;
  return `${l.cantidad} unidad${l.cantidad === 1 ? '' : 'es'}`;
}

/**
 * Solicitud tal como la recibe el responsable interno.
 * Sin precios, sin IVA y sin totales: en esta versión es una solicitud, no
 * un pedido valorado. Los avisos internos sí van, para que quien prepare
 * sepa qué artículos tienen datos por confirmar.
 */
function componerMensaje(pedido, { urlPanel = null } = {}) {
  const L = ['📦 NUEVA SOLICITUD DE PEDIDO', ''];
  L.push(`Pedido: ${pedido.id}`);
  L.push(`Tienda: ${pedido.cliente.nombre}`);
  L.push(`Teléfono: +${pedido.cliente.telefonos?.[0] || '?'}`);
  L.push(`Fecha: ${fechaLegible(pedido.creado)}`);
  if (pedido.cliente.direccion) L.push(`Dirección: ${pedido.cliente.direccion}`);
  L.push('');
  L.push('Productos:');
  for (const l of pedido.lineas) {
    let linea = `• [${l.codigo}] ${l.descripcion}`;
    if (l.marca) linea += ` ${l.marca}`;
    linea += ` — ${cantidadTexto(l)}`;
    if (l.unidad_pedido === 'caja' && Number.isFinite(l.und_caja) && l.und_caja > 0) {
      linea += ` (${l.und_caja} uds/caja)`;
    }
    L.push(linea);
    if (l.observaciones) L.push(`   Obs: ${l.observaciones}`);
  }
  L.push('');
  L.push('Observaciones:');
  L.push(pedido.observaciones || 'Sin observaciones');

  const avisos = avisosInternos(pedido);
  if (avisos.length) {
    L.push('');
    L.push('⚠️ Avisos internos:');
    for (const a of avisos) L.push(`• ${a}`);
  }

  L.push('');
  L.push('Estado: pendiente de revisión por Chacón Alcántara.');
  if (urlPanel) L.push(`Panel: ${urlPanel}`);
  return L.join('\n');
}

/**
 * Artículos cuyos datos siguen sin resolver. No impiden pedir —el MVP no
 * calcula nada— pero quien prepara el pedido debe saberlo.
 */
function avisosInternos(pedido) {
  const avisos = [];
  for (const l of pedido.lineas || []) {
    const b = l.bloqueos || [];
    if (b.includes('varios_precios_sin_nivel_identificado')) {
      avisos.push(`[${l.codigo}] tiene varios precios en el catálogo: tarifa por confirmar.`);
    }
    if (b.includes('promocion_requiere_validacion')) {
      avisos.push(`[${l.codigo}] es artículo promocional: condiciones a validar.`);
    }
    if (b.includes('peso_desconocido')) {
      avisos.push(`[${l.codigo}] sin peso registrado en el catálogo.`);
    }
  }
  return avisos;
}

/* ---- envío -------------------------------------------------------------- */
/**
 * Envía con reintentos controlados y deja traza del intento en el pedido.
 * Nunca lanza: un fallo de envío no debe perder el pedido, que ya está
 * guardado y visible en el panel para reintentarlo.
 */
async function enviar(pedido, { urlPanel = null } = {}) {
  const to = destino();
  const m = modo();
  const texto = componerMensaje(pedido, { urlPanel });
  const telCliente = pedido.cliente.telefonos?.[0] || '';

  const problema = revisarConfiguracion({ telefonoTienda: telCliente });
  if (problema) {
    console.error('[chacon][config]', problema.aviso);
    const intento = { ts: new Date().toISOString(), modo: m, ok: false, error: problema.codigo };
    await registrar(pedido, intento, { estado: 'bloqueado_por_configuracion', aviso: problema.aviso });
    return { ok: false, modo: m, error: problema.codigo, aviso_configuracion: problema.aviso, texto };
  }

  if (m !== 'whatsapp') {
    const intento = { ts: new Date().toISOString(), modo: m, ok: true, simulado: true };
    await registrar(pedido, intento, { estado: 'simulado' });
    console.log(`[chacon][${m}] solicitud ${pedido.id} NO enviada de verdad:\n${texto}`);
    return { ok: true, modo: m, simulado: true, texto };
  }

  let ultimo = null;
  for (let i = 1; i <= MAX_INTENTOS; i += 1) {
    const cliente = { phone_number_id: process.env.CHACON_PHONE_NUMBER_ID
      || process.env.WHATSAPP_PHONE_NUMBER_ID || '' };
    const r = await wa.sendTextDetailed(cliente, to, texto);
    ultimo = { ts: new Date().toISOString(), modo: m, intento: i, ok: r.ok,
               status: r.status, wamid: r.wamid || null, detalle: r.ok ? null : r.detail };
    if (r.ok) {
      // Aceptado por el proveedor. NO entregado: eso lo dirá el webhook.
      await registrar(pedido, ultimo, { estado: 'aceptado_por_proveedor', wamid: r.wamid || null });
      if (r.wamid) await repo.mapearEnvio(r.wamid, pedido.id);
      return { ok: true, modo: m, wamid: r.wamid || null, entregado: false, texto };
    }
    await new Promise((res) => setTimeout(res, 500 * i));
  }
  await registrar(pedido, ultimo, { estado: 'fallido' });
  console.error('[chacon] no se pudo entregar la solicitud', pedido.id, 'al canal interno');
  return { ok: false, modo: m, error: 'envio_fallido', texto };
}

/** Reintento manual desde el panel. Mismo camino, sin duplicar el pedido. */
async function reintentar(pedidoId, { urlPanel = null } = {}) {
  const p = await repo.getPedido(pedidoId);
  if (!p) return { ok: false, error: 'pedido_inexistente' };
  if (p.envio_interno?.entregado) return { ok: true, ya_entregado: true };
  return enviar(p, { urlPanel });
}

async function registrar(pedido, intento, { estado, wamid = null, aviso = null } = {}) {
  pedido.envio_interno = pedido.envio_interno
    || { intentos: [], entregado: false, estado: 'pendiente', wamid: null };
  if (intento) pedido.envio_interno.intentos.push(intento);
  pedido.envio_interno.estado = estado;
  pedido.envio_interno.destinatario = nombreDestinatario();
  if (wamid) pedido.envio_interno.wamid = wamid;
  if (aviso) pedido.envio_interno.aviso_configuracion = aviso;
  // `entregado` solo lo pone `confirmarEntrega`, con el estado del proveedor.
  const p = await repo.getPedido(pedido.id);
  if (p) {
    p.envio_interno = pedido.envio_interno;
    await repo.guardarPedido(p);   // sobrescribe: no re-inserta en la lista
  }
}

/**
 * Lo llama el webhook cuando el proveedor informa del estado real del
 * mensaje. Es lo único que puede marcar la solicitud como recibida.
 */
async function confirmarEntrega(wamid, estadoProveedor) {
  const pedidoId = await repo.pedidoPorEnvio(wamid);
  if (!pedidoId) return null;
  const p = await repo.getPedido(pedidoId);
  if (!p) return null;
  p.envio_interno = p.envio_interno || { intentos: [], entregado: false };
  p.envio_interno.estado_proveedor = estadoProveedor;
  p.envio_interno.ts_estado_proveedor = new Date().toISOString();
  if (estadoProveedor === 'delivered' || estadoProveedor === 'read') {
    p.envio_interno.entregado = true;
    p.envio_interno.estado = 'entregado';
  } else if (estadoProveedor === 'failed') {
    p.envio_interno.entregado = false;
    p.envio_interno.estado = 'fallido';
  }
  await repo.guardarPedido(p);
  return p;
}

module.exports = {
  enviar, reintentar, componerMensaje, avisosInternos, confirmarEntrega,
  destino, nombreDestinatario, remitente, modo, revisarConfiguracion, MAX_INTENTOS,
};
