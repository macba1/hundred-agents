/* ============================================================
   Simulador de WhatsApp de la demo.

   No hay respuestas precocinadas: cada turno viaja a POST /api/demo-chat,
   que ejecuta el agente real (mismo prompt, mismo catálogo, mismas reglas)
   contra OpenAI en el servidor. La clave nunca está aquí.

   El historial vive en esta página y viaja en cada petición: el endpoint es
   sin estado, así que cualquier instancia serverless puede atender cualquier
   turno de la conversación.
   ============================================================ */
(function () {
  'use strict';

  var CLIENTE = 'providencia';
  var ENDPOINT = '/api/demo-chat';

  var hilo = document.getElementById('hilo');
  var forma = document.getElementById('forma');
  var entrada = document.getElementById('entrada');
  var enviar = document.getElementById('enviar');
  var cajaSug = document.getElementById('sugerencias');
  var subtitulo = document.getElementById('wa-sub');

  var tarjetaLead = document.getElementById('tarjeta-lead');
  var traza = document.getElementById('traza');
  var trazaVacia = document.getElementById('traza-vacia');
  var tarjetaTraza = document.getElementById('tarjeta-traza');

  var historial = [];
  var ocupado = false;

  var SUGERENCIAS_INICIO = [
    'Hola',
    'Ver productos',
    'Quiero vender sus productos',
    'Dónde comprar',
    'Hablar con Ventas',
  ];

  /* ---- utilidades ---- */

  function hora() {
    var d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function escapar(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** Negritas y cursivas al estilo WhatsApp (*negrita*, _cursiva_). */
  function formato(texto) {
    return escapar(texto)
      .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)_([^_\n]+)_/g, '$1<em>$2</em>');
  }

  function abajo() {
    hilo.scrollTop = hilo.scrollHeight;
  }

  function burbuja(texto, quien) {
    var b = document.createElement('div');
    b.className = 'burbuja ' + (quien === 'yo' ? 'yo' : 'bot');
    b.innerHTML = formato(texto) + '<span class="hora">' + hora() + '</span>';
    hilo.appendChild(b);
    abajo();
    return b;
  }

  function escribiendo(on) {
    var v = document.getElementById('escribiendo');
    if (!on) { if (v) v.remove(); return; }
    if (v) return;
    var d = document.createElement('div');
    d.className = 'escribiendo';
    d.id = 'escribiendo';
    d.innerHTML = '<i></i><i></i><i></i>';
    hilo.appendChild(d);
    abajo();
  }

  /* ---- sugerencias rápidas (ayudas de UX, no un árbol rígido) ---- */

  function pintarSugerencias(lista) {
    cajaSug.textContent = '';
    if (!lista || !lista.length) { cajaSug.hidden = true; return; }
    cajaSug.hidden = false;
    lista.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = t;
      b.addEventListener('click', function () { mandar(t); });
      cajaSug.appendChild(b);
    });
  }

  /* ---- panel lateral ---- */

  var ETIQUETAS = {
    nombre: 'Nombre', empresa: 'Empresa / negocio', ciudad: 'Ciudad', estado: 'Estado',
    pais: 'País', tipo_negocio: 'Tipo de negocio', productos_interes: 'Productos de interés',
    volumen_aproximado: 'Volumen aproximado', telefono: 'Teléfono', email: 'Correo',
    contacto_preferido: 'Contacto preferido', resumen: 'Qué necesita',
  };
  var ORDEN = ['empresa', 'tipo_negocio', 'ciudad', 'estado', 'pais', 'productos_interes',
    'volumen_aproximado', 'telefono', 'email', 'contacto_preferido', 'resumen'];
  var ANCHOS = { productos_interes: true, resumen: true };

  function pintarLead(lead) {
    document.getElementById('lead-nombre').textContent = lead.nombre || 'Prospecto sin nombre';
    document.getElementById('lead-folio').textContent = lead.folio || '';

    var campos = document.getElementById('lead-campos');
    campos.textContent = '';
    ORDEN.forEach(function (k) {
      var v = lead[k];
      if (v == null || v === '') return;
      if (Array.isArray(v)) v = v.join(', ');
      var d = document.createElement('div');
      if (ANCHOS[k]) d.className = 'ancho';
      var dt = document.createElement('dt'); dt.textContent = ETIQUETAS[k] || k;
      var dd = document.createElement('dd'); dd.textContent = v;
      d.appendChild(dt); d.appendChild(dd);
      campos.appendChild(d);
    });

    var pie = document.getElementById('lead-pie');
    pie.textContent = '';
    var prio = document.createElement('span');
    prio.className = 'prio ' + (lead.prioridad || 'por_valorar');
    prio.textContent = 'Prioridad ' + String(lead.prioridad || 'por valorar').replace('_', ' ');
    pie.appendChild(prio);
    var faltan = (lead.completitud && lead.completitud.faltantes) || [];
    var t = document.createElement('span');
    t.style.marginLeft = '10px';
    t.textContent = faltan.length
      ? 'Falta por confirmar: ' + faltan.map(function (k) { return (ETIQUETAS[k] || k).toLowerCase(); }).join(', ') + '.'
      : 'Ficha completa según los campos propuestos.';
    pie.appendChild(t);

    tarjetaLead.hidden = false;
    tarjetaLead.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function anotarTraza(clase, titulo, detalle) {
    trazaVacia.hidden = true;
    traza.hidden = false;
    tarjetaTraza.classList.add('viva');
    var li = document.createElement('li');
    var ico = document.createElement('span');
    ico.className = 'ico ' + clase;
    ico.textContent = clase === 'buscar' ? '⌕' : clase === 'escalar' ? '↑' : '✓';
    var txt = document.createElement('div');
    var b = document.createElement('b'); b.textContent = titulo;
    var p = document.createElement('span'); p.textContent = detalle;
    txt.appendChild(b); txt.appendChild(p);
    li.appendChild(ico); li.appendChild(txt);
    traza.appendChild(li);
  }

  /* ---- un turno ---- */

  function mandar(texto) {
    texto = String(texto || '').trim();
    if (!texto || ocupado) return;

    burbuja(texto, 'yo');
    entrada.value = '';
    entrada.style.height = 'auto';
    pintarSugerencias([]);
    ocupado = true;
    enviar.disabled = true;
    subtitulo.textContent = 'escribiendo…';
    escribiendo(true);

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client: CLIENTE, mensaje: texto, historial: historial }),
    })
      .then(function (r) { return r.json().then(function (j) { return { estado: r.status, cuerpo: j }; }); })
      .then(function (res) {
        escribiendo(false);
        var j = res.cuerpo || {};

        if (!j.ok) {
          burbuja(j.respuesta || 'La demostración no está disponible en este momento. Vuelve a intentarlo en un minuto.', 'bot');
          return;
        }

        historial = j.historial || historial;
        burbuja(j.respuesta, 'bot');

        (j.busquedas || []).forEach(function (b) {
          anotarTraza('buscar', 'Consulta al catálogo',
            (b.consulta ? '“' + b.consulta + '”' : 'catálogo completo') +
            ' — ' + b.total + ' coincidencia' + (b.total === 1 ? '' : 's'));
        });
        (j.escalamientos || []).forEach(function (e) {
          anotarTraza('escalar', 'Marcado para el equipo comercial', e.motivo);
        });
        (j.leads || []).forEach(function (l) {
          anotarTraza('lead', 'Ficha de prospecto creada', l.folio + ' · ' + (l.nombre || ''));
          pintarLead(l);
        });

        if (j.limite) pintarSugerencias([]);
      })
      .catch(function (err) {
        escribiendo(false);
        console.error('[demo] fallo de red', err);
        burbuja('Se cortó la conexión con el asistente. ¿Me repites tu mensaje?', 'bot');
      })
      .then(function () {
        ocupado = false;
        enviar.disabled = false;
        subtitulo.textContent = 'en línea';
        entrada.focus();
      });
  }

  /* ---- eventos ---- */

  forma.addEventListener('submit', function (e) {
    e.preventDefault();
    mandar(entrada.value);
  });

  entrada.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      mandar(entrada.value);
    }
  });

  entrada.addEventListener('input', function () {
    entrada.style.height = 'auto';
    entrada.style.height = Math.min(entrada.scrollHeight, 110) + 'px';
  });

  pintarSugerencias(SUGERENCIAS_INICIO);
})();
