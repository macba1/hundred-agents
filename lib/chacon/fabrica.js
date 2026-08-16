/* ============================================================
   Salida del pedido hacia Chacón Alcántara.

   Adaptador desacoplado: hoy WhatsApp interno (o simulado), mañana ERP,
   correo o Google Sheet sin tocar la lógica de pedidos.

   Aviso importante y fácil de equivocar: el número que RECIBE el pedido
   dentro de Chacón no es el teléfono de la tienda, ni tiene por qué ser el
   mismo número de WhatsApp Business desde el que responde el agente.
   Algunos proveedores no permiten que un número se envíe mensajes a sí
   mismo. Por eso `FACTORY_WHATSAPP_NUMBER` es una variable aparte y el
   envío se niega si coincide con el teléfono del cliente.
   ============================================================ */

const wa = require('../wa/whatsapp');
const repo = require('./repo');

const MAX_INTENTOS = Number(process.env.CHACON_ENVIO_MAX_INTENTOS || 3);

function destino() {
  return (process.env.FACTORY_WHATSAPP_NUMBER || '').replace(/[^0-9]/g, '');
}

function modo() {
  if (!destino()) return 'simulado_sin_destino';
  if (!wa.token()) return 'simulado_sin_credenciales';
  return 'whatsapp';
}

/** Mensaje interno. Lleva todo lo que fábrica necesita para preparar. */
function componerMensaje(pedido, { urlPanel = null } = {}) {
  const L = [];
  L.push(`📦 PEDIDO ${pedido.id}`);
  L.push(`Tienda: ${pedido.cliente.nombre}`);
  L.push(`Teléfono: +${pedido.cliente.telefonos?.[0] || '?'}`);
  if (pedido.cliente.direccion) L.push(`Dirección: ${pedido.cliente.direccion}`);
  L.push(`Fecha: ${pedido.creado}`);
  L.push('');
  for (const l of pedido.lineas) {
    const cant = l.unidad_pedido === 'caja'
      ? `${l.cantidad} caja(s)${l.unidades ? ` = ${l.unidades} uds` : ''}`
      : l.unidad_pedido === 'kg' ? `${l.cantidad} kg` : `${l.cantidad} uds`;
    let linea = `• [${l.codigo}] ${l.descripcion} — ${cant}`;
    if (l.peso_estimado_kg !== null) linea += ` · peso est. ${l.peso_estimado_kg} kg`;
    if (l.precio_kg_sin_iva !== null) linea += ` · ${l.precio_kg_sin_iva} €/kg`;
    if (l.importe_estimado_sin_iva !== null) linea += ` · ~${l.importe_estimado_sin_iva} €`;
    L.push(linea);
    if (l.bloqueos?.length) L.push(`   ⚠️ PENDIENTE: ${l.bloqueos.join(', ')}`);
    if (l.observaciones) L.push(`   Obs: ${l.observaciones}`);
  }
  L.push('');
  const t = pedido.totales;
  if (t.base_estimada_sin_iva !== null) L.push(`Importe estimado SIN IVA: ${t.base_estimada_sin_iva} €`);
  if (t.peso_estimado_kg) L.push(`Peso estimado total: ${t.peso_estimado_kg} kg`);
  if (t.lineas_pendientes_revision) L.push(`⚠️ ${t.lineas_pendientes_revision} línea(s) sin precio o sin peso: requieren revisión.`);
  L.push('IVA no calculado (sin tabla aprobada).');
  if (pedido.observaciones) L.push(`Observaciones: ${pedido.observaciones}`);
  if (urlPanel) L.push(`Panel: ${urlPanel}`);
  return L.join('\n');
}

/**
 * Envía con reintentos controlados y deja traza del intento en el pedido.
 * Nunca lanza: un fallo de envío no debe perder el pedido, que ya está
 * guardado. El estado de entrega queda registrado para reintentar después.
 */
async function enviar(pedido, { urlPanel = null } = {}) {
  const to = destino();
  const m = modo();
  const texto = componerMensaje(pedido, { urlPanel });
  const telCliente = (pedido.cliente.telefonos?.[0] || '').replace(/[^0-9]/g, '');

  if (to && telCliente && to === telCliente) {
    // Guardarraíl: mandarle el pedido interno a la propia tienda sería una
    // fuga de datos y además no llegaría a fábrica.
    const intento = { ts: new Date().toISOString(), modo: m, ok: false,
                      error: 'destino_igual_al_telefono_del_cliente' };
    await registrar(pedido, intento, false);
    return { ok: false, modo: m, error: intento.error, texto };
  }

  if (m !== 'whatsapp') {
    const intento = { ts: new Date().toISOString(), modo: m, ok: true, simulado: true };
    await registrar(pedido, intento, true);
    console.log(`[chacon][${m}] pedido ${pedido.id} NO enviado de verdad:\n${texto}`);
    return { ok: true, modo: m, simulado: true, texto };
  }

  let ultimo = null;
  for (let i = 1; i <= MAX_INTENTOS; i += 1) {
    const cliente = { phone_number_id: process.env.CHACON_PHONE_NUMBER_ID
      || process.env.WHATSAPP_PHONE_NUMBER_ID || '' };
    const ok = await wa.sendText(cliente, to, texto);
    ultimo = { ts: new Date().toISOString(), modo: m, intento: i, ok };
    if (ok) { await registrar(pedido, ultimo, true); return { ok: true, modo: m, texto }; }
    await new Promise((r) => setTimeout(r, 500 * i));
  }
  await registrar(pedido, ultimo, false);
  console.error('[chacon] no se pudo entregar el pedido', pedido.id, 'a fábrica');
  return { ok: false, modo: m, error: 'envio_fallido', texto };
}

async function registrar(pedido, intento, entregado) {
  pedido.envio_interno = pedido.envio_interno || { intentos: [], entregado: false };
  pedido.envio_interno.intentos.push(intento);
  pedido.envio_interno.entregado = entregado;
  const p = await repo.getPedido(pedido.id);
  if (p) {
    p.envio_interno = pedido.envio_interno;
    await repo.guardarPedido(p);   // sobrescribe: no re-inserta en la lista
  }
}

module.exports = { enviar, componerMensaje, destino, modo, MAX_INTENTOS };
