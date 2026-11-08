import { apiUrl } from './api-base.js';
/**
 * Chat Editor Core — Rich text editor (Quill self-hosted) in a resizable modal.
 *
 * Features:
 *   - Modal overlay with explicit X close (no click-outside close).
 *   - Loads the bubble content (plain text or HTML).
 *   - Friendly format selector (TXT / DOCX / PDF chips with icons + labels).
 *   - "Descargar" button + small credit-cost info tag.
 *   - Resizable card via bottom-right drag handle.
 *   - Hand-off to the existing document-download endpoint (1 crédito, idempotente).
 *
 * Usage in chat context:
 *   ChatEditor.open(bubbleText, onSave, onDownload)
 *   // onSave({html, text})       — content edited (fallback if no onDownload)
 *   // onDownload(format, {html,text}) — called with 'txt' | 'docx' | 'pdf'
 */

(function() {
  'use strict';

  // El header Authorization SOLO viaja si hay token: un "Bearer " vacío o un
  // token caducado hacen que el backend descarte la sesión, aunque la cookie
  // httpOnly del login siga viva. La cookie es la credencial principal.
  function authHeaders(extra = {}) {
    const token = localStorage.getItem('jwt') || '';
    const headers = Object.assign({}, extra);
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  // ---- Config ----
  // Quill AUTOHOSPEDADO en /js/vendor y /css: la CSP del shell define
  // style-src 'self' + tailwindcss + fonts — jsdelivr NO está en style-src
  // y cdn.quilljs.com en ninguno, así que el CDN queda bloqueado por el
  // navegador (error de stylesheet violando style-src). 'self' siempre pasa.
  // Bytes verificados idénticos a jsdelivr 1.3.7 (sin "latest").
  const QUILL_SOURCE = './js/vendor/quill.min.js';
  const QUILL_STYLE = './css/quill.snow.css';

  // Costo por descarga (coincide con la tarifa 'document_download' en tariffs).
  const DOWNLOAD_COST_LABEL = '1 crédito por descarga';

  // ---- Lazy-load Quill via Promise ----
  function loadQuill() {
    return new Promise((resolve, reject) => {
      if (window.Quill) return resolve(window.Quill);
      const js = document.createElement('script');
      js.src = QUILL_SOURCE;
      js.async = true;
      js.onload = () => {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = QUILL_STYLE;
        css.media = 'screen';
        document.head.appendChild(css);
        resolve(window.Quill);
      };
      js.onerror = () => reject(new Error('No se pudo cargar el editor (Quill).'));
      document.head.appendChild(js);
    });
  }

  // ---- DOM helpers ----
  // 'class' NO es propiedad JS de un elemento (es className): Object.assign
  // crearía un expando inútil y las clases Tailwind nunca se aplicarían.
  function elt(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') {
          e.className = v;
        } else if (k === 'style' && typeof v === 'string') {
          e.style.cssText = v;
        } else {
          e.setAttribute(k, v);
        }
      }
    }
    if (children) {
      // Acepta un nodo, un string (texto), o un array de ambos.
      const list = Array.isArray(children) ? children : [children];
      list.forEach(c => {
        if (typeof c === 'string') {
          e.appendChild(document.createTextNode(c));
        } else if (c instanceof Node) {
          e.appendChild(c);
        }
      });
    }
    return e;
  }
  function q(s, parent = document) { return parent.querySelector(s); }

  // ---- Icons (inline SVG, pointer-events none por seguridad de extensiones) ----
  function qIcon(name, extraClass) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    // Los SVG tienen className como SVGAnimatedString (no string): cualquier
    // handler global (ej. extensiones) que haga e.target.className.indexOf(...)
    // crashea si el click cae en el SVG. pointer-events:none lo evita.
    svg.style.pointerEvents = 'none';
    svg.classList.add('h-4', 'w-4', 'shrink-0');
    if (extraClass) extraClass.split(' ').forEach(c => svg.classList.add(c));

    const paths = {
      x: 'M6 6l12 12M18 6L6 18',
      download: 'M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2',
      file: 'M13 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V9l-6-6zM13 3v6h6M9 13h6m-6 4h4',
      maximize: 'M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3',
      restore: 'M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3',
      resize: 'M21 21l-5-5M21 15v6h-6M14 10l-4-4M10 14l4 4M3 14v7h7'
    };
    const d = paths[name] || paths.file;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }

  // ---- Public API ----
  const ChatEditor = {
    // Open modal with initial text, return {close, getContent}
    // onDownload(format, {html, text}) — callback for TXT/DOCX/PDF exports.
    open(text, onSave, onDownload) {
      this._onDownload = onDownload || null;
      this._onSave = onSave || null;
      loadQuill().then(Quill => this._open(text, Quill)).catch(err => {
        console.error('Editor load failed:', err);
      });
      return {
        close: () => { const m = q('#chat-editor-modal'); if (m) m.remove(); },
        getContent: () => this.quill ? this.quill.getContents() : null
      };
    },

    _open(text, Quill) {
      // Skip de confirm POR BURBUJA: hash estable del texto en sessionStorage
      // (solo la sesión actual). Cada burbuja decide por separado.
      const hashText = (t) => {
        let h = 5381;
        for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
        return 'h' + (h >>> 0).toString(16);
      };
      // Parseo robusto: formatos viejos o corruptos reinician a lista vacía
      // (si el valor guardado es '1', JSON.parse da número y rompía el skip).
      const confirmSkipList = (key) => {
        try {
          const v = JSON.parse(sessionStorage.getItem(key) || '[]');
          return Array.isArray(v) ? v : [];
        } catch (_) { return []; }
      };
      const confirmSkipHas = (key, t) => confirmSkipList(key).includes(hashText(t));
      const confirmSkipSet = (key, t, on) => {
        const hashes = confirmSkipList(key);
        const h = hashText(t);
        const next = on ? [...new Set([...hashes, h])] : hashes.filter(x => x !== h);
        sessionStorage.setItem(key, JSON.stringify(next));
      };

      // Defensivo: si quedó un modal huérfano de una sesión anterior
      // (cleanup fallido), eliminarlo antes de crear uno nuevo —
      // si no, new Quill('#chat-editor') se liga al elemento viejo.
      const stale = q('#chat-editor-modal');
      if (stale) stale.remove();

      // ---- Modal overlay (sin cierre por click fuera: cierre explícito X) ----
      const modal = elt('div', {
        id: 'chat-editor-modal',
        class: 'fixed inset-0 z-50 hidden items-center justify-center bg-black/40 p-4'
      });

      const card = elt('div', {
        class: 'relative flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl',
        style: 'height: 72vh; min-height: 420px;'
      });

      // ---- Header: título + tag de costo + X ----
      const header = elt('div', {
        class: 'flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3'
      });
      const titleWrap = elt('div', { class: 'flex min-w-0 items-center gap-2' });
      // Tag del costo: base administrable desde /tariffs (tabla tariffs).
      // El total final = base + créditos por tokens del contenido.
      const costTag = elt('span', {
        class: 'inline-flex shrink-0 items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-medium leading-none text-sky-700',
        title: 'La tarifa base es configurable por el administrador'
      }, ['Base: 1 cr + tokens']);
      titleWrap.append(
        elt('span', { class: 'truncate text-sm font-semibold text-slate-800' }, ['Editar respuesta']),
        costTag
      );
      const closeBtn = elt('button', {
        type: 'button',
        class: 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-700',
        'aria-label': 'Cerrar editor',
        title: 'Cerrar (Esc)'
      }, [qIcon('x')]);
      // ---- Toggle maximizar/restaurar junto a la X ----
      let maximized = false;
      let preMaxGeo = null;
      const maxBtn = elt('button', {
        type: 'button',
        class: 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-700',
        'aria-label': 'Maximizar editor'
      }, [qIcon('maximize')]);
      const setMaxIcon = (isMax) => {
        maxBtn.replaceChildren(qIcon(isMax ? 'restore' : 'maximize'));
        maxBtn.title = isMax ? 'Volver al tamaño real' : 'Maximizar';
        maxBtn.setAttribute('aria-label', maxBtn.title);
      };
      maxBtn.onclick = () => {
        maximized = !maximized;
        if (maximized) {
          preMaxGeo = { w: card.offsetWidth, h: card.offsetHeight };
          applyMaximized();
          saveGeo({ maximized: true });
        } else {
          const geo = preMaxGeo || { w: 672, h: Math.floor(window.innerHeight * 0.72) };
          card.style.maxWidth = 'none';
          card.style.width = geo.w + 'px';
          card.style.height = geo.h + 'px';
          saveGeo(geo);
        }
        setMaxIcon(maximized);
      };

      // maxBtn + X juntos a la derecha (justify-between con 3 hijos
      // dejaba el maximize flotando en el medio, lejos de la X).
      const headerActions = elt('div', { class: 'flex items-center gap-1.5 shrink-0' });
      headerActions.append(maxBtn, closeBtn);
      header.append(titleWrap, headerActions);

      // ---- Geometría persistida (localStorage): sobrevive recargas ----
      const GEO_KEY = 'aj:editor:geometry';
      const loadGeo = () => {
        try { return JSON.parse(localStorage.getItem(GEO_KEY) || 'null'); }
        catch (_) { return null; }
      };
      const saveGeo = (geo) => {
        try { localStorage.setItem(GEO_KEY, JSON.stringify(geo)); } catch (_) {}
      };
      const applyMaximized = () => {
        card.style.maxWidth = 'none';
        card.style.width = '98vw';
        card.style.height = '94vh';
      };
      const applyGeo = (geo) => {
        if (!geo) return;
        if (geo.maximized) { applyMaximized(); return; }
        if (geo.w) { card.style.maxWidth = 'none'; card.style.width = geo.w + 'px'; }
        if (geo.h) { card.style.height = geo.h + 'px'; }
      };

      // ---- Cuerpo del editor ----
      const editorWrap = elt('div', { class: 'min-h-0 flex-1 overflow-y-auto px-4 py-3' });
      const editor = elt('div', { id: 'chat-editor', style: 'min-height: 100%;' });
      editorWrap.append(editor);

      // ---- Footer: selector de formato (chips con icono + label) + Descargar ----
      const footer = elt('div', {
        class: 'flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3'
      });

      const fmtWrap = elt('div', { class: 'flex items-center gap-2', role: 'group', 'aria-label': 'Formato de descarga' });
      fmtWrap.append(elt('span', { class: 'text-xs font-medium text-slate-500' }, ['Descargar como:']));

      let selectedFormat = 'pdf';
      const fmtChips = {};
      const chipBase = 'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition select-none ';
      const chipOff = chipBase + 'border-slate-300 bg-white text-slate-600 hover:border-brand-400 hover:text-brand-700';
      const chipOn = chipBase + 'border-brand-500 bg-brand-50 text-brand-700';

      [
        { format: 'txt', label: 'Texto (.txt)' },
        { format: 'docx', label: 'Word (.docx)' },
        { format: 'pdf', label: 'PDF (.pdf)' }
      ].forEach(({ format, label }) => {
        const chip = elt('button', {
          type: 'button',
          class: chipOn,
          'aria-pressed': format === selectedFormat ? 'true' : 'false',
          title: 'Descargar en formato ' + format.toUpperCase()
        }, [qIcon('file'), label]);
        chip.dataset.format = format;
        chip.onclick = () => {
          selectedFormat = format;
          Object.values(fmtChips).forEach(c => {
            const on = c.dataset.format === selectedFormat;
            c.className = on ? chipOn : chipOff;
            c.setAttribute('aria-pressed', on ? 'true' : 'false');
          });
        };
        fmtChips[format] = chip;
        fmtWrap.append(chip);
      });

      // Descargar: icono + label; el tag del costo ya está en el header.
      const downloadBtn = elt('button', {
        type: 'button',
        class: 'inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60',
        'aria-label': 'Descargar documento en el formato seleccionado'
      }, [qIcon('download', 'h-4 w-4'), 'Descargar']);

      footer.append(fmtWrap, downloadBtn);

      // ---- Handle de redimensionado (esquina inferior derecha) ----
      const resizeHandle = elt('div', {
        class: 'absolute bottom-0 right-0 flex h-5 w-5 cursor-nwse-resize items-end justify-end p-1 text-slate-300 hover:text-brand-500',
        title: 'Arrastra para agrandar o achicar'
      }, [qIcon('resize', 'h-3 w-3')]);

      card.append(header, editorWrap, footer, resizeHandle);
      modal.append(card);

      // IMPORTANTE: montar en el DOM ANTES de inicializar Quill —
      // new Quill('#chat-editor') no encuentra elementos detached.
      document.body.append(modal);

      this.quill = new Quill('#chat-editor', {
        theme: 'snow',
        placeholder: 'Haz clic para editar el mensaje...',
        modules: {
          toolbar: [['bold', 'italic', 'underline'], ['clean'], [{ color: [] }]]
        }
      });

      // ---- Tarifa base administrable (tabla tariffs vía /tariffs) ----
      // El server cobra base + tokens; el front muestra el desglose con la
      // MISMA estimación del módulo de rotación: ceil(caracteres / 4).
      let baseCredits = 1;
      const TOKENS_PER_CREDIT = 1000;
      fetch(apiUrl('/tariffs'), {
        credentials: 'include',
        headers: authHeaders(),
      })
      .then(r => r.json())
      .then(payload => {
        const list = payload && payload.data && Array.isArray(payload.data.tariffs)
          ? payload.data.tariffs
          : [];
        const row = list.find(t => t && t.operation === 'document_download');
        const n = row ? parseInt(row.credits_cost, 10) : NaN;
        if (!isNaN(n) && n > 0) {
          baseCredits = n;
          costTag.textContent = `Base: ${baseCredits} cr + tokens`;
        }
      })
      .catch(() => { /* fallback: base 1 */ });

      // Desglose de costo con el contenido ACTUAL del editor.
      const costBreakdown = () => {
        const chars = this.quill.getText().trim().length;
        const tokens = Math.max(1, Math.ceil(chars / 4));
        const tokenCredits = Math.ceil(tokens / TOKENS_PER_CREDIT);
        const total = baseCredits + tokenCredits;
        return { chars, tokens, tokenCredits, total, cr: (n) => `${n} crédito${n === 1 ? '' : 's'}` };
      };

      // ---- Cargar la data de la burbuja ----
      // Texto plano -> setText; HTML -> clipboard; Delta -> setContents.
      if (typeof text === 'string') {
        if (/<[a-z][\s\S]*>/i.test(text)) {
          this.quill.clipboard.dangerouslyPasteHTML(text);
        } else {
          this.quill.setText(text);
        }
      } else if (text && text.delta) {
        this.quill.setContents(text.delta);
      } else if (text && text.html) {
        this.quill.clipboard.dangerouslyPasteHTML(text.html);
      }

      // ---- Editor llena la card (sin scroll doble): una sola zona de scroll ----
      if (!q('#chat-editor-fill-style')) {
        document.head.append(elt('style', { id: 'chat-editor-fill-style' }, [
          '#chat-editor-modal .ql-container { height: 100%; display: flex; flex-direction: column; }',
          '#chat-editor-modal .ql-editor { min-height: 100%; flex: 1; }'
        ].join('\n')));
      }

      // ---- Show + geometría persistida (localStorage sobrevive recargas) ----
      requestAnimationFrame(() => {
        const persisted = loadGeo();
        if (persisted) {
          applyGeo(persisted);
          maximized = !!persisted.maximized;
          setMaxIcon(maximized);
        }
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        this.quill.focus();
      });

      // ---- Cierre explícito: X (y Esc como atajo de teclado) ----
      const closeModal = () => this._cleanup();
      closeBtn.onclick = closeModal;
      modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          closeModal();
        }
      });
      // Sin cierre por click fuera (requisito): el overlay no tiene onclick.

      // ---- Descarga: confirmación amable + cooldown 10s anti-spam ----
      // Cada click genera un operationId nuevo (el server es idempotente por
      // operationId), así que un doble-click accidental SÍ cobraría doble:
      // el cooldown bloquea spam y equivocaciones.
      let cooldownTimer = null;

      const setDownloadUi = (disabled, label) => {
        downloadBtn.disabled = disabled;
        downloadBtn.replaceChildren(qIcon('download', 'h-4 w-4'), label);
      };

      const startCooldown = () => {
        this._cooldownUntil = Date.now() + 10000;
        setDownloadUi(true, 'Descargando…');
        if (cooldownTimer) clearInterval(cooldownTimer);
        cooldownTimer = setInterval(() => {
          const left = Math.ceil((this._cooldownUntil - Date.now()) / 1000);
          if (left <= 0) {
            clearInterval(cooldownTimer);
            cooldownTimer = null;
            setDownloadUi(false, 'Descargar');
          } else {
            setDownloadUi(true, `Disponible en ${left}s`);
          }
        }, 250);
      };

      const fireDownload = () => {
        const html = this.quill.root.innerHTML;
        const textContent = this.quill.getText();
        const payload = { html, text: textContent };
        if (this._onDownload) {
          this._onDownload(selectedFormat, payload);
        } else if (this._onSave) {
          this._onSave(payload);
        }
        startCooldown();
      };

      // Confirmación amable: límites del asistente + desglose de costo.
      // El desglose viene del SERVER (modo quote) — el precio mostrado es
      // siempre el que se cobrará; fallback al cálculo local si falla.
      const openConfirm = () => {
        if (Date.now() < (this._cooldownUntil || 0)) return;
        const bd = costBreakdown();
        const confirmOverlay = elt('div', {
          class: 'absolute inset-0 z-10 hidden items-center justify-center rounded-2xl bg-slate-900/40 p-4'
        });
        const box = elt('div', { class: 'mx-4 w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl' });
        const totalEl = elt('p', { class: 'font-medium' }, [`Costo de esta descarga: ${bd.cr(bd.total)}`]);
        const detailEl = elt('p', { class: 'mt-1 text-xs leading-relaxed text-sky-700' }, [
          `Base: ${bd.cr(baseCredits)} · Contenido: ${bd.chars.toLocaleString('es-CL')} caracteres `
            + `≈ ${bd.tokens.toLocaleString('es-CL')} tokens → ${bd.cr(bd.tokenCredits)}`
        ]);
        box.append(
          elt('h3', { class: 'text-base font-semibold text-slate-900' }, ['Antes de descargar']),
          elt('p', { class: 'mt-2 text-sm leading-relaxed text-slate-600' }, [
            'Este borrador fue creado con asistencia de IA y es solo una ayuda para organizarte: ',
            'no reemplaza la revisión de un abogado ni de otro profesional, y no garantiza resultados judiciales. ',
            'Revísalo con calma y ajústalo antes de usarlo.'
          ]),
          // Desglose oficial del server (quote): base + tokens del contenido.
          elt('div', { class: 'mt-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900' }, [
            totalEl,
            detailEl
          ]),
          // Checkbox de sesión: cobros futuros sin este confirm.
          (function () {
            const label = elt('label', {
              class: 'mt-3 flex items-center gap-2 text-xs text-slate-600 select-none'
            });
            const cb = elt('input', { type: 'checkbox', class: 'h-3.5 w-3.5 rounded border-slate-300 text-brand-600' });
            cb.addEventListener('change', () => {
              try {
                confirmSkipSet('aj:no-confirm-doc', text, cb.checked);
              } catch (_) {}
            });
            label.append(cb, document.createTextNode('No deseo recibir más esta notificación (solo en esta sesión)'));
            return label;
          })()
        );

        // Cotización oficial del server (sin cobro): reemplaza el cálculo local.
        fetch(apiUrl('/documents/download'), {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          credentials: 'include',
          body: JSON.stringify({ html: this.quill.root.innerHTML, format: selectedFormat, quote: true })
        })
        .then(r => r.json())
        .then(qp => {
          const p = qp && qp.success && qp.pricing ? qp.pricing : null;
          if (!p) return;
          const cr = (n) => `${n} crédito${n === 1 ? '' : 's'}`;
          totalEl.textContent = `Costo de esta descarga: ${cr(p.total_credits)}`;
          detailEl.textContent = `Base: ${cr(p.base_credits)} · Contenido: ${p.chars.toLocaleString('es-CL')} caracteres `
            + `≈ ${p.tokens.toLocaleString('es-CL')} tokens → ${cr(p.token_credits)}`;
        })
        .catch(() => { /* se mantienen los números locales */ });
        const actions = elt('div', { class: 'mt-4 flex justify-end gap-2' });
        const backBtn = elt('button', {
          type: 'button',
          class: 'rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400'
        }, ['Volver']);
        const okBtn = elt('button', {
          type: 'button',
          class: 'inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700'
        }, [qIcon('download', 'h-4 w-4'), 'Entendido, descargar']);
        actions.append(backBtn, okBtn);
        box.append(actions);
        confirmOverlay.append(box);
        modal.append(confirmOverlay);
        requestAnimationFrame(() => {
          confirmOverlay.classList.remove('hidden');
          confirmOverlay.classList.add('flex');
        });
        backBtn.onclick = () => confirmOverlay.remove();
        okBtn.onclick = () => {
          confirmOverlay.remove();
          fireDownload();
        };
      };

      // Skip POR BURBUJA: si el usuario marcó "no deseo" en ESTA burbuja
      // (hash de su texto en la sesión actual), el cobro se hace directo.
      downloadBtn.onclick = () => {
        let skip = false;
        try { skip = confirmSkipHas('aj:no-confirm-doc', text); } catch (_) {}
        if (skip) { fireDownload(); return; }
        openConfirm();
      };
      // Si se reabre dentro del cooldown, restaurar el estado bloqueado.
      if (Date.now() < (this._cooldownUntil || 0)) {
        startCooldown();
      }

      // ---- Redimensionado por arrastre ----
      resizeHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const startW = card.offsetWidth;
        const startH = card.offsetHeight;
        const maxW = () => Math.floor(window.innerWidth * 0.95);
        const maxH = () => Math.floor(window.innerHeight * 0.92);

        const onMove = (ev) => {
          const w = Math.min(Math.max(startW + (ev.clientX - startX), 380), maxW());
          const h = Math.min(Math.max(startH + (ev.clientY - startY), 380), maxH());
          card.style.width = w + 'px';
          card.style.height = h + 'px';
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          // Persistir el tamaño elegido y salir del estado maximizado:
          // el tamaño manual ES la nueva geometría del usuario.
          maximized = false;
          setMaxIcon(false);
          saveGeo({ w: card.offsetWidth, h: card.offsetHeight });
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    },

    _cleanup() {
      // Quill 1.3.7 NO tiene destroy(): llamarlo lanza TypeError y aborta el
      // cleanup, dejando el modal huérfano en el DOM. Solo soltar la referencia.
      this.quill = null;
      const m = q('#chat-editor-modal');
      if (m) m.remove();
    }
  };

  // Export for module systems or global scope
  if (typeof define === 'function' && define.amd) {
    define(() => ChatEditor);
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = ChatEditor;
  } else {
    window.ChatEditor = ChatEditor;
  }
})();
