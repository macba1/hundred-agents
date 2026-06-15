/* ============================================================
   Hundred Agents — landing page logic
   Bilingual content, scroll reveals, FAQ accordion, contact
   form, and the live agentic-network canvas (FIG.01).
   Ported from the design prototype (Hundred Agents.dc.html).
   ============================================================ */

/* ---------------------------------------------------------------
   1. Copy (EN / ES)
--------------------------------------------------------------- */
const STRINGS = {
  en: {
    nav: { why: 'Why', what: 'What we do', cases: 'Use cases', how: 'How it works', contact: 'Contact' },
    kick: { why: 'The problem', what: 'The method', dyn: 'The principle', cases: 'The applications', how: 'The engagement', faq: 'Questions' },
    legend: { agents: 'Agents', gate: 'Human gate', exec: 'Execution' },
    fig1: 'THE_AGENTIC_WORKFLOW', fig1note: 'Live', fig2: 'CONTROLLED_AUTOMATION', fig2note: 'Constraints → outcome',
    hero: {
      eyebrow: 'AI workflow infrastructure',
      titlePre: 'You know AI matters. The real question is ',
      titleEm: 'where it works',
      titlePost: ' inside your company.',
      subtitle: 'We map how your business runs today, find where AI agents create real value, and deploy them inside your workflows — without breaking the processes that already work.',
      cta1: 'Start with your workflow',
      cta2: 'See use cases',
    },
    why: {
      heading: "AI isn't the hard part. Knowing where to put it is.",
      cards: [
        { n: '01', title: 'You know AI is important', body: "The problem isn't awareness. It's knowing where AI creates real value instead of noise." },
        { n: '02', title: 'Your workflows are complex', body: 'Every company has rules, approvals, exceptions and systems. AI has to respect all of them.' },
        { n: '03', title: 'Agents need control', body: 'Agents act inside your tools. That power needs permissions, limits, approvals and traceability.' },
      ],
    },
    what: {
      heading: 'From a process you already run to agents you can trust.',
      steps: [
        { num: '01', title: 'Workflow discovery', body: 'We map how the work actually happens today — people, steps, systems and handoffs.' },
        { num: '02', title: 'AI opportunity mapping', body: 'We pinpoint where agents add speed and where humans must stay in control.' },
        { num: '03', title: 'Agentic workflow design', body: 'We design dynamic workflows that adapt to context but follow your business rules.' },
        { num: '04', title: 'Implementation & governance', body: 'We deploy with permissions, approvals and audit trails built in from day one.' },
      ],
    },
    dyn: {
      heading: 'Dynamic workflows, not chaotic ones.',
      body: 'Agents adapt to context — but always respect business rules, permissions and human approval points. Power with guardrails, not autonomy without limits.',
      inputsLabel: 'Inputs',
      inputs: ['Business rules', 'Company systems', 'AI agents', 'Human approval', 'Audit trail'],
      outLabel: 'Output', outFull: 'Controlled agentic workflow',
      caption: 'Every input constrains the system. The result is automation you can hand to an auditor.',
    },
    cases: {
      heading: 'Where teams start — and where they grow.',
      tiers: [
        { name: 'Small business', tag: 'Start here', items: ['Lead intake', 'Follow-up emails', 'Scheduling', 'Document extraction', 'Weekly reports'] },
        { name: 'Growing company', tag: 'Most common', items: ['CRM updates', 'Ticket triage', 'Proposal drafts', 'Knowledge assistants', 'Ops dashboards'] },
        { name: 'Enterprise', tag: 'At scale', items: ['Human-in-the-loop approvals', 'Audit trails', 'Policy-based automation', 'Multi-system orchestration', 'AI governance'] },
      ],
    },
    how: {
      heading: 'Four steps from idea to measured result.',
      steps: [
        { num: '1', title: 'Map the current workflow', body: 'We document how it runs today, with no changes yet.' },
        { num: '2', title: 'Pick the first use case', body: 'We choose one workflow where AI pays off fast and safely.' },
        { num: '3', title: 'Design the agentic workflow', body: 'We build the agents, rules and approval points around it.' },
        { num: '4', title: 'Deploy and measure', body: 'We ship it, track results and expand from proof, not hype.' },
      ],
    },
    faq: {
      heading: 'Straight answers.',
      items: [
        { q: 'Why not just buy an AI tool?', a: "Tools are generic. Your workflows aren't. We make AI fit your process, systems and rules — not the other way around." },
        { q: 'Do you replace our current processes?', a: 'No. We map what already works, then add agents only where they create value. The process stays yours.' },
        { q: 'Can this work for small companies?', a: 'Yes. Small teams often see the fastest wins — lead intake, follow-ups, scheduling and reports.' },
        { q: 'Can this work for enterprise teams?', a: 'Yes. We design for permissions, audit trails, policy-based automation and multi-system orchestration.' },
        { q: 'What is an agentic workflow?', a: 'A workflow where AI agents take actions across your tools — within business rules, permissions and human approval points.' },
      ],
    },
    contact: {
      eyebrow: 'Contact',
      heading: 'Show us one workflow that wastes time.',
      sub: "We'll show you where AI can help. No deck required — bring one real process and we'll map where agents fit.",
      meta: 'Hundred Agents · Austin, Texas',
      form: {
        name: 'Name', namePh: 'Jane Doe',
        email: 'Work email', emailPh: 'jane@company.com',
        problem: 'The workflow that wastes time', problemPh: 'Describe one process — what happens today, who is involved, and where it slows down.',
        submit: 'Request a workflow review',
        privacy: 'No spam · reply in 1 business day',
        status: 'Received',
        success: 'Request received.',
        successSub: "We'll reply within one business day to schedule your workflow review. Nothing else lands in your inbox.",
        errRequired: 'Please complete all three fields.',
        errEmail: 'Enter a valid email address.',
      },
    },
    footer: { text: '© 2026 Hundred Agents AI LLC · Austin, Texas · info@thehagentic.com' },
  },

  es: {
    nav: { why: 'Por qué', what: 'Qué hacemos', cases: 'Casos de uso', how: 'Cómo funciona', contact: 'Contacto' },
    kick: { why: 'El problema', what: 'El método', dyn: 'El principio', cases: 'Las aplicaciones', how: 'El proceso', faq: 'Preguntas' },
    legend: { agents: 'Agentes', gate: 'Gate humano', exec: 'Ejecución' },
    fig1: 'EL_WORKFLOW_AGENTIC', fig1note: 'En vivo', fig2: 'AUTOMATIZACION_CONTROLADA', fig2note: 'Restricciones → resultado',
    hero: {
      eyebrow: 'Infraestructura de workflows con AI',
      titlePre: 'Sabes que la AI importa. La pregunta real es ',
      titleEm: 'dónde funciona',
      titlePost: ' dentro de tu empresa.',
      subtitle: 'Mapeamos cómo opera tu negocio hoy, encontramos dónde los agentes AI crean valor real y los desplegamos dentro de tus workflows — sin romper los procesos que ya funcionan.',
      cta1: 'Empieza con tu workflow',
      cta2: 'Ver casos de uso',
    },
    why: {
      heading: 'La AI no es lo difícil. Saber dónde ponerla, sí.',
      cards: [
        { n: '01', title: 'Sabes que la AI es importante', body: 'El problema no es la conciencia. Es saber dónde la AI crea valor real en vez de ruido.' },
        { n: '02', title: 'Tus workflows son complejos', body: 'Toda empresa tiene reglas, aprobaciones, excepciones y sistemas. La AI debe respetarlos todos.' },
        { n: '03', title: 'Los agentes necesitan control', body: 'Los agentes actúan dentro de tus herramientas. Ese poder necesita permisos, límites, aprobaciones y trazabilidad.' },
      ],
    },
    what: {
      heading: 'De un proceso que ya operas a agentes en los que puedes confiar.',
      steps: [
        { num: '01', title: 'Descubrimiento del workflow', body: 'Mapeamos cómo sucede el trabajo hoy — personas, pasos, sistemas y traspasos.' },
        { num: '02', title: 'Mapeo de oportunidades AI', body: 'Identificamos dónde los agentes aportan velocidad y dónde el humano mantiene el control.' },
        { num: '03', title: 'Diseño de workflow agentic', body: 'Diseñamos workflows dinámicos que se adaptan al contexto pero siguen tus reglas de negocio.' },
        { num: '04', title: 'Implementación y gobierno', body: 'Desplegamos con permisos, aprobaciones y trazabilidad desde el primer día.' },
      ],
    },
    dyn: {
      heading: 'Workflows dinámicos, no caóticos.',
      body: 'Los agentes se adaptan al contexto — pero siempre respetan reglas de negocio, permisos y puntos de aprobación humana. Poder con límites, no autonomía sin control.',
      inputsLabel: 'Entradas',
      inputs: ['Reglas de negocio', 'Sistemas de la empresa', 'Agentes AI', 'Aprobación humana', 'Trazabilidad'],
      outLabel: 'Resultado', outFull: 'Workflow agentic controlado',
      caption: 'Cada entrada restringe el sistema. El resultado es automatización que puedes entregar a un auditor.',
    },
    cases: {
      heading: 'Dónde empiezan los equipos — y hacia dónde crecen.',
      tiers: [
        { name: 'Pequeña empresa', tag: 'Empieza aquí', items: ['Captación de leads', 'Emails de seguimiento', 'Agendado', 'Extracción de documentos', 'Reportes semanales'] },
        { name: 'Empresa en crecimiento', tag: 'Lo más común', items: ['Actualización de CRM', 'Triage de tickets', 'Borradores de propuestas', 'Asistentes de conocimiento', 'Dashboards de operaciones'] },
        { name: 'Enterprise', tag: 'A escala', items: ['Aprobaciones con humano en el loop', 'Trazabilidad', 'Automatización por políticas', 'Orquestación multi-sistema', 'Gobierno de AI'] },
      ],
    },
    how: {
      heading: 'Cuatro pasos de la idea al resultado medido.',
      steps: [
        { num: '1', title: 'Mapea el workflow actual', body: 'Documentamos cómo opera hoy, sin cambios todavía.' },
        { num: '2', title: 'Elige el primer caso de uso', body: 'Escogemos un workflow donde la AI rinde rápido y seguro.' },
        { num: '3', title: 'Diseña el workflow agentic', body: 'Construimos los agentes, reglas y puntos de aprobación alrededor.' },
        { num: '4', title: 'Despliega y mide', body: 'Lo lanzamos, medimos resultados y crecemos desde la prueba, no el hype.' },
      ],
    },
    faq: {
      heading: 'Respuestas claras.',
      items: [
        { q: '¿Por qué no comprar una herramienta de AI y ya?', a: 'Las herramientas son genéricas. Tus workflows no. Hacemos que la AI se ajuste a tu proceso, sistemas y reglas — no al revés.' },
        { q: '¿Reemplazan nuestros procesos actuales?', a: 'No. Mapeamos lo que ya funciona y añadimos agentes solo donde crean valor. El proceso sigue siendo tuyo.' },
        { q: '¿Funciona para empresas pequeñas?', a: 'Sí. Los equipos pequeños suelen ver los resultados más rápidos — leads, seguimientos, agendado y reportes.' },
        { q: '¿Funciona para equipos enterprise?', a: 'Sí. Diseñamos para permisos, trazabilidad, automatización por políticas y orquestación multi-sistema.' },
        { q: '¿Qué es un workflow agentic?', a: 'Un workflow donde los agentes AI ejecutan acciones en tus herramientas — dentro de reglas de negocio, permisos y puntos de aprobación humana.' },
      ],
    },
    contact: {
      eyebrow: 'Contacto',
      heading: 'Muéstranos un workflow que pierde tiempo.',
      sub: 'Te mostramos dónde puede ayudar la AI. Sin presentación — trae un proceso real y mapeamos dónde encajan los agentes.',
      meta: 'Hundred Agents · Austin, Texas',
      form: {
        name: 'Nombre', namePh: 'Juana Pérez',
        email: 'Correo de trabajo', emailPh: 'juana@empresa.com',
        problem: 'El workflow que pierde tiempo', problemPh: 'Describe un proceso — qué pasa hoy, quién participa y dónde se traba.',
        submit: 'Solicita una revisión de workflow',
        privacy: 'Sin spam · respuesta en 1 día hábil',
        status: 'Recibido',
        success: 'Solicitud recibida.',
        successSub: 'Te respondemos en un día hábil para agendar tu revisión de workflow. Nada más llega a tu bandeja.',
        errRequired: 'Completa los tres campos.',
        errEmail: 'Ingresa un correo válido.',
      },
    },
    footer: { text: '© 2026 Hundred Agents AI LLC · Austin, Texas · info@thehagentic.com' },
  },
};

