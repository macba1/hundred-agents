/* ============================================================
   Vitrina "Lo que el agente ya conoce".

   Se sirve de GET /api/demo-chat?client=providencia, que devuelve una
   proyección del MISMO catalogo.json que consulta el agente. No hay copia
   del catálogo en el navegador a propósito: si mañana cambia un producto,
   el chat y esta sección cambian a la vez o no cambia ninguno.
   ============================================================ */
(function () {
  'use strict';

  var cats = document.getElementById('cats');
  var desc = document.getElementById('cat-desc');
  var rejilla = document.getElementById('rejilla');
  var empresa = document.getElementById('empresa');

  var DIAS = {
    lunes: 'Lunes', martes: 'Martes', miercoles: 'Miércoles',
    jueves: 'Jueves', viernes: 'Viernes',
  };

  function pintarProductos(cat) {
    desc.textContent = cat.descripcion || '';
    rejilla.textContent = '';
    cat.productos.forEach(function (p) {
      var art = document.createElement('article');
      art.className = 'prod';

      if (p.imagen) {
        var foto = document.createElement('div');
        foto.className = 'prod-foto';
        var img = document.createElement('img');
        img.src = p.imagen;
        img.alt = p.nombre;
        img.loading = 'lazy';
        img.decoding = 'async';
        foto.appendChild(img);
        art.appendChild(foto);
      }

      var cuerpo = document.createElement('div');
      cuerpo.className = 'prod-cuerpo';
      var h = document.createElement('h3'); h.textContent = p.nombre;
      cuerpo.appendChild(h);
      if (p.descripcion) {
        var d = document.createElement('p'); d.textContent = p.descripcion;
        cuerpo.appendChild(d);
      }
      if (p.presentaciones && p.presentaciones.length) {
        var pres = document.createElement('div');
        pres.className = 'pres';
        p.presentaciones.forEach(function (t) {
          var s = document.createElement('span'); s.textContent = t;
          pres.appendChild(s);
        });
        cuerpo.appendChild(pres);
      }
      art.appendChild(cuerpo);
      rejilla.appendChild(art);
    });
  }

  function pintarEmpresa(v) {
    var horario = Object.keys(DIAS)
      .map(function (k) { return DIAS[k] + ': ' + (v.horarios[k] || '—'); })
      .join('\n');

    var filas = [
      ['Dónde están', v.direccion],
      ['Horario publicado', horario],
      ['Contacto publicado', v.telefonos + '\n' + v.email],
      ['Desde', (v.empresa.fundacion || '') + '. ' + (v.empresa.trayectoria || '')],
      ['Presencia', 'México, Estados Unidos y Centroamérica. Cobertura y condiciones concretas: por confirmar con el equipo comercial.'],
      ['Certificaciones publicadas', 'La web menciona HACCP y FDA. Qué certificado aplica a qué producto está por confirmar.'],
    ];

    empresa.textContent = '';
    filas.forEach(function (f) {
      if (!f[1]) return;
      var div = document.createElement('div');
      var dt = document.createElement('dt'); dt.textContent = f[0];
      var dd = document.createElement('dd');
      dd.style.whiteSpace = 'pre-line';
      dd.textContent = f[1];
      div.appendChild(dt); div.appendChild(dd);
      empresa.appendChild(div);
    });
  }

  function pintar(v) {
    cats.textContent = '';
    v.categorias.forEach(function (cat, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
      var img = document.createElement('img');
      img.src = cat.imagen; img.alt = ''; img.loading = 'lazy';
      var span = document.createElement('span');
      span.textContent = cat.nombre + ' · ' + cat.productos.length;
      b.appendChild(img); b.appendChild(span);
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(cats.children, function (o) {
          o.setAttribute('aria-pressed', 'false');
        });
        b.setAttribute('aria-pressed', 'true');
        pintarProductos(cat);
      });
      cats.appendChild(b);
    });
    if (v.categorias.length) pintarProductos(v.categorias[0]);
    pintarEmpresa(v);
  }

  fetch('/api/demo-chat?client=providencia')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok || !j.vitrina) throw new Error('vitrina no disponible');
      pintar(j.vitrina);
    })
    .catch(function (err) {
      console.error('[catalogo]', err);
      desc.textContent = 'El catálogo no se pudo cargar en este entorno. ' +
        'Necesita el endpoint /api/demo-chat activo.';
    });
})();
