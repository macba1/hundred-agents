/* ============================================================
   "Validemos juntos el alcance" — el guion de la reunión, hecho pantalla.

   No es otro discovery: el diagnóstico ya se hizo. La primera pantalla
   enseña lo que entendimos para que lo confirmen o lo corrijan, y el resto
   recorre SOLO las decisiones que todavía faltan, una por pantalla.

   Todo es client-side. Las respuestas se guardan en localStorage para que
   una recarga a media reunión no borre el trabajo, y salen de aquí por
   copiar/JSON/TXT. No hay servidor ni base de datos detrás: en esta fase no
   hacen falta, y no tener backend es una cosa menos que puede fallar
   delante del cliente.
   ============================================================ */
(function () {
  'use strict';

  var CLAVE = 'providencia.validacion.v1';

  /* ---------- lo que entendimos del diagnóstico ---------- */

  var ENTENDIMIENTO = [
    'Queremos responder inmediatamente a nuevos prospectos por WhatsApp.',
    'El foco inicial son nuevos clientes y distribuidores.',
    'El agente debe funcionar también fuera del horario de oficina.',
    'El agente responderá información de empresa y producto.',
    'Calificará oportunidades antes de pasarlas a Ventas.',
    'No sustituirá al equipo comercial.',
    'No conectaremos SAP en la primera fase.',
    'No inventará precios, stock ni condiciones.',
    'Queremos tener el piloto listo antes de octubre.',
  ];

  /* ---------- el guion ---------- */

  var PASOS = [
    {
      id: 'entendimiento',
      fase: 'Entendimiento',
      titulo: 'Lo que hemos entendido',
      lead: 'Esto es lo que nos llevamos del diagnóstico. Confirmen punto por punto lo que está bien y marquen lo que hay que corregir.',
      tipo: 'entendimiento',
    },
    {
      id: 'publico',
      fase: 'Reglas',
      titulo: 'A quién atendemos',
      lead: 'La primera fase se diseña alrededor de un solo público. Cuanto más claro, mejor califica.',
      preguntas: [
        {
          id: 'fase1_publico', tipo: 'radio',
          texto: '¿Confirmamos que la primera fase atiende principalmente a NUEVOS PROSPECTOS y no a los clientes actuales?',
          opciones: ['Sí, solo prospectos inicialmente', 'También queremos atender clientes actuales'],
          otro: true,
        },
        {
          id: 'perfiles', tipo: 'checks',
          texto: '¿A qué perfiles debe poder atender?',
          opciones: ['Distribuidor / mayorista', 'Tienda', 'Cadena / empresa', 'Consumidor final', 'Exportador / importador'],
          pre: ['Distribuidor / mayorista', 'Tienda', 'Cadena / empresa'],
          otro: true,
        },
      ],
    },
    {
      id: 'respuestas',
      fase: 'Reglas',
      titulo: 'Qué puede responder solo',
      lead: 'Todo lo que marquen aquí lo contesta el agente sin molestar a Ventas. Lo que no, lo escala.',
      preguntas: [
        {
          id: 'puede_responder', tipo: 'checks',
          texto: 'Confirmen qué puede responder automáticamente:',
          opciones: ['Información de la empresa', 'Ubicación', 'Horarios', 'Catálogo', 'Presentaciones',
            'Dónde comprar', 'Cómo convertirse en distribuidor', 'Cobertura geográfica',
            'Certificaciones', 'Ingredientes / alérgenos'],
          pre: ['Información de la empresa', 'Ubicación', 'Horarios', 'Catálogo', 'Presentaciones',
            'Dónde comprar', 'Cómo convertirse en distribuidor'],
          otro: true,
        },
        {
          id: 'precios', tipo: 'radio',
          texto: 'PRECIOS — la pregunta crítica. Cuando alguien pregunte precio, ¿qué debe hacer el agente?',
          pista: 'Hoy el agente no da ningún precio. Esta respuesta decide si eso cambia y con qué fuente.',
          opciones: [
            'A. Puede dar precios públicos',
            'B. Puede dar una tarifa general de mayoreo',
            'C. Depende del cliente / volumen',
            'D. Siempre debe pasarlo a un vendedor',
          ],
          otro: true,
          sigue: {
            cuando: ['A. Puede dar precios públicos', 'B. Puede dar una tarifa general de mayoreo', 'C. Depende del cliente / volumen'],
            id: 'precios_fuente',
            texto: '¿Dónde está la fuente oficial de esos precios? (sistema, archivo, responsable)',
          },
        },
      ],
    },
    {
      id: 'lead',
      fase: 'Reglas',
      titulo: 'Qué significa un buen lead',
      lead: 'Ventas recibe la ficha con estos campos. Marcados están los que proponemos nosotros.',
      preguntas: [
        {
          id: 'campos_lead', tipo: 'checks',
          texto: '¿Qué información necesita Ventas antes de recibir un prospecto?',
          opciones: ['Nombre', 'Empresa', 'Ciudad', 'Estado', 'País', 'Tipo de negocio',
            'Productos de interés', 'Volumen aproximado', 'Teléfono', 'Email'],
          pre: ['Nombre', 'Empresa', 'Ciudad', 'Estado', 'País', 'Tipo de negocio',
            'Productos de interés', 'Volumen aproximado', 'Teléfono', 'Email'],
          otro: true,
        },
        {
          id: 'lead_caliente', tipo: 'texto',
          texto: '¿Qué hace que un prospecto sea "prioritario" o "caliente"?',
          pista: 'Ejemplos: volumen mínimo, tipo de negocio, zona sin cubrir, que ya venda producto parecido…',
          placeholder: 'Por ejemplo: pide más de X cajas, es cadena, es una zona donde todavía no tenemos distribuidor…',
        },
      ],
    },
    {
      id: 'escalamiento',
      fase: 'Reglas',
      titulo: 'A quién llega y cuándo',
      lead: 'Un lead que no llega a una persona no sirve de nada. Definamos destinatarios y disparadores.',
      preguntas: [
        {
          id: 'destinatarios', tipo: 'destinos',
          texto: '¿Quién debe recibir un nuevo lead calificado?',
          pista: 'Pueden ser varias personas. En el piloto es a quien le llega la notificación.',
        },
        {
          id: 'disparadores', tipo: 'checks',
          texto: '¿Qué situaciones deben pasar inmediatamente a una persona?',
          opciones: ['Precio especial', 'Pedido grande', 'Queja', 'Problema de calidad',
            'Solicitud internacional', 'Condiciones de crédito', 'Información que el agente no conoce'],
          pre: ['Precio especial', 'Pedido grande', 'Queja', 'Problema de calidad',
            'Solicitud internacional', 'Condiciones de crédito', 'Información que el agente no conoce'],
          otro: true,
        },
      ],
    },
    {
      id: 'whatsapp',
      fase: 'WhatsApp',
      titulo: 'El número de WhatsApp',
      lead: 'De estas tres respuestas depende cuánto tarda el alta técnica con Meta. Si no lo saben, "No sabemos" es una respuesta perfectamente útil: lo averiguamos nosotros.',
      preguntas: [
        {
          id: 'wa_business', tipo: 'radio',
          texto: '¿El número actual está en WhatsApp Business?',
          opciones: ['Sí', 'No', 'No sabemos'],
        },
        {
          id: 'wa_cloud', tipo: 'radio',
          texto: '¿Está conectado a Meta Business Manager / WhatsApp Business Platform (Cloud API)?',
          opciones: ['Sí', 'No', 'No sabemos'],
        },
        {
          id: 'wa_conservar', tipo: 'radio',
          texto: '¿Quieren conservar exactamente el número actual?',
          opciones: ['Sí', 'Podemos usar otro', 'Por decidir'],
        },
      ],
    },
    {
      id: 'materiales',
      fase: 'Materiales',
      titulo: 'Lo que necesitamos de ustedes',
      lead: 'Nada de esto lo puede inventar el agente. Marquen qué existe hoy y qué nos van a enviar.',
      preguntas: [
        {
          id: 'materiales', tipo: 'materiales',
          texto: 'Para producción necesitaremos:',
          opciones: ['Catálogo oficial actualizado', 'Lista de precios / reglas de precio si aplica',
            'Condiciones de mayoreo', 'Pedido mínimo', 'Cobertura / zonas', 'Política de envío',
            'Preguntas frecuentes', 'Ingredientes y alérgenos', 'Certificados que podamos comunicar',
            'Ejemplos reales de conversaciones de WhatsApp', 'Contactos de escalamiento'],
        },
        {
          id: 'idioma', tipo: 'radio',
          texto: 'Idioma inicial del agente',
          pista: 'Nuestra propuesta viene preseleccionada.',
          opciones: ['Español México', 'Español + inglés'],
          pre: 'Español México',
          otro: true,
        },
      ],
    },
    {
      id: 'metricas',
      fase: 'Métricas',
      titulo: '¿Cómo sabremos que está funcionando?',
      lead: 'Estas son las que proponemos medir desde el primer día. Quiten lo que no les sirva y añadan lo que falte.',
      preguntas: [
        {
          id: 'metricas', tipo: 'checks',
          texto: 'Métricas del piloto',
          opciones: ['Tiempo medio de primera respuesta', 'Conversaciones fuera de horario atendidas',
            'Nuevos prospectos capturados', 'Leads calificados enviados a Ventas',
            'Reducción de tiempo del equipo comercial', 'Oportunidades que terminan en venta'],
          pre: ['Tiempo medio de primera respuesta', 'Conversaciones fuera de horario atendidas',
            'Nuevos prospectos capturados', 'Leads calificados enviados a Ventas',
            'Reducción de tiempo del equipo comercial', 'Oportunidades que terminan en venta'],
          otro: true,
        },
      ],
    },
    {
      id: 'alcance',
      fase: 'Confirmación',
      titulo: 'Alcance de la Fase 1',
      lead: 'Lo que entra y lo que explícitamente no entra en el primer piloto.',
      tipo: 'alcance',
      preguntas: [
        {
          id: 'alcance_ok', tipo: 'radio',
          texto: '¿Estamos alineados con este alcance inicial?',
          opciones: ['Sí', 'Hay que modificarlo'],
          otro: false,
          sigue: { cuando: ['Hay que modificarlo'], id: 'alcance_cambios', texto: '¿Qué hay que modificar?' },
        },
      ],
    },
    {
      id: 'resumen',
      fase: 'Confirmación',
      titulo: 'Resultado de validación — Dulces Providencia',
      lead: 'Todo lo que confirmaron y corrigieron, listo para llevárselo de la reunión.',
      tipo: 'resumen',
    },
  ];

  var DENTRO = ['WhatsApp', 'Preguntas frecuentes', 'Catálogo', 'Cualificación de prospectos',
    'Escalamiento a Ventas', 'Panel / registro de prospectos'];
  var FUERA = ['SAP', 'Inventario en tiempo real', 'Crédito', 'Facturación', 'Venta en ruta',
    'Automatización de llamadas', 'Decisiones de descuento automáticas'];

  var FASES = ['Entendimiento', 'Reglas', 'WhatsApp', 'Materiales', 'Métricas', 'Confirmación'];

  /* ---------- estado ---------- */

  var estado = cargar();
  // La pantalla también se recuerda: si a media reunión se recarga la página,
  // volver a la primera pregunta y buscar dónde iban es justo lo que no se
  // puede hacer delante del cliente.
  var indice = 0;

  function cargar() {
    try {
      var raw = localStorage.getItem(CLAVE);
      if (raw) return JSON.parse(raw);
    } catch (e) { console.warn('[validacion] no se pudo leer el guardado', e); }
    return { entendimiento: {}, respuestas: {}, pantalla: 0, iniciado: new Date().toISOString() };
  }

  function guardar() {
    estado.actualizado = new Date().toISOString();
    estado.pantalla = indice;
    try { localStorage.setItem(CLAVE, JSON.stringify(estado)); }
    catch (e) { console.warn('[validacion] no se pudo guardar', e); }
  }

  function pre(preg) {
    if (preg.tipo === 'checks') return (preg.pre || []).slice();
    if (preg.tipo === 'materiales') return {};
    if (preg.tipo === 'destinos') return [];
    return preg.pre || '';
  }

  function valor(preg) {
    if (!(preg.id in estado.respuestas)) estado.respuestas[preg.id] = pre(preg);
    return estado.respuestas[preg.id];
  }

  /* ---------- utilidades DOM ---------- */

  function el(tag, clase, texto) {
    var n = document.createElement(tag);
    if (clase) n.className = clase;
    if (texto != null) n.textContent = texto;
    return n;
  }

  function botonOpcion(texto, activo, onClick) {
    var b = el('button', 'btn-op', texto);
    b.type = 'button';
    b.setAttribute('aria-pressed', activo ? 'true' : 'false');
    b.addEventListener('click', onClick);
    return b;
  }

  /* ---------- render de cada tipo ---------- */

  function pintarEntendimiento(destino) {
    var caja = el('div', 'entendido');
    ENTENDIMIENTO.forEach(function (texto, i) {
      var k = 'e' + i;
      var dato = estado.entendimiento[k] || {};
      var fila = el('div', 'ent' + (dato.veredicto === 'ok' ? ' ok' : dato.veredicto === 'cambiar' ? ' cambiar' : ''));
      fila.appendChild(el('p', null, '✓ ' + texto));

      var acc = el('div', 'acc');
      acc.appendChild(botonOpcion('Correcto', dato.veredicto === 'ok', function () {
        estado.entendimiento[k] = { punto: texto, veredicto: 'ok' };
        guardar(); render();
      }));
      acc.appendChild(botonOpcion('Hay que cambiarlo', dato.veredicto === 'cambiar', function () {
        estado.entendimiento[k] = { punto: texto, veredicto: 'cambiar', correccion: dato.correccion || '' };
        guardar(); render();
      }));
      fila.appendChild(acc);

      if (dato.veredicto === 'cambiar') {
        var ta = el('textarea', 'campo');
        ta.rows = 2;
        ta.placeholder = '¿Qué debemos corregir?';
        ta.value = dato.correccion || '';
        ta.addEventListener('input', function () {
          estado.entendimiento[k].correccion = ta.value;
          guardar();
        });
        fila.appendChild(ta);
      }
      caja.appendChild(fila);
    });
    destino.appendChild(caja);
  }

  function pintarSigue(preg, destino) {
    if (!preg.sigue) return;
    var v = estado.respuestas[preg.id];
    if (preg.sigue.cuando.indexOf(v) === -1) return;
    var caja = el('div', 'campo-mini');
    var lab = el('p', 'pista', preg.sigue.texto);
    var ta = el('textarea', 'campo');
    ta.rows = 2;
    ta.value = estado.respuestas[preg.sigue.id] || '';
    ta.addEventListener('input', function () {
      estado.respuestas[preg.sigue.id] = ta.value;
      guardar();
    });
    caja.appendChild(lab); caja.appendChild(ta);
    destino.appendChild(caja);
  }

  function pintarRadio(preg, destino) {
    var v = valor(preg);
    var caja = el('div', 'opciones' + (preg.opciones.some(function (o) { return o.length > 34; }) ? ' col' : ''));
    preg.opciones.forEach(function (o) {
      caja.appendChild(botonOpcion(o, v === o, function () {
        estado.respuestas[preg.id] = o;
        guardar(); render();
      }));
    });
    if (preg.otro) {
      var esOtro = v && preg.opciones.indexOf(v) === -1;
      caja.appendChild(botonOpcion('Otro', esOtro, function () {
        estado.respuestas[preg.id] = esOtro ? '' : ' ';
        guardar(); render();
      }));
    }
    destino.appendChild(caja);

    if (preg.otro && v && preg.opciones.indexOf(v) === -1) {
      var inp = el('input', 'campo campo-mini');
      inp.type = 'text';
      inp.placeholder = 'Escriban su respuesta';
      inp.value = v.trim();
      inp.addEventListener('input', function () {
        estado.respuestas[preg.id] = inp.value || ' ';
        guardar();
      });
      destino.appendChild(inp);
    }
    pintarSigue(preg, destino);
  }

  function pintarChecks(preg, destino) {
    var v = valor(preg);
    var caja = el('div', 'marcas');
    preg.opciones.forEach(function (o) {
      var lab = el('label', 'marca');
      var inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.checked = v.indexOf(o) !== -1;
      inp.addEventListener('change', function () {
        var lista = estado.respuestas[preg.id];
        if (inp.checked) { if (lista.indexOf(o) === -1) lista.push(o); }
        else { estado.respuestas[preg.id] = lista.filter(function (x) { return x !== o; }); }
        guardar();
      });
      lab.appendChild(inp);
      lab.appendChild(el('span', null, o));
      caja.appendChild(lab);
    });
    destino.appendChild(caja);

    if (preg.otro) {
      var inp2 = el('input', 'campo campo-mini');
      inp2.type = 'text';
      inp2.placeholder = 'Otro (añadan lo que falte, separado por comas)';
      inp2.value = estado.respuestas[preg.id + '_otro'] || '';
      inp2.addEventListener('input', function () {
        estado.respuestas[preg.id + '_otro'] = inp2.value;
        guardar();
      });
      destino.appendChild(inp2);
    }
  }

  function pintarTexto(preg, destino) {
    var ta = el('textarea', 'campo');
    ta.rows = 3;
    ta.placeholder = preg.placeholder || '';
    ta.value = valor(preg) || '';
    ta.addEventListener('input', function () {
      estado.respuestas[preg.id] = ta.value;
      guardar();
    });
    destino.appendChild(ta);
  }

  function pintarDestinos(preg, destino) {
    var lista = valor(preg);
    if (!lista.length) lista.push({ nombre: '', cargo: '', email: '', whatsapp: '' });

    var caja = el('div', 'destinos');
    lista.forEach(function (d, i) {
      var fila = el('div', 'destino');
      [['nombre', 'Nombre'], ['cargo', 'Cargo'], ['email', 'Correo'], ['whatsapp', 'WhatsApp']]
        .forEach(function (c) {
          var inp = el('input', 'campo');
          inp.type = c[0] === 'email' ? 'email' : 'text';
          inp.placeholder = c[1];
          inp.value = d[c[0]] || '';
          inp.addEventListener('input', function () { d[c[0]] = inp.value; guardar(); });
          fila.appendChild(inp);
        });
      var quitar = el('button', 'quitar', '×');
      quitar.type = 'button';
      quitar.title = 'Quitar destinatario';
      quitar.addEventListener('click', function () {
        estado.respuestas[preg.id] = lista.filter(function (_, j) { return j !== i; });
        guardar(); render();
      });
      fila.appendChild(quitar);
      caja.appendChild(fila);
    });
    destino.appendChild(caja);

    var mas = el('button', 'btn fantasma campo-mini', '+ Añadir destinatario');
    mas.type = 'button';
    mas.addEventListener('click', function () {
      lista.push({ nombre: '', cargo: '', email: '', whatsapp: '' });
      guardar(); render();
    });
    destino.appendChild(mas);
  }

  function pintarMateriales(preg, destino) {
    var v = valor(preg);
    var caja = el('div', 'materiales');
    preg.opciones.forEach(function (o) {
      var fila = el('div', 'material');
      fila.appendChild(el('span', null, o));
      var acc = el('div', 'acc');
      ['Tenemos', 'Se los enviamos', 'No aplica'].forEach(function (op) {
        acc.appendChild(botonOpcion(op, v[o] === op, function () {
          v[o] = v[o] === op ? undefined : op;
          if (v[o] === undefined) delete v[o];
          guardar(); render();
        }));
      });
      fila.appendChild(acc);
      caja.appendChild(fila);
    });
    destino.appendChild(caja);
  }

  function pintarAlcance(destino) {
    var caja = el('div', 'alcance');
    var dentro = el('div', 'dentro');
    dentro.appendChild(el('h5', null, 'En Fase 1'));
    var u1 = el('ul');
    DENTRO.forEach(function (t) { u1.appendChild(el('li', null, '✓ ' + t)); });
    dentro.appendChild(u1);

    var fuera = el('div', 'fuera');
    fuera.appendChild(el('h5', null, 'Fuera de Fase 1'));
    var u2 = el('ul');
    FUERA.forEach(function (t) { u2.appendChild(el('li', null, '× ' + t)); });
    fuera.appendChild(u2);

    caja.appendChild(dentro); caja.appendChild(fuera);
    destino.appendChild(caja);
  }

  var PINTORES = {
    radio: pintarRadio, checks: pintarChecks, texto: pintarTexto,
    destinos: pintarDestinos, materiales: pintarMateriales,
  };

  /* ---------- resumen ---------- */

  function etiquetaPregunta(id) {
    for (var i = 0; i < PASOS.length; i += 1) {
      var pregs = PASOS[i].preguntas || [];
      for (var j = 0; j < pregs.length; j += 1) {
        if (pregs[j].id === id) return pregs[j].texto;
        if (pregs[j].sigue && pregs[j].sigue.id === id) return pregs[j].sigue.texto;
      }
    }
    return id;
  }

  function construirResumen() {
    var confirmados = [];
    var cambios = [];
    ENTENDIMIENTO.forEach(function (texto, i) {
      var d = estado.entendimiento['e' + i];
      if (!d) return;
      if (d.veredicto === 'ok') confirmados.push(texto);
      else cambios.push({ punto: texto, correccion: (d.correccion || '').trim() || '(sin detalle)' });
    });
    var sinRevisar = ENTENDIMIENTO.filter(function (_, i) { return !estado.entendimiento['e' + i]; });

    var respuestas = [];
    var pendientes = [];
    PASOS.forEach(function (paso) {
      (paso.preguntas || []).forEach(function (preg) {
        var v = estado.respuestas[preg.id];
        var vacio = v == null || v === '' ||
          (Array.isArray(v) && !v.length) ||
          (preg.tipo === 'materiales' && !Object.keys(v || {}).length) ||
          (preg.tipo === 'destinos' && !(v || []).some(function (d) {
            return d.nombre || d.email || d.whatsapp;
          }));
        if (vacio) { pendientes.push(preg.texto); return; }
        respuestas.push({ id: preg.id, pregunta: preg.texto, tipo: preg.tipo, valor: v,
          extra: estado.respuestas[preg.id + '_otro'] || '' });
        if (preg.sigue && estado.respuestas[preg.sigue.id]) {
          respuestas.push({ id: preg.sigue.id, pregunta: preg.sigue.texto, tipo: 'texto',
            valor: estado.respuestas[preg.sigue.id], extra: '' });
        }
      });
    });

    var mats = estado.respuestas.materiales || {};
    var nosEnvian = Object.keys(mats).filter(function (k) { return mats[k] === 'Se los enviamos'; });
    var tienen = Object.keys(mats).filter(function (k) { return mats[k] === 'Tenemos'; });
    var faltaMarcar = (PASOS.find(function (p) { return p.id === 'materiales'; })
      .preguntas[0].opciones).filter(function (o) { return !mats[o]; });

    var destinos = (estado.respuestas.destinatarios || []).filter(function (d) {
      return d.nombre || d.email || d.whatsapp;
    });

    return {
      cliente: 'Dulces prOvidenCia',
      documento: 'Resultado de validación',
      generado: new Date().toISOString(),
      entendimiento: { confirmados: confirmados, cambios: cambios, sin_revisar: sinRevisar },
      respuestas: respuestas,
      pendientes: pendientes,
      materiales: { tienen: tienen, nos_envian: nosEnvian, sin_marcar: faltaMarcar },
      responsables: destinos,
      alcance: {
        en_fase_1: DENTRO,
        fuera_de_fase_1: FUERA,
        aceptado: estado.respuestas.alcance_ok || '(sin responder)',
        cambios: estado.respuestas.alcance_cambios || '',
      },
    };
  }

  function valorTexto(r) {
    var v = r.valor;
    if (Array.isArray(v)) {
      if (r.tipo === 'destinos') {
        return v.filter(function (d) { return d.nombre || d.email || d.whatsapp; })
          .map(function (d) {
            return [d.nombre, d.cargo, d.email, d.whatsapp].filter(Boolean).join(' · ');
          }).join(' | ');
      }
      return v.join(', ') + (r.extra ? ', ' + r.extra : '');
    }
    if (v && typeof v === 'object') {
      return Object.keys(v).map(function (k) { return k + ': ' + v[k]; }).join(' | ');
    }
    return String(v).trim() + (r.extra ? ' (+ ' + r.extra + ')' : '');
  }

  function resumenTexto(r) {
    var L = [];
    L.push('RESULTADO DE VALIDACIÓN — DULCES PROVIDENCIA');
    L.push('Agente comercial de WhatsApp · Fase 1');
    L.push('Generado: ' + new Date(r.generado).toLocaleString('es-MX'));
    L.push('');
    L.push('PUNTOS CONFIRMADOS (' + r.entendimiento.confirmados.length + ')');
    r.entendimiento.confirmados.forEach(function (t) { L.push('  ✓ ' + t); });
    if (!r.entendimiento.confirmados.length) L.push('  (ninguno todavía)');
    L.push('');
    L.push('CAMBIOS SOLICITADOS (' + r.entendimiento.cambios.length + ')');
    r.entendimiento.cambios.forEach(function (c) {
      L.push('  ! ' + c.punto);
      L.push('    → ' + c.correccion);
    });
    if (!r.entendimiento.cambios.length) L.push('  (ninguno)');
    if (r.entendimiento.sin_revisar.length) {
      L.push('');
      L.push('PUNTOS SIN REVISAR (' + r.entendimiento.sin_revisar.length + ')');
      r.entendimiento.sin_revisar.forEach(function (t) { L.push('  ? ' + t); });
    }
    L.push('');
    L.push('RESPUESTAS');
    r.respuestas.forEach(function (x) {
      L.push('  · ' + x.pregunta);
      L.push('    ' + valorTexto(x));
    });
    if (!r.respuestas.length) L.push('  (ninguna todavía)');
    L.push('');
    L.push('CAMPOS PENDIENTES (' + r.pendientes.length + ')');
    r.pendientes.forEach(function (t) { L.push('  □ ' + t); });
    if (!r.pendientes.length) L.push('  (ninguno: se respondió todo)');
    L.push('');
    L.push('MATERIALES QUE NOS ENVÍAN');
    r.materiales.nos_envian.forEach(function (t) { L.push('  → ' + t); });
    if (!r.materiales.nos_envian.length) L.push('  (ninguno marcado)');
    if (r.materiales.tienen.length) {
      L.push('  Ya tienen: ' + r.materiales.tienen.join(', '));
    }
    if (r.materiales.sin_marcar.length) {
      L.push('  Sin marcar: ' + r.materiales.sin_marcar.join(', '));
    }
    L.push('');
    L.push('RESPONSABLES INDICADOS');
    r.responsables.forEach(function (d) {
      L.push('  · ' + [d.nombre, d.cargo, d.email, d.whatsapp].filter(Boolean).join(' · '));
    });
    if (!r.responsables.length) L.push('  (ninguno)');
    L.push('');
    L.push('ALCANCE FINAL');
    L.push('  Aceptado: ' + r.alcance.aceptado);
    if (r.alcance.cambios) L.push('  Modificaciones: ' + r.alcance.cambios);
    L.push('  En Fase 1: ' + r.alcance.en_fase_1.join(', '));
    L.push('  Fuera de Fase 1: ' + r.alcance.fuera_de_fase_1.join(', '));
    L.push('');
    L.push('Documento generado en la demo de Hundred Agents. No sustituye a un contrato.');
    return L.join('\n');
  }

  function descargar(nombre, contenido, mime) {
    var blob = new Blob([contenido], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function pintarResumen(destino) {
    var r = construirResumen();
    var caja = el('div', 'resumen');

    function bloque(titulo, items, clase) {
      var b = el('div', 'resumen-bloque');
      b.appendChild(el('h4', null, titulo));
      if (!items.length) { b.appendChild(el('p', 'nada', 'Nada registrado todavía.')); }
      else {
        var ul = el('ul');
        items.forEach(function (t) {
          var li = el('li', clase || null, t);
          ul.appendChild(li);
        });
        b.appendChild(ul);
      }
      caja.appendChild(b);
    }

    bloque('Puntos confirmados (' + r.entendimiento.confirmados.length + ')', r.entendimiento.confirmados);
    bloque('Cambios solicitados (' + r.entendimiento.cambios.length + ')',
      r.entendimiento.cambios.map(function (c) { return c.punto + ' → ' + c.correccion; }), 'cambio');
    bloque('Respuestas (' + r.respuestas.length + ')',
      r.respuestas.map(function (x) { return x.pregunta + ' — ' + valorTexto(x); }));
    bloque('Campos pendientes (' + r.pendientes.length + ')', r.pendientes);
    bloque('Materiales que deben enviarnos (' + r.materiales.nos_envian.length + ')', r.materiales.nos_envian);
    bloque('Responsables indicados (' + r.responsables.length + ')',
      r.responsables.map(function (d) { return [d.nombre, d.cargo, d.email, d.whatsapp].filter(Boolean).join(' · '); }));
    bloque('Alcance final aceptado', [r.alcance.aceptado + (r.alcance.cambios ? ' — ' + r.alcance.cambios : '')]);

    destino.appendChild(caja);

    var pre = el('pre', 'salida', resumenTexto(r));
    destino.appendChild(pre);

    var nav = el('div', 'navegacion');
    var copiar = el('button', 'btn primario', 'Copiar resumen');
    copiar.type = 'button';
    var aviso = el('span', 'avisado');
    copiar.addEventListener('click', function () {
      var texto = resumenTexto(construirResumen());
      var ok = function () { aviso.textContent = 'Resumen copiado.'; setTimeout(function () { aviso.textContent = ''; }, 2600); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(texto).then(ok, function () { seleccionar(pre); });
      } else { seleccionar(pre); }
    });

    var json = el('button', 'btn fantasma', 'Descargar JSON');
    json.type = 'button';
    json.addEventListener('click', function () {
      descargar('validacion-dulces-providencia.json',
        JSON.stringify(construirResumen(), null, 2), 'application/json');
    });

    var txt = el('button', 'btn fantasma', 'Descargar TXT');
    txt.type = 'button';
    txt.addEventListener('click', function () {
      descargar('validacion-dulces-providencia.txt',
        resumenTexto(construirResumen()), 'text/plain;charset=utf-8');
    });

    var reset = el('button', 'btn peligro', 'Reiniciar reunión');
    reset.type = 'button';
    reset.addEventListener('click', function () {
      if (!window.confirm('Se borrarán TODAS las respuestas de esta reunión y no se pueden recuperar. ¿Continuamos?')) return;
      try { localStorage.removeItem(CLAVE); } catch (e) { /* nada que hacer */ }
      estado = { entendimiento: {}, respuestas: {}, iniciado: new Date().toISOString() };
      indice = 0;
      render();
      document.getElementById('validacion').scrollIntoView({ behavior: 'smooth' });
    });

    nav.appendChild(copiar); nav.appendChild(json); nav.appendChild(txt); nav.appendChild(reset);
    nav.appendChild(aviso);
    destino.appendChild(nav);
  }

  function seleccionar(nodo) {
    var rango = document.createRange();
    rango.selectNodeContents(nodo);
    var sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(rango);
  }

  /* ---------- render general ---------- */

  var hoja = document.getElementById('hoja');
  var pasosUI = document.getElementById('pasos');
  var barra = document.getElementById('barra');

  function render() {
    var paso = PASOS[indice];

    // fases
    pasosUI.textContent = '';
    var faseActual = paso.fase;
    var iActual = FASES.indexOf(faseActual);
    FASES.forEach(function (f, i) {
      var s = el('span', i === iActual ? 'on' : i < iActual ? 'hecho' : '', f);
      pasosUI.appendChild(s);
    });
    barra.style.width = Math.round(((indice) / (PASOS.length - 1)) * 100) + '%';

    hoja.textContent = '';
    hoja.appendChild(el('h3', null, paso.titulo));
    if (paso.lead) hoja.appendChild(el('p', 'lead', paso.lead));

    if (paso.tipo === 'entendimiento') pintarEntendimiento(hoja);
    if (paso.tipo === 'alcance') pintarAlcance(hoja);
    if (paso.tipo === 'resumen') { pintarResumen(hoja); return; }

    (paso.preguntas || []).forEach(function (preg) {
      var caja = el('div', 'preg');
      caja.appendChild(el('h4', null, preg.texto));
      if (preg.pista) caja.appendChild(el('p', 'pista', preg.pista));
      (PINTORES[preg.tipo] || function () {})(preg, caja);
      hoja.appendChild(caja);
    });

    var nav = el('div', 'navegacion');
    if (indice > 0) {
      var atras = el('button', 'btn fantasma', '← Atrás');
      atras.type = 'button';
      atras.addEventListener('click', function () { indice -= 1; render(); subir(); });
      nav.appendChild(atras);
    }
    var sig = el('button', 'btn primario',
      indice === PASOS.length - 2 ? 'Ver el resumen →' : 'Siguiente →');
    sig.type = 'button';
    sig.addEventListener('click', function () { indice += 1; render(); subir(); });
    nav.appendChild(sig);
    nav.appendChild(el('span', 'cuenta', 'Pantalla ' + (indice + 1) + ' de ' + PASOS.length));
    hoja.appendChild(nav);
  }

  function subir() {
    document.getElementById('validacion').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Se acota contra la longitud actual del guion: si el guion cambia entre
  // versiones, una pantalla guardada que ya no existe no puede romper la página.
  var guardada = Number(estado.pantalla || 0);
  if (Number.isFinite(guardada) && guardada > 0 && guardada < PASOS.length) indice = guardada;

  render();
})();