/* ---------------------------------------------------------------
   2. State
--------------------------------------------------------------- */
const state = {
  lang: 'en',
  openFaq: 0,
  submitted: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Resolve a dotted key like "contact.form.name" against an object. */
function lookup(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

/* ---------------------------------------------------------------
   3. Rendering
--------------------------------------------------------------- */
function applyI18n(t) {
  $$('[data-i18n]').forEach((el) => {
    const val = lookup(t, el.getAttribute('data-i18n'));
    if (typeof val === 'string') el.textContent = val;
  });
}

function renderWhy(t) {
  $('#why-grid').innerHTML = t.why.cards.map((c) => `
    <div class="why-card" data-reveal>
      <div class="n">${c.n}</div>
      <h3>${esc(c.title)}</h3>
      <p>${esc(c.body)}</p>
    </div>`).join('');
}

function renderWhat(t) {
  $('#what-list').innerHTML = t.what.steps.map((s) => `
    <div class="what-row">
      <div class="num">${s.num}</div>
      <h3>${esc(s.title)}</h3>
      <p>${esc(s.body)}</p>
    </div>`).join('');
}

function renderDynInputs(t) {
  $('#dyn-inputs').innerHTML = t.dyn.inputs.map((label, i) => {
    const human = i === 3;
    const color = human ? '#FF4D00' : 'rgba(255,255,255,0.82)';
    return `
      <div class="dyn-input${human ? ' human' : ''}">
        <span class="ix" style="color:${color};">${'0' + (i + 1)}</span>
        <span class="lbl" style="color:${color};">${esc(label)}</span>
      </div>`;
  }).join('');
}

function renderCases(t) {
  $('#cases-grid').innerHTML = t.cases.tiers.map((tier, i) => {
    const hot = i === 1;
    const items = tier.items.map((label, k) => `
      <div class="tier-item">
        <span class="i">${String(k + 1).padStart(2, '0')}</span>
        <span class="lbl">${esc(label)}</span>
      </div>`).join('');
    return `
      <div class="tier${hot ? ' hot' : ''}" data-reveal>
        <div class="tier-head">
          <h3>${esc(tier.name)}</h3>
          <span class="tier-tag">${esc(tier.tag)}</span>
        </div>
        <div class="tier-rule"></div>
        ${items}
      </div>`;
  }).join('');
}

function renderHow(t) {
  $('#how-grid').innerHTML = t.how.steps.map((s) => `
    <div class="how-step" data-reveal>
      <div class="top">
        <span class="num">${s.num}</span>
        <span class="rule"></span>
      </div>
      <h3>${esc(s.title)}</h3>
      <p>${esc(s.body)}</p>
    </div>`).join('');
}

function renderFaq(t) {
  $('#faq-list').innerHTML = t.faq.items.map((it, i) => {
    const open = state.openFaq === i;
    return `
      <div class="faq-item${open ? ' open' : ''}" data-faq="${i}">
        <button class="faq-q" type="button" aria-expanded="${open}">
          <span class="q-left"><span class="q-idx">06.${i + 1}</span><span class="q-text">${esc(it.q)}</span></span>
          <span class="q-icon">${open ? '–' : '+'}</span>
        </button>
        <div class="faq-answer"><p>${esc(it.a)}</p></div>
      </div>`;
  }).join('');

}

/**
 * FAQ accordion via event delegation on the container, so it works on the
 * server-rendered EN markup without a rebuild (and survives re-renders on
 * language switch — the container element persists).
 */
function setupFaq() {
  const list = $('#faq-list');
  if (!list) return;
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.faq-q');
    if (!btn || !list.contains(btn)) return;
    const item = btn.parentElement;
    const wasOpen = item.classList.contains('open');

    list.querySelectorAll('.faq-item').forEach((it) => {
      it.classList.remove('open');
      const q = it.querySelector('.faq-q');
      if (q) q.setAttribute('aria-expanded', 'false');
      const ic = it.querySelector('.q-icon');
      if (ic) ic.textContent = '+';
    });

    if (!wasOpen) {
      item.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      const ic = item.querySelector('.q-icon');
      if (ic) ic.textContent = '–';
      state.openFaq = Array.prototype.indexOf.call(list.children, item);
    } else {
      state.openFaq = -1;
    }
  });
}

