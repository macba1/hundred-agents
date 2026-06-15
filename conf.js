/* ============================================================
   Conference page (/conferencia-mexico-2026)
   Bilingual ES/EN + scroll reveals. Default language is ES;
   the EN copy here OVERWRITES the server-rendered ES text on
   switch — the page reads fully with JavaScript disabled.
   ============================================================ */

const STRINGS = {
  es: {
    nav: { why: 'Por qué', what: 'Qué hacemos', cases: 'Casos de uso', how: 'Cómo funciona', contact: 'Contacto' },
    hero: {
      eyebrow: 'Conferencia · México 2026',
      back: '← Volver al inicio',
      title: 'AI en Acción',
      subtitle: 'Visión y aplicación práctica para tu negocio.',
    },
    kick: { context: 'El contexto', speakers: 'Los ponentes', topics: 'Qué abordamos', goal: 'El objetivo' },
    intro: {
      p1: 'La inteligencia artificial dejó de ser una tecnología reservada para las grandes corporaciones. Hoy, cualquier empresa, organización o negocio local puede usar AI para mejorar procesos, automatizar tareas, atender mejor a sus clientes y tomar mejores decisiones.',
      p2: 'En esta conferencia, Ruth Anaya (CEO & Founder) y Antonio Jiménez (Co-Founder & Strategic Advisor) comparten una visión práctica sobre cómo aplicar la inteligencia artificial de forma efectiva en empresas reales — respetando sus procesos, sus prioridades y su forma de trabajar.',
    },
    speakers: { heading: 'Quiénes presentan.' },
    spk: {
      ruth: {
        role: 'CEO & Founder', name: 'Ruth Anaya',
        bio: 'Lidera la gestión de la compañía, la relación con clientes y la coordinación operativa de los proyectos. Su trabajo consiste en convertir necesidades reales de negocio en soluciones claras y ejecutables.',
      },
      antonio: {
        role: 'Co-Founder & Strategic Advisor', name: 'Antonio Jiménez',
        bio: 'Aporta la visión estratégica, con experiencia trabajando en el entorno de tecnología empresarial de primer nivel (Apple, Google, Amazon Web Services, ServiceNow, entre otras). Su enfoque se centra en lo que casi nadie explica bien: dónde la AI genera valor real, cómo priorizar los casos de uso correctos y cómo evitar implementaciones caras que no producen resultados.',
      },
    },
    topics: {
      body: 'Ejemplos concretos en: atención al cliente, operaciones, ventas, marketing, administración, análisis de información y automatización de workflows.',
    },
    goal: {
      label: 'El objetivo',
      body: 'Que salgas con un plan claro: qué procesos de tu negocio puedes mejorar, por dónde empezar, y cómo convertir la AI en una ventaja competitiva real — no en un gasto más.',
    },
    contact: { more: '¿Más información?' },
    footer: { text: '© 2026 Hundred Agents AI LLC · Austin, Texas · info@thehagentic.com' },
  },

  en: {
    nav: { why: 'Why', what: 'What we do', cases: 'Use cases', how: 'How it works', contact: 'Contact' },
    hero: {
      eyebrow: 'Conference · Mexico 2026',
      back: '← Back to home',
      title: 'AI in Action',
      subtitle: 'Vision and practical application for your business.',
    },
    kick: { context: 'The context', speakers: 'The speakers', topics: 'What we cover', goal: 'The goal' },
    intro: {
      p1: 'Artificial intelligence is no longer a technology reserved for large corporations. Today, any company, organization or local business can use AI to improve processes, automate tasks, serve customers better and make better decisions.',
      p2: 'In this conference, Ruth Anaya (CEO & Founder) and Antonio Jiménez (Co-Founder & Strategic Advisor) share a practical vision on how to apply artificial intelligence effectively in real companies — respecting their processes, their priorities and their way of working.',
    },
    speakers: { heading: 'Who presents.' },
    spk: {
      ruth: {
        role: 'CEO & Founder', name: 'Ruth Anaya',
        bio: "Leads the company's management, client relationships and the operational coordination of projects. Her work turns real business needs into clear, executable solutions.",
      },
      antonio: {
        role: 'Co-Founder & Strategic Advisor', name: 'Antonio Jiménez',
        bio: 'Brings the strategic vision, with experience working in the top-tier enterprise technology environment (Apple, Google, Amazon Web Services, ServiceNow, among others). His focus is on what almost no one explains well: where AI generates real value, how to prioritize the right use cases, and how to avoid expensive implementations that produce no results.',
      },
    },
    topics: {
      body: 'Concrete examples in: customer service, operations, sales, marketing, administration, information analysis and workflow automation.',
    },
    goal: {
      label: 'The goal',
      body: 'That you leave with a clear plan: which processes in your business you can improve, where to start, and how to turn AI into a real competitive advantage — not just another expense.',
    },
    contact: { more: 'More information?' },
    footer: { text: '© 2026 Hundred Agents AI LLC · Austin, Texas · info@thehagentic.com' },
  },
};

const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const lookup = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

let state = { lang: 'es' };

function applyI18n(t) {
  $$('[data-i18n]').forEach((el) => {
    const val = lookup(t, el.getAttribute('data-i18n'));
    if (typeof val === 'string') el.textContent = val;
  });
}

function setLang(lang) {
  if (!STRINGS[lang]) return;
  state.lang = lang;
  document.documentElement.lang = lang;
  applyI18n(STRINGS[lang]);
  $$('.lang-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.lang === lang));
  observeReveals();
}

/* scroll reveals */
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

function init() {
  // ES content is server-rendered in the HTML — do NOT rebuild it at load.
  // JS only swaps copy when the user switches language.
  state.lang = document.documentElement.lang === 'en' ? 'en' : 'es';
  $$('.lang-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.lang === state.lang);
    b.addEventListener('click', () => setLang(b.dataset.lang));
  });
  observeReveals();
  window.addEventListener('scroll', observeReveals, { passive: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
