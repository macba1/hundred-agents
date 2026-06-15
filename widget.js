/* ============================================================
   Chat widget — talks ONLY to /api/chat (and /api/lead is used
   server-side). No API keys here. Mode comes from the script's
   data-mode attribute ("home" | "mexico").
   ============================================================ */
(function () {
  'use strict';

  const script = document.currentScript || document.querySelector('script[data-mode]');
  const MODE = (script && script.dataset.mode) === 'mexico' ? 'mexico' : 'home';

  const T = {
    en: {
      launch: 'Chat with us',
      title: 'Hundred Agents',
      sub: MODE === 'mexico' ? 'Conference · Mexico 2026' : 'AI workflow assistant',
      placeholder: 'Type your message…',
      greet: MODE === 'mexico'
        ? "Hi — I help you with two things: registering for the AI en Acción · México 2026 conference and, if you want, leaving a question for our speakers Ruth and Antonio. Shall we start your registration?"
        : "Hi — I'm the Hundred Agents assistant. Ask me anything about applying AI in your business, and I can connect you with the team.",
      error: 'Something went wrong on our side. Please email info@thehagentic.com and we\'ll help you directly.',
      close: 'Close chat',
    },
    es: {
      launch: 'Chatea con nosotros',
      title: 'Hundred Agents',
      sub: MODE === 'mexico' ? 'Conferencia · México 2026' : 'Asistente de workflows AI',
      placeholder: 'Escribe tu mensaje…',
      greet: MODE === 'mexico'
        ? 'Hola — te ayudo con dos cosas: registrarte para la conferencia AI en Acción · México 2026 y, si quieres, dejar una pregunta para nuestros ponentes Ruth y Antonio. ¿Empezamos con tu registro?'
        : 'Hola — soy el asistente de Hundred Agents. Pregúntame lo que quieras sobre aplicar AI en tu negocio y puedo ponerte en contacto con el equipo.',
      error: 'Algo falló de nuestro lado. Escríbenos a info@thehagentic.com y te ayudamos directamente.',
      close: 'Cerrar chat',
    },
  };

  const lang = () => (document.documentElement.lang === 'es' ? 'es' : 'en');
  const t = () => T[lang()];

  const messages = [];   // {role, content}
  let busy = false;
  let greeted = false;

  // ---- build DOM ----
  const launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'ha-chat-launcher';
  launcher.setAttribute('aria-haspopup', 'dialog');

  const panel = document.createElement('div');
  panel.className = 'ha-chat-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-label', 'Hundred Agents chat');
  panel.innerHTML = `
    <div class="ha-chat-head">
      <div>
        <div class="title"><span class="sq"></span><span class="t-title"></span></div>
        <div class="sub t-sub"></div>
      </div>
      <button type="button" class="ha-chat-close" aria-label="">&times;</button>
    </div>
    <div class="ha-chat-log" role="log" aria-live="polite"></div>
    <form class="ha-chat-form">
      <textarea class="ha-chat-input" rows="1" aria-label="Message"></textarea>
      <button type="submit" class="ha-chat-send" aria-label="Send">&rarr;</button>
    </form>`;

  document.body.appendChild(launcher);
  document.body.appendChild(panel);

  const log = panel.querySelector('.ha-chat-log');
  const form = panel.querySelector('.ha-chat-form');
  const input = panel.querySelector('.ha-chat-input');
  const sendBtn = panel.querySelector('.ha-chat-send');
  const closeBtn = panel.querySelector('.ha-chat-close');

  function applyLabels() {
    const s = t();
    launcher.innerHTML = '<span class="dot"></span>' + s.launch;
    panel.querySelector('.t-title').textContent = s.title;
    panel.querySelector('.t-sub').textContent = s.sub;
    input.placeholder = s.placeholder;
    closeBtn.setAttribute('aria-label', s.close);
  }
  applyLabels();

  function addMsg(role, content) {
    const el = document.createElement('div');
    el.className = 'ha-msg ' + (role === 'user' ? 'user' : 'bot');
    if (role === 'bot') el.innerHTML = linkify(content);
    else el.textContent = content;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function linkify(text) {
    const esc = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return esc
      .replace(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, '<a href="mailto:$1">$1</a>')
      .replace(/\n/g, '<br>');
  }

  let typingEl = null;
  function showTyping() {
    typingEl = document.createElement('div');
    typingEl.className = 'ha-typing';
    typingEl.innerHTML = '<span></span><span></span><span></span>';
    log.appendChild(typingEl);
    log.scrollTop = log.scrollHeight;
  }
  function hideTyping() { if (typingEl) { typingEl.remove(); typingEl = null; } }

  function openPanel() {
    panel.classList.add('open');
    launcher.hidden = true;
    if (!greeted) { greeted = true; const g = t().greet; messages.push({ role: 'assistant', content: g }); addMsg('bot', g); }
    setTimeout(() => input.focus(), 50);
  }
  function closePanel() { panel.classList.remove('open'); launcher.hidden = false; launcher.focus(); }

  launcher.addEventListener('click', openPanel);
  closeBtn.addEventListener('click', closePanel);

  // Let any in-page CTA open the existing chat (no new flow).
  document.querySelectorAll('[data-ha-chat-open]').forEach((el) => {
    el.addEventListener('click', (e) => { e.preventDefault(); openPanel(); });
  });
  // Public hook for buttons added later.
  window.HAChat = { open: openPanel, close: closePanel };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel.classList.contains('open')) closePanel(); });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 110) + 'px';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;

    input.value = '';
    input.style.height = 'auto';
    messages.push({ role: 'user', content: text });
    addMsg('user', text);

    busy = true; sendBtn.disabled = true; showTyping();
    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: MODE, messages }),
      });
      hideTyping();
      if (!resp.ok) throw new Error('http ' + resp.status);
      const data = await resp.json();
      const reply = data.reply || '';
      messages.push({ role: 'assistant', content: reply });
      addMsg('bot', reply);
    } catch (err) {
      hideTyping();
      addMsg('bot', t().error);
    } finally {
      busy = false; sendBtn.disabled = false; input.focus();
    }
  });
})();