function renderFormCopy(t) {
  $('#f-name').placeholder = t.contact.form.namePh;
  $('#f-email').placeholder = t.contact.form.emailPh;
  $('#f-problem').placeholder = t.contact.form.problemPh;
}

/** Minimal HTML escaping for interpolated copy. */
function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/* ---------------------------------------------------------------
   4. Language
--------------------------------------------------------------- */
function setLang(lang) {
  state.lang = lang;
  const t = STRINGS[lang];
  document.documentElement.lang = lang;

  applyI18n(t);
  renderWhy(t);
  renderWhat(t);
  renderDynInputs(t);
  renderCases(t);
  renderHow(t);
  renderFaq(t);
  renderFormCopy(t);

  $$('.lang-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.lang === lang));

  // Newly-injected list items need reveal wiring + immediate in-view check.
  observeReveals();
}

/* ---------------------------------------------------------------
   5. Scroll reveals
--------------------------------------------------------------- */
let revealObserver = null;
function observeReveals() {
  const els = $$('[data-reveal]:not(.rv-in)');
  if ('IntersectionObserver' in window) {
    if (!revealObserver) {
      revealObserver = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) { e.target.classList.add('rv-in'); revealObserver.unobserve(e.target); }
        });
      }, { threshold: 0.06, rootMargin: '0px 0px -5% 0px' });
    }
    els.forEach((el) => {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      if (r.top < vh * 0.95 && r.bottom > 0) el.classList.add('rv-in');
      else revealObserver.observe(el);
    });
  } else {
    els.forEach((el) => el.classList.add('rv-in'));
  }
}

