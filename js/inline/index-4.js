    // Heart of this surface: wallet, RAG and rate limits of the ley-datos
    // heart. Set BEFORE anything else reads it (same contract as app.html).
    const HEART = 'atscv';
    localStorage.setItem('heart_id', HEART);

    // Kind hint shown next to a 401: most existing accounts never set a
    // password (magic-link only), so we point them back to the link.
    const PASSWORD_LOGIN_HINT = 'Si nunca fijaste una contraseña, usa el enlace mágico: llega a tu correo y desde tu Perfil puedes dejarla guardada.';

    function setError(form, message, hint) {
      const box = form.querySelector('[data-error]');
      box.textContent = '';
      box.append(document.createTextNode(message));
      if (hint) {
        const hintEl = document.createElement('span');
        hintEl.className = 'mt-1 block text-xs text-rose-700';
        hintEl.textContent = hint;
        box.append(hintEl);
      }
      box.classList.remove('hidden');
    }

    function clearError(form) {
      const box = form.querySelector('[data-error]');
      box.textContent = '';
      box.classList.add('hidden');
    }

    async function requestMagicLink({ name, email, newsletter }) {
      // The real backend route (public/index.php POST /auth/magic-link):
      // JSON body, terms_accepted is server-enforced, heart routes the
      // welcome credit to the wallet this surface spends from.
      const response = await fetch(window.API('/auth/magic-link'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          email,
          terms_accepted: true,
          newsletter: newsletter === true,
          heart: HEART,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.success) {
        const err = data.error;
        const message = typeof err === 'string'
          ? err
          : (err && err.message) || 'No pudimos enviar el enlace ahora. Inténtalo de nuevo en unos minutos.';
        throw new Error(message);
      }

      return data;
    }

    // POST /auth/login: email + password + remember opt-in. On success the
    // backend sets the httpOnly session cookies (persistent 30 days when
    // remember=true, session-scope when remember=false); the caller then
    // navigates to the panel.
    async function loginWithPassword(email, password, remember) {
      const response = await fetch(window.API('/auth/login'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, remember: remember === true }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.success) {
        const err = data.error;
        const message = typeof err === 'string'
          ? err
          : (err && err.message) || 'No pudimos iniciar sesión ahora. Inténtalo nuevamente en unos minutos.';
        throw Object.assign(new Error(message), { status: response.status });
      }

      return data;
    }

    // POST /auth/register: creates the account with a password (min 8,
    // server-enforced) and sets the session cookies in the same response,
    // so the caller can navigate straight to the panel. Heart flows
    // (welcome bonus) and terms are server-enforced.
    async function registerAccount({ name, email, password, newsletter }) {
      const response = await fetch(window.API('/auth/register'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          email,
          password,
          terms_accepted: true,
          newsletter: newsletter === true,
          heart: HEART,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.success) {
        const err = data.error;
        const message = typeof err === 'string'
          ? err
          : (err && err.message) || 'No pudimos crear tu cuenta ahora. Inténtalo nuevamente en unos minutos.';
        throw new Error(message);
      }

      return data;
    }

    function wireAuthForm(formId, options) {
      const form = document.getElementById(formId);

      if (!form) return;

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        clearError(form);

        const emailInput = form.querySelector('[name="email"]');
        const email = (emailInput.value || '').trim();
        const name = options.requireName ? (form.querySelector('[name="name"]').value || '').trim() : '';
        const newsletterEl = form.querySelector('[name="newsletter"]');
        const passwordInput = form.querySelector('[name="password"]');
        const password = passwordInput ? passwordInput.value : '';
        const usePassword = options.allowPassword && password !== '';

        // Registro con contraseña: server enforces min 8 too, but checking
        // here keeps the error local and immediate (empatía: no idas y
        // vueltas al servidor por algo el formulario sabe fallar mejor).
        if (options.passwordRequired) {
          if (password.length < 8) {
            setError(form, 'La contraseña debe tener al menos 8 caracteres. La usas para entrar a tu panel.');
            passwordInput?.focus();
            return;
          }
          const confirmInput = form.querySelector('[name="password_confirm"]');
          if (password !== (confirmInput ? confirmInput.value : '')) {
            setError(form, 'Las contraseñas no coinciden. Revísalas e inténtalo, con calma: sin apuros.');
            confirmInput?.focus();
            return;
          }
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          setError(form, 'Escribe tu correo para enviarte el enlace de acceso (ejemplo: nombre@correo.cl).');
          emailInput.focus();
          return;
        }

        const button = form.querySelector('button[type="submit"]');
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = usePassword ? 'Entrando…' : options.loadingText;

        // When true the browser is navigating to the panel: keep the button
        // disabled and skip the restore in finally.
        let navigating = false;

        try {
          if (options.passwordRequired) {
            // Registro directo: /auth/register sets the session cookies in
            // this same response, so the visitor lands on their panel with
            // the welcome credits ready.
            const payload = await registerAccount({ name, email, password, newsletter: newsletterEl ? newsletterEl.checked : false });
            const session = payload && payload.data ? payload.data : payload;

            // Anuncia el registro: el checkout público de pagos (los packs
            // son visibles sin cuenta) consume este evento para desbloquear
            // el botón de pago SIN sacar a la persona de esta página. Si
            // nadie lo consume, el flujo normal es abrir el panel.
            const registered = new CustomEvent('aj:registered', { detail: session, cancelable: true });
            document.dispatchEvent(registered);

            if (registered.defaultPrevented) {
              // La superficie pública tomó el control: la sesión ya está
              // abierta y los 100 créditos de bienvenida acreditados. El
              // botón vuelve a su estado (finally) y la persona sigue aquí.
              return;
            }

            navigating = true;
            button.textContent = 'Abriendo tu panel…';
            window.location.assign(options.passwordRedirect || 'app.html');
            return;
          }

          if (usePassword) {
            // "Recordar sesión" is login-only: unchecked → session-scope
            // cookies. The checkbox is read wherever the login form has one
            // (registro/scan never touch it).
            const rememberCheckbox = form.querySelector('[name="remember"]');
            await loginWithPassword(email, password, rememberCheckbox ? rememberCheckbox.checked : true);
            navigating = true;
            button.textContent = 'Entrando…';
            window.location.assign(options.passwordRedirect);
            return;
          }

          await requestMagicLink({ name, email, newsletter: newsletterEl ? newsletterEl.checked : false });
          form.hidden = true;
          const success = form.parentElement.querySelector('[data-success]');
          success.querySelector('[data-success-email]').textContent = email;
          const recoveryNote = success.querySelector('[data-recovery-note]');
          if (recoveryNote) recoveryNote.classList.add('hidden');
          success.classList.remove('hidden');
        } catch (error) {
          setError(form, error.message, error.status === 401 ? PASSWORD_LOGIN_HINT : '');
        } finally {
          if (!navigating) {
            button.disabled = false;
            button.textContent = originalText;
          }
        }
      });
    }

    // "Olvidé mi contraseña": request a magic link for the typed email and
    // explain, kindly, that the link logs them in and Perfil lets them set a
    // new password.
    (function wireRecoveryLink() {
      const link = document.getElementById('login-recover');
      const form = document.getElementById('form-login');
      if (!link || !form) return;

      link.addEventListener('click', async () => {
        clearError(form);

        const emailInput = form.querySelector('[name="email"]');
        const email = (emailInput.value || '').trim();

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          setError(form, 'Escribe tu correo para enviarte el enlace de acceso (ejemplo: nombre@correo.cl).');
          emailInput.focus();
          return;
        }

        const originalText = link.textContent;
        link.disabled = true;
        link.textContent = 'Enviando enlace…';

        try {
          await requestMagicLink({ name: '', email, newsletter: false });
          form.hidden = true;
          const success = form.parentElement.querySelector('[data-success]');
          success.querySelector('[data-success-email]').textContent = email;
          const recoveryNote = success.querySelector('[data-recovery-note]');
          if (recoveryNote) recoveryNote.classList.remove('hidden');
          success.classList.remove('hidden');
        } catch (error) {
          setError(form, error.message);
        } finally {
          link.disabled = false;
          link.textContent = originalText;
        }
      });
    })();

    // ----- Password reveal (eye icon) + advisory strength meter -----
    // Same contract as the main panel: aria-pressed mirrors the revealed
    // state, delegated listeners so any future password field works, and
    // the meter is ADVISORY ONLY (real limits live server-side, bcrypt).
    // Copy is zero-blame: guide, never scold.
    document.addEventListener('click', (event) => {
      const button = event.target && event.target.closest
        ? event.target.closest('button[data-password-eye]')
        : null;
      if (!button || !document.contains(button)) return;
      const input = button.parentElement.querySelector('input');
      if (!input) return;
      const willShow = input.type !== 'text';
      input.type = willShow ? 'text' : 'password';
      button.setAttribute('aria-pressed', willShow ? 'true' : 'false');
      button.setAttribute('aria-label', willShow ? 'Ocultar contraseña' : 'Mostrar contraseña');
      button.setAttribute('title', willShow ? 'Ocultar contraseña' : 'Mostrar contraseña');
      const iconEye = button.querySelector('[data-eye-icon]');
      const iconEyeOff = button.querySelector('[data-eye-off-icon]');
      if (iconEye) iconEye.classList.toggle('hidden', willShow);
      if (iconEyeOff) iconEyeOff.classList.toggle('hidden', !willShow);
    });

    const PASSWORD_STRENGTH_FILL = { debil: 'bg-rose-400', media: 'bg-amber-400', segura: 'bg-emerald-500' };
    const PASSWORD_STRENGTH_COPY = {
      corta: 'Fortaleza de la contraseña: por empezar. 8+ caracteres, mezcla mayúsculas, minúsculas y números: entre más larga, más segura.',
      debil: 'Fortaleza de la contraseña: débil. Puedes reforzarla agregando mayúsculas, números o algunos caracteres más.',
      media: 'Fortaleza de la contraseña: media. Con 12 o más caracteres y un símbolo queda aún más segura.',
      segura: 'Fortaleza de la contraseña: segura. Bien: entre más larga, más difícil de adivinar.'
    };
    const PASSWORD_STRENGTH_FILLED = { corta: 0, debil: 1, media: 2, segura: 3 };

    function passwordStrength(value) {
      const hasLower = /[a-záéíóúüñ]/.test(value);
      const hasUpper = /[A-ZÁÉÍÓÚÜÑ]/.test(value);
      const hasDigit = /[0-9]/.test(value);
      const hasSymbol = /[^A-Za-z0-9áéíóúüñÁÉÍÓÚÜÑ]/.test(value);
      if (value.length >= 12 && hasUpper && hasLower && hasDigit && hasSymbol) return 'segura';
      if (value.length >= 10 && hasUpper && hasLower && hasDigit) return 'media';
      if (value.length >= 8 && (hasLower || hasUpper)) return 'debil';
      return 'corta';
    }

    function paintPasswordStrength(value, meter) {
      const level = passwordStrength(value);
      const filled = PASSWORD_STRENGTH_FILLED[level] || 0;
      meter.querySelectorAll('[data-strength-seg]').forEach((segment, index) => {
        const activeColor = index < filled ? PASSWORD_STRENGTH_FILL[level] : null;
        Object.keys(PASSWORD_STRENGTH_FILL).forEach((levelName) => {
          segment.classList.toggle(PASSWORD_STRENGTH_FILL[levelName], activeColor === PASSWORD_STRENGTH_FILL[levelName]);
        });
        segment.classList.toggle('bg-slate-200', !activeColor);
      });
      const text = meter.querySelector('[data-strength-text]');
      if (text) text.textContent = PASSWORD_STRENGTH_COPY[level];
      meter.classList.toggle('hidden', value.length === 0);
    }

    document.addEventListener('input', (event) => {
      const target = event.target;
      if (!target || !target.matches || !target.matches('input[data-strength-for]')) return;
      const meter = document.getElementById(target.dataset.strengthFor || target.getAttribute('data-strength-for'));
      if (meter) paintPasswordStrength(target.value || '', meter);
    });

    wireAuthForm('form-login', { requireName: false, loadingText: 'Enviando…', allowPassword: true, passwordRedirect: 'app.html' });
    wireAuthForm('form-registro', { requireName: true, loadingText: 'Creando tu cuenta…', passwordRequired: true, passwordRedirect: 'app.html' });

    // ============================== RECORDAR SESIÓN ==============================
    // Persisted opt-in (aj:remember): the panel reads it on every silent
    // /auth/refresh rotation so a remembered session stays persistent and an
    // un-remembered session keeps dying with the browser. Stored value:
    // '1' → true, absent or '0' → false.
    (function wireRememberSession() {
      const REMEMBER_KEY = 'aj:remember';
      const checkbox = document.getElementById('login-remember');

      if (!checkbox) return;

      try {
        checkbox.checked = localStorage.getItem(REMEMBER_KEY) === '1';
      } catch (_) { /* storage unavailable: markup default (unchecked) applies */ }

      checkbox.addEventListener('change', () => {
        try {
          localStorage.setItem(REMEMBER_KEY, checkbox.checked ? '1' : '0');
        } catch (_) { /* storage unavailable: the choice just survives the page */ }
      });
    })();

    // ============================== LOGGED-IN VISITOR ==============================
    // Owner (2026-10-22): "si el usuario está logeado el registro y form login
    // desaparecen del index, y los botones de header cambian a entrar a
    // panel". One /auth/me probe on load reflows the landing for a returning
    // user; on any failure the default (visitor) markup stays untouched.
    // Session knowledge for the scan flow (ldAuthedEmail + body dataset):
    // clicking "Escanear mi sitio" skips the email gate for a returning
    // visitor. It stays in memory/DOM only — never localStorage.
    let ldAuthedEmail = null;

    // Session-aware UI: the header CTAs and the Acceso cards follow the
    // session. It runs at boot AND when the account is created IN this very
    // page (the public checkout modal registers without reloading).
    function revealSessionUi(user) {
      if (!user) return;

      // Expose the session for the scan flow: the account email travels
      // with the scan-entry POST instead of asking again (feature:
      // logged-in scan, no email gate). httpOnly cookies stay the only
      // session store.
      document.body.dataset.ldAuthed = '1';
      ldAuthedEmail = typeof user.email === 'string' ? user.email.trim() : '';

      // Header: hide the auth links, reveal the panel entry. The theme
      // toggle carries no data-auth-links, so it is never touched.
      document.querySelectorAll('[data-auth-links]').forEach((el) => el.classList.add('hidden'));

      const enterPanel = document.getElementById('btn-enter-panel');
      if (enterPanel) enterPanel.hidden = false;

      // Acceso: hide login/registro cards and the heading, show the
      // welcome card (markup stays in the DOM, only hidden).
      const loginCard = document.getElementById('login');
      const registerCard = document.getElementById('registro');
      const welcome = document.getElementById('auth-welcome');
      const heading = document.querySelector('[data-auth-heading]');

      if (loginCard) loginCard.hidden = true;
      if (registerCard) registerCard.hidden = true;
      if (heading) heading.hidden = true;
      if (welcome) welcome.hidden = false;

      // Warm greeting with the first name, built via textContent — the
      // name is user-controlled and must never touch innerHTML.
      const name = typeof user.name === 'string' ? user.name.trim() : '';
      const firstName = name.split(/\s+/)[0] || '';
      const welcomeText = welcome?.querySelector('[data-welcome-text]');

      if (firstName && welcomeText) {
        welcomeText.textContent = `Bienvenido de nuevo, ${firstName}: ya tienes una sesión activa; tu panel te espera.`;
      }
    }

    // Una cuenta creada desde ESTA página (modal del checkout público) no
    // recarga la landing: el mismo evento que desbloquea el botón de pago
    // actualiza la UI de sesión.
    document.addEventListener('aj:registered', (event) => {
      const user = event.detail && event.detail.user;
      if (user) revealSessionUi(user);
    });

    (async function revealLoggedInState() {
      const enterPanel = document.getElementById('btn-enter-panel');

      enterPanel?.addEventListener('click', () => {
        window.location.assign('app.html');
      });

      try {
        const fetchMe = () => fetch(window.API('/auth/me'), {
          credentials: 'include',
          headers: { 'Accept': 'application/json' },
        });
        let response = await fetchMe();

        // The short-lived access token can expire while the refresh cookie
        // is still valid (30-min access / httpOnly refresh): silently renew
        // once before giving up, so a logged-in visitor is not mistaken
        // for anonymous.
        if (response.status === 401) {
          const refreshed = await fetch(window.API('/auth/refresh'), {
            method: 'POST',
            credentials: 'include',
            headers: { 'Accept': 'application/json' },
          });
          if (refreshed.ok) response = await fetchMe();
        }

        const data = await response.json().catch(() => ({}));

        // Response shape: { success, data: { user, balance } } — flat
        // data.user never exists on /auth/me.
        const user = data && data.success ? data.data && data.data.user : null;

        if (!user) return;

        revealSessionUi(user);
      } catch (_) {
        // Network/backend hiccup: keep the visitor landing exactly as it is.
      }
    })();

    // ============================== SCAN-FIRST FLOW ==============================
    // The visitor types the URL FIRST; the email gate opens as a modal and
    // carries them in (direct scan-entry in the dev pilot, magic link in
    // production). The URL is parked in localStorage so the panel (app.html)
    // prefills the analyzer right after entry — and auto-starts the analysis
    // ONCE, per the owner's directive (2026-10-22): the visitor asked for the
    // scan and the welcome bonus pays for it.
    const PENDING_SCAN_KEY = 'ld_pending_scan_url';

    function normalizeScanUrl(raw) {
      let value = (raw || '').trim().replace(/\s+/g, '');

      if (value === '') return null;
      if (!/^https?:\/\//i.test(value)) value = 'https://' + value;

      try {
        const url = new URL(value);

        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        if (!url.hostname.includes('.')) return null;

        return url.href;
      } catch (_) {
        return null;
      }
    }

    const scanModal = document.getElementById('scan-modal');

    function openScanModal(url) {
      if (!scanModal) return;

      scanModal.querySelectorAll('[data-scan-url]').forEach((el) => { el.textContent = url; });

      // Two variants, one contract: the anonymous flow keeps its email gate
      // exactly as before; a returning visitor (revealLoggedInState) skips
      // it and only confirms the scan T&C. The T&C stays REQUIRED in both —
      // the backend consent for persistent-site scanning never weakens.
      const authed = typeof ldAuthedEmail === 'string' && ldAuthedEmail.includes('@');
      const emailRow = scanModal.querySelector('[data-scan-email-row]');
      const accountLine = scanModal.querySelector('[data-scan-account-line]');
      const introAnon = scanModal.querySelector('[data-scan-intro-anon]');
      const introAuthed = scanModal.querySelector('[data-scan-intro-authed]');
      const emailInput = scanModal.querySelector('#scan-email');

      if (emailRow) emailRow.classList.toggle('hidden', authed);
      if (introAnon) introAnon.classList.toggle('hidden', authed);
      // The authed intro and account line carry the hidden attribute in
      // markup (no-tailwind default): toggle the property, not a class.
      if (introAuthed) introAuthed.hidden = !authed;
      if (accountLine) {
        const emailSlot = accountLine.querySelector('[data-scan-account-email]');

        if (emailSlot) emailSlot.textContent = authed ? ldAuthedEmail : '';
        accountLine.hidden = !authed;
      }
      // Keep the native `required` on the hidden input consistent: prefilled
      // with the account email, native validation has nothing to flag.
      if (authed && emailInput) emailInput.value = ldAuthedEmail;

      // With an active session the email gate disappears, so its native
      // `required` must go too (a hidden required field blocks the submit
      // in some browsers). The T&C gate is decided by the BACKEND
      // (POST /auth/scan-consent): the account may have accepted an older
      // version of the Terms, and only the server knows that.
      const termsBox = scanModal.querySelector('#scan-terms');

      if (emailInput) emailInput.required = !authed;
      if (termsBox) termsBox.required = !authed;

      const formWrap = scanModal.querySelector('[data-modal-form-wrap]');
      const successBox = scanModal.querySelector('[data-modal-success]');

      if (formWrap) formWrap.classList.remove('hidden');
      if (successBox) successBox.classList.add('hidden');
      clearError(scanModal.querySelector('#form-scan') || scanModal);

      scanModal.hidden = false;
      document.body.style.overflow = 'hidden';

      // First tab stop per variant: the email field when anonymous, the
      // T&C checkbox when the account is already known.
      if (authed) {
        const terms = scanModal.querySelector('#scan-terms');

        if (terms) terms.focus({ preventScroll: true });
      } else if (emailInput) {
        emailInput.focus({ preventScroll: true });
      }
    }

    function closeScanModal() {
      if (!scanModal || scanModal.hidden) return;

      restoreLoginHome();
      scanModal.hidden = true;
      document.body.style.overflow = '';
    }

    // ---- Reuse the page's own login form inside the scan modal ----
    // When the typed email already has an account, the backend refuses the
    // direct entry (409 EMAIL_REGISTERED): the visitor must prove ownership.
    // We MOVE #form-login into the modal (DOM moves keep its submit wiring)
    // and put it back in the auth section if the modal closes first.
    let loginHome = null;

    function restoreLoginHome() {
      const form = document.getElementById('form-login');
      if (!form || !loginHome) return;
      loginHome.parent.insertBefore(form, loginHome.next);
      form.hidden = false;
      loginHome = null;
    }

    function openLoginInsideModal() {
      const form = document.getElementById('form-login');
      const wrap = scanModal?.querySelector('[data-modal-form-wrap]');
      if (!form || !wrap) return;

      loginHome = { parent: form.parentNode, next: form.nextSibling };
      wrap.appendChild(form);
      form.hidden = false;

      const scanForm = scanModal?.querySelector('#form-scan');
      if (scanForm) scanForm.hidden = true;

      const intro = scanModal?.querySelector('[data-scan-intro-anon]');
      if (intro) intro.textContent = 'Este correo ya tiene una cuenta. Ingresa con tu contraseña para continuar y el análisis de tu sitio parte de inmediato.';

      // Preload the known email and focus the password field.
      const emailField = form.querySelector('[name="email"]');
      const scanEmail = scanModal?.querySelector('#scan-email');
      if (emailField && scanEmail) emailField.value = scanEmail.value;
      const passwordField = form.querySelector('[name="password"]');
      if (passwordField) passwordField.setAttribute('required', 'required');
      // The hint "(opcional: si la dejas vacía…)" belongs to the page form,
      // where an empty password asks for a magic link. Here the password IS
      // the proof of ownership: the label must say so.
      const passwordHint = form.querySelector('[data-password-hint]');
      if (passwordHint) passwordHint.textContent = '(obligatoria: la cuenta ya existe)';
      passwordField?.focus();
    }

    scanModal?.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('[data-modal-close]')) {
        closeScanModal();
        return;
      }

      // Backdrop click closes; clicks inside the card must not bubble here.
      if (event.target instanceof Element && event.target.hasAttribute('data-modal-backdrop')) {
        closeScanModal();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeScanModal();
    });

    const scanUrlForm = document.getElementById('form-scan-url');

    scanUrlForm?.addEventListener('submit', (event) => {
      event.preventDefault();

      const input = document.getElementById('scan-url');
      const errorBox = scanUrlForm.querySelector('[data-scan-error]');
      const flash = scanUrlForm.querySelector('[data-scan-flash]');

      const url = normalizeScanUrl(input?.value);

      if (!url) {
        errorBox.textContent = 'Escribe la dirección de tu sitio (ejemplo: tusitio.cl o https://tusitio.cl).';
        errorBox.classList.remove('hidden');
        input?.focus();
        return;
      }

      errorBox.classList.add('hidden');
      localStorage.setItem(PENDING_SCAN_KEY, url);

      // Impact moment: one light sweep across the pill, then the email gate.
      const beam = flash?.firstElementChild;

      if (flash && beam && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        beam.classList.remove('scan-flash-run');
        void beam.offsetWidth; // restart the animation from the left edge
        beam.classList.add('scan-flash-run');
        setTimeout(() => openScanModal(url), 650);
      } else {
        openScanModal(url);
      }
    });

    const scanEmailForm = document.getElementById('form-scan');

    scanEmailForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearError(scanEmailForm);

      const emailInput = scanEmailForm.querySelector('[name="email"]');
      // Logged-in scan flow: the email comes from the /auth/me session
      // (ldAuthedEmail) instead of the hidden input; the anonymous flow
      // validates the typed email exactly as before.
      const sessionEmail = typeof ldAuthedEmail === 'string' ? ldAuthedEmail : '';
      const email = sessionEmail || (emailInput.value || '').trim();

      if (!sessionEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setError(scanEmailForm, 'Escribe tu correo para continuar con el análisis (ejemplo: nombre@correo.cl).');
        emailInput.focus();
        return;
      }

      // Native `required` on the terms checkbox supplies the visual hint;
      // the anonymous path reaches here only with a valid email. A logged-in
      // account already accepted the Terms (the BACKEND decides if the
      // accepted version is still current), so the gate is not enforced
      // here for them.
      if (!sessionEmail && !scanEmailForm.querySelector('[name="terms"]')?.checked) {
        setError(scanEmailForm, 'Necesitamos que aceptes los Términos y Condiciones para almacenar tu sitio.');
        return;
      }

      const button = scanEmailForm.querySelector('button[type="submit"]');
      const originalText = button.textContent;

      // Logged-in visitor: the session IS the proof of ownership — skip
      // /auth/scan-entry entirely (it registers or refuses by email design)
      // and go straight to the panel with the parked URL, exactly like a
      // successful direct entry did before the 409 security fix.
      //
      // The BACKEND owns the consent decision (POST /auth/scan-consent): if
      // the account accepted the current Terms version, the scan goes
      // through; if the Terms changed, we ask again and record the new
      // acceptance.
      if (sessionEmail) {
        const modalUrlNow = scanModal?.querySelector('[data-scan-url]')?.textContent?.trim() || '';
        const termsChecked = !!scanEmailForm.querySelector('[name="terms"]')?.checked;

        button.disabled = true;
        button.textContent = 'Entrando…';

        try {
          const consentResponse = await fetch(window.API('/auth/scan-consent'), {
            method: 'POST',
            credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accept: termsChecked }),
          });
          const consentData = await consentResponse.json().catch(() => ({}));
          const consent = consentData && consentData.success ? consentData.data : null;

          if (!consentResponse.ok || !consent || !consent.consent) {
            // The Terms changed since they accepted: ask again, kindly.
            const termsBox = scanEmailForm.querySelector('[name="terms"]');
            if (termsBox) {
              termsBox.required = true;
              termsBox.focus({ preventScroll: true });
            }
            setError(scanEmailForm, (consent && consent.message)
              || 'Necesitamos que aceptes los Términos y Condiciones vigentes para almacenar tu sitio.');
            button.disabled = false;
            button.textContent = originalText;
            return;
          }
        } catch (_) {
          // Network trouble: do not strand the visitor — the scan can wait
          // for the next click.
          setError(scanEmailForm, 'No pudimos confirmar tu sesión ahora. Revisa tu conexión e inténtalo de nuevo.');
          button.disabled = false;
          button.textContent = originalText;
          return;
        }

        if (modalUrlNow) localStorage.setItem(PENDING_SCAN_KEY, modalUrlNow);

        window.location.assign('app.html');

        return;
      }

      // True while the browser is on its way to the panel: keep the button
      // disabled and skip the restore in finally.
      let navigating = false;
      button.disabled = true;
      button.textContent = 'Entrando…';

      // Dev pilot: POST /auth/scan-entry registers the visitor (welcome
      // bonus included) and lands them straight in the panel — no email
      // round-trip. Outside development the backend answers 403 and we
      // fall back to the magic-link flow below, exactly as before.
      try {
        let directEntry = null;
        let validationMessage = null;

        try {
          const response = await fetch(window.API('/auth/scan-entry'), {
            method: 'POST',
            credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, heart: HEART, terms_accepted: true }),
          });

          if (response.ok) {
            const data = await response.json().catch(() => ({}));
            if (data.success) directEntry = data;
          } else if (response.status === 400) {
            const data = await response.json().catch(() => ({}));
            const err = data.error;
            validationMessage = typeof err === 'string' ? err : (err && err.message) || '';
          } else if (response.status === 409) {
            // The email already has an account: prove ownership first.
            // The page's own login form opens inside this modal (password
            // or magic link); on success it navigates to the panel, where
            // the parked URL starts the scan.
            const modalUrl = scanModal?.querySelector('[data-scan-url]')?.textContent?.trim() || '';
            if (modalUrl) localStorage.setItem(PENDING_SCAN_KEY, modalUrl);

            button.disabled = false;
            button.textContent = originalText;
            openLoginInsideModal();

            return;
          }
          // 403 (production) or any other status: fall back to the magic link.
        } catch (_) {
          // Network failure: fall back to the magic link.
        }

        if (directEntry) {
          // The URL form already parked the scan URL; re-assert it so the
          // panel prefills and auto-starts the analysis the visitor asked for.
          const modalUrl = scanModal?.querySelector('[data-scan-url]')?.textContent?.trim() || '';
          if (modalUrl) localStorage.setItem(PENDING_SCAN_KEY, modalUrl);

          navigating = true;
          button.textContent = 'Entrando…';
          window.location.assign('app.html');
          return;
        }

        if (validationMessage) {
          setError(scanEmailForm, validationMessage);
          return;
        }

        // Fallback: magic link (production path), unchanged behavior.
        button.textContent = 'Enviando…';
        await requestMagicLink({ name: '', email, newsletter: false });

        const successBox = scanModal.querySelector('[data-modal-success]');
        const formWrap = scanModal.querySelector('[data-modal-form-wrap]');

        if (successBox) {
          successBox.querySelector('[data-success-email]').textContent = email;
          const urlEl = successBox.querySelector('[data-success-url]');
          const pending = localStorage.getItem(PENDING_SCAN_KEY) || '';

          if (urlEl) urlEl.textContent = pending;
        }

        if (formWrap) formWrap.classList.add('hidden');
        if (successBox) successBox.classList.remove('hidden');
      } catch (error) {
        setError(scanEmailForm, error.message);
      } finally {
        if (!navigating) {
          button.disabled = false;
          button.textContent = originalText;
        }
      }
    });

    // ============================== LIGHTBOX ==============================
    // Click-to-zoom for the section screenshots (9 imgs, cursor-zoom-in).
    // One shared viewer: backdrop / × / Escape close it, focus is stored
    // and restored, and body scroll is locked while it is open.
    (function wireLightbox() {
      const box = document.getElementById('lightbox');

      if (!box) return;

      const img = box.querySelector('[data-lightbox-img]');
      const caption = box.querySelector('[data-lightbox-caption]');
      const close = box.querySelector('[data-lightbox-close]');
      let lastFocus = null;

      function openLightbox(source) {
        lastFocus = document.activeElement;
        img.src = source.currentSrc || source.src;
        img.alt = source.alt || '';
        caption.textContent = source.alt || '';
        box.hidden = false;
        document.body.style.overflow = 'hidden';
        close.focus();
      }

      function closeLightbox() {
        if (box.hidden) return;

        box.hidden = true;
        document.body.style.overflow = '';
        if (lastFocus && lastFocus.isConnected) lastFocus.focus();
        lastFocus = null;
      }

      document.querySelectorAll('img.cursor-zoom-in').forEach((el) => {
        el.addEventListener('click', () => openLightbox(el));
      });

      box.addEventListener('click', (event) => {
        if (!(event.target instanceof Element)) return;

        if (event.target.hasAttribute('data-lightbox-backdrop') || event.target.closest('[data-lightbox-close]')) {
          closeLightbox();
        }
      });

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeLightbox();
      });
    })();

    // ============================== CONTACT ==============================
    // Ported from the main landing's "Contáctanos" section: same POST
    // /contact contract (honeypot "website" empty, name/email/message).
    // User input only ever touches the DOM via textContent — never
    // innerHTML; the status copy stays warm and blame-free.
    (function wireContactForm() {
      const form = document.getElementById('contact-form');

      if (!form) return;

      const statusEl = document.getElementById('contact-status');
      const submit = form.querySelector('#contact-submit');
      const OK_CLASSES = ['border-emerald-200', 'bg-emerald-50/60', 'text-emerald-900'];
      // Failure keeps the file's existing rose error palette (amber is not
      // part of this landing's theme).
      const FAIL_CLASSES = ['border-rose-200', 'bg-rose-50', 'text-rose-800'];
      const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const GENERIC_ERROR = 'No pudimos enviarlo ahora; puedes reintentar en un momento.';

      function setFieldError(input, message) {
        const box = document.getElementById(input.id + '-error');

        if (!box) return;
        box.textContent = message;
        box.classList.remove('hidden');
      }

      function clearFieldErrors() {
        form.querySelectorAll('[id$="-error"]').forEach((box) => {
          box.textContent = '';
          box.classList.add('hidden');
        });
      }

      function showStatus(message, ok) {
        if (!statusEl) return;

        statusEl.classList.add('hidden');
        statusEl.classList.remove(...OK_CLASSES, ...FAIL_CLASSES);
        statusEl.classList.add(...(ok ? OK_CLASSES : FAIL_CLASSES));
        statusEl.classList.remove('hidden');
        statusEl.textContent = message;
      }

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        clearFieldErrors();

        const nameInput = form.querySelector('[name="name"]');
        const emailInput = form.querySelector('[name="email"]');
        const messageInput = form.querySelector('[name="message"]');
        const honeypot = (form.querySelector('[name="website"]')?.value || '').trim();
        const name = (nameInput?.value || '').trim();
        const email = (emailInput?.value || '').trim();
        const message = (messageInput?.value || '').trim();

        if (name === '') {
          setFieldError(nameInput, 'Escribe tu nombre para saber cómo responderte.');
          nameInput?.focus();
          return;
        }

        if (!EMAIL_RE.test(email)) {
          setFieldError(emailInput, 'Escribe tu correo para que podamos responderte (ejemplo: nombre@correo.cl).');
          emailInput?.focus();
          return;
        }

        if (message === '') {
          setFieldError(messageInput, 'Cuéntanos brevemente en qué te podemos ayudar.');
          messageInput?.focus();
          return;
        }

        // Honeypot filled: a bot is in the field. Pretend success and keep
        // the request — and the table — clean, like the backend does.
        if (honeypot !== '') {
          form.reset();
          showStatus('Gracias. Recibimos tu mensaje; te escribiremos en breve.', true);
          return;
        }

        submit.disabled = true;
        const originalText = submit.textContent;
        submit.textContent = 'Enviando…';

        try {
          const response = await fetch(window.API('/contact'), {
            method: 'POST',
            credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, message, website: '' }),
          });
          const data = await response.json().catch(() => ({}));

          if (response.ok && data && data.success) {
            form.reset();
            showStatus('Gracias. Recibimos tu mensaje; te escribiremos a ' + email + ' en breve.', true);
          } else {
            showStatus(GENERIC_ERROR, false);
          }
        } catch (_) {
          showStatus(GENERIC_ERROR, false);
        } finally {
          submit.disabled = false;
          submit.textContent = originalText;
        }
      });
    })();
  