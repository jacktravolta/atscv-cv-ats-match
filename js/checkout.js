import { apiGet } from './http.js';
import {
  TOPUP_AMOUNTS,
  TOPUP_DEFAULT_AMOUNT,
  clearFieldError,
  collectTopupDocument,
  createTopupOrder,
  setFieldError,
} from './topup.js';
import { openRegisterModal } from './register-modal.js';
// Public checkout: the PACKS are visible to anyone, the PAY is gated by a
// real account.
//
// An anonymous visitor picks a pack and presses the pay button: the
// registration modal opens with the page's own registration form, the
// account is created (the server grants the welcome credits and opens the
// session) and the pay button unlocks right there — no detour to the panel.
//
// The server stays the authority: POST /payments/orders requires a session
// no matter what this front does.

const numberFormat = new Intl.NumberFormat('es-CL');

const PAY_LABEL = 'Ir a pagar';
const REGISTER_LABEL = 'Crear cuenta para pagar';

/**
 * Reads the amount selected by the pack cards, falling back to the default
 * pack for any stale/unknown value.
 *
 * @param {HTMLElement} root
 * @returns {number}
 */
function selectedAmount(root) {
  const input = root.querySelector('[data-checkout-amount]');
  const amount = Number(input && input.value);

  return TOPUP_AMOUNTS.has(amount) ? amount : TOPUP_DEFAULT_AMOUNT;
}

/**
 * Normalizes the session payload coming from the registration form
 * (`{ user, balance }`).
 *
 * @param {object} detail
 * @returns {{ user: object, balance: number|null }}
 */
function normalizeSession(detail) {
  const source = detail && detail.user ? detail : (detail && detail.data ? detail.data : null);

  if (!source || !source.user) {
    return { user: null, balance: null };
  }

  return {
    user: source.user,
    balance: typeof source.balance === 'number' ? source.balance : null,
  };
}

/**
 * Wires one public checkout surface.
 *
 * @param {HTMLElement} root
 */
