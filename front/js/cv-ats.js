    import { extract } from './extract/index.js';

    const STEP2_DELAY_MS = 880; // ~40% of the artificial timeline

    // The module is shared by the standalone /cv-ats/ page and by the card
    // inside the user panel, so the links to the landing are resolved from
    // the module's own location instead of from the page that loaded it.
    const APP_ROOT = new URL('../', import.meta.url).href;

    const state = {
      cv: { file: null, text: '' },
      oferta: { mode: 'texto', text: '', file: null, fileText: '', tipo: '' },
      match: null,
      busy: false,
      ofertaTracked: false,
      inputsCollapsed: false,
    };

    const el = {
      cvDrop: document.getElementById('cv-drop'),
      cvInput: document.getElementById('cv-input'),
      cvChip: document.getElementById('cv-chip'),
      cvChipName: document.getElementById('cv-chip-name'),
      cvChipSize: document.getElementById('cv-chip-size'),
      cvClear: document.getElementById('cv-clear'),
      cvError: document.getElementById('cv-error'),
      cvProgressWrap: document.getElementById('cv-progress-wrap'),
      cvProgress: document.getElementById('cv-progress'),
      cvProgressLabel: document.getElementById('cv-progress-label'),
      ofertaTabTexto: document.getElementById('oferta-tab-texto'),
      ofertaTabArchivo: document.getElementById('oferta-tab-archivo'),
      ofertaPanelTexto: document.getElementById('oferta-panel-texto'),
      ofertaPanelArchivo: document.getElementById('oferta-panel-archivo'),
      ofertaTextarea: document.getElementById('oferta-textarea'),
      ofertaDrop: document.getElementById('oferta-drop'),
      ofertaInput: document.getElementById('oferta-input'),
      ofertaChip: document.getElementById('oferta-chip'),
      ofertaChipName: document.getElementById('oferta-chip-name'),
      ofertaChipSize: document.getElementById('oferta-chip-size'),
      ofertaClear: document.getElementById('oferta-clear'),
      ofertaError: document.getElementById('oferta-error'),
      ofertaProgressWrap: document.getElementById('oferta-progress-wrap'),
      ofertaProgress: document.getElementById('oferta-progress'),
      ofertaProgressLabel: document.getElementById('oferta-progress-label'),
      btnAnalizar: document.getElementById('btn-analizar'),
      btnHint: document.getElementById('btn-hint'),
      resultados: document.getElementById('resultados'),
    };

    /* ------------------------------- analytics ------------------------------ */

    function track(event, extra) {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(Object.assign({ event: event }, extra || {}));
    }

    /* ------------------------------- helpers -------------------------------- */

    const uuid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'k-' + Date.now() + '-' + Math.random().toString(16).slice(2);

    function formatSize(bytes) {
      if (!Number.isFinite(bytes)) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    // Lowercase, strip accents and trim — used to compare ATS keywords.
    const normalize = (value) => String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();

    function classifyTipo(sourceType) {
      const raw = normalize(sourceType);
      if (raw.includes('pdf')) return 'pdf';
      if (raw.includes('img') || raw.includes('image') || raw.includes('ocr') || raw.includes('foto')) return 'imagen';
      return 'texto';
    }

    function showFieldError(target, message) {
      target.textContent = message;
      target.classList.remove('hidden');
    }

    function clearFieldError(target) {
      target.textContent = '';
      target.classList.add('hidden');
    }

    /* ------------------------- tiny markdown renderer ----------------------- */

    function inlineMarkdown(text) {
      return escapeHtml(text)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
    }

    function renderMarkdown(markdown) {
      const lines = String(markdown || '').split(/\r?\n/);
      let html = '';
      let paragraph = [];
      let inList = false;

      const flushParagraph = () => {
        if (paragraph.length) {
          html += '<p class="mb-3">' + inlineMarkdown(paragraph.join(' ')) + '</p>';
          paragraph = [];
        }
      };
      const closeList = () => {
        if (inList) { html += '</ul>'; inList = false; }
      };

      for (const raw of lines) {
        const line = raw.trim();
        if (!line) { flushParagraph(); closeList(); continue; }

        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
          flushParagraph(); closeList();
          const tag = heading[1].length <= 2 ? 'h3' : 'h4';
          html += '<' + tag + ' class="mt-4 mb-2 font-display text-lg">' + inlineMarkdown(heading[2]) + '</' + tag + '>';
          continue;
        }

        const listItem = line.match(/^[-*+]\s+(.*)$/);
        if (listItem) {
          flushParagraph();
          if (!inList) { html += '<ul class="mb-3 list-disc space-y-1 pl-5">'; inList = true; }
          html += '<li>' + inlineMarkdown(listItem[1]) + '</li>';
          continue;
        }

        closeList();
        paragraph.push(line);
      }
      flushParagraph();
      closeList();
      return html;
    }

    /* ------------------------------ file intake ----------------------------- */

    function bindDropZone(zone, onFile) {
      const highlight = (on) => zone.classList.toggle('border-blue-600', on);
      ['dragenter', 'dragover'].forEach((evt) => zone.addEventListener(evt, (event) => {
        event.preventDefault();
        highlight(true);
      }));
      ['dragleave', 'dragend'].forEach((evt) => zone.addEventListener(evt, () => highlight(false)));
      zone.addEventListener('drop', (event) => {
        event.preventDefault();
        highlight(false);
        const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
        if (file) onFile(file);
      });
      zone.addEventListener('click', () => zone.__input && zone.__input.click());
      zone.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); zone.__input && zone.__input.click(); }
      });
    }

    // The browser must not navigate away when a file misses the drop zone.
    ['dragover', 'drop'].forEach((evt) => window.addEventListener(evt, (event) => event.preventDefault()));

    function showChip(chip, nameTarget, sizeTarget, file) {
      nameTarget.textContent = file.name;
      sizeTarget.textContent = '· ' + formatSize(file.size);
      chip.classList.remove('hidden');
      chip.classList.add('flex');
    }

    function hideChip(chip) {
      chip.classList.add('hidden');
      chip.classList.remove('flex');
    }

    async function readWithProgress(file, progressWrap, progressBar, progressLabel, prefix, listoLabel) {
      progressWrap.classList.remove('hidden');
      const setPercent = (percent) => {
        const value = Math.max(0, Math.min(100, Math.round(percent || 0)));
        progressBar.style.width = value + '%';
        progressLabel.textContent = prefix + '… ' + value + '%';
      };
      setPercent(0);
      try {
        const resultado = await extract(file, setPercent);
        // The bar STAYS: it is the proof that the file came in and the text
        // is ready. Hiding it exactly when the person wants to see that
        // everything went well would throw away the only signal they have.
        progressBar.style.width = '100%';
        progressLabel.textContent = (listoLabel || 'Listo') + ' ✓';
        return resultado;
      } catch (error) {
        progressWrap.classList.add('hidden');
        progressBar.style.width = '0%';
        throw error;
      }
    }

    async function handleCvFile(file) {
      clearFieldError(el.cvError);
      showChip(el.cvChip, el.cvChipName, el.cvChipSize, file);
      try {
        const result = await readWithProgress(file, el.cvProgressWrap, el.cvProgress, el.cvProgressLabel, 'Leyendo tu CV', 'Tu CV está listo');
        const text = (result && result.text || '').trim();
        if (!text) {
          state.cv = { file: null, text: '' };
          showFieldError(el.cvError, 'Este archivo no tiene texto legible. Si es una foto, prueba con una imagen más nítida, o vuelve a intentarlo con el PDF original.');
        } else {
          state.cv = { file: file, text: text };
          // The extracted text is shown right away: the person can fix what
          // the reader got wrong before comparing.
          if (el.cvTextarea) el.cvTextarea.value = text;
          track('cv_ats_upload_cv');
        }
      } catch (error) {
        state.cv = { file: null, text: '' };
        showFieldError(el.cvError, (error && error.message) || 'No pudimos leer este archivo. Puedes probar con otro formato, sin problema.');
      }
      syncAnalyzeButton();
    }

    function clearCv() {
      state.cv = { file: null, text: '' };
      el.cvInput.value = '';
      if (el.cvTextarea) el.cvTextarea.value = '';
      hideChip(el.cvChip);
      clearFieldError(el.cvError);
      if (el.cvProgressWrap) el.cvProgressWrap.classList.add('hidden');
      if (el.cvProgress) el.cvProgress.style.width = '0%';
      syncAnalyzeButton();
    }

    function setOfertaFile(file) {
      state.oferta.mode = 'archivo';
      state.oferta.file = file;
      showChip(el.ofertaChip, el.ofertaChipName, el.ofertaChipSize, file);
      clearFieldError(el.ofertaError);
      readWithProgress(file, el.ofertaProgressWrap, el.ofertaProgress, el.ofertaProgressLabel, 'Leyendo la oferta', 'La oferta está lista')
        .then((result) => {
          const text = (result && result.text || '').trim();
          if (!text) {
            state.oferta.file = null;
            state.oferta.fileText = '';
            showFieldError(el.ofertaError, 'No pudimos leer texto en esta imagen. Si puedes, pega el texto de la oferta en la otra pestaña.');
          } else {
            state.oferta.fileText = text;
            state.oferta.tipo = classifyTipo(result && result.sourceType);
            if (!state.ofertaTracked) { track('cv_ats_upload_oferta_tipo', { tipo: state.oferta.tipo }); state.ofertaTracked = true; }
          }
          syncAnalyzeButton();
        })
        .catch((error) => {
          state.oferta.file = null;
          state.oferta.fileText = '';
          showFieldError(el.ofertaError, (error && error.message) || 'No pudimos leer este archivo. Puedes probar con otro formato, sin problema.');
          syncAnalyzeButton();
        });
    }

    function clearOfertaFile() {
      state.oferta.file = null;
      state.oferta.fileText = '';
      el.ofertaInput.value = '';
      hideChip(el.ofertaChip);
      clearFieldError(el.ofertaError);
      if (state.oferta.mode === 'archivo') state.oferta.mode = 'texto';
      syncAnalyzeButton();
    }

    function ofertaTexto() {
      if (state.oferta.mode === 'archivo') return state.oferta.fileText;
      return state.oferta.text;
    }

    function ofertaReady() {
      const content = ofertaTexto();
      if (state.oferta.mode === 'archivo') return !!(state.oferta.file && state.oferta.fileText.trim());
      return !!(content && content.trim());
    }

    /* ---------------------------- state -> button --------------------------- */

    function syncAnalyzeButton() {
      const ready = !!(state.cv.text && state.cv.text.trim()) && ofertaReady();
      el.btnAnalizar.setAttribute('aria-disabled', ready ? 'false' : 'true');
      el.btnAnalizar.classList.toggle('opacity-50', !ready);
      el.btnAnalizar.classList.toggle('cursor-not-allowed', !ready);

      if (ready) {
        el.btnHint.textContent = 'Listo. Puedes analizar cuando quieras.';
      } else if (!(state.cv.text || '').trim() && !ofertaReady()) {
        el.btnHint.textContent = 'Para continuar, faltan tu CV y la oferta.';
      } else if (!(state.cv.text || '').trim()) {
        el.btnHint.textContent = 'Solo falta tu CV para continuar.';
      } else {
        el.btnHint.textContent = 'Solo falta la oferta para continuar.';
      }
    }

    /* ----------------------------- API requests ----------------------------- */

    class ApiError extends Error {
      constructor(status, code, message) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
      }
    }

    async function postJson(path, body) {
      let response;
      try {
        response = await fetch(window.API(path), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (networkError) {
        throw new ApiError(0, 'NETWORK_ERROR', 'No pudimos conectar ahora. Revisa tu conexión y vuelve a intentarlo, sin apuro.');
      }

      let payload = null;
      try { payload = await response.json(); } catch (parseError) { payload = null; }

      if (!response.ok || !payload || payload.success !== true) {
        const apiError = (payload && payload.error) || {};
        throw new ApiError(
          response.status,
          apiError.code || 'HTTP_' + response.status,
          apiError.message || 'Algo salió mal al procesar la solicitud. Lo intentamos de nuevo en un momento.'
        );
      }
      return payload.data || {};
    }

    /* ------------------------------- rendering ------------------------------ */

    function gaugeMarkup(score) {
      const safeScore = Math.max(0, Math.min(100, Number(score) || 0));
      const circumference = 2 * Math.PI * 54;
      const offset = circumference * (1 - safeScore / 100);
      const colorClass = safeScore < 50 ? 'stroke-red-500' : (safeScore < 75 ? 'stroke-amber-500' : 'stroke-emerald-500');
      return (
        '<div class="relative mx-auto h-36 w-36">' +
          '<svg viewBox="0 0 128 128" class="h-36 w-36 -rotate-90" role="img" aria-label="Match ' + safeScore + ' de 100">' +
            '<circle cx="64" cy="64" r="54" fill="none" stroke-width="12" class="stroke-slate-200"></circle>' +
            '<circle id="gauge-arc" cx="64" cy="64" r="54" fill="none" stroke-width="12" stroke-linecap="round" ' +
              'class="' + colorClass + ' transition-all duration-1000 ease-out" ' +
              'stroke-dasharray="' + circumference.toFixed(2) + '" stroke-dashoffset="' + circumference.toFixed(2) + '"></circle>' +
          '</svg>' +
          '<div class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">' +
            '<span id="gauge-number" class="text-4xl font-semibold text-slate-800">0</span>' +
            '<span class="text-xs text-slate-600">de 100</span>' +
          '</div>' +
        '</div>' +
        '<p class="mt-2 text-center text-sm font-medium text-slate-700">Match con la oferta</p>'
      );
    }

    function animateGauge(score) {
      const arc = document.getElementById('gauge-arc');
      const number = document.getElementById('gauge-number');
      if (!arc || !number) return;
      const safeScore = Math.max(0, Math.min(100, Number(score) || 0));
      const circumference = 2 * Math.PI * 54;
      requestAnimationFrame(() => {
        arc.setAttribute('stroke-dashoffset', String(circumference * (1 - safeScore / 100)));
      });
      const started = performance.now();
      const duration = 900;
      const tick = (now) => {
        const progress = Math.min(1, (now - started) / duration);
        number.textContent = String(Math.round(safeScore * progress));
        if (progress < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    function keywordLists(data) {
      const keywords = (data.oferta && Array.isArray(data.oferta.keywords_ats)) ? data.oferta.keywords_ats : null;
      const missing = (data.brecha && Array.isArray(data.brecha.keywords_faltantes)) ? data.brecha.keywords_faltantes : null;
      if (!keywords || !missing) return { present: null, missing: null };
      const missingSet = new Set(missing.map(normalize));
      return {
        present: keywords.filter((keyword) => !missingSet.has(normalize(keyword))),
        missing: missing.slice(),
      };
    }

    /**
     * The charts of the report.
     *
     * Every number here comes from the SAME analysis the text describes:
     * the keyword lists, the strengths, the weaknesses and the suggested
     * actions. Nothing is invented to fill the space — the charts simply
     * show what the model found in a shape the eye reads faster.
     */
    function graficasMarkup(data, score) {
      const cobertura = coberturaKeywords(data);
      const presentes = cobertura.presentes;
      const faltantes = cobertura.faltantes;

      const brecha = data.brecha || {};
      const fortalezas = (Array.isArray(brecha.fortalezas) ? brecha.fortalezas : []).length;
      const debilidades = (Array.isArray(brecha.debilidades) ? brecha.debilidades : []).length;
      const acciones = (Array.isArray(brecha.que_cambiar_para_pasar) ? brecha.que_cambiar_para_pasar : []).length;

      return '<div class="grid gap-4 sm:grid-cols-2">' +
        '<div class="rounded-xl border border-slate-200 bg-white p-4 text-center">' + gaugeMarkup(score) + '</div>' +
        donutCoberturaMarkup(cobertura.porcentaje) +
        barraKeywordsMarkup(presentes, faltantes) +
        indicadoresMarkup(fortalezas, debilidades, acciones) +
      '</div>';
    }

    /**
     * How many of the offer's keywords the CV already covers.
     */
    function coberturaKeywords(data) {
      const keywords = keywordLists(data);
      const presentes = (keywords.present || []).length;
      const faltantes = (keywords.missing || []).length;
      const total = presentes + faltantes;

      return {
        presentes: presentes,
        faltantes: faltantes,
        porcentaje: total > 0 ? Math.round((presentes / total) * 100) : 0,
      };
    }

    function donutCoberturaMarkup(porcentaje) {
      const radio = 34;
      const circunferencia = 2 * Math.PI * radio;
      const offset = circunferencia * (1 - porcentaje / 100);
      const color = porcentaje >= 70 ? 'stroke-emerald-500' : (porcentaje >= 40 ? 'stroke-amber-500' : 'stroke-rose-500');

      return '<div class="rounded-xl border border-slate-200 bg-white p-4 text-center">' +
        '<p class="text-xs font-semibold text-slate-700">Cobertura de palabras clave</p>' +
        '<div class="relative mx-auto mt-2 h-28 w-28">' +
          '<svg viewBox="0 0 80 80" class="h-28 w-28 -rotate-90" role="img" aria-label="Cobertura ' + porcentaje + ' por ciento">' +
            '<circle cx="40" cy="40" r="' + radio + '" fill="none" stroke-width="10" class="stroke-slate-200"></circle>' +
            '<circle id="donut-arc" cx="40" cy="40" r="' + radio + '" fill="none" stroke-width="10" stroke-linecap="round" ' +
              'class="' + color + ' transition-all duration-1000 ease-out" ' +
              'stroke-dasharray="' + circunferencia.toFixed(2) + '" stroke-dashoffset="' + circunferencia.toFixed(2) + '"></circle>' +
          '</svg>' +
          '<div class="pointer-events-none absolute inset-0 flex items-center justify-center">' +
            '<span id="donut-number" class="text-2xl font-semibold text-slate-800">0%</span>' +
          '</div>' +
        '</div>' +
        '<p class="mt-2 text-xs text-slate-600">de las palabras clave de la oferta</p>' +
      '</div>';
    }

    function barraKeywordsMarkup(presentes, faltantes) {
      const total = presentes + faltantes;
      const porcentaje = total > 0 ? Math.round((presentes / total) * 100) : 0;

      return '<div class="rounded-xl border border-slate-200 bg-white p-4">' +
        '<p class="text-xs font-semibold text-slate-700">Reparto de palabras clave</p>' +
        '<div class="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-slate-100">' +
          '<div class="h-full bg-emerald-500 transition-all duration-700" style="width:' + porcentaje + '%"></div>' +
          '<div class="h-full bg-rose-400 transition-all duration-700" style="width:' + (100 - porcentaje) + '%"></div>' +
        '</div>' +
        '<div class="mt-3 flex items-center justify-between gap-2 text-xs text-slate-600">' +
          '<span><span class="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500"></span>' + presentes + ' ya las tienes</span>' +
          '<span><span class="mr-1 inline-block h-2 w-2 rounded-full bg-rose-400"></span>' + faltantes + ' te faltan</span>' +
        '</div>' +
      '</div>';
    }

    function indicadoresMarkup(fortalezas, debilidades, acciones) {
      const stat = (valor, etiqueta, clases) =>
        '<div class="rounded-lg bg-slate-50 px-2 py-3 text-center">' +
          '<p class="text-xl font-semibold ' + clases + '">' + valor + '</p>' +
          '<p class="mt-0.5 text-[11px] leading-tight text-slate-600">' + etiqueta + '</p>' +
        '</div>';

      return '<div class="rounded-xl border border-slate-200 bg-white p-4">' +
        '<p class="text-xs font-semibold text-slate-700">Lo que encontró el análisis</p>' +
        '<div class="mt-3 grid grid-cols-3 gap-2">' +
          stat(fortalezas, 'Fortalezas', 'text-emerald-600') +
          stat(debilidades, 'Debilidades', 'text-rose-600') +
          stat(acciones, 'Acciones posibles', 'text-blue-600') +
        '</div>' +
      '</div>';
    }

    /**
     * The donut fills itself, the same way the gauge does.
     */
    function animateDonut(porcentaje) {
      const arc = document.getElementById('donut-arc');
      const number = document.getElementById('donut-number');
      if (!arc || !number) return;

      const radio = 34;
      const circunferencia = 2 * Math.PI * radio;
      const safe = Math.max(0, Math.min(100, Number(porcentaje) || 0));

      requestAnimationFrame(() => {
        arc.setAttribute('stroke-dashoffset', String(circunferencia * (1 - safe / 100)));
      });

      const started = performance.now();
      const duration = 900;
      const tick = (now) => {
        const progress = Math.min(1, (now - started) / duration);
        number.textContent = Math.round(safe * progress) + '%';
        if (progress < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    /**
     * The panel's header shows the credits ALWAYS and in real time: the
     * analysis and the generation charge credits, so the header has to hear
     * about it the moment it happens.
     */
    function avisarCreditos(creditos) {
      const n = Number(creditos);
      if (!Number.isFinite(n)) return;
      document.dispatchEvent(new CustomEvent('wallet:balance-updated', { detail: { balance: n } }));
    }

    function pillList(items, tone) {
      const toneClass = tone === 'missing'
        ? 'bg-rose-50 text-rose-700 border-rose-200'
        : 'bg-emerald-50 text-emerald-700 border-emerald-200';
      return '<ul class="flex flex-wrap gap-2">' + items.map((item) =>
        '<li class="rounded-full border ' + toneClass + ' px-2.5 py-1 text-sm">' + escapeHtml(item) + '</li>'
      ).join('') + '</ul>';
    }

    function paywallMarkup(message) {
      return (
        '<div class="rounded-xl border border-amber-200 bg-amber-50 p-6">' +
          '<h3 class="font-display text-xl text-amber-800">Para seguir, necesitas créditos</h3>' +
          (message ? '<p class="mt-2 text-sm text-amber-800">' + escapeHtml(message) + '</p>' : '') +
          '<p class="mt-2 text-sm text-amber-800">Tu análisis quedó listo arriba: puedes revisarlo con calma. Cuando quieras adaptar tu CV, el pack recomendado te deja continuar sin vueltas.</p>' +
          '<a href="' + escapeHtml(APP_ROOT + 'index.html#recargas') + '" class="mt-4 inline-block rounded-lg bg-blue-600 px-5 py-3 font-semibold text-white no-underline hover:bg-blue-700">Ver el pack recomendado</a>' +
          '<p class="mt-3 text-xs text-amber-800">Los precios y el detalle de cada pack están en la página de recargas.</p>' +
        '</div>'
      );
    }

    /**
     * The picker the panel shows BEFORE generating: which document and which
     * template.
     *
     * Both lists come from the API catalogue (the gap report carries them),
     * so the panel can never offer a combination the API would refuse. The
     * document type changes the PROMPT the model receives (cover the gaps /
     * enhance the experiences); the template changes the layout.
     */
    function catalogoMarkup(tipos, plantillas) {
      const listaTipos = (Array.isArray(tipos) ? tipos : []).filter((item) => item && item.id);
      const listaPlantillas = (Array.isArray(plantillas) ? plantillas : []).filter((item) => item && item.id);

      if (listaTipos.length === 0 && listaPlantillas.length === 0) return '';

      const tiposHtml = listaTipos.length === 0 ? '' :
        '<fieldset class="mt-5">' +
          '<legend class="text-sm font-semibold text-slate-800">Qué documento quieres descargar</legend>' +
          '<div class="mt-2 grid gap-2">' +
            listaTipos.map((tipo, index) =>
              '<label class="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 hover:border-blue-300">' +
                '<input type="radio" name="cv-ats-tipo" value="' + escapeHtml(tipo.id) + '" class="mt-1"' + (index === 0 ? ' checked' : '') + '>' +
                '<span>' +
                  '<span class="block text-sm font-semibold text-slate-800">' + escapeHtml(tipo.nombre || tipo.id) + '</span>' +
                  '<span class="mt-1 block text-xs text-slate-600">' + escapeHtml(tipo.descripcion || '') + '</span>' +
                '</span>' +
              '</label>'
            ).join('') +
          '</div>' +
        '</fieldset>';

      const plantillasHtml = listaPlantillas.length === 0 ? '' :
        '<fieldset class="mt-5">' +
          '<legend class="text-sm font-semibold text-slate-800">Plantilla</legend>' +
          '<div class="mt-2 grid gap-2 sm:grid-cols-2">' +
            listaPlantillas.map((plantilla, index) =>
              '<div class="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3">' +
                '<label class="flex flex-1 cursor-pointer items-start gap-3">' +
                  '<input type="radio" name="cv-ats-plantilla" value="' + escapeHtml(plantilla.id) + '" class="mt-1"' + (index === 0 ? ' checked' : '') + '>' +
                  '<span>' +
                    '<span class="block text-sm font-semibold text-slate-800">' + escapeHtml(plantilla.nombre || plantilla.id) + '</span>' +
                    '<span class="mt-1 block text-xs text-slate-600">' + escapeHtml(plantilla.descripcion || '') + '</span>' +
                  '</span>' +
                '</label>' +
                '<button type="button" data-cv-ats-preview="' + escapeHtml(plantilla.id) + '" ' +
                  'class="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:border-blue-400 hover:text-blue-700">' +
                  'Vista previa' +
                '</button>' +
              '</div>'
            ).join('') +
          '</div>' +
        '</fieldset>';

      return tiposHtml + plantillasHtml;
    }

    /**
     * The URL block: read a document straight from a link.
     *
     * The SAME component for the CV and for the offer: the globe, the brand
     * border, the breathing glow, and the same downloader behind it. A PDF
     * or a Word file arrives AS ITSELF and is loaded exactly like an
     * attached file; a web page arrives as its text.
     *
     * @param {(datos: object, mostrarEstado: Function) => void} alRecibir
     * @param {string} etiqueta   What this block reads, in plain words.
     * @param {string} id         Id of the block, so both cards are findable.
     */
    function crearBloqueUrl(alRecibir, etiqueta, id) {
      const bloque = document.createElement('div');
      bloque.id = id;
      bloque.className = 'mb-4';
      bloque.innerHTML =
        '<p class="text-xs leading-relaxed text-slate-600">' +
          (etiqueta || '¿Tienes el link del documento? Pégalo y lo leemos por ti: ' +
            'si es un PDF o un Word lo cargamos igual que si lo subieras, y si es una página ' +
            'tomamos su texto.') +
        '</p>' +
        '<div class="cvats-scan-glow relative mt-2 flex flex-wrap items-center gap-2 rounded-2xl border-2 border-brand-200 bg-white p-2 pl-4 shadow-sm">' +
          '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 shrink-0 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z" />' +
          '</svg>' +
          '<label class="sr-only">Link del documento</label>' +
          '<input type="text" inputmode="url" autocomplete="off" spellcheck="false" ' +
            'placeholder="https://ejemplo.com/mi-documento" ' +
            'class="h-11 min-w-0 flex-1 basis-56 bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400">' +
          '<button type="button" ' +
            'class="h-11 shrink-0 rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50">' +
            'Leer' +
          '</button>' +
        '</div>' +
        '<p class="mt-2 hidden text-xs leading-relaxed" aria-live="polite"></p>';

      const input = bloque.querySelector('input');
      const boton = bloque.querySelector('button');
      const estado = bloque.querySelector('p:last-child');

      const mostrarEstado = (mensaje, tono) => {
        estado.textContent = mensaje;
        estado.classList.remove('hidden');
        estado.className = 'mt-2 text-xs leading-relaxed ' + (
          tono === 'error' ? 'text-rose-600' : (tono === 'ok' ? 'text-emerald-600' : 'text-slate-600')
        );
      };

      const leer = async () => {
        const preparacion = prepararUrl(input.value);

        if (preparacion.vacio) {
          mostrarEstado('Pega el link del documento para que podamos leerlo.', 'error');
          input.focus();
          return;
        }

        if (preparacion.invalido) {
          mostrarEstado('Ese link no parece una URL válida. Revisa que empiece por https://', 'error');
          input.focus();
          return;
        }

        // We show the address we are really reading: the person can see
        // (and fix) what we resolved before trusting it.
        input.value = preparacion.url;

        boton.disabled = true;
        boton.textContent = 'Leyendo…';
        mostrarEstado('Estamos leyendo el documento…', 'info');

        try {
          const data = await postJson('/v1/cv-ats/desde-url', { url: preparacion.url });
          await alRecibir(data, mostrarEstado);
        } catch (error) {
          mostrarEstado(
            (error && error.message) || 'No pudimos leer ese link. Puedes subir el archivo o pegar el texto: el resultado es el mismo.',
            'error'
          );
        } finally {
          boton.disabled = false;
          boton.textContent = 'Leer';
        }
      };

      boton.addEventListener('click', leer);

      // Enter reads too: nobody should have to hunt for the button.
      input.addEventListener('keydown', (evento) => {
        if (evento.key === 'Enter') {
          evento.preventDefault();
          leer();
        }
      });

      return bloque;
    }

    /**
     * The address as the person typed it, ready to be fetched: the scheme
     * is added when it is missing ("www.ejemplo.com" works) and anything
     * that is not a web address is rejected BEFORE the request.
     *
     * @returns {{vacio?: boolean, invalido?: boolean, url?: string}}
     */
    function prepararUrl(valor) {
      const crudo = (valor || '').trim();

      if (!crudo) return { vacio: true };

      const conEsquema = /^[a-z][a-z0-9+.-]*:\/\//i.test(crudo)
        ? crudo
        : 'https://' + crudo.replace(/^\/+/, '');

      if (!/^https?:\/\/[^\s/]+/i.test(conEsquema)) return { invalido: true };

      return { url: conEsquema };
    }

    /**
     * The offer read from a link: the text lands in the SAME form the pasted
     * text uses and the "Pegar texto" tab opens with it.
     */
    function inyectarBloqueUrl() {
      if (document.getElementById('oferta-url-bloque')) return;

      const tarjeta = document.getElementById('card-oferta');
      const anclaje = tarjeta ? tarjeta.querySelector('[role="group"]') : null;
      if (!anclaje) return;

      const bloque = crearBloqueUrl(async (data, mostrarEstado) => {
        if (data.tipo === 'archivo') {
          // A PDF or a Word file: it is loaded EXACTLY like an attached one.
          const archivo = archivoDesdeBase64(data.base64, data.nombre, data.mime);
          setOfertaFile(archivo);
          mostrarEstado('Leímos el archivo del link (' + (data.nombre || 'documento') + '). Lo cargamos igual que si lo hubieras subido.', 'ok');
          return;
        }

        const texto = (data.texto || '').trim();
        const recortado = texto.length > 20000;
        const final = recortado ? texto.slice(0, 20000) : texto;

        el.ofertaTextarea.value = final;
        el.ofertaTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        state.oferta.file = null;
        state.oferta.fileText = '';

        // The offer did not come from a file: its reading bar does not apply.
        if (el.ofertaProgressWrap) el.ofertaProgressWrap.classList.add('hidden');
        if (el.ofertaProgress) el.ofertaProgress.style.width = '0%';

        setOfertaTab('texto');

        mostrarEstado(
          recortado
            ? 'Leímos la publicación. Era muy larga, así que tomamos los primeros 20.000 caracteres: revisa que sea la parte del puesto.'
            : 'Leímos la publicación (' + (data.caracteres || final.length) + ' caracteres). Ya está en el campo de texto: revísala y compara.',
          'ok'
        );
        track('cv_ats_oferta_url');
        syncAnalyzeButton();
      }, '¿Tienes el link de la publicación? Pégalo y leemos la oferta por ti: tomamos la descripción completa del puesto y la comparamos con tu CV, igual que si la hubieras copiado a mano.', 'oferta-url-bloque');

      anclaje.parentNode.insertBefore(bloque, anclaje);
    }

    /**
     * The CV card, built as a MIRROR of the offer card.
     *
     * Same order, same classes, same behaviour: the link block, the two
     * tabs, the editable text, the drop zone and the note at the end. Only
     * the purpose changes (your CV instead of the job posting), so the
     * texts differ but the shape is the same: whoever uses one knows how
     * the other works.
     */
    function construirTarjetaCv() {
      if (document.getElementById('cv-tabs')) return;

      const tarjeta = document.getElementById('card-cv');
      if (!tarjeta) return;

      // The existing drop zone (and its chip, progress and errors) becomes
      // the "Subir archivo" panel.
      const panelArchivo = document.createElement('div');
      panelArchivo.id = 'cv-panel-archivo';
      panelArchivo.className = 'hidden';

      const moving = [
        el.cvDrop, el.cvChip, el.cvProgressWrap, el.cvError, el.cvInput,
      ].filter(Boolean);

      moving.forEach((nodo) => panelArchivo.appendChild(nodo));

      // The "Pegar texto" panel: editable, because the person knows their
      // CV better than any reader does.
      const panelTexto = document.createElement('div');
      panelTexto.id = 'cv-panel-texto';
      panelTexto.innerHTML =
        '<label for="cv-textarea" class="sr-only">Pega aquí tu CV</label>' +
        '<textarea id="cv-textarea" rows="8" ' +
          'class="w-full resize-y rounded-lg border border-slate-300 bg-white p-3 text-sm text-slate-800" ' +
          'placeholder="Pega aquí tu CV: tu nombre, tu cargo, tu experiencia, tus estudios y tus habilidades."></textarea>' +
        '<p class="mt-1 text-xs text-slate-600">Pega el texto completo de tu CV.</p>';

      // The same two tabs as the offer, with the same classes.
      const pestanas = document.createElement('div');
      pestanas.id = 'cv-tabs';
      pestanas.className = 'mb-3 inline-flex rounded-md border border-slate-200 bg-slate-50 p-1';
      pestanas.setAttribute('role', 'group');
      pestanas.setAttribute('aria-label', 'Cómo quieres agregar tu CV');
      pestanas.innerHTML =
        '<button type="button" id="cv-tab-texto" class="rounded px-3 py-1.5 text-sm font-medium" aria-pressed="true">Pegar texto</button>' +
        '<button type="button" id="cv-tab-archivo" class="rounded px-3 py-1.5 text-sm font-medium" aria-pressed="false">Subir archivo</button>';

      // The same note as the offer: the last thing added is what counts.
      const nota = document.createElement('p');
      nota.id = 'cv-source-note';
      nota.className = 'mt-2 text-xs text-slate-600';
      nota.textContent = 'Se usará lo último que hayas agregado.';

      // The link block: the same component the offer uses, in the same
      // place (right under the heading, above the tabs).
      const bloqueUrl = crearBloqueUrl(async (data, mostrarEstado) => {
        if (data.tipo === 'archivo') {
          // A PDF or a Word file: loaded EXACTLY like an attached one, with
          // the same reader, the same progress bar and the same messages.
          const archivo = archivoDesdeBase64(data.base64, data.nombre, data.mime);
          handleCvFile(archivo);
          mostrarEstado('Leímos el archivo del link (' + (data.nombre || 'documento') + '). Lo cargamos igual que si lo hubieras subido.', 'ok');
          return;
        }

        const texto = (data.texto || '').trim();

        el.cvTextarea.value = texto;
        el.cvTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        setCvTab('texto');
        mostrarEstado('Leímos el texto de la página (' + (data.caracteres || texto.length) + ' caracteres). Revísalo y edítalo si quieres.', 'ok');
        track('cv_ats_cv_url');
        syncAnalyzeButton();
      }, '¿Tu CV está en un link? Pégalo y lo leemos por ti: si es un PDF o un Word lo cargamos igual que si lo subieras, y si es una página tomamos su texto.', 'cv-url-bloque');

      // The elements are still detached here: they are looked up INSIDE the
      // pieces we just built, not in the document.
      el.cvTextarea = panelTexto.querySelector('#cv-textarea');
      el.cvTabTexto = pestanas.querySelector('#cv-tab-texto');
      el.cvTabArchivo = pestanas.querySelector('#cv-tab-archivo');
      el.cvPanelTexto = panelTexto;
      el.cvPanelArchivo = panelArchivo;

      el.cvTabTexto.addEventListener('click', () => setCvTab('texto'));
      el.cvTabArchivo.addEventListener('click', () => setCvTab('archivo'));

      el.cvTextarea.addEventListener('input', () => {
        state.cv.text = el.cvTextarea.value;

        // If the person edits the text, the uploaded file is no longer the
        // source: the chip goes away so the screen does not lie.
        if (state.cv.file) {
          state.cv.file = null;
          hideChip(el.cvChip);
          if (el.cvInput) el.cvInput.value = '';
        }

        syncAnalyzeButton();
      });

      // The order of the card: link block, tabs, text, file and note.
      // Exactly the offer's order.
      tarjeta.appendChild(bloqueUrl);
      tarjeta.appendChild(pestanas);
      tarjeta.appendChild(panelTexto);
      tarjeta.appendChild(panelArchivo);
      tarjeta.appendChild(nota);

      setCvTab('texto');
    }

    function setCvTab(mode) {
      const esTexto = mode === 'texto';

      if (el.cvPanelTexto) el.cvPanelTexto.classList.toggle('hidden', !esTexto);
      if (el.cvPanelArchivo) el.cvPanelArchivo.classList.toggle('hidden', esTexto);

      const activo = (boton, activo) => {
        if (!boton) return;
        boton.setAttribute('aria-pressed', String(activo));
        boton.classList.toggle('bg-white', activo);
        boton.classList.toggle('shadow-sm', activo);
      };

      activo(el.cvTabTexto, esTexto);
      activo(el.cvTabArchivo, !esTexto);
    }

    /**
     * The bytes that came from a link become a File: from there on it is
     * the same file the person would have attached by hand.
     */
    function archivoDesdeBase64(base64, nombre, mime) {
      const binario = atob(base64 || '');
      const bytes = new Uint8Array(binario.length);
      for (let i = 0; i < binario.length; i++) {
        bytes[i] = binario.charCodeAt(i);
      }
      return new File([bytes], nombre || 'documento', {
        type: mime || 'application/octet-stream',
      });
    }

    /**
     * The inputs (your CV and the offer) collapse when the report arrives.
     *
     * Two reasons: the report IS the answer, and the attachments stop
     * taking the whole screen. One click brings them back and nothing is
     * lost: the text and the files stay loaded.
     */
    function activarSeccionMinimizable() {
      if (document.getElementById('cv-ats-inputs-wrap')) return;

      const cardCv = document.getElementById('card-cv');
      const grid = cardCv ? cardCv.closest('section') : null;
      if (!grid) return;

      // The wrapper that can shrink to nothing: the classic
      // grid-template-rows 1fr -> 0fr transition.
      const wrapper = document.createElement('div');
      wrapper.id = 'cv-ats-inputs-wrap';
      wrapper.className = 'grid transition-[grid-template-rows] duration-300 ease-out';
      wrapper.style.gridTemplateRows = '1fr';

      const interior = document.createElement('div');
      interior.className = 'overflow-hidden';

      grid.parentNode.insertBefore(wrapper, grid);
      wrapper.appendChild(interior);
      interior.appendChild(grid);

      // The toggle lives next to the heading of the block (never inside a
      // card: the cards have their own headings).
      const titulo = Array.from(document.querySelectorAll('h1, h2, h3')).find((nodo) => {
        if (nodo.closest('#card-cv') || nodo.closest('#card-oferta')) return false;
        return !!(grid.compareDocumentPosition(nodo) & Node.DOCUMENT_POSITION_PRECEDING);
      });

      if (!titulo || !titulo.parentNode) return;

      const bloque = titulo.parentNode;
      const fila = document.createElement('div');
      fila.className = 'flex flex-wrap items-start justify-between gap-3';

      bloque.parentNode.insertBefore(fila, bloque);
      fila.appendChild(bloque);
      bloque.classList.add('min-w-0', 'flex-1');

      const boton = document.createElement('button');
      boton.type = 'button';
      boton.id = 'cv-ats-toggle-inputs';
      boton.className = 'inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-brand-300 hover:text-brand-700';
      boton.setAttribute('aria-expanded', 'true');
      boton.setAttribute('aria-controls', 'cv-ats-inputs-wrap');
      boton.innerHTML =
        '<span class="whitespace-nowrap">Ocultar adjuntos</span>' +
        '<svg class="h-4 w-4 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
          'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

      fila.appendChild(boton);
      el.toggleInputs = boton;
      boton.addEventListener('click', () => setInputsCollapsed(!state.inputsCollapsed));
    }

    /**
     * Show or hide the attachments area. Nothing inside is touched: the
     * text and the files stay loaded, they are only out of sight.
     */
    function setInputsCollapsed(colapsado) {
      state.inputsCollapsed = colapsado;

      const wrapper = document.getElementById('cv-ats-inputs-wrap');
      if (wrapper) wrapper.style.gridTemplateRows = colapsado ? '0fr' : '1fr';

      const boton = el.toggleInputs;
      if (!boton) return;

      boton.setAttribute('aria-expanded', String(!colapsado));
      const texto = boton.querySelector('span');
      if (texto) texto.textContent = colapsado ? 'Mostrar adjuntos' : 'Ocultar adjuntos';
      const chevron = boton.querySelector('svg');
      if (chevron) chevron.classList.toggle('rotate-180', colapsado);
    }

    /**
     * The MODAL with the preview of one template.
     *
     * The modal is built by the module (not by the page markup) so the
     * panel and the standalone /cv-ats/ route behave exactly the same.
     */
    function asegurarModal() {
      let modal = document.getElementById('cv-ats-modal');

      if (modal) return modal;

      modal = document.createElement('div');
      modal.id = 'cv-ats-modal';
      modal.className = 'fixed inset-0 z-50 hidden';
      modal.innerHTML =
        '<div data-cv-ats-modal-fondo class="absolute inset-0 bg-slate-900/50"></div>' +
        '<div class="relative flex min-h-full items-center justify-center p-4">' +
          '<div role="dialog" aria-modal="true" aria-labelledby="cv-ats-modal-titulo" ' +
            'class="relative max-h-[85vh] w-full max-w-2xl overflow-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">' +
            '<div class="flex items-start justify-between gap-4">' +
              '<div>' +
                '<h3 id="cv-ats-modal-titulo" class="font-display text-lg font-semibold text-slate-900">Vista previa</h3>' +
                '<p class="mt-1 text-xs text-slate-500">Muestra recortada con tus datos. No se puede copiar.</p>' +
              '</div>' +
              '<button type="button" data-cv-ats-modal-cerrar ' +
                'class="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-sm text-slate-600 transition hover:bg-slate-50" ' +
                'aria-label="Cerrar la vista previa">Cerrar</button>' +
            '</div>' +
            '<div id="cv-ats-modal-cuerpo" class="mt-4"></div>' +
          '</div>' +
        '</div>';

      document.body.appendChild(modal);

      modal.querySelector('[data-cv-ats-modal-cerrar]').addEventListener('click', cerrarPreviewModal);
      modal.querySelector('[data-cv-ats-modal-fondo]').addEventListener('click', cerrarPreviewModal);

      return modal;
    }

    function abrirPreviewModal(plantillaId) {
      const modal = asegurarModal();
      const cuerpo = modal.querySelector('#cv-ats-modal-cuerpo');
      const titulo = modal.querySelector('#cv-ats-modal-titulo');

      const catalogo = (state.match && state.match.plantillas) || [];
      const plantilla = catalogo.find((item) => item && item.id === plantillaId)
        || { id: plantillaId, nombre: plantillaId };

      if (titulo) titulo.textContent = 'Vista previa · ' + (plantilla.nombre || plantilla.id);

      if (cuerpo) {
        cuerpo.innerHTML = previewBloque(plantilla);
        bloquearCopia(cuerpo);
      }

      modal.classList.remove('hidden');
      document.body.classList.add('overflow-hidden');

      const cerrar = modal.querySelector('[data-cv-ats-modal-cerrar]');
      if (cerrar) cerrar.focus();
    }

    function cerrarPreviewModal() {
      const modal = document.getElementById('cv-ats-modal');
      if (!modal || modal.classList.contains('hidden')) return;
      modal.classList.add('hidden');
      document.body.classList.remove('overflow-hidden');
    }

    /**
     * The preview of one template, painted with the person's REAL data.
     *
     * Two rules the owner set:
     *   1. It shows THEIR data (the profile the analysis was made with), not
     *      a generic sample: what you see is the shape of the document you
     *      are about to download.
     *   2. It is deliberately INCOMPLETE and NOT COPYABLE. The text is
     *      truncated and the selection is disabled, so the preview never
     *      becomes a way to harvest the CV instead of generating it.
     */
    function previewPlantilla(plantilla) {
      const perfil = (state.match && state.match.perfil) || {};
      const secciones = Array.isArray(plantilla.secciones) && plantilla.secciones.length
        ? plantilla.secciones
        : ['resumen', 'habilidades', 'experiencia', 'educacion'];
      const titulos = plantilla.titulos || {};

      const nombre = recorta(perfil.nombre || 'Tu nombre', 60);
      const cargo = recorta(perfil.cargo_actual || '', 60);
      const skills = (perfil.skills_tecnicas || []).slice(0, 8);
      const blandas = (perfil.skills_blandas || []).slice(0, 4);
      const experiencias = (perfil.experiencias || []).slice(0, 2);
      const educacion = (perfil.educacion || []).slice(0, 2);
      const anios = perfil['años_experiencia'];

      const resumen = [cargo, anios ? anios + ' años de experiencia' : '', skills.slice(0, 4).join(' · ')]
        .filter(Boolean)
        .join(' · ');

      const bloques = [];

      for (const seccion of secciones) {
        let contenido = '';

        if (seccion === 'resumen' && resumen) {
          contenido = '<p class="pv-texto">' + escapeHtml(recorta(resumen, 110)) + '</p>';
        } else if (seccion === 'habilidades' && (skills.length || blandas.length)) {
          contenido = '<p class="pv-texto">' + escapeHtml(skills.concat(blandas).join(' · ')) + '</p>';
        } else if (seccion === 'experiencia' && experiencias.length) {
          contenido = '<ul class="pv-lista">' + experiencias.map((exp) =>
            '<li>' +
              '<span class="pv-cargo">' + escapeHtml(recorta(exp.cargo || '', 40)) + '</span>' +
              (exp.empresa ? ' — ' + escapeHtml(recorta(exp.empresa, 32)) : '') +
              (exp.fechas ? ' (' + escapeHtml(recorta(exp.fechas, 22)) + ')' : '') +
              '<ul class="pv-lista pv-lista-hija">' +
                (exp.logros || []).slice(0, 2).map((logro) => '<li>' + escapeHtml(recorta(logro, 70)) + '</li>').join('') +
              '</ul>' +
            '</li>'
          ).join('') + '</ul>';
        } else if (seccion === 'educacion' && educacion.length) {
          contenido = '<ul class="pv-lista">' + educacion.map((item) => '<li>' + escapeHtml(recorta(item, 60)) + '</li>').join('') + '</ul>';
        }

        if (!contenido) continue;

        bloques.push('<h4 class="pv-titulo">' + escapeHtml(titulos[seccion] || seccion) + '</h4>' + contenido);
      }

      return '<div class="pv-documento">' +
        '<p class="pv-nombre">' + escapeHtml(nombre) + '</p>' +
        (cargo ? '<p class="pv-cargo-linea">' + escapeHtml(cargo) + '</p>' : '') +
        bloques.join('') +
        '<p class="pv-corte">…vista previa recortada</p>' +
      '</div>';
    }

    function previewBloque(plantilla) {
      return '<div class="rounded-xl border border-slate-200 bg-slate-50 p-4">' +
        '<div class="pv-sin-copia">' + previewPlantilla(plantilla) + '</div>' +
        '<p class="mt-2 text-[11px] leading-relaxed text-slate-500">' +
          'Es una muestra con tus datos, recortada a propósito. El documento que descargas va completo.' +
        '</p>' +
      '</div>';
    }

    /**
     * The preview cannot be copied: no selection, no context menu, no drag.
     */
    function bloquearCopia(cont) {
      if (!cont || cont.dataset.cvAtsCopyBlocked === '1') return;
      cont.dataset.cvAtsCopyBlocked = '1';
      cont.addEventListener('contextmenu', (evento) => evento.preventDefault());
      cont.addEventListener('copy', (evento) => evento.preventDefault());
      cont.addEventListener('cut', (evento) => evento.preventDefault());
      cont.addEventListener('dragstart', (evento) => evento.preventDefault());
    }

    function recorta(texto, maximo) {
      const limpio = String(texto || '').trim();
      if (limpio.length <= maximo) return limpio;
      return limpio.slice(0, maximo).replace(/\s+\S*$/, '') + '…';
    }

    function inyectarEstilosPreview() {
      if (document.getElementById('cv-ats-preview-styles')) return;

      const estilo = document.createElement('style');
      estilo.id = 'cv-ats-preview-styles';
      estilo.textContent = [
        // ---- Vista previa de la plantilla ----
        '.pv-sin-copia { user-select: none; -webkit-user-select: none; }',
        '.pv-documento { background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:16px; font-size:12px; line-height:1.55; color:#334155; }',
        '.pv-nombre { font-size:14px; font-weight:700; letter-spacing:.02em; color:#0f172a; }',
        '.pv-cargo-linea { margin-top:2px; font-size:12px; color:#475569; }',
        '.pv-titulo { margin-top:12px; font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:#1d4ed8; }',
        '.pv-texto { margin-top:4px; color:#475569; }',
        '.pv-lista { margin-top:4px; list-style:none; }',
        '.pv-lista > li { margin-top:6px; }',
        '.pv-lista-hija { padding-left:12px; border-left:2px solid #e2e8f0; }',
        '.pv-lista-hija > li { margin-top:2px; color:#64748b; }',
        '.pv-cargo { font-weight:600; color:#1e293b; }',
        '.pv-corte { margin-top:10px; font-size:11px; color:#94a3b8; font-style:italic; }',

        // ---- La zona de carga llama la atención (sin abusedar) ----
        '.cvats-zona { position: relative; overflow: hidden; }',
        '.cvats-zona::before { content:""; position:absolute; inset:0; border-radius:inherit; box-shadow: inset 0 0 0 0 rgba(37,99,235,.30); animation: cvats-anel 2.6s ease-out infinite; pointer-events:none; }',
        '.cvats-zona::after { content:""; position:absolute; top:0; left:0; width:42%; height:100%; background:linear-gradient(100deg, transparent, rgba(255,255,255,.75), transparent); transform:translateX(-150%); animation: cvats-brillo 3.2s ease-in-out infinite; pointer-events:none; }',
        '.cvats-zona > svg { animation: cvats-flota 2.4s ease-in-out infinite; }',
        '.cvats-zona > p:first-of-type { animation: cvats-latido 2.4s ease-in-out infinite; }',
        '@keyframes cvats-flota { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-7px); } }',
        '@keyframes cvats-anel { 0% { box-shadow: inset 0 0 0 0 rgba(37,99,235,.32); } 70%,100% { box-shadow: inset 0 0 0 16px rgba(37,99,235,0); } }',
        '@keyframes cvats-brillo { 0%,55% { transform: translateX(-150%); } 100% { transform: translateX(340%); } }',
        '@keyframes cvats-latido { 0%,100% { color:#334155; } 50% { color:#1d4ed8; } }',
        '@media (prefers-reduced-motion: reduce) { .cvats-zona::before, .cvats-zona::after, .cvats-zona > svg, .cvats-zona > p:first-of-type { animation: none; } }',

        // ---- El glow de la tarjeta de URL (mismo tema que leydatos) ----
        '.cvats-scan-glow { animation: cvats-glow 2.8s ease-in-out infinite; }',
        '@keyframes cvats-glow { 0%,100% { box-shadow: 0 0 0 0 rgba(37,99,235,.18); } 50% { box-shadow: 0 0 0 6px rgba(37,99,235,.07); } }',
        '@media (prefers-reduced-motion: reduce) { .cvats-scan-glow { animation: none; } }',
      ].join('\n');

      document.head.appendChild(estilo);
    }

    /**
     * The drop zones invite the file: the icon floats, a light sweeps the
     * zone and the border breathes. Motion is the invitation — and it stops
     * for the people who asked the system to calm down.
     */
    function activarZonasDeCarga() {
      for (const zona of [el.cvDrop, el.ofertaDrop]) {
        if (zona) zona.classList.add('cvats-zona');
      }
    }

    function seleccionTipo() {
      const input = document.querySelector('input[name="cv-ats-tipo"]:checked');
      return input ? input.value : '';
    }

    function seleccionPlantilla() {
      const input = document.querySelector('input[name="cv-ats-plantilla"]:checked');
      return input ? input.value : 'harvard';
    }

    function nombreCatalogo(lista, id) {
      const item = (Array.isArray(lista) ? lista : []).find((x) => x && x.id === id);
      return item ? (item.nombre || item.id) : (id || '');
    }

    function alertMarkup(kind, message, withLoginLink) {
      const tone = kind === 'danger'
        ? 'border-rose-200 bg-rose-50 text-rose-700'
        : 'border-sky-200 bg-sky-50 text-sky-700';
      return (
        '<div class="rounded-xl border ' + tone + ' p-5" role="alert">' +
          '<p class="font-medium">' + escapeHtml(message) + '</p>' +
          (withLoginLink ? '<p class="mt-2 text-sm"><a href="' + escapeHtml(APP_ROOT + 'index.html#acceso') + '" class="font-semibold underline">Inicia sesión para analizar</a></p>' : '') +
        '</div>'
      );
    }

    function renderLoading() {
      const step = (index, label) =>
        '<li class="flex items-center gap-3" data-step="' + index + '">' +
          '<span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-slate-300 text-xs font-semibold text-slate-500 step-mark">' + index + '</span>' +
          '<span class="step-label text-slate-600">' + label + '</span>' +
        '</li>';
      el.resultados.innerHTML =
        '<div class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">' +
          '<h2 class="font-display text-xl">Estamos comparando</h2>' +
          '<p class="mt-1 text-sm text-slate-600">Toma un momento. Te aviso en cada paso.</p>' +
          '<ol class="mt-4 space-y-3" aria-live="polite">' +
            step(1, 'Extrayendo tu perfil…') +
            step(2, 'Extrayendo la oferta…') +
            step(3, 'Comparando…') +
          '</ol>' +
        '</div>';
      el.resultados.scrollIntoView({ behavior: 'smooth', block: 'start' });
      markStep(1);
    }

    function markStep(index) {
      const item = el.resultados.querySelector('[data-step="' + index + '"]');
      if (!item || item.dataset.done === '1') return;
      item.dataset.done = '1';
      const mark = item.querySelector('.step-mark');
      const label = item.querySelector('.step-label');
      if (mark) {
        mark.innerHTML = '&#10003;';
        mark.classList.remove('border-slate-300', 'text-slate-500');
        mark.classList.add('border-emerald-500', 'bg-emerald-500', 'text-white');
      }
      if (label) {
        label.classList.remove('text-slate-600');
        label.classList.add('text-slate-800', 'font-medium');
      }
    }

    function renderMatchReport(data) {
      const score = Math.max(0, Math.min(100, Math.round(Number(data.match_score) || 0)));
      const keywords = keywordLists(data);
      const markdown = (data.brecha && data.brecha.informe_markdown) || data.informe_texto || '';
      const credits = Number(data.creditos_restantes);
      const noCredits = Number.isFinite(credits) && credits <= 0;

      const keywordsBlock = (keywords.present || keywords.missing)
        ? '<div class="mt-5 grid gap-4 sm:grid-cols-2">' +
            (keywords.present
              ? '<div class="rounded-lg border border-emerald-200 bg-emerald-50/60 p-4"><h4 class="mb-2 text-sm font-semibold text-emerald-700">Palabras clave que ya tienes</h4>' + pillList(keywords.present, 'present') + '</div>'
              : '') +
            (keywords.missing
              ? '<div class="rounded-lg border border-rose-200 bg-rose-50/60 p-4"><h4 class="mb-2 text-sm font-semibold text-rose-700">Palabras clave que faltan</h4>' + pillList(keywords.missing, 'missing') + '</div>'
              : '') +
          '</div>'
        : '';

      const cta = noCredits
        ? paywallMarkup('')
        : '<div class="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-5">' +
            '<p class="text-sm text-slate-600">Si esta oferta es la que quieres, puedo reescribir tu CV resaltando lo que sí encaja.</p>' +
            catalogoMarkup(data.tipos, data.plantillas) +
            '<button type="button" id="btn-generar" class="mt-5 w-full rounded-lg bg-blue-600 px-6 py-4 text-base font-semibold text-white hover:bg-blue-700">Generar CV Adaptado a esta oferta [3 créditos]</button>' +
            (Number.isFinite(credits) ? '<p class="mt-2 text-xs text-slate-600">Te quedan ' + credits + ' crédito' + (credits === 1 ? '' : 's') + '.</p>' : '') +
          '</div>';

      el.resultados.innerHTML =
        '<div class="grid gap-4 lg:grid-cols-2">' +
          '<div class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-5">' +
            graficasMarkup(data, score) +
            keywordsBlock +
          '</div>' +
          '<div class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">' +
            '<h2 class="font-display text-xl">Tu informe</h2>' +
            '<div class="mt-3 text-sm text-slate-700">' + renderMarkdown(markdown) + '</div>' +
            cta +
          '</div>' +
        '</div>';
      animateGauge(score);
      animateDonut(coberturaKeywords(data).porcentaje);
      track('cv_ats_match_score', { score: score });

      // The report is the answer: the attachments fold away to give it the
      // room, and the person lands right on the result.
      setInputsCollapsed(true);
      el.resultados.scrollIntoView({ behavior: 'smooth', block: 'start' });

      const generateButton = document.getElementById('btn-generar');
      if (generateButton) generateButton.addEventListener('click', runGeneration);
    }

    function renderGenerado(data) {
      const nuevo = Math.max(0, Math.min(100, Math.round(Number(data.nuevo_match_score) || 0)));
      const anterior = state.match ? Math.round(Number(state.match.match_score) || 0) : 0;
      const delta = nuevo - anterior;
      const cv = (data.cv || {});
      const docxHref = cv.docx_url ? window.API(cv.docx_url) : null;
      const pdfHref = cv.pdf_url ? window.API(cv.pdf_url) : null;
      const carta = (data.carta || {});
      const cartaDocx = carta.docx_url ? window.API(carta.docx_url) : null;
      const cartaPdf = carta.pdf_url ? window.API(carta.pdf_url) : null;
      const tipoNombre = nombreCatalogo(state.match && state.match.tipos, data.tipo || seleccionTipo());
      const plantillaNombre = nombreCatalogo(state.match && state.match.plantillas, data.plantilla || seleccionPlantilla());
      const credits = Number(data.creditos_restantes);

      const upsell =
        '<div class="mt-6 rounded-xl border border-slate-200 bg-white p-5">' +
          '<h3 class="font-display text-lg">Si te sirve, más adelante</h3>' +
          '<p class="mt-1 text-sm text-slate-600">Ninguna de estas opciones es necesaria: con el CV ya puedes postular.</p>' +
          '<div class="mt-3 grid gap-3 sm:grid-cols-3">' +
            '<div class="rounded-lg border border-slate-200 bg-slate-50 p-4"><p class="text-sm font-semibold text-slate-800">Mensaje para LinkedIn</p><p class="mt-1 text-sm text-slate-600">Un mensaje corto y honesto para presentarte en esta oferta.</p></div>' +
            '<div class="rounded-lg border border-slate-200 bg-slate-50 p-4"><p class="text-sm font-semibold text-slate-800">3 respuestas de entrevista</p><p class="mt-1 text-sm text-slate-600">Preguntas frecuentes de esta oferta y cómo responderlas con tu experiencia.</p></div>' +
            '<div class="rounded-lg border border-slate-200 bg-slate-50 p-4"><p class="text-sm font-semibold text-slate-800">Pack de 5 adaptaciones</p><p class="mt-1 text-sm text-slate-600">Para cuando estés mirando varios puestos a la vez.</p></div>' +
          '</div>' +
        '</div>';

      const wrapper = document.createElement('div');
      wrapper.innerHTML =
        '<div id="cv-generado" class="rounded-xl border border-emerald-200 bg-white p-6 shadow-sm">' +
          '<div class="flex flex-wrap items-center justify-between gap-3">' +
            '<h2 class="font-display text-xl">Tu CV adaptado está listo</h2>' +
            '<p class="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-sm font-semibold text-emerald-700">Nuevo match: ' + nuevo + '/100' +
              (delta !== 0 ? ' (' + (delta > 0 ? '+' : '') + delta + ')' : '') + '</p>' +
          '</div>' +
          '<p class="mt-1 text-xs text-slate-600">Documento: ' + escapeHtml(tipoNombre || 'CV adaptado') +
            ' · Plantilla: ' + escapeHtml(plantillaNombre || 'harvard') + '</p>' +
          '<p class="mt-1 text-sm text-slate-600">Revísalo con calma antes de enviarlo: tú conoces tu historia mejor que nadie.</p>' +
          '<pre class="mt-4 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">' + escapeHtml(cv.texto || '') + '</pre>' +
          '<div class="mt-4 flex flex-wrap gap-3">' +
            (docxHref ? '<a href="' + escapeHtml(docxHref) + '" target="_blank" rel="noopener" class="rounded-lg bg-blue-600 px-5 py-3 font-semibold text-white no-underline hover:bg-blue-700">Descargar DOCX</a>' : '') +
            (pdfHref ? '<a href="' + escapeHtml(pdfHref) + '" target="_blank" rel="noopener" class="rounded-lg border border-slate-300 bg-white px-5 py-3 font-semibold text-slate-800 no-underline hover:bg-slate-100">Descargar PDF</a>' : '') +
          '</div>' +
          ((cartaDocx || cartaPdf) ? '<div class="mt-3 flex flex-wrap items-center gap-3">' +
            '<span class="text-sm text-slate-600">Carta de presentación:</span>' +
            (cartaDocx ? '<a href="' + escapeHtml(cartaDocx) + '" target="_blank" rel="noopener" class="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 no-underline hover:bg-slate-100">Carta DOCX</a>' : '') +
            (cartaPdf ? '<a href="' + escapeHtml(cartaPdf) + '" target="_blank" rel="noopener" class="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 no-underline hover:bg-slate-100">Carta PDF</a>' : '') +
          '</div>' : '') +
          '<p class="mt-4 text-xs text-slate-600">Borrador generado con asistencia de IA. No constituye asesoría legal ni garantiza resultado. Requiere revisión humana.</p>' +
          (Number.isFinite(credits) && credits > 0 ? '<p class="mt-2 text-xs text-slate-600">Te quedan ' + credits + ' crédito' + (credits === 1 ? '' : 's') + '.</p>' : '') +
        '</div>' + upsell;
      el.resultados.appendChild(wrapper);

      track('cv_ats_generado', { score: nuevo });
      document.getElementById('cv-generado').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function renderFailure(error) {
      const status = error && error.status;
      const code = error && error.code;
      if (status === 401 || code === 'UNAUTHORIZED') {
        el.resultados.innerHTML = alertMarkup('info', 'Tu sesión expiró o aún no iniciaste sesión. Puedes volver cuando quieras: aquí no guardamos nada de tu CV.', true);
        return;
      }
      if (status === 402 || code === 'INSUFFICIENT_CREDITS') {
        el.resultados.innerHTML = paywallMarkup(error.message);
        return;
      }
      el.resultados.innerHTML = alertMarkup('danger', (error && error.message) || 'No pudimos completar el análisis. Intentémoslo de nuevo en un momento.', false);
    }

    /* -------------------------------- flows --------------------------------- */

    async function runMatch() {
      if (state.busy) return;
      state.busy = true;
      state.match = null;
      const stepTimer = setTimeout(() => markStep(2), STEP2_DELAY_MS);

      renderLoading();
      try {
        const data = await postJson('/v1/cv-ats/match', {
          cv_texto: state.cv.text,
          oferta_texto: ofertaTexto(),
          idempotency_key: uuid(),
        });
        clearTimeout(stepTimer);
        markStep(2);
        markStep(3);
        state.match = data;
      avisarCreditos(data.creditos_restantes);
        setTimeout(() => renderMatchReport(data), 250);
      } catch (error) {
        clearTimeout(stepTimer);
        renderFailure(error);
      } finally {
        state.busy = false;
      }
    }

    async function runGeneration() {
      if (state.busy || !state.match) return;
      const button = document.getElementById('btn-generar');
      state.busy = true;
      if (button) { button.textContent = 'Generando tu CV adaptado…'; button.setAttribute('aria-busy', 'true'); button.disabled = true; }
      try {
        // The API reads the REAL data back from the stored analysis (the
        // report the person paid for), so the document is always built with
        // it. The payload is only the fallback for an answer that carries no
        // operation id.
        const cuerpo = {
          tipo: seleccionTipo(),
          plantilla: seleccionPlantilla(),
          idempotency_key: uuid(),
          operacion: state.match.operacion,
        };

        if (!cuerpo.operacion) {
          cuerpo.perfil = state.match.perfil;
          cuerpo.oferta = state.match.oferta;
          cuerpo.brecha = state.match.brecha;
        }

        const data = await postJson('/v1/cv-ats/generar-adaptado', cuerpo);
        avisarCreditos(data.creditos_restantes);
        renderGenerado(data);
      } catch (error) {
        if (button) { button.textContent = 'Generar CV Adaptado a esta oferta [3 créditos]'; button.removeAttribute('aria-busy'); button.disabled = false; }
        if (error && (error.status === 402 || error.code === 'INSUFFICIENT_CREDITS')) {
          button && button.insertAdjacentHTML('afterend', paywallMarkup(error.message));
        } else if (error && (error.status === 401 || error.code === 'UNAUTHORIZED')) {
          button && button.insertAdjacentHTML('afterend', alertMarkup('info', 'Tu sesión expiró. Puedes volver cuando quieras.', true));
        } else if (button) {
          button.insertAdjacentHTML('afterend', alertMarkup('danger', (error && error.message) || 'No pudimos generar el CV ahora. Intentémoslo de nuevo en un momento.', false));
        }
      } finally {
        state.busy = false;
      }
    }

    /* ------------------------------- wiring --------------------------------- */

    el.cvInput.addEventListener('change', () => { const file = el.cvInput.files[0]; if (file) handleCvFile(file); });
    el.cvClear.addEventListener('click', (event) => { event.stopPropagation(); clearCv(); });
    el.cvDrop.__input = el.cvInput;
    bindDropZone(el.cvDrop, handleCvFile);

    el.ofertaInput.addEventListener('change', () => { const file = el.ofertaInput.files[0]; if (file) setOfertaFile(file); });
    el.ofertaClear.addEventListener('click', (event) => { event.stopPropagation(); clearOfertaFile(); });
    el.ofertaDrop.__input = el.ofertaInput;
    bindDropZone(el.ofertaDrop, setOfertaFile);

    el.ofertaTextarea.addEventListener('input', () => {
      state.oferta.mode = 'texto';
      state.oferta.text = el.ofertaTextarea.value;
      if (el.ofertaTextarea.value.trim() && !state.ofertaTracked) {
        track('cv_ats_upload_oferta_tipo', { tipo: 'texto' });
        state.ofertaTracked = true;
      }
      syncAnalyzeButton();
    });

    const setOfertaTab = (mode) => {
      const isText = mode === 'texto';
      state.oferta.mode = mode;
      el.ofertaPanelTexto.classList.toggle('hidden', !isText);
      el.ofertaPanelArchivo.classList.toggle('hidden', isText);
      el.ofertaTabTexto.setAttribute('aria-pressed', String(isText));
      el.ofertaTabArchivo.setAttribute('aria-pressed', String(!isText));
      el.ofertaTabTexto.classList.toggle('bg-white', isText);
      el.ofertaTabTexto.classList.toggle('shadow-sm', isText);
      el.ofertaTabArchivo.classList.toggle('bg-white', !isText);
      el.ofertaTabArchivo.classList.toggle('shadow-sm', !isText);
      syncAnalyzeButton();
    };
    el.ofertaTabTexto.addEventListener('click', () => setOfertaTab('texto'));
    el.ofertaTabArchivo.addEventListener('click', () => setOfertaTab('archivo'));

    el.btnAnalizar.addEventListener('click', () => {
      if (el.btnAnalizar.getAttribute('aria-disabled') === 'true') {
        el.btnAnalizar.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      runMatch();
    });

    // The template preview opens in a MODAL. The listener is delegated on
    // the results container: the buttons are repainted with every report and
    // this way one listener serves all of them.
    el.resultados.addEventListener('click', (evento) => {
      const boton = evento.target.closest('[data-cv-ats-preview]');
      if (!boton) return;
      evento.preventDefault();
      abrirPreviewModal(boton.getAttribute('data-cv-ats-preview'));
    });

    document.addEventListener('keydown', (evento) => {
      if (evento.key === 'Escape') cerrarPreviewModal();
    });

    setOfertaTab('texto');
    syncAnalyzeButton();
    inyectarEstilosPreview();
    construirTarjetaCv();
    activarZonasDeCarga();
    inyectarBloqueUrl();
    activarSeccionMinimizable();
