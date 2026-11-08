// Chat widget — self-contained ES module for the Plataforma Web de
// Asistencia Jurídica Digital.
//
// Renders a chat box (message list + input + send), calls
// POST /chat/completions, shows a typing indicator, renders the answer and
// its sources, and shows the remaining balance when the caller is
// authenticated. Tailwind CSS must be loaded by the host page.
//
// The widget is intentionally framework-free and side-effect-free: it only
// touches the container you pass to mountChat(). It is meant to be embedded
// later in the "Preguntas" page and the app page.
//
// Usage:
//   import { mountChat } from '/js/chat-widget.js';
//   mountChat(document.getElementById('chat'), {
//     title: 'Preguntas',
//     welcomeMessage: 'Hola, ¿en qué puedo ayudarte?',
//     onBalanceChange: (balance) => { ... },
//   });

import { apiUrl } from './api-base.js';
import { avatarNode, botAvatarNode } from './avatar.js';
import { playChime, soundsEnabled } from './sounds.js?v=2';
import { typewrite } from './chat-typewriter.js?v=2';

/**
 * @param {string} tag
 * @param {Record<string, string>} attrs
 * @returns {HTMLElement}
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') {
      node.className = value;
    } else {
      node.setAttribute(key, value);
    }
  }

  for (const child of children) {
    if (typeof child === 'string') {
      node.appendChild(document.createTextNode(child));
    } else if (child instanceof Node) {
      node.appendChild(child);
    }
  }

  return node;
}

  // ---- Safe markdown for assistant answers --------------------------------
  // Chat answers are UNTRUSTED model output. The renderer escapes ALL HTML
  // first and then emits ONLY tags this code builds itself, so no raw tag
  // from the model can reach innerHTML. Links are restricted to http(s) and
  // same-site root-relative URLs. Subset: headings (#..####), **bold**,
  // *italic*, `code`, [links](url), - bullets, 1. ordered lists, <br>.
  const MD_CODE_STYLE = 'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;'
    + 'background:#e2e8f0;border-radius:4px;padding:1px 5px;font-size:12px;';

  function escapeHtmlText(s) {
    return String(s)
      .replace(/&/g, '&' + 'amp;')
      .replace(/</g, '&' + 'lt;')
      .replace(/>/g, '&' + 'gt;')
      .replace(/"/g, '&' + 'quot;')
      .replace(/'/g, '&' + '#39;');
  }

  function mdInline(escaped) {
    let s = escaped;
    // Links first so their brackets/parens never look like list syntax.
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, (m, t, u) =>
      '<a href="' + u + '" target="_blank" rel="noopener noreferrer" '
      + 'style="color:#2563eb;text-decoration:underline;">' + t + '</a>');
    // Bare URLs -> clickable, new window (escaped text, so only safe chars).
    s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)"']+)/g, (m, pre, u) =>
      pre + '<a href="' + u + '" target="_blank" rel="noopener noreferrer" '
      + 'style="color:#2563eb;text-decoration:underline;word-break:break-all;">' + u + '</a>');
    // Chilean phone numbers -> WhatsApp (wa.me). Only +56/56-prefixed or
    // bare mobile-shaped 9 XXXX XXXX groups; never inside a longer number.
    s = s.replace(/(^|[^\d.\w])(\+?56[\s.-]?)?(9[\s.-]?\d{4}[\s.-]?\d{4})(?!\d)/g, (m, pre, cc, num) => {
      const digits = ('' + num).replace(/\D/g, '');
      if (digits.length < 9 || digits.length > 11) return m;
      const wa = digits.startsWith('56') ? digits : '56' + digits;
      return pre + '<a href="https://wa.me/' + wa + '" target="_blank" rel="noopener noreferrer" '
        + 'style="color:#16a34a;text-decoration:underline;">' + num + '</a>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)~]|$)/g, '$1<em>$2</em>');
    s = s.replace(/`([^`\n]+)`/g, (m, c) => '<code style="' + MD_CODE_STYLE + '">' + c + '</code>');
    return s;
  }

  // Etiquetas numeradas (T11): cada enlace de página web de una respuesta del
  // asistente se lee "enlace N" (N = orden de aparición, se reinicia por
  // mensaje). El href NUNCA se reescribe (el listener del modal de video lo
  // lee) y title conserva la URL original (comillas blindadas por si acaso;
  // el texto ya viene escapado por el paso escape-first). Excepción: wa.me
  // conserva el número como texto — es un atajo de contacto, no un enlace a
  // un documento — y no consume número. Se numera el HTML armado (una sola
  // pasada, en orden de aparición real), porque mdInline convierte primero
  // los enlaces markdown y después las URLs sueltas: un contador dentro de
  // esas pasadas numeraría mal cuando ambas conviven en una misma línea.
  // Alcance: solo burbujas del asistente — renderChatMarkdown no se usa para
  // mensajes del usuario (textContent) y los botones de acción viven fuera
  // de la burbuja, así que nunca caen en esta pasada.
  function numberWebLinks(html) {
    let n = 0;
    return String(html).replace(/(<a\s[^>]*?href="([^"]*)"[^>]*>)([^<]*)<\/a>/g, (m, open, href) => {
      if (href.indexOf('https://wa.me/') === 0) return m; // teléfono: texto actual
      n += 1;
      return open.slice(0, -1) + ' title="' + href.replace(/"/g, '&' + 'quot;') + '">enlace ' + n + '</a>';
    });
  }

  function renderChatMarkdown(raw) {
    const lines = String(raw ?? '').split(/\r?\n/);
    const out = [];
    let list = null;
    let para = null;
    const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
    const closePara = () => { if (para !== null) { out.push('<p style="margin:0 0 6px;">' + para + '</p>'); para = null; } };

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') { closePara(); closeList(); continue; }

      const heading = trimmed.match(/^#{1,4}\s+(.*)$/);
      const bullet = trimmed.match(/^[-•]\s+(.*)$/);
      const ordered = trimmed.match(/^(\d{1,2})[.)]\s+(.*)$/);
      if (heading) {
        closePara(); closeList();
        out.push('<p style="margin:10px 0 4px;font-weight:700;font-size:14px;color:#0f172a;">'
          + mdInline(escapeHtmlText(heading[1])) + '</p>');
        continue;
      }
      if (bullet || ordered) {
        closePara();
        const kind = bullet ? 'ul' : 'ol';
        if (list !== kind) { closeList(); out.push('<' + kind + ' style="margin:4px 0 6px;padding-left:18px;">'); list = kind; }
        out.push('<li style="margin:2px 0;">'
          + mdInline(escapeHtmlText(bullet ? bullet[1] : ordered[2])) + '</li>');
        continue;
      }
      closeList();
      const seg = mdInline(escapeHtmlText(trimmed));
      para = para === null ? seg : para + '<br>' + seg;
    }
    closePara(); closeList();
    return numberWebLinks(out.join(''));
  }

  /** True when the answer carries markdown this renderer would improve. */
  function hasMarkdownSyntax(raw) {
    return /(\*\*[^*]+\*\*|`[^`\n]+`|^\s*#{1,4}\s|^\s*[-•]\s|^\s*\d{1,2}[.)]\s|\[[^\]]+\]\((?:https?:\/\/|\/)[^\s)]*\))/m
      .test(String(raw ?? ''));
  }

  /** True when the answer carries something worth linkifying (URL/phone). */
  function hasLinkableContent(raw) {
    return /((?:https?:\/\/)[^\s<)"']+|(^|[^\d.\w])(\+?56[\s.-]?)?(9[\s.-]?\d{4}[\s.-]?\d{4})(?!\d))/m
      .test(String(raw ?? ''));
  }

  /** Plain-text view for the typewriter: same words, no raw syntax noise. */
  function stripMarkdownSyntax(raw) {
    return String(raw ?? '')
      .replace(/\[([^\]]+)\]\((?:https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/^#{1,4}\s+/gm, '')
      .replace(/^(\s*)[-•]\s+/gm, '$1• ')
      .replace(/^(\s*)(\d{1,2})[.)]\s+/gm, '$1$2. ');
  }

  // ---- Video platform allowlist (module scope) -----------------------------
  // Links to these platforms inside assistant answers open in a modal player
  // over the chat instead of navigating away. Adding a platform = one entry
  // (strict id regex + embed URL builder).
  const VIDEO_PROVIDERS = [
    { re: /^https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?(?:[^#]*&)?v=([A-Za-z0-9_-]{5,40})(?:[&#]|$)/i,
      build: (id) => 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0' },
    { re: /^https?:\/\/(?:www\.)?youtu\.be\/([A-Za-z0-9_-]{5,40})(?:[?&#]|$)/i,
      build: (id) => 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0' },
    { re: /^https?:\/\/(?:www\.|m\.)?youtube\.com\/shorts\/([A-Za-z0-9_-]{5,40})(?:[?&#]|$)/i,
      build: (id) => 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0' },
    { re: /^https?:\/\/(?:www\.)?vimeo\.com\/(\d{6,15})(?:[?&#]|$)/i,
      build: (id) => 'https://player.vimeo.com/video/' + id + '?autoplay=1' },
  ];

  /** Embed URL for a known video link, or null when it is not a video. */
  function videoEmbedUrl(href) {
    const u = String(href ?? '');
    for (const p of VIDEO_PROVIDERS) {
      const m = u.match(p.re);
      if (m) return p.build(m[1]);
    }
    return null;
  }

/**
 * @param {number} status
 * @returns {string}
 */
function defaultMessageFor(status) {
  switch (status) {
    case 401:
      return 'Tu sesión expiró. Inicia sesión nuevamente para continuar, solo toma un momento.';
    case 402:
      return 'No tienes suficientes créditos para esta operación. Puedes recargar cuando quieras y seguir desde donde ibas.';
    case 429:
      return 'Has alcanzado el límite de mensajes por ahora. En unos minutos puedes volver a intentarlo: gracias por tu paciencia.';
    default:
      return 'No pudimos generar una respuesta ahora mismo. No se te cobró nada: inténtalo de nuevo en un momento.';
  }
}

/**
 * Mount the chat widget inside a container element.
 *
 * @param {HTMLElement} container
 * @param {{ title?: string, placeholder?: string, welcomeMessage?: string, conversationId?: string|null, apiBase?: string, extraBody?: object, showPromptDebug?: boolean, onBalanceChange?: (balance: number) => void, onError?: (info: { status: number, code: string, message: string }) => void, getUser?: () => ({ name?: string, id?: string, email?: string, avatar?: string|null }|null) }} options
 * @returns {{ conversationId: string|null, setConversationId: (id: string|null) => void, addMessage: (role: string, text: string, meta?: { sourceIds?: string[] }, opts?: { instant?: boolean }) => HTMLElement, attachmentHost: HTMLElement, sendQuestion: (question: string) => Promise<void>, destroy: () => void }}
 */
export function mountChat(container, options = {}) {
  if (!container) {
    throw new Error('mountChat requires a container element');
  }

  // Live identity for the sender circle on the visitor's own messages. Hosts
  // that pass no getter (guest pages) render plain rows, as before.
  const getUser = typeof options.getUser === 'function' ? options.getUser : null;

  // El conversationId vive en sessionStorage (por PESTAÑA, no por origin):
  // en memoria se perdía con cualquier recarga y el siguiente mensaje arrancaba
  // una conversación nueva, cobrando contexto de cero. Se veía como "lo anterior
  // se pierde". sessionStorage no se comparte entre pestañas, así que dos
  // ventanas con hearts distintos no se pisan.
  const CONV_STORAGE_KEY = 'chat_conversation_id';

  function storedConversationId() {
    try {
      return sessionStorage.getItem(CONV_STORAGE_KEY) || null;
    } catch (_) {
      return null; // storage bloqueado: degradar a solo memoria
    }
  }

  function storeConversationId(id) {
    try {
      if (id) { sessionStorage.setItem(CONV_STORAGE_KEY, id); }
      else { sessionStorage.removeItem(CONV_STORAGE_KEY); }
    } catch (_) { /* no crítico */ }
  }

  const state = {
    conversationId: options.conversationId || storedConversationId(),
    busy: false,
    authenticated: false,
    bubbleMinSentences: 3,
    botAvatar: null,
    ttsVoice: '',
    balance: null,
  };

  container.classList.add(
    'chat-widget',
    'flex',
    'flex-col',
    'h-full',
    'min-h-0',
    'overflow-hidden',
    'rounded-3xl',
    'border',
    'border-slate-200/80',
    'bg-white',
    'shadow-sm'
  );

  // ----- Header: title + remaining balance (authenticated only) -----
  const header = el('div', {
    class: 'mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 pb-1 pt-3',
  });

  const titleBox = el('div', { class: 'min-w-0' });

  const title = el('p', { class: 'truncate text-sm font-semibold text-slate-800' });
  title.textContent = options.title || 'Asistente legal';

  const subtitle = el('p', { class: 'truncate text-xs text-slate-500' });
  subtitle.textContent = 'Respuestas con asistencia de IA. Revisa siempre con un profesional.';

  titleBox.append(title, subtitle);

  const balanceBadge = el('span', {
    class: 'hidden shrink-0 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700',
  });

  // Voz de lectura: override por usuario (localStorage 'tts_voice', JSON
  // {name, lang}). Control compacto en la cabecera, junto al saldo. Sin Web
  // Speech API no hay nada que elegir: el control queda oculto (patrón del
  // botón de dictado). Aplica a la PRÓXIMA locución, no corta la actual.
  const voiceSelect = el('select', {
    class: 'hidden max-w-[9rem] shrink-0 rounded-full border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100',
    title: 'Voz de lectura',
    'aria-label': 'Voz de lectura',
  });
  voiceSelect.append(new Option('Automática', ''));

  // Repuebla el selector con las voces curadas del navegador. Se llama también
  // desde voiceschanged: en Chrome la lista llega después de la carga.
  function fillVoiceSelect() {
    if (!window.speechSynthesis) return;
    // Elección vigente para reaplicarla tras reconstruir la lista.
    let wanted = '';
    try {
      const saved = JSON.parse(localStorage.getItem('tts_voice') || 'null');
      if (saved && saved.name) wanted = saved.lang ? `${saved.name}|${saved.lang}` : saved.name;
    } catch (_) { /* preferencia corrupta: auto */ }
    while (voiceSelect.options.length > 1) voiceSelect.remove(1);
    const { es, en } = curatedTtsVoices();
    const addGroup = (label, list) => {
      if (!list.length) return;
      const group = document.createElement('optgroup');
      group.label = label;
      list.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = `${v.name}|${v.lang}`;
        opt.textContent = `${v.name} (${v.lang})${ttsGenderTag(v.name)}`;
        group.append(opt);
      });
      voiceSelect.append(group);
    };
    addGroup('Español', es);
    addGroup('Inglés', en);
    const found = [...voiceSelect.options].find((o) =>
      o.value === wanted || (wanted && wanted.indexOf('|') === -1 && o.value.split('|')[0] === wanted));
    voiceSelect.value = found ? found.value : '';
    voiceSelect.classList.remove('hidden');
  }

  voiceSelect.addEventListener('change', () => {
    try {
      const value = voiceSelect.value;
      if (!value) {
        localStorage.removeItem('tts_voice');
        return;
      }
      // Partir por el ÚLTIMO '|' por si el nombre llegara a contener ese carácter.
      const sep = value.lastIndexOf('|');
      const name = sep >= 0 ? value.slice(0, sep) : value;
      const lang = sep >= 0 ? value.slice(sep + 1) : '';
      localStorage.setItem('tts_voice', JSON.stringify(lang ? { name, lang } : { name }));
    } catch (_) { /* localStorage bloqueado: sin preferencia guardada */ }
  });

  fillVoiceSelect();

  header.append(titleBox, voiceSelect, balanceBadge);

  // Umbral de frases para mostrar acciones + imagen del asistente: config desde admin.
  fetch(apiUrl('/ui-settings'), { credentials: 'include' })
    .then(r => r.json())
    .then(d => {
      const settings = d && d.data && d.data.settings ? d.data.settings : {};
      const n = parseInt(settings.bubble_min_sentences, 10);
      if (!isNaN(n) && n > 0) state.bubbleMinSentences = n;
      state.botAvatar = settings.bot_avatar || null;
      // Voz predeterminada del admin ('nombre|idioma' o '' = automática).
      state.ttsVoice = String(settings.tts_voice || '');
    })
    .catch(() => { /* fallback 3 + glyph por defecto */ });

  // ----- Message list: centered column, scrollbars hidden (native feel) -----
  const list = el('div', {
    class: 'chat-messages mx-auto w-full max-w-3xl flex-1 space-y-3 overflow-y-auto px-4 py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden scroll-smooth',
  });

  // ----- Input bar (pill with action icons) -----
  const form = el('form', {
    class: 'mx-auto flex w-full max-w-3xl items-end gap-2 border-t border-slate-200/70 bg-white/90 px-4 py-3 backdrop-blur',
  });

  const pill = el('div', {
    class: 'flex flex-1 items-end gap-1 rounded-full border border-slate-200 bg-slate-100 px-2 py-1.5 transition focus-within:border-blue-400 focus-within:bg-white',
  });

  // Microphone button for speech-to-text
  const micButton = el('button', {
    type: 'button',
    class: 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-200 hover:text-red-600',
    'aria-label': 'Dictar mensaje (voz a texto)',
    title: 'Dictar mensaje (voz a texto)',
  });
  micButton.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 19c0 1.105-.895 2-2 2s-2-.895-2-2v-4a4 4 0 011.163-2.83A5.981 5.981 0 0120 11.5c0-2.538-1.78-4.73-4.238-5.496V2a1 1 0 00-2 0v3.51C8.673 8.709 7 10.625 7 12.5a5.995 5.995 0 003.593 5.49l3.71 3.71a1 1 0 001.414 0l2.303-2.303a1 1 0 011.414 0l.094.094a1 1 0 001.414 0l3.293-3.293a1 1 0 011.414 0l3.536 3.536a1 1 0 001.414 0l1.5-1.5a1 1 0 10-1.414-1.414l-2.83 2.83a5.98 5.98 0 01-4.242 0H11a1 1 0 010-2h3.994a5.002 5.002 0 010-10H11a1 1 0 100 2h3.01A7.002 7.002 0 0112 21c3.314 0 6-2.686 6-6v-2a2 2 0 10-4 0v2c0 2.21-1.79 4-4 4z"/></svg>';

  const attachButton = el('button', {
    type: 'button',
    class: 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-200 hover:text-blue-600',
    'aria-label': 'Adjuntar documento',
  });
  attachButton.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M13.234 20.252l-9.9-9.9a4.5 4.5 0 016.364-6.364l9.9 9.9a6 6 0 01-8.486 8.486l-8.485-8.485"/></svg>';

  const input = el('textarea', {
    rows: '1',
    class: 'max-h-32 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-slate-800 placeholder-slate-500 outline-none',
  });
  input.placeholder = options.placeholder || 'Escribe tu pregunta aquí…';

  const sendButton = el('button', {
    type: 'submit',
    class: 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50',
    'aria-label': 'Enviar mensaje',
  });
  const sendIcon = el('span', { class: 'inline-flex' });
  sendIcon.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 19V5m-6 6l6-6 6 6"/></svg>';
  const sendBusy = el('span', { class: 'hidden text-sm font-medium' });
  sendBusy.textContent = '…';
  sendButton.append(sendIcon, sendBusy);

  // Host for host-page attachment cards (progress/result), shown between
  // the messages and the input bar.
  const attachmentHost = el('div', {
    class: 'chat-attachments mx-auto w-full max-w-3xl space-y-2 px-4 empty:hidden',
  });

  // Hidden file input for attachments (Meta AI style: self-contained)
  const fileInput = el('input', {
    type: 'file',
    multiple: true,
    class: 'hidden',
    accept: '.png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.txt,.md,.mp3,.wav,.ogg,.m4a,.flac,.webm',
  });

  // ===== Meta AI-style attachment modal =====
  const modalOverlay = el('div', {
    class: 'fixed inset-0 z-50 hidden items-center justify-center bg-slate-900/60 backdrop-blur-sm',
  });

  const modal = el('div', {
    class: 'relative w-full max-w-xl rounded-3xl bg-white p-6 shadow-2xl',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Agregar contenido multimedia y archivos',
  });

  const modalHeader = el('div', { class: 'mb-4 flex items-start justify-between' });
  const modalTitle = el('div', {});
  const modalTitleH = el('h2', { class: 'text-xl font-semibold text-slate-900' });
  modalTitleH.textContent = 'Agregar contenido multimedia y archivos';
  const modalTitleP = el('p', { class: 'text-sm text-slate-500' });
  modalTitleP.textContent = 'Sube lo que quieras';
  modalTitle.append(modalTitleH, modalTitleP);

  const modalClose = el('button', {
    type: 'button',
    class: 'rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600',
    'aria-label': 'Cerrar',
  });
  modalClose.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>';
  modalHeader.append(modalTitle, modalClose);

  // Dropzone
  const dropzone = el('div', {
    class: 'flex min-h-[180px] cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 p-8 text-center transition-colors hover:border-blue-400 hover:bg-blue-50/50',
    tabindex: '0',
    role: 'button',
    'aria-label': 'Haz clic para explorar, o arrastra y suelta aquí',
  });
  const dropIcon = el('div', {
    class: 'flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-200/70 text-slate-500 transition-colors group-hover:text-blue-500',
  });
  dropIcon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"/></svg>';
  const dropText = el('p', { class: 'text-sm text-slate-500' });
  dropText.textContent = 'Haz clic para explorar, o arrastra y suelta aquí';
  dropzone.append(dropIcon, dropText);

  // Processing state inside modal
  const modalProcessing = el('div', {
    class: 'hidden flex min-h-[180px] flex-col items-center justify-center gap-4 rounded-2xl border border-blue-100 bg-blue-50/50 p-8',
  });
  const processingSpinner = el('div', { class: 'h-10 w-10 animate-spin rounded-full border-4 border-blue-200 border-t-blue-600' });
  const processingText = el('p', { class: 'text-sm font-medium text-blue-700' });
  processingText.textContent = 'Procesando documento…';
  const processingBar = el('div', { class: 'h-1.5 w-48 overflow-hidden rounded-full bg-blue-100' });
  const processingBarFill = el('div', { class: 'h-full w-0 rounded-full bg-blue-600 transition-all duration-300' });
  processingBar.append(processingBarFill);
  modalProcessing.append(processingSpinner, processingText, processingBar);

  // Queue list + action buttons (multi-upload with explicit confirmation)
  const modalQueueWrap = el('div', { class: 'hidden mt-4 space-y-2' });
  const queueLabel = el('p', { class: 'text-xs font-semibold uppercase tracking-wide text-slate-400' });
  queueLabel.textContent = 'Archivos en cola';
  const modalQueueList = el('div', { class: 'space-y-2 max-h-48 overflow-y-auto' });
  modalQueueWrap.append(queueLabel, modalQueueList);

  const modalActions = el('div', { class: 'hidden mt-4 flex items-center justify-end gap-3' });

  const discardBtn = el('button', {
    type: 'button',
    class: 'rounded-xl px-4 py-2.5 text-sm font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700',
  });
  discardBtn.textContent = 'Descartar';
  discardBtn.addEventListener('click', discardQueue);

  const confirmBtn = el('button', {
    type: 'button',
    class: 'rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50',
  });
  confirmBtn.textContent = 'Confirmar y guardar';
  confirmBtn.disabled = true;
  confirmBtn.addEventListener('click', confirmIngest);

  modalActions.append(discardBtn, confirmBtn);

  modal.append(modalHeader, dropzone, modalProcessing, modalQueueWrap, modalActions);
  modalOverlay.append(modal);

  // Modal helpers
  function openModal() {
    modalOverlay.classList.remove('hidden');
    modalOverlay.classList.add('flex');
    dropzone.classList.remove('hidden');
    modalProcessing.classList.add('hidden');
    modalProcessing.classList.remove('flex');
    renderModalQueue();
  }

  function closeModal() {
    modalOverlay.classList.add('hidden');
    modalOverlay.classList.remove('flex');
  }

  function showProcessing() {
    dropzone.classList.add('hidden');
    modalProcessing.classList.remove('hidden');
    modalProcessing.classList.add('flex');
  }

  function updateModalProgress(percent, text) {
    if (text) processingText.textContent = text;
    processingBarFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  }

  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  // ===== Video link modal (YouTube/Vimeo over the chat box) =====
  // Same overlay pattern as the attachment modal above; closing removes the
  // iframe from the DOM, which stops playback. TTS is untouched (independent
  // feature).
  const videoOverlay = el('div', {
    class: 'fixed inset-0 z-50 hidden items-center justify-center bg-slate-900/70 p-4',
  });
  const videoBox = el('div', {
    class: 'relative w-[min(92vw,156vh,56rem)] rounded-2xl bg-slate-900 p-3 shadow-2xl',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Video',
  });
  const videoClose = el('button', {
    type: 'button',
    class: 'absolute -right-3 -top-3 flex h-9 w-9 items-center justify-center rounded-full bg-white text-slate-800 shadow-lg transition hover:bg-slate-200',
    'aria-label': 'Cerrar video',
  });
  videoClose.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>';
  videoBox.append(videoClose);
  videoOverlay.append(videoBox);

  let videoLastFocus = null;

  function openVideoModal(embedUrl) {
    closeVideoModal(); // never two at once
    const frame = el('iframe', {
      class: 'aspect-video w-full rounded-xl bg-black',
      src: embedUrl,
      title: 'Video',
      allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
      allowfullscreen: '',
      referrerpolicy: 'strict-origin-when-cross-origin',
      sandbox: 'allow-scripts allow-same-origin allow-presentation allow-popups',
    });
    videoBox.append(frame);
    videoOverlay.classList.remove('hidden');
    videoOverlay.classList.add('flex');
    videoLastFocus = document.activeElement;
    videoClose.focus();
  }

  function closeVideoModal() {
    videoOverlay.classList.add('hidden');
    videoOverlay.classList.remove('flex');
    // Removing the iframe from the DOM stops playback.
    [...videoBox.querySelectorAll('iframe')].forEach((f) => f.remove());
    if (videoLastFocus && typeof videoLastFocus.focus === 'function') videoLastFocus.focus();
    videoLastFocus = null;
  }

  videoClose.addEventListener('click', closeVideoModal);
  videoOverlay.addEventListener('click', (e) => {
    if (e.target === videoOverlay) closeVideoModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !videoOverlay.classList.contains('hidden')) closeVideoModal();
  });

  // ONE delegated listener on the messages list: messages (and their anchors)
  // are added dynamically, so nothing is bound per anchor. Non-video links
  // keep the current behavior (new tab).
  list.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || !list.contains(a)) return;
    const embed = videoEmbedUrl(a.getAttribute('href'));
    if (!embed) return;
    e.preventDefault();
    openVideoModal(embed);
  });
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  // Drag & drop on the modal dropzone
  ['dragenter', 'dragover'].forEach((eventName) => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.add('border-blue-400', 'bg-blue-50');
    });
  });
  ['dragleave', 'drop'].forEach((eventName) => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.remove('border-blue-400', 'bg-blue-50');
    });
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation(); // NO burbujear al contenedor del chat (evita doble ingest)
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length > 0) {
      for (const file of Array.from(files)) {
        void extractToQueue(file);
      }
    }
  });

  // También cortar la propagación en todo el overlay del modal
  ['dragenter', 'dragover', 'drop'].forEach((eventName) => {
    modalOverlay.addEventListener(eventName, (e) => {
      e.stopPropagation();
    });
  });

  // ===== Multi-upload queue (extraction in modal → CONFIRM → ingest → chat) =====
  // Nada se ingesta sin validación explícita del usuario (botón Confirmar).
  let modalQueue = []; // [{ id, file, name, sourceType, text, status, progress }]

  function generateQueueId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  function updateConfirmButton() {
    const ready = modalQueue.filter(q => q.status === 'ready').length;
    const any = modalQueue.length > 0;
    modalActions.classList.toggle('hidden', !any);
    if (any) {
      confirmBtn.textContent = ready > 0
        ? `Confirmar y guardar (${ready})`
        : 'Procesando…';
      confirmBtn.disabled = ready === 0;
      confirmBtn.classList.toggle('opacity-50', ready === 0);
      confirmBtn.classList.toggle('cursor-not-allowed', ready === 0);
    }
  }

  function renderModalQueue() {
    modalQueueList.innerHTML = '';
    modalQueue.forEach((item, index) => {
      const row = el('div', {
        class: 'flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5',
        'data-queue-index': String(index),
      });

      const icon = el('div', {
        class: item.status === 'error'
          ? 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-500'
          : item.status === 'ready'
          ? 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600'
          : 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600',
      });
      icon.innerHTML = item.status === 'error'
        ? '<svg xmlns="http://www.w3.org/2000/svg" class="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>'
        : item.status === 'ready'
        ? '<svg xmlns="http://www.w3.org/2000/svg" class="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.4"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>'
        : '<svg xmlns="http://www.w3.org/2000/svg" class="h-4.5 w-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M13.234 20.252l-9.9-9.9a4.5 4.5 0 016.364-6.364l9.9 9.9a6 6 0 01-8.486 8.486l-8.485-8.485"/></svg>';

      const info = el('div', { class: 'min-w-0 flex-1' });
      const name = el('p', { class: 'truncate text-sm font-medium text-slate-800' });
      name.textContent = item.name;
      const status = el('p', {
        class: item.status === 'error' ? 'text-xs text-red-500' : 'text-xs text-slate-500',
      });
      status.textContent = item.statusText || '';
      info.append(name, status);

      const progressWrap = el('div', { class: 'w-16 shrink-0' });
      const barOuter = el('div', { class: 'h-1.5 w-full overflow-hidden rounded-full bg-slate-200' });
      const barFill = el('div', {
        class: item.status === 'ready' ? 'h-full rounded-full bg-emerald-500 transition-all duration-300' : 'h-full rounded-full bg-blue-500 transition-all duration-300',
      });
      barFill.style.width = `${item.progress}%`;
      barOuter.append(barFill);
      progressWrap.append(barOuter);

      row.append(icon, info, progressWrap);
      modalQueueList.appendChild(row);
    });
    updateConfirmButton();
  }

  function updateQueueItem(id, updates) {
    const idx = modalQueue.findIndex(q => q.id === id);
    if (idx !== -1) {
      Object.assign(modalQueue[idx], updates);
      renderModalQueue();
    }
  }

  // Extract a single file (adds to queue, no ingest)
  async function extractToQueue(file) {
    const itemId = generateQueueId();
    const item = {
      id: itemId,
      file,
      name: file.name,
      sourceType: 'text',
      text: null,
      status: 'pending',
      statusText: 'En cola…',
      progress: 0,
    };
    modalQueue.push(item);
    renderModalQueue();
    dropzone.classList.add('hidden');
    modalQueueWrap.classList.remove('hidden');

    try {
      const extractModule = await import('./extract/index.js?v=4');
      const { extract } = extractModule;

      updateQueueItem(itemId, { status: 'extracting', statusText: 'Leyendo documento…' });

      const { text, sourceType } = await extract(file, (percent) => {
        updateQueueItem(itemId, { progress: percent });
      });

      const clean = (text || '').trim();
      if (clean === '') {
        updateQueueItem(itemId, { status: 'error', statusText: 'Sin texto encontrado', progress: 0 });
        return;
      }

      updateQueueItem(itemId, {
        text: clean,
        sourceType,
        status: 'ready',
        statusText: `Listo (${clean.length} caracteres)`,
        progress: 100,
      });
    } catch (error) {
      console.error('[ChatWidget] Extract error:', error);
      updateQueueItem(itemId, { status: 'error', statusText: error.message || 'Error al leer' });
    }
  }

  // Confirm: ingest ALL ready files → chat messages → close modal
  async function confirmIngest() {
    const ready = modalQueue.filter(q => q.status === 'ready');
    if (ready.length === 0) return;

    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Guardando…';

    const saved = [];
    for (const item of ready) {
      try {
        updateQueueItem(item.id, { status: 'saving', statusText: 'Guardando…' });
        const apiModule = await import('./api.js?v=5');
        await apiModule.ingestDocument({ text: item.text, sourceType: item.sourceType, name: item.name, extra: options.extraBody || {} });
        updateQueueItem(item.id, { status: 'saved', statusText: 'Guardado ✓', progress: 100 });
        saved.push(item);
      } catch (error) {
        console.error('[ChatWidget] Ingest error:', error);
        updateQueueItem(item.id, { status: 'error', statusText: 'Error al guardar' });
      }
    }

    if (saved.length > 0) {
      // Close the modal and confirm LOCALLY. No auto-send: the attachments
      // stay PENDING server-side and attach to the user's NEXT real
      // question, so "Pregunta del usuario" is exactly what they typed.
      // Panels that render a documents/source history (e.g. the ley-datos
      // "Mis documentos" list) listen for this event to refresh in place —
      // without it the ingest only shows up after a manual page reload.
      setTimeout(() => {
        document.dispatchEvent(new CustomEvent('chat:documents-ingested', {
          detail: { names: saved.map((item) => item.name) },
        }));

        closeModal();
        modalQueue = [];

        const names = saved.map((item) => item.name).join(', ');
        const headline = saved.length === 1
          ? 'Documento guardado'
          : `${saved.length} documentos guardados`;
        addMessage(
          'assistant',
          `📎 ${headline}: ${names}. Quedaron listos como contexto: escribe tu pregunta y los tomaré en cuenta.`
        );
      }, 500);
    } else {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirmar y guardar';
    }
  }

  // Discard: clear queue without ingesting
  function discardQueue() {
    modalQueue = [];
    modalQueueList.innerHTML = '';
    modalQueueWrap.classList.add('hidden');
    dropzone.classList.remove('hidden');
    updateConfirmButton();
  }

  pill.append(micButton, attachButton, input);
  form.append(pill, sendButton);

  container.append(header, list, attachmentHost, form, fileInput, modalOverlay, videoOverlay);

  // The paperclip opens the Meta AI-style modal
  attachButton.addEventListener('click', () => {
    openModal();
  });

  // Handle file selection from the modal's hidden input (MULTIPLE)
  fileInput.addEventListener('change', async () => {
    // Copiar la lista ANTES de limpiar el input: value='' destruye el FileList vivo.
    const files = Array.from(fileInput.files || []);
    if (files.length === 0) return;
    fileInput.value = '';
    for (const file of files) {
      await extractToQueue(file);
    }
  });

  /**
   * Creates a Meta AI-style attachment chip above the input.
   *
   * @param {File} file
   * @returns {HTMLElement}
   */
  function createAttachmentChip(file) {
    const chip = el('div', {
      class: 'flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm transition-all',
    });

    const icon = el('div', {
      class: 'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600',
    });
    icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M13.234 20.252l-9.9-9.9a4.5 4.5 0 016.364-6.364l9.9 9.9a6 6 0 01-8.486 8.486l-8.485-8.485"/></svg>';

    const info = el('div', { class: 'min-w-0 flex-1' });
    const name = el('p', { class: 'truncate text-sm font-medium text-slate-800' });
    name.textContent = file.name;
    const status = el('p', { class: 'text-xs text-slate-500' });
    status.textContent = 'Procesando…';
    info.append(name, status);

    const progressWrap = el('div', { class: 'w-20' });
    const progressBarOuter = el('div', { class: 'h-1.5 w-full overflow-hidden rounded-full bg-slate-200' });
    const progressBar = el('div', { class: 'h-full w-0 rounded-full bg-blue-500 transition-all duration-300' });
    progressBarOuter.append(progressBar);
    progressWrap.append(progressBarOuter);

    chip.append(icon, info, progressWrap);
    return chip;
  }

  function updateChipProgress(chip, percent, text) {
    const status = chip.querySelector('.text-xs.text-slate-500');
    if (status && text) status.textContent = text;
    const bar = chip.querySelector('.h-full');
    if (bar) bar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  }

  function updateChipDone(chip) {
    updateChipProgress(chip, 100, 'Listo ✓');
    chip.classList.add('border-emerald-200', 'bg-emerald-50');
    const bar = chip.querySelector('.h-full');
    if (bar) {
      bar.classList.remove('bg-blue-500');
      bar.classList.add('bg-emerald-500');
    }
  }

  function updateChipError(chip, message) {
    updateChipProgress(chip, 0, message || 'Error');
    chip.classList.add('border-red-200', 'bg-red-50');
    const status = chip.querySelector('.text-xs.text-slate-500');
    if (status) status.classList.add('text-red-500');
  }

  addMessage(
    'assistant',
    options.welcomeMessage
      || 'Hola, soy tu asistente. Pregúntame lo que necesites: respondo con base en la información disponible y te aviso cuando algo falte.'
  );

  // Auto-grow the textarea up to its max height.
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 128) + 'px';
  });

  // Enter sends (Shift+Enter inserts a newline).
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const question = input.value.trim();

    if (question === '' || state.busy) {
      return;
    }

    void sendQuestion(question);
  });

  // ===== Speech-to-Text (Web Speech API) =====
  let recognition = null;
  let isRecording = false;

  function initSpeechRecognition() {
    if (typeof window.SpeechRecognition === 'undefined' && typeof window.webkitSpeechRecognition === 'undefined') {
      console.warn('[ChatWidget] Speech Recognition not supported in this browser');
      micButton.disabled = true;
      micButton.title = 'Voz a texto no soportado en este navegador';
      micButton.classList.add('opacity-50', 'cursor-not-allowed');
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.lang = 'es-CL';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      isRecording = true;
      micButton.classList.add('text-red-600', 'bg-red-50', 'animate-pulse');
      micButton.setAttribute('aria-label', 'Grabando... Click para detener');
      micButton.title = 'Grabando... Click para detener';
      input.placeholder = 'Escuchando...';
    };

    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      input.value = transcript;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 128) + 'px';
    };

    recognition.onerror = (event) => {
      console.warn('[ChatWidget] Speech recognition error:', event.error);
      if (event.error === 'not-allowed') {
        addMessage('assistant', 'Permiso de micrófono denegado. Por favor, habilita el acceso al micrófono en tu navegador.', undefined, { instant: true });
      }
      stopRecording();
    };

    recognition.onend = () => {
      stopRecording();
    };
  }

  function startRecording() {
    if (isRecording || state.busy) return;
    if (!recognition) {
      initSpeechRecognition();
    }
    if (recognition) {
      try {
        input.value = '';
        input.placeholder = 'Escuchando...';
        recognition.start();
      } catch (e) {
        console.warn('[ChatWidget] Error starting recognition:', e);
      }
    }
  }

  function stopRecording() {
    if (!isRecording) return;
    if (recognition) {
      try {
        recognition.stop();
      } catch (e) {
        // Ignore
      }
    }
    isRecording = false;
    micButton.classList.remove('text-red-600', 'bg-red-50', 'animate-pulse');
    micButton.setAttribute('aria-label', 'Dictar mensaje (voz a texto)');
    micButton.title = 'Dictar mensaje (voz a texto)';
    input.placeholder = options.placeholder || 'Escribe tu pregunta aquí…';
  }

  function toggleRecording() {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }

  // Initialize speech recognition
  initSpeechRecognition();

  // Toggle recording on mic button click
  micButton.addEventListener('click', (e) => {
    e.preventDefault();
    toggleRecording();
  });

  // "Near the bottom" test for auto-scroll decisions (same threshold the
  // typewriter uses to decide whether to follow the reveal).
  function nearBottom() {
    return list.scrollHeight - list.scrollTop - list.clientHeight <= 90;
  }

  // Número de frases del texto (separa por . ! ? … y saltos de línea).
  function countSentences(t) {
    const parts = (t || '')
      .split(/[.!?…]+(?:\s|$)|\n+/)
      .map(s => s.trim())
      .filter(Boolean);
    return parts.length;
  }

  /**
   * @param {string} role
   * @param {string} text
   * @param {{ sourceIds?: string[] }} [meta] — sources RAG citados por la respuesta (para borrado)
   * @param {{ instant?: boolean }} [opts] — instant skips the typing effect:
   *   used for error notices, which must be readable immediately.
   * @returns {HTMLElement}
   */
  function addMessage(role, text, meta, opts = {}) {
    // Acciones SIEMPRE visibles debajo de la burbuja (mobile no tiene hover).
    // Unified row shape for both roles: [identity circle, content column].
    // The content column always exists (flex-1 + min-w-0 keep the bubble's
    // max-w-% resolvable) and holds the bubble plus the action buttons. The
    // identity circle leads for the assistant (left) and trails for the user
    // (right, Google Chat style). dataset stays on the row: history, the
    // editor and the RAG-delete flow read it from there.
    const isOwn = role === 'user';
    const row = el('div', { class: 'flex items-end gap-2' });
    const content = el('div', {
      class: 'flex min-w-0 flex-1 flex-col gap-1 ' + (isOwn ? 'items-end' : 'items-start')
    });
    const bubble = el('div', {
      class: isOwn
        ? 'max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-blue-600 px-3.5 py-2.5 text-sm text-white'
        : 'max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-slate-100 px-3.5 py-2.5 text-sm text-slate-800',
    });

    // Store original text for editor/TTS downstream BEFORE typing starts:
    // they always read the FULL message, never the partially-typed bubble.
    row.dataset.messageText = text;

    if (isOwn) {
      // textContent (never innerHTML): the user's own words render as-is,
      // no typing effect for their own input.
      bubble.textContent = text;
    } else {
      // Assistant bubbles type progressively (perceived streaming — see
      // /js/chat-typewriter.js; prefers-reduced-motion skips the effect
      // inside typewrite). Text typed is UNTRUSTED model output, so the
      // typer types a marker-free plain view; when the answer carries
      // markdown, onComplete swaps the finished text for the safe rendered
      // HTML (renderChatMarkdown is escape-first: no model-authored tag can
      // reach innerHTML — only tags this module builds itself).
      const displayText = hasMarkdownSyntax(text) ? stripMarkdownSyntax(text) : text;
      // Render (markdown or linkified) when the answer carries markdown
      // syntax OR bare URLs/phones worth making clickable.
      const renderMarkdown = displayText !== text || hasLinkableContent(text);
      const typer = typewrite(bubble, displayText, {
        scroller: list,
        onComplete: () => {
          bubble.classList.remove('cursor-pointer');
          bubble.removeAttribute('title');
          bubble.removeAttribute('aria-busy');

          if (renderMarkdown) {
            bubble.innerHTML = renderChatMarkdown(text); // escape-first, see above
            bubble.style.whiteSpace = 'normal'; // <br>/<p> take over line breaks
          }

          // Formatted report (server-rendered, additive field informe_html):
          // shown inside a sandboxed iframe right below the text. The
          // sandbox blocks scripts (render-only view); onComplete fires on
          // every path (typed, instant, reduced-motion), so the report
          // always appears once.
          if (meta && typeof meta.informeHtml === 'string' && meta.informeHtml.length > 0) {
            const frame = el('iframe', {
              class: 'max-w-[85%] rounded-xl border border-slate-200 bg-white',
              title: 'Informe',
            });
            frame.setAttribute('sandbox', 'allow-same-origin');
            frame.setAttribute('srcdoc', meta.informeHtml);
            frame.style.width = '100%';
            frame.style.height = '460px';
            bubble.after(frame);
            meta.informeHtml = ''; // idempotent: never render twice on retry
          }
        },
        instant: opts.instant === true,
      });

      if (typer.animated) {
        // Skip affordance: a click/tap on the message reveals it at once.
        bubble.classList.add('cursor-pointer');
        bubble.title = 'Mostrar todo';
        bubble.setAttribute('aria-busy', 'true');
        bubble.addEventListener('click', () => typer.complete());
      }
    }

    // Sources RAG citados por esta respuesta: el 🗑️ los borra a nivel RAG.
    if (meta && Array.isArray(meta.sourceIds) && meta.sourceIds.length > 0) {
      row.dataset.sourceIds = JSON.stringify(meta.sourceIds);
    }

    // Acciones por burbuja SOLO si el texto supera el umbral de frases
    // (admin-editable en /ui-settings; default 3).
    const showActions = countSentences(text) > (state.bubbleMinSentences || 3);
    let actions = null;
    let audioBtn = null;
    let editBtn = null;
    let deleteBtn = null;

    // — Escuchar (TTS, operación pagada): SIEMPRE disponible, desde la
    // primera burbuja del historial, sin umbral de frases. —
    audioBtn = el('button', {
      type: 'button',
      class: 'tts-btn rounded p-1 text-slate-400 transition hover:bg-slate-200 hover:text-brand-700',
      title: 'Escuchar mensaje',
      'aria-label': 'Escuchar mensaje'
    }, [svgIcon('audio')]);

    if (showActions) {
      actions = el('div', {
        class: 'flex items-center gap-1',
        'aria-label': 'Acciones del mensaje'
      });

      // — Editar/Descargar: abre el editor con el flujo TXT/DOCX/PDF —
      editBtn = el('button', {
        type: 'button',
        class: 'rounded p-1 text-slate-400 transition hover:bg-slate-200 hover:text-brand-700',
        title: 'Editar y descargar documento',
        'aria-label': 'Editar y descargar documento'
      }, [svgIcon('download')]);

      // — Eliminar —
      deleteBtn = el('button', {
        type: 'button',
        class: 'rounded p-1 text-slate-400 transition hover:bg-slate-200 hover:text-rose-600',
        title: 'Eliminar mensaje',
        'aria-label': 'Eliminar mensaje'
      }, [svgIcon('trash')]);

      actions.append(editBtn, deleteBtn);
      content.append(bubble, audioBtn, actions);
    } else {
      // Sin umbral: solo el botón de audio junto a la burbuja.
      content.append(bubble, audioBtn);
    }

    if (isOwn) {
      row.append(content);

      if (getUser) {
        const me = getUser();

        if (me) {
          row.append(avatarNode(me, 'sm'));
        }
      }
    } else {
      row.append(botAvatarNode(state.botAvatar, 'sm'));
      row.append(content);
    }

    list.append(row);
    // Follow the new row only if the user is already near the bottom: if
    // they scrolled up to re-read, don't yank them down. While typing, the
    // typewriter re-checks on every tick and resumes following when the
    // user returns near the bottom.
    if (nearBottom()) {
      list.scrollTop = list.scrollHeight;
    }

    // Sin acciones (burbuja corta): nada que atar.
    if (!showActions) return row;

    // — Editar: bot abre el modal del editor (descarga TXT/DOCX/PDF 1 crédito); user edita inline —
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (role === 'assistant' || role === 'bot') {
        // chat-editor.js es un script clásico (IIFE -> window.ChatEditor):
        // import() resuelve al namespace del módulo (sin exports), por eso
        // hay que tomar window.ChatEditor después de cargar. El ?v= evita
        // que el navegador sirva una versión vieja cacheada del editor
        // (los cambios del editor no se reflejarían hasta un hard refresh).
        import('./chat-editor.js?v=' + Date.now())
          .then(() => {
            const Editor = window.ChatEditor;
            if (!Editor || typeof Editor.open !== 'function') {
              throw new Error('ChatEditor no disponible');
            }
            Editor.open(text, downloadEditedDocument, (format, content) => downloadEditedDocument(content, format));
          })
          .catch(err => {
            console.error('Editor load failed:', err);
            addMessage('assistant', '✶ No pudimos abrir el editor. Intenta nuevamente.', undefined, { instant: true });
          });
      } else {
        // Mensaje del usuario: edición inline de la burbuja.
        makeBubbleEditable(bubble, row);
      }
    });

    // — Escuchar: cotización server + confirm + cobro + Web Speech API —
    audioBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Mientras habla: detener es gratis (y re-habilita los botones).
      if (window.speechSynthesis && speechSynthesis.speaking) {
        speechSynthesis.cancel();
        hideStopButton();
        enableTtsButtons();
        return;
      }
      if (Date.now() < ttsCooldownUntil) return; // cooldown 10s anti-spam

      // Selección de texto: si hay un FRAGMENTO seleccionado con el mouse
      // DENTRO de esta burbuja, se reproduce solo ese fragmento; si no,
      // la burbuja completa.
      let spoken = text;
      let isFragment = false;
      try {
        const sel = window.getSelection();
        const insideBubble = sel && sel.rangeCount > 0 && sel.anchorNode && sel.focusNode
          && bubble.contains(sel.anchorNode) && bubble.contains(sel.focusNode);
        if (insideBubble && !sel.isCollapsed) {
          const frag = sel.toString().trim();
          if (frag) { spoken = frag; isFragment = true; }
        }
      } catch (_) { /* selección no disponible: burbuja completa */ }

      const clean = cleanForSpeech(spoken);

      // Skip POR BURBUJA: si marcó "no deseo" para este texto, cobra directo.
      const skipConfirm = confirmSkipHas('aj:no-confirm-tts', clean);
      if (skipConfirm) {
        disableTtsButtons();
        try {
          const chargedDirect = await ttsCharge(clean, 'tts_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
          if (chargedDirect && chargedDirect.success) {
            if (typeof chargedDirect.new_balance === 'number') {
              state.balance = chargedDirect.new_balance;
              balanceBadge.textContent = `Saldo restante: ${chargedDirect.new_balance} crédito${chargedDirect.new_balance === 1 ? '' : 's'}`;
              balanceBadge.classList.remove('hidden');
              if (typeof options.onBalanceChange === 'function') options.onBalanceChange(chargedDirect.new_balance);
            }
            ttsCooldownUntil = Date.now() + 10000;
            speakText(clean);
          } else {
            hideStopButton();
            enableTtsButtons();
            showErrorOverlay((chargedDirect && chargedDirect.error) || 'No se pudo autorizar la locución.');
          }
        } catch (err) {
          hideStopButton();
          enableTtsButtons();
          showErrorOverlay('Error al autorizar: ' + err.message);
        }
        return;
      }
      await startTtsFlow(clean, isFragment);
    });

    // — Eliminar: SIEMPRE pide confirmación por modal (rojo, no recuperable,
    // link a privacidad). Sin modal no se borra nada. —
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmDangerModal({
        title: '¿Eliminar este mensaje?',
        message: 'El mensaje y su conocimiento asociado se eliminarán de forma permanente. '
          + 'Esta información no es recuperable, ni siquiera por nuestro equipo.',
        confirmLabel: 'Sí, eliminar'
      }).then((ok) => {
        if (!ok) return;
      // 1. RAG: si la burbuja citó sources, borrarlos del vector store (user+heart).
      const raw = row.dataset.sourceIds;
      if (raw) {
        let sourceIds = [];
        try { sourceIds = JSON.parse(raw) || []; } catch (_) { sourceIds = []; }
        if (Array.isArray(sourceIds) && sourceIds.length > 0) {
          fetch(apiUrl('/rag/sources'), {
            method: 'POST',
            headers: authHeaders(),
            credentials: 'include',
            body: JSON.stringify({
              sourceIds: sourceIds,
              heart: localStorage.getItem('heart_id') || 'atscv'
            })
          })
          .then(r => r.json())
          .then(d => {
            if (!d.success) {
              addMessage('assistant', '✶ No pudimos borrar el conocimiento de este mensaje: ' + (d.error || 'error desconocido') + '.', undefined, { instant: true });
            }
          })
          .catch(() => {
            addMessage('assistant', '✶ No pudimos borrar el conocimiento de este mensaje. Inténtalo de nuevo.', undefined, { instant: true });
          });
        }
      }
        // 2. Front: remover la burbuja de la conversación.
        row.style.transition = 'opacity 150ms ease, transform 150ms ease';
        row.style.opacity = '0';
        row.style.transform = 'scale(0.95)';
        setTimeout(() => row.remove(), 150);
      });
    });

    return row;
  }

  /**
   * Convierte una burbuja de mensaje de usuario en editable inline.
   * Guarda al blur o Enter; Cancela con Escape.
   */
  function makeBubbleEditable(bubble, row) {
    if (bubble.isContentEditable) return;
    const original = bubble.textContent;

    bubble.contentEditable = 'true';
    bubble.classList.add('outline-none', 'ring-2', 'ring-blue-300');
    bubble.focus();

    // Colocar el cursor al final del texto.
    const range = document.createRange();
    range.selectNodeContents(bubble);
    range.collapse(false);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }

    const finish = (save) => {
      bubble.contentEditable = 'false';
      bubble.classList.remove('outline-none', 'ring-2', 'ring-blue-300');
      const newText = bubble.textContent.trim();
      if (!save || !newText) {
        // Cancelar o texto vacío: restaurar original.
        bubble.textContent = original;
        row.dataset.messageText = original;
      } else {
        row.dataset.messageText = newText;
      }
    };

    bubble.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        bubble.removeEventListener('keydown', onKey);
        finish(true);
      } else if (e.key === 'Escape') {
        bubble.removeEventListener('keydown', onKey);
        finish(false);
      }
    });

    bubble.addEventListener('blur', function onBlur() {
      bubble.removeEventListener('blur', onBlur);
      finish(true);
    }, { once: false });
  }

  // ---- TTS: cobro server-side + Web Speech API (nativa) ----
  let ttsCooldownUntil = 0;

  // Skip de confirm POR BURBUJA (hash del texto, solo sesión actual).
  function hashText(t) {
    let h = 5381;
    for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
    return 'h' + (h >>> 0).toString(16);
  }
  // Lee la lista de hashes de forma robusta: si el valor guardado es de un
  // formato viejo o está corrupto (p.ej. '1'), se reinicia a lista vacía.
  function confirmSkipList(key) {
    try {
      const v = JSON.parse(sessionStorage.getItem(key) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (_) { return []; }
  }
  function confirmSkipHas(key, t) {
    return confirmSkipList(key).includes(hashText(t));
  }
  function confirmSkipSet(key, t, on) {
    try {
      const hashes = confirmSkipList(key);
      const h = hashText(t);
      const next = on ? [...new Set([...hashes, h])] : hashes.filter(x => x !== h);
      sessionStorage.setItem(key, JSON.stringify(next));
    } catch (_) {}
  }

  // Headers de auth para fetch del widget: Bearer si hay JWT en localStorage
  // + same-origin para que la cookie httpOnly del login acompañe siempre.
  function authHeaders() {
    // El header Authorization SOLO viaja si hay token: un "Bearer " vacío o
    // un token caducado hacen que el backend descarte la sesión, aunque la
    // cookie httpOnly del login siga viva.
    const token = localStorage.getItem('jwt') || '';
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  function cleanForSpeech(text) {
    return text.replace(/\*\*/g, '').replace(/`/g, '').trim();
  }

  // ---- Voz de lectura: selector por usuario (cabecera del panel) ----
  // La API de voces no informa género, así que se reconoce por nombre y solo
  // se etiqueta cuando se reconoce. Lista corta y curada: español (1 hombre
  // + mujeres hasta 3) y 2 en inglés. Versión local: sin imports cruzados.
  function ttsGenderTag(name) {
    const MALE_RE = /(jorge|diego|carlos|enrique|pablo|juan|andres|andrés|ricardo|manuel|gonzalo|raul|raúl|david|mark|george|daniel|james|male|hombre)/i;
    const FEMALE_RE = /(monica|mónica|sabina|helena|laura|lucia|lucía|paulina|elena|carmen|isabela|marisol|esperanza|sofia|sofía|camila|zira|aria|jenny|samantha|susan|karen|female|mujer)/i;
    const n = String(name || '');
    if (MALE_RE.test(n)) return ' · hombre';
    if (FEMALE_RE.test(n)) return ' · mujer';
    return '';
  }

  function curatedTtsVoices() {
    if (!window.speechSynthesis) return { es: [], en: [] };
    const all = (speechSynthesis.getVoices() || []).filter((v) => v && v.lang);
    const es = all.filter((v) => v.lang.toLowerCase().indexOf('es') === 0);
    const en = all.filter((v) => v.lang.toLowerCase().indexOf('en') === 0);
    const pick = (arr, limit, wanted) => {
      const out = [];
      for (const g of wanted) {
        const hit = arr.find((v) => ttsGenderTag(v.name) === ' · ' + g && out.indexOf(v) === -1);
        if (hit) out.push(hit);
      }
      for (const v of arr) {
        if (out.length >= limit) break;
        if (out.indexOf(v) === -1) out.push(v);
      }
      return out;
    };
    return { es: pick(es, 3, ['hombre', 'mujer', 'mujer']), en: pick(en, 2, []) };
  }

  // Selección de voz: prioriza las de mejor calidad que trae el sistema.
  // (Google y Microsoft Natural/Online suenan mucho mejor que las base.)
  function pickBestVoice() {
    const voices = speechSynthesis.getVoices();
    // Voz elegida por el usuario en el panel (localStorage) tiene prioridad.
    try {
      const saved = JSON.parse(localStorage.getItem('tts_voice') || 'null');
      if (saved && saved.name) {
        const mine = voices.find(v => v.name === saved.name && (!saved.lang || v.lang === saved.lang));
        if (mine) return mine;
      }
    } catch (_) { /* preferencia corrupta: auto */ }
    // Voz predeterminada del admin (state.ttsVoice = 'nombre|idioma'):
    // partir por el ÚLTIMO '|' por si el nombre llegara a contener ese carácter.
    if (state.ttsVoice) {
      const sep = state.ttsVoice.lastIndexOf('|');
      const name = sep >= 0 ? state.ttsVoice.slice(0, sep) : state.ttsVoice;
      const lang = sep >= 0 ? state.ttsVoice.slice(sep + 1) : '';
      const server = voices.find(v => v.name === name && (!lang || v.lang === lang));
      if (server) return server;
    }
    const es = voices.filter(v => v.lang && v.lang.toLowerCase().startsWith('es'));
    if (es.length === 0) return null;
    const score = (v) => {
      const n = v.name.toLowerCase();
      let s = 0;
      if (n.includes('natural') || n.includes('online')) s += 100;  // neuronas
      if (n.includes('google')) s += 80;                            // Chrome
      if (n.includes('microsoft')) s += 60;                          // Edge/Win
      if (/es-cl|es-419|es-mx|es-ar|es-co/.test(v.lang.toLowerCase())) s += 20; // LatAm
      else if (v.lang.toLowerCase() === 'es-es') s += 10;
      if (v.localService) s += 5;
      return s;
    };
    return es.sort((a, b) => score(b) - score(a))[0];
  }

  // Precarga: las voces cargan async (Chrome dispara voiceschanged después).
  if (window.speechSynthesis) {
    speechSynthesis.getVoices();
    speechSynthesis.onvoiceschanged = () => {
      speechSynthesis.getVoices();
      fillVoiceSelect(); // la lista llegó: repoblar el selector de la cabecera
    };
  }

  // Chunking por oraciones: Chrome/Edge cortan utterances muy largas.
  function splitForSpeech(text, maxLen) {
    const sentences = text.split(/(?<=[.!?¿¡])\s+|\n+/);
    const chunks = [];
    let current = '';
    for (const s of sentences) {
      if ((current + ' ' + s).trim().length <= maxLen) {
        current = (current + ' ' + s).trim();
      } else {
        if (current) chunks.push(current);
        // Oración individual más larga que maxLen: cortar por palabras.
        let rest = s;
        while (rest.length > maxLen) {
          let cut = rest.lastIndexOf(' ', maxLen);
          if (cut < 20) cut = maxLen;
          chunks.push(rest.slice(0, cut));
          rest = rest.slice(cut).trim();
        }
        current = rest;
      }
    }
    if (current) chunks.push(current);
    return chunks.length ? chunks : [text];
  }

  // Botón STOP flotante: visible solo mientras la locución suena.
  function showStopButton() {
    if (document.getElementById('tts-stop-btn')) return;
    const btn = el('button', {
      id: 'tts-stop-btn',
      type: 'button',
      class: 'fixed bottom-4 right-4 z-50 inline-flex items-center gap-2 rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-lg transition hover:bg-rose-700',
      title: 'Detener audio',
      'aria-label': 'Detener audio'
    });
    const stopSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    stopSvg.setAttribute('viewBox', '0 0 24 24');
    stopSvg.setAttribute('fill', 'currentColor');
    stopSvg.setAttribute('aria-hidden', 'true');
    stopSvg.classList.add('h-4', 'w-4');
    stopSvg.style.pointerEvents = 'none';
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '6');
    rect.setAttribute('y', '6');
    rect.setAttribute('width', '12');
    rect.setAttribute('height', '12');
    stopSvg.appendChild(rect);
    btn.append(stopSvg, document.createTextNode('Detener'));
    btn.onclick = () => {
      speechSynthesis.cancel();
      hideStopButton();
      enableTtsButtons();
    };
    document.body.append(btn);
  }

  function hideStopButton() {
    const b = document.getElementById('tts-stop-btn');
    if (b) b.remove();
  }

  function speakText(text) {
    showStopButton();
    const voice = pickBestVoice();
    const chunks = splitForSpeech(text, 200);
    speechSynthesis.cancel();
    chunks.forEach((chunk, i) => {
      const utter = new SpeechSynthesisUtterance(chunk);
      utter.lang = voice ? voice.lang : 'es-ES';
      if (voice) utter.voice = voice;
      utter.rate = 1;
      utter.pitch = 1;
      utter.volume = 1;
      if (i === chunks.length - 1) {
        // El ÚLTIMO chunk re-habilita SIEMPRE (fin, error o interrupción).
        utter.onend = () => { enableTtsButtons(); hideStopButton(); };
        utter.onerror = () => { enableTtsButtons(); hideStopButton(); };
      }
      // speechSynthesis encola automáticamente: suenan en orden.
      speechSynthesis.speak(utter);
    });
  }

  function disableTtsButtons() {
    document.querySelectorAll('.tts-btn').forEach(b => { b.disabled = true; });
  }

  function enableTtsButtons() {
    document.querySelectorAll('.tts-btn').forEach(b => { b.disabled = false; });
  }

  const cr = (n) => `${n} crédito${n === 1 ? '' : 's'}`;

  async function ttsQuote(text) {
    const r = await fetch(apiUrl('/tts'), {
      method: 'POST',
      headers: authHeaders(),
      credentials: 'include',
      // Dev-only per-request heart: the quote must read the SAME wallet the
      // panel's header shows (multi-heart local installs).
      body: JSON.stringify({ text, quote: true, ...(options.extraBody || {}) })
    });
    return r.json();
  }

  async function ttsCharge(text, operationId) {
    const r = await fetch(apiUrl('/tts'), {
      method: 'POST',
      headers: authHeaders(),
      credentials: 'include',
      // Same heart override as /chat/completions (see sendQuestion): the
      // locución debits the wallet of the chat that is speaking.
      body: JSON.stringify({ text, operationId, ...(options.extraBody || {}) })
    });
    return r.json();
  }

  // Confirm TTS: overlay liviano con desglose oficial (server quote).
  function openTtsConfirm(text, isFragment) {
    const overlay = el('div', {
      class: 'fixed inset-0 z-50 hidden items-center justify-center bg-slate-900/40 p-4'
    });
    const box = el('div', { class: 'mx-4 w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl' });
    const totalEl = el('p', { class: 'text-sm font-medium text-sky-900' }, ['Calculando…']);
    const detailEl = el('p', { class: 'mt-1 text-xs leading-relaxed text-sky-700' }, '');
    box.append(
      el('h3', { class: 'text-base font-semibold text-slate-900' }, [isFragment ? 'Escuchar fragmento seleccionado' : 'Escuchar mensaje']),
      el('p', { class: 'mt-2 text-sm leading-relaxed text-slate-600' }, [
        'La locución es una operación pagada. No reemplaza a un profesional: es solo una ayuda para acceder al contenido.'
      ]),
      el('div', { class: 'mt-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900' }, [totalEl, detailEl]),
      (function () {
        const label = el('label', {
          class: 'mt-3 flex items-center gap-2 text-xs text-slate-600 select-none'
        });
        const cb = el('input', { type: 'checkbox', class: 'h-3.5 w-3.5 rounded border-slate-300 text-brand-600' });
        cb.addEventListener('change', () => {
          confirmSkipSet('aj:no-confirm-tts', text, cb.checked);
        });
        label.append(cb, document.createTextNode('No deseo recibir más esta notificación (solo en esta sesión)'));
        return label;
      })()
    );
    const actions = el('div', { class: 'mt-4 flex justify-end gap-2' });
    const backBtn = el('button', {
      type: 'button',
      class: 'rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400'
    }, ['Volver']);
    const okBtn = el('button', {
      type: 'button',
      class: 'inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700'
    }, ['Escuchar']);
    actions.append(backBtn, okBtn);
    box.append(actions);
    overlay.append(box);
    document.body.append(overlay);
    requestAnimationFrame(() => { overlay.classList.remove('hidden'); overlay.classList.add('flex'); });
    backBtn.onclick = () => overlay.remove();
    okBtn.onclick = async () => {
      overlay.remove();
      disableTtsButtons();
      try {
        const charged = await ttsCharge(text, 'tts_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
        if (charged && charged.success) {
          if (typeof charged.new_balance === 'number') {
            state.balance = charged.new_balance;
            balanceBadge.textContent = `Saldo restante: ${charged.new_balance} crédito${charged.new_balance === 1 ? '' : 's'}`;
            balanceBadge.classList.remove('hidden');
            if (typeof options.onBalanceChange === 'function') options.onBalanceChange(charged.new_balance);
          }
          ttsCooldownUntil = Date.now() + 10000;
          speakText(text);
        } else {
          // Cobro no autorizado (p.ej. 402): re-habilitar para que el
          // usuario pueda reintentar tras recargar.
          hideStopButton();
          enableTtsButtons();
          showErrorOverlay(charged.error || 'No se pudo autorizar la locución.');
        }
      } catch (err) {
        hideStopButton();
        enableTtsButtons();
        showErrorOverlay('Error al autorizar: ' + err.message);
      }
    };
    ttsQuote(text).then(q => {
      const p = q && q.success && q.pricing ? q.pricing : null;
      if (!p) return;
      totalEl.textContent = `Costo de escuchar: ${cr(p.total_credits)}`;
      detailEl.textContent = `Base: ${cr(p.base_credits)} · Contenido: ${p.chars.toLocaleString('es-CL')} caracteres `
        + `≈ ${p.tokens.toLocaleString('es-CL')} tokens → ${cr(p.token_credits)}`;
    }).catch(() => {});
  }

  function showErrorOverlay(msg) {
    const overlay = el('div', {
      class: 'fixed inset-0 z-50 hidden items-center justify-center bg-slate-900/40 p-4'
    });
    const box = el('div', { class: 'mx-4 w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl' });
    box.append(el('p', { class: 'text-sm text-slate-700' }, [msg]));
    const ok = el('button', {
      type: 'button',
      class: 'mt-4 w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700'
    }, ['Entendido']);
    ok.onclick = () => overlay.remove();
    box.append(ok);
    overlay.append(box);
    document.body.append(overlay);
    requestAnimationFrame(() => { overlay.classList.remove('hidden'); overlay.classList.add('flex'); });
  }

  /**
   * Modal de confirmación de borrado (rojo): siempre pide confirmación
   * explícita. La info eliminada NO es recuperable; link a privacidad.
   * @returns Promise<boolean> true si el usuario confirmó.
   */
  function confirmDangerModal({ title, message, confirmLabel }) {
    return new Promise((resolve) => {
      const overlay = el('div', {
        class: 'fixed inset-0 z-50 hidden items-center justify-center bg-slate-900/40 p-4'
      });
      const box = el('div', {
        class: 'mx-4 w-full max-w-md rounded-2xl border border-rose-300 bg-white p-5 shadow-xl'
      });

      // Encabezado rojo: icono de advertencia + título.
      const head = el('div', { class: 'flex items-start gap-3' });
      const iconWrap = el('span', {
        class: 'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-600'
      });
      const warnSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      warnSvg.setAttribute('viewBox', '0 0 24 24');
      warnSvg.setAttribute('fill', 'none');
      warnSvg.setAttribute('stroke', 'currentColor');
      warnSvg.setAttribute('stroke-width', '2');
      warnSvg.setAttribute('stroke-linecap', 'round');
      warnSvg.setAttribute('stroke-linejoin', 'round');
      warnSvg.setAttribute('aria-hidden', 'true');
      warnSvg.classList.add('h-5', 'w-5');
      warnSvg.style.pointerEvents = 'none';
      const warnPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      warnPath.setAttribute('d', 'M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z');
      warnSvg.appendChild(warnPath);
      iconWrap.appendChild(warnSvg);
      head.append(iconWrap, el('h3', { class: 'text-base font-semibold text-rose-700' }, [title]));

      const msg = el('p', { class: 'mt-3 text-sm leading-relaxed text-slate-600' }, [message]);
      // Link a la política de privacidad (nueva pestaña: no pierde el modal).
      const link = el('a', {
        href: '/index.html#/privacidad',
        target: '_blank',
        rel: 'noopener',
        class: 'mt-2 inline-block text-xs font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800'
      }, ['Ver nuestra Política de Privacidad']);

      const actions = el('div', { class: 'mt-5 flex justify-end gap-2' });
      const cancelBtn = el('button', {
        type: 'button',
        class: 'rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400'
      }, ['Cancelar']);
      const okBtn = el('button', {
        type: 'button',
        class: 'rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-700'
      }, [confirmLabel || 'Sí, eliminar']);
      actions.append(cancelBtn, okBtn);

      box.append(head, msg, link, actions);
      overlay.append(box);
      document.body.append(overlay);
      requestAnimationFrame(() => { overlay.classList.remove('hidden'); overlay.classList.add('flex'); });
      // Cierre SOLO explícito (sin click fuera).
      const done = (val) => { overlay.remove(); resolve(val); };
      cancelBtn.onclick = () => done(false);
      okBtn.onclick = () => done(true);
    });
  }

  async function startTtsFlow(clean, isFragment) {
    try {
      const q = await ttsQuote(clean);
      if (!q.success) { showErrorOverlay(q.error || 'No se pudo cotizar la locución.'); return; }
      openTtsConfirm(clean, isFragment);
    } catch (err) {
      showErrorOverlay('Error al cotizar: ' + err.message);
    }
  }

  /**
   * Helper único para descargar el documento editado (1 crédito).
   * Usa el endpoint existente /documents/download (REST), que cobra la tarifa
   * vigente de 'document_download' (idempotente por operationId).
   * @param {{ html: string, text?: string }} result — salida del ChatEditor
   * @param {string} [format='pdf'] — 'txt' | 'docx' | 'pdf'
   */
  function downloadEditedDocument({ html }, format = 'pdf') {
    const uuid = self.crypto.randomUUID();
    fetch(apiUrl('/documents/download'), {
      method: 'POST',
      credentials: 'include',
      headers: authHeaders(),
      body: JSON.stringify({
        html: html,
        templateId: 'demanda_alimentos',
        format: format,
        operationId: uuid,
        heart: localStorage.getItem('heart_id') || 'atscv'
      })
    })
    .then(r => r.json())
    .then(d => {
      if (d.success && d.blob_base64) {
        // El server devuelve base64; decodificar a bytes y descargar.
        const bin = atob(d.blob_base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = d.filename || ('documento.' + format);
        a.click();
        URL.revokeObjectURL(url);

        // El endpoint ya debitó: reflejar el saldo real en el badge.
        if (typeof d.new_balance === 'number') {
          state.balance = d.new_balance;
          state.authenticated = true;
          balanceBadge.textContent = `Saldo restante: ${d.new_balance} crédito${d.new_balance === 1 ? '' : 's'}`;
          balanceBadge.classList.remove('hidden');
          if (typeof options.onBalanceChange === 'function') {
            options.onBalanceChange(d.new_balance);
          }
        }
      } else if (d.error) {
        addMessage('assistant', '✶ ' + d.error + (typeof d.balance === 'number' ? ' (saldo: ' + d.balance + ' créditos)' : '') + '. Recarga tu billetera para continuar.', undefined, { instant: true });
      }
    })
    .catch(err => {
      console.error('Download failed:', err);
      addMessage('assistant', '⚌ No se pudo generar el documento. Intenta nuevamente.', undefined, { instant: true });
    });
  }

  /** Iconos SVG inline para las acciones por burbuja. */
  function svgIcon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('h-3.5', 'w-3.5');
    // Los SVG tienen className como SVGAnimatedString (no string): cualquier
    // handler global (ej. extensiones del navegador) que haga
    // e.target.className.indexOf(...) crashea si el click cae en el SVG.
    // pointer-events:none garantiza que el target sea siempre el <button>.
    svg.style.pointerEvents = 'none';

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    if (name === 'audio') {
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('d', 'M11 5L6 9H2v6h4l5 4V5z M15.54 8.46a5 5 0 010 7.07 M19.07 4.93a10 10 0 010 14.14');
    } else if (name === 'download') {
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('d', 'M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2');
    } else if (name === 'pencil') {
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('d', 'M15.232 5.232l3.536 3.536M4 20h4l10-10-4-4L4 16v4z');
    } else {
      // trash
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('d', 'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16');
    }
    svg.appendChild(path);
    return svg;
  }

  function addTypingRow() {
    // Same shape as an assistant row: bot circle at the left, dots inside
    // the content column, so the swap to the real answer never jumps.
    const row = el('div', { class: 'flex items-end gap-2' });
    const content = el('div', { class: 'flex min-w-0 flex-1 flex-col items-start' });
    const bubble = el('div', {
      class: 'flex items-center gap-1 rounded-2xl rounded-bl-sm bg-slate-100 px-4 py-3',
    });
    for (let i = 0; i < 3; i++) {
      bubble.append(el('span', {
        class: 'h-2 w-2 animate-bounce rounded-full bg-slate-400',
        style: `animation-delay:${(i * 0.15).toFixed(2)}s`,
      }));
    }
    content.append(bubble);
    row.append(botAvatarNode(state.botAvatar, 'sm'), content);
    list.append(row);
    // Follow the new row only if the user is already near the bottom: if
    // they scrolled up to re-read, don't yank them down. While typing, the
    // typewriter re-checks on every tick and resumes following when the
    // user returns near the bottom.
    if (nearBottom()) {
      list.scrollTop = list.scrollHeight;
    }
    return row;
  }

  /**
   * @param {Array<{ title?: string|null, scope?: string }>} sources
   */
  function renderSources(sources) {
    if (!Array.isArray(sources) || sources.length === 0) {
      return;
    }

    // Minimized card: collapsed by default, the user expands it when they
    // want to see the consulted sources. Native <details> keeps the a11y
    // tree simple (summary is the toggle).
    const box = el('details', {
      class: 'mt-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1',
    });

    const summary = el('summary', {
      class: 'cursor-pointer select-none text-[11px] font-medium uppercase tracking-wide text-slate-400',
    });
    summary.textContent = `Fuentes consultadas (${sources.length})`;

    const sourceList = el('div', { class: 'mt-1 space-y-0.5' });

    for (const source of sources) {
      const line = el('p', { class: 'truncate text-[11px] text-slate-500' });
      const name = source.title || 'Documento sin título';
      line.textContent = source.scope === 'user' ? `• ${name} (tus documentos)` : `• ${name}`;
      sourceList.append(line);
    }

    box.append(summary, sourceList);

    // Assistant rows carry a leading identity <span>; the content column is
    // their last div child (fallback: the row itself).
    const lastRow = list.lastElementChild;
    const column = lastRow && lastRow.querySelector(':scope > div:last-child');

    if (column || lastRow) {
      (column || lastRow).append(box);
    }
  }

  async function sendQuestion(question) {
    state.busy = true;
    sendButton.disabled = true;
    sendIcon.classList.add('hidden');
    sendBusy.classList.remove('hidden');

    addMessage('user', question);
    input.value = '';
    input.style.height = 'auto';

    const typingRow = addTypingRow();

    try {
      // Cross-server topology: the chat brain lives on the API origin, so
      // the absolute URL goes through apiUrl() (api-config.js). Kept the
      // optional options.apiBase as an explicit override for embeds.
      const response = await fetch(apiUrl('/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        // Same-origin credentials: the httpOnly auth cookie rides along
        // when the user is logged in.
        credentials: 'include',
        body: JSON.stringify({
          question,
          ...(state.conversationId ? { conversation_id: state.conversationId } : {}),
          // Host-injected extra fields (e.g. dev-only per-request heart).
          ...(options.extraBody || {}),
        }),
      });

      const payload = await response.json().catch(() => null);

      typingRow.remove();

      if (!response.ok) {
        const message = payload && payload.error && payload.error.message
          ? payload.error.message
          : defaultMessageFor(response.status);

        // Host hook: the panel can react to a specific error code (e.g. the
        // email re-verification gate) with its own banner and next step.
        if (typeof options.onError === 'function') {
          try {
            options.onError({
              status: response.status,
              code: (payload && payload.error && payload.error.code) || '',
              message,
            });
          } catch (_) { /* el error del host no rompe el chat */ }
        }

        addMessage('assistant', message, undefined, { instant: true });
        return;
      }

      const data = payload && payload.data ? payload.data : {};

      state.conversationId = data.conversation_id || state.conversationId;
      storeConversationId(state.conversationId);
      state.authenticated = typeof data.balance === 'number';

      // Sources RAG únicos citados por esta respuesta (para el borrado 🗑️).
      const ragSourceIds = Array.isArray(data.sources)
        ? [...new Set(data.sources.map(s => String(s.source_id || '')).filter(Boolean))]
        : [];

      if (state.authenticated) {
        state.balance = data.balance;
        balanceBadge.textContent = `Saldo restante: ${data.balance} crédito${data.balance === 1 ? '' : 's'}`;
        balanceBadge.classList.remove('hidden');

        if (typeof options.onBalanceChange === 'function') {
          options.onBalanceChange(data.balance);
        }
      }

      addMessage('assistant', String(data.answer ?? ''), {
        sourceIds: ragSourceIds,
        informeHtml: typeof data.informe_html === 'string' ? data.informe_html : '',
      });
      renderSources(data.sources);
      renderMonitoring(data.monitoring);

      // The full prompt (system + user + the RETRIEVED CONTEXT) is internal.
      // The analysis reaches the chat silently: dumping the raw prompt here
      // would spill the recovered documents (the person's own CV, the legal
      // fragments) into the conversation as a wall of text. It stays opt-in
      // for whoever needs to debug the retrieval.
      if (options.showPromptDebug) {
        renderPromptDebug(data.prompt_sent);
      }

      // Subtle arrival chime (opt-in from Perfil) — success path only:
      // errors/catch above must stay silent.
      if (soundsEnabled()) {
        playChime('chat');
      }
    } catch (networkError) {
      typingRow.remove();
      addMessage('assistant', 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo nuevamente.', undefined, { instant: true });
    } finally {
      state.busy = false;
      sendButton.disabled = false;
      sendBusy.classList.add('hidden');
      sendIcon.classList.remove('hidden');
      input.focus();
    }
  }

  /**
   * Renders token usage + real cost monitoring line (for tariff adjustment).
   *
   * @param {{input_tokens?: number, output_tokens?: number, total_tokens?: number, cost_usd?: number, cost_clp?: number}} monitoring
   */
  function renderMonitoring(monitoring) {
    if (!monitoring || typeof monitoring !== 'object') return;
    const total = monitoring.total_tokens ?? ((monitoring.input_tokens ?? 0) + (monitoring.output_tokens ?? 0));
    if (!total) return;

    const row = el('div', { class: 'flex justify-start' });
    const box = el('div', {
      class: 'max-w-[85%] rounded-xl bg-slate-50 border border-slate-200 px-3 py-2 text-[11px] text-slate-500 font-mono',
    });

    const usd = typeof monitoring.cost_usd === 'number' ? '$' + monitoring.cost_usd.toFixed(6) : '';
    const clp = typeof monitoring.cost_clp === 'number' ? '$' + Math.round(monitoring.cost_clp).toLocaleString('es-CL') + ' CLP' : '';
    const cost = [usd, clp].filter(Boolean).join(' = ');

    box.textContent = `📊 Tokens: in=${monitoring.input_tokens ?? 0} out=${monitoring.output_tokens ?? 0} total=${total}` + (cost ? ` · Costo real: ${cost}` : '');
    row.append(box);
    list.append(row);
    // Follow the new row only if the user is already near the bottom: if
    // they scrolled up to re-read, don't yank them down. While typing, the
    // typewriter re-checks on every tick and resumes following when the
    // user returns near the bottom.
    if (nearBottom()) {
      list.scrollTop = list.scrollHeight;
    }
  }

  /**
   * Renders the complete prompt sent to the AI (system + user) as a
   * collapsible <details> block, so you can see exactly what the AI receives.
   *
   * @param {{system?: string, user?: string}} prompt
   */
  function renderPromptDebug(prompt) {
    if (!prompt || typeof prompt !== 'object') return;
    if (!prompt.system && !prompt.user) return;

    const row = el('div', { class: 'flex justify-start' });
    const details = el('details', {
      class: 'max-w-[85%] rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-[11px] text-amber-900',
    });
    const summary = el('summary', { class: 'cursor-pointer font-medium select-none' });
    summary.textContent = '🔧 Prompt enviado a la IA (click para ver)';
    details.append(summary);

    const sysLabel = el('p', { class: 'mt-2 font-bold' });
    sysLabel.textContent = 'SYSTEM:';
    // No max-height cap: the user asked to see the FULL prompt. The
    // <details> starts collapsed, so full height only costs space when open.
    const sysPre = el('pre', { class: 'whitespace-pre-wrap break-words bg-white/60 rounded-lg p-2 mt-1' });
    sysPre.textContent = prompt.system || '(vacío)';
    const userLabel = el('p', { class: 'mt-2 font-bold' });
    userLabel.textContent = 'USER:';
    const userPre = el('pre', { class: 'whitespace-pre-wrap break-words bg-white/60 rounded-lg p-2 mt-1' });
    userPre.textContent = prompt.user || '(vacío)';

    details.append(sysLabel, sysPre, userLabel, userPre);
    row.append(details);
    list.append(row);
    // Follow the new row only if the user is already near the bottom: if
    // they scrolled up to re-read, don't yank them down. While typing, the
    // typewriter re-checks on every tick and resumes following when the
    // user returns near the bottom.
    if (nearBottom()) {
      list.scrollTop = list.scrollHeight;
    }
  }

  return {
    get conversationId() {
      return state.conversationId;
    },
    // Continue a conversation created outside the widget (e.g. the
    // ley_datos informe conversation recorded server-side).
    setConversationId(id) {
      state.conversationId = id || null;
      storeConversationId(state.conversationId);
    },
    addMessage: (role, text, meta, opts) => addMessage(role, text, meta, opts),
    attachmentHost,
    sendQuestion,
    destroy() {
      container.replaceChildren();
    },
  };
}