/* ---------------------------------------------------------------
   6. Contact form
--------------------------------------------------------------- */
function setupForm() {
  const form = $('#contact-form');
  const errBox = $('#form-err');
  const errMsg = $('#form-err .msg');

  const clearErr = () => { errBox.hidden = true; };
  ['#f-name', '#f-email', '#f-problem'].forEach((s) => $(s).addEventListener('input', clearErr));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = STRINGS[state.lang];
    const name = $('#f-name').value.trim();
    const email = $('#f-email').value.trim();
    const problem = $('#f-problem').value.trim();

    if (!name || !email || !problem) {
      errMsg.textContent = t.contact.form.errRequired;
      errBox.hidden = false;
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      errMsg.textContent = t.contact.form.errEmail;
      errBox.hidden = false;
      return;
    }

    errBox.hidden = true;

    // Build a mailto: open the user's email client pre-filled with the
    // form fields. URL-encode everything (handles accents / special chars).
    const subjectMap = {
      en: 'Workflow review request — ' + name,
      es: 'Solicitud de revisión de workflow — ' + name,
    };
    const bodyMap = {
      en: `Name: ${name}\nWork email: ${email}\n\nThe workflow that wastes time:\n${problem}\n`,
      es: `Nombre: ${name}\nCorreo de trabajo: ${email}\n\nEl workflow que pierde tiempo:\n${problem}\n`,
    };
    const subject = subjectMap[state.lang] || subjectMap.en;
    const body = bodyMap[state.lang] || bodyMap.en;
    const mailto = 'mailto:info@thehagentic.com'
      + '?subject=' + encodeURIComponent(subject)
      + '&body=' + encodeURIComponent(body);
    window.location.href = mailto;

    state.submitted = true;
    form.hidden = true;
    $('#form-success').hidden = false;
  });
}