function initCheckout(root) {
  const options = {
    heart: (root.dataset.checkoutHeart || '').trim(),
    registerFormId: (root.dataset.checkoutRegisterForm || '').trim(),
    registerTitle: root.dataset.checkoutRegisterTitle || 'Crea tu cuenta para pagar',
    registerDescription: root.dataset.checkoutRegisterDescription
      || 'Escribe tu nombre, tu correo y una contraseña. Te acreditamos 100 créditos de bienvenida.',
    walletUrl: (root.dataset.checkoutWalletUrl || '').trim(),
    walletLabel: root.dataset.checkoutWalletLabel || 'Ver mi billetera',
  };

  const amountInput = root.querySelector('[data-checkout-amount]');
  const packsHost = root.querySelector('[data-checkout-packs]');
  const submitButton = root.querySelector('[data-checkout-submit]');
  const labelEl = root.querySelector('[data-checkout-submit-label]') || submitButton;
  const fiscalBox = root.querySelector('[data-checkout-fiscal]');
  const lockHint = root.querySelector('[data-checkout-lock]');
  const balanceHint = root.querySelector('[data-checkout-balance]');
  const notice = root.querySelector('[data-checkout-notice]');
  const errorBox = root.querySelector('[data-checkout-error]');
  const receipt = root.querySelector('[data-checkout-receipt]');

  if (!packsHost || !submitButton) {
    return;
  }

  let session = null;
  let signedIn = false;

  function showNotice(message) {
    if (!notice) return;
    notice.textContent = message;
    notice.classList.remove('hidden');
  }

  function clearNotice() {
    if (!notice) return;
    notice.textContent = '';
    notice.classList.add('hidden');
  }

  function showError(message) {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
  }

  function clearError() {
    if (!errorBox) return;
    errorBox.textContent = '';
    errorBox.classList.add('hidden');
  }

  /**
   * Paints the button + hints for the current session state.
   */
  function paintState() {
    if (signedIn) {
      labelEl.textContent = PAY_LABEL;
      lockHint?.classList.add('hidden');

      if (balanceHint) {
        if (session && typeof session.balance === 'number') {
          balanceHint.textContent = `Tu saldo actual: ${numberFormat.format(session.balance)} créditos.`;
          balanceHint.classList.remove('hidden');
        } else {
          balanceHint.classList.add('hidden');
        }
      }

      return;
    }

    labelEl.textContent = REGISTER_LABEL;
    lockHint?.classList.remove('hidden');
    balanceHint?.classList.add('hidden');
  }

  /**
   * Opens the registration modal (the page's own registration form).
   */
  function openRegistration() {
    const form = options.registerFormId ? document.getElementById(options.registerFormId) : null;

    if (!form) {
      showError('No pudimos abrir el formulario de registro. Recarga la página e inténtalo nuevamente, por favor.');
      return;
    }

    openRegisterModal({
      form,
      title: options.registerTitle,
      description: options.registerDescription,
    });
  }

  /**
   * Shows the receipt of a confirmed top-up (fake provider confirms in
   * place; the real gateway comes back to the wallet panel).
   *
   * @param {object} order
   */
  async function showReceipt(order) {
    if (!receipt) return;

    const credits = Number(order && order.credits ? order.credits : 0);

    try {
      const url = options.heart ? `/auth/me?heart=${encodeURIComponent(options.heart)}` : '/auth/me';
      const me = await apiGet(url);
      session = { user: me.user, balance: typeof me.balance === 'number' ? me.balance : null };
    } catch (error) {
      // The receipt still shows the credited amount: the balance line is a
      // bonus, not the receipt itself.
    }

    receipt.replaceChildren();
    receipt.classList.remove('hidden');

    const card = document.createElement('div');
    card.className = 'rounded-xl border border-emerald-200 bg-emerald-50 p-4';

    const title = document.createElement('p');
    title.className = 'text-sm font-semibold text-emerald-900';
    title.textContent = 'Recarga acreditada';

    const amount = document.createElement('p');
    amount.className = 'mt-1 text-sm text-emerald-800';
    amount.textContent = `Sumamos ${numberFormat.format(credits)} créditos a tu billetera.`;

    card.appendChild(title);
    card.appendChild(amount);

    if (session && typeof session.balance === 'number') {
      const balance = document.createElement('p');
      balance.className = 'mt-1 text-xs text-emerald-700';
      balance.textContent = `Tu saldo actual: ${numberFormat.format(session.balance)} créditos.`;
      card.appendChild(balance);
    }

    const voucher = document.createElement('p');
    voucher.className = 'mt-2 text-xs leading-relaxed text-emerald-700';
    voucher.textContent = 'El comprobante queda disponible en tu billetera.';
    card.appendChild(voucher);

    if (options.walletUrl) {
      const link = document.createElement('a');
      link.href = options.walletUrl;
      link.className = 'mt-3 inline-flex items-center justify-center rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700';
      link.textContent = options.walletLabel;
      card.appendChild(link);
    }

    receipt.appendChild(card);
    paintState();
  }

  /**
   * Creates the order and hands the visitor over to the payment gateway.
   */
  async function startPayment() {
    const amount = selectedAmount(root);
    const { body: documentBody, invalid } = collectTopupDocument('checkout');

    if (invalid.length > 0) {
      for (const field of invalid) {
        const input = document.getElementById(field.id);
        if (input) setFieldError(input, field.message);
      }
      const first = document.getElementById(invalid[0].id);
      if (first) first.focus();
      showError('Revisa los campos marcados en rojo antes de pagar.');
      return;
    }

    clearError();
    clearNotice();
    submitButton.disabled = true;
    labelEl.textContent = 'Abriendo el pago…';

    try {
      const order = await createTopupOrder({
        amount,
        document: documentBody,
        heart: options.heart || null,
      });

      const redirectUrl = typeof order.redirect_url === 'string' ? order.redirect_url : '';

      if (redirectUrl.includes('/payments/fake/confirm')) {
        // Modo prueba: el proveedor confirma aquí mismo (endpoint
        // idempotente, mismas cookies) y el visitante no sale de la página.
        await fetch(redirectUrl, { headers: { Accept: 'application/json' }, credentials: 'include' });
        await showReceipt(order);
        // El botón queda deshabilitado hasta elegir un pack de nuevo (misma
        // regla del panel Billetera).
        labelEl.textContent = PAY_LABEL;
        return;
      }

      // Salimos del sitio hacia la pasarela de pago: navegación real, no una
      // vista del SPA.
      window.location.href = redirectUrl;
    } catch (error) {
      showError(error && error.message
        ? error.message
        : 'No pudimos iniciar el pago. Inténtalo nuevamente en un momento, por favor.');
      submitButton.disabled = false;
      paintState();
    }
  }

  // Pack cards: one selected at a time. The amount lives in the hidden
  // input, exactly like the wallet panel reads it.
  packsHost.addEventListener('click', (event) => {
    const card = event.target instanceof Element ? event.target.closest('button[data-amount]') : null;

    if (!card || !TOPUP_AMOUNTS.has(Number(card.dataset.amount))) return;

    for (const other of packsHost.querySelectorAll('button[data-amount]')) {
      other.setAttribute('aria-pressed', String(other === card));
    }

    if (amountInput) {
      amountInput.value = card.dataset.amount;
    }

    // Elegir un pack de nuevo re-habilita el pago tras un cobro exitoso.
    submitButton.disabled = false;
    receipt?.classList.add('hidden');
    paintState();
  });

  // Factura revela los datos tributarios; boleta los mantiene fuera de la
  // vista para que el formulario siga siendo breve por defecto.
  for (const radio of root.querySelectorAll('input[name="checkout-doc-type"]')) {
    radio.addEventListener('change', () => {
      if (fiscalBox) {
        fiscalBox.classList.toggle('hidden', radio.value !== '33' || !radio.checked);
      }
    });
  }

  // Errores inline del formulario fiscal: al corregir un campo su marca
  // roja desaparece al instante (sin esperar otro submit).
  for (const fiscalId of ['checkout-rut', 'checkout-razon', 'checkout-giro', 'checkout-direccion', 'checkout-comuna', 'checkout-email']) {
    const field = document.getElementById(fiscalId);
    if (field) {
      field.addEventListener('input', () => clearFieldError(field));
    }
  }

  submitButton.addEventListener('click', async () => {
    if (!signedIn) {
      openRegistration();
      return;
    }

    await startPayment();
  });

  // Una cuenta creada en cualquier parte de la página (el modal o el
  // formulario de la landing) desbloquea el pago aquí mismo.
  document.addEventListener('aj:registered', (event) => {
    const next = normalizeSession(event.detail);

    if (!next.user) return;

    session = next;
    signedIn = true;
    paintState();
    showNotice('¡Listo! Tu cuenta quedó creada y acreditamos 100 créditos de bienvenida. Ya puedes pagar tu pack.');
  });

  // Estado inicial: sin sesión el botón pide la cuenta; con sesión, paga
  // directo.
  paintState();

  const url = options.heart ? `/auth/me?heart=${encodeURIComponent(options.heart)}` : '/auth/me';

  apiGet(url)
    .then((me) => {
      session = { user: me.user, balance: typeof me.balance === 'number' ? me.balance : null };
      signedIn = true;
      paintState();
    })
    .catch((error) => {
      // 401 = visitante anónimo (el caso normal de este front). Cualquier
      // otro fallo se explica, pero nunca bloquea la lectura de los packs.
      signedIn = false;
      paintState();

      if (error && error.status && error.status !== 401) {
        showError('No pudimos verificar tu sesión ahora. Si ya tienes cuenta, igual puedes recargar: te pediremos iniciar sesión al pagar.');
      }
    });
}

/**
 * Boots every public checkout surface of the page.
 */
function boot() {
  for (const root of document.querySelectorAll('[data-checkout]')) {
    initCheckout(root);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