/* ---------------------------------------------------------------
   7. FIG.01 — live agentic network (canvas)
   Ported verbatim from the prototype.
--------------------------------------------------------------- */
function startViz() {
  const cv = $('#viz');
  if (!cv || !cv.getContext) return;
  const ctx = cv.getContext('2d');
  let W = 0, H = 0, dpr = 1;
  const padX = 54;
  const nodes = [
    { x: 0.05, y: 0.28 }, { x: 0.05, y: 0.50 }, { x: 0.05, y: 0.72 },
    { x: 0.30, y: 0.15 }, { x: 0.30, y: 0.38 }, { x: 0.30, y: 0.62 }, { x: 0.30, y: 0.85 },
    { x: 0.53, y: 0.30 }, { x: 0.53, y: 0.50 }, { x: 0.53, y: 0.70 },
    { x: 0.73, y: 0.50, type: 'gate' },
    { x: 0.93, y: 0.50, type: 'out' },
  ];
  const E = (a, b, hot) => ({ a, b, hot: !!hot });
  const edges = [
    E(0, 3), E(0, 4), E(1, 4), E(1, 5), E(2, 5), E(2, 6),
    E(3, 7), E(4, 7), E(4, 8), E(5, 8), E(5, 9), E(6, 9),
    E(7, 10, 1), E(8, 10, 1), E(9, 10, 1),
    E(10, 11, 1),
  ];
  const rand = (a, b) => a + Math.random() * (b - a);
  const N = 56;
  const parts = [];
  const spawn = (p) => { p.e = edges[(Math.random() * edges.length) | 0]; p.t = rand(-0.5, 0); p.sp = rand(0.22, 0.46); };
  for (let i = 0; i < N; i++) { const p = {}; spawn(p); p.t = Math.random(); parts.push(p); }
  const px = (n) => ({ x: padX + n.x * (W - 2 * padX), y: H * 0.12 + n.y * (H * 0.76) });

  const resize = () => {
    const r = cv.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.max(1, r.width * dpr); cv.height = Math.max(1, r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    W = r.width; H = r.height;
  };
  resize();
  window.addEventListener('resize', resize);

  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    const tnow = now / 1000;
    ctx.clearRect(0, 0, W, H);

    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.035)'; ctx.lineWidth = 1;
    for (let gx = padX; gx <= W - padX + 1; gx += 44) { ctx.beginPath(); ctx.moveTo(gx, H * 0.06); ctx.lineTo(gx, H * 0.94); ctx.stroke(); }

    // edges
    ctx.lineWidth = 1;
    edges.forEach((e) => { const a = px(nodes[e.a]), b = px(nodes[e.b]); ctx.strokeStyle = e.hot ? 'rgba(255,77,0,0.14)' : 'rgba(255,255,255,0.08)'; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); });

    // particles (streaks)
    parts.forEach((p) => {
      p.t += p.sp * dt;
      if (p.t > 1.05) spawn(p);
      if (p.t < 0) return;
      const a = px(nodes[p.e.a]), b = px(nodes[p.e.b]);
      const t = Math.min(p.t, 1), tt = Math.max(0, t - 0.16);
      const hx = a.x + (b.x - a.x) * t, hy = a.y + (b.y - a.y) * t;
      const tx = a.x + (b.x - a.x) * tt, ty = a.y + (b.y - a.y) * tt;
      const col = p.e.hot ? '255,77,0' : '255,255,255';
      const grad = ctx.createLinearGradient(tx, ty, hx, hy);
      grad.addColorStop(0, 'rgba(' + col + ',0)'); grad.addColorStop(1, 'rgba(' + col + ',0.85)');
      ctx.strokeStyle = grad; ctx.lineWidth = p.e.hot ? 2 : 1.4;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.fillStyle = 'rgba(' + col + ',1)'; ctx.shadowColor = 'rgba(' + col + ',0.9)'; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(hx, hy, p.e.hot ? 2.6 : 1.9, 0, 6.2832); ctx.fill(); ctx.shadowBlur = 0;
    });

    // nodes
    nodes.forEach((n, i) => {
      const c = px(n);
      if (n.type === 'gate') {
        const pulse = (Math.sin(tnow * 2.2) + 1) / 2;
        const rr = 13 + 7 * pulse;
        ctx.strokeStyle = 'rgba(255,77,0,' + (0.2 + 0.4 * pulse) + ')'; ctx.lineWidth = 1.5;
        ctx.strokeRect(c.x - rr, c.y - rr, rr * 2, rr * 2);
        ctx.fillStyle = 'rgba(255,77,0,0.18)'; ctx.fillRect(c.x - 8, c.y - 8, 16, 16);
        ctx.strokeStyle = '#FF4D00'; ctx.lineWidth = 2; ctx.strokeRect(c.x - 8, c.y - 8, 16, 16);
      } else if (n.type === 'out') {
        ctx.shadowColor = 'rgba(255,255,255,0.5)'; ctx.shadowBlur = 12;
        ctx.fillStyle = '#fff'; ctx.fillRect(c.x - 7, c.y - 7, 14, 14); ctx.shadowBlur = 0;
      } else {
        const a = 0.4 + 0.35 * ((Math.sin(tnow * 1.6 + i) + 1) / 2);
        ctx.fillStyle = '#0E0F12'; ctx.fillRect(c.x - 5, c.y - 5, 10, 10);
        ctx.strokeStyle = 'rgba(255,255,255,' + a + ')'; ctx.lineWidth = 1.2; ctx.strokeRect(c.x - 5, c.y - 5, 10, 10);
      }
    });

    // labels
    ctx.font = '10px "Geist Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    const g = px(nodes[10]); ctx.fillStyle = '#FF4D00'; ctx.fillText('HUMAN_GATE', g.x, g.y + 34);
    const o = px(nodes[11]); ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillText('EXEC', o.x, o.y + 30);
    ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(255,255,255,0.38)';
    ctx.fillText('AGENTS ×100', px(nodes[0]).x - 10, H * 0.075);

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/* ---------------------------------------------------------------
   8. Init
--------------------------------------------------------------- */
function init() {
  // EN content is server-rendered in the HTML — do NOT rebuild it at load.
  // JS only swaps copy when the user switches language (or back to EN).
  state.lang = document.documentElement.lang === 'es' ? 'es' : 'en';
  $$('.lang-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.lang === state.lang);
    b.addEventListener('click', () => setLang(b.dataset.lang));
  });
  setupForm();
  setupFaq();
  observeReveals();
  startViz();
  window.addEventListener('scroll', observeReveals, { passive: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
