// Registration modal.
//
// The modal MOVES the page's own registration form into it (a DOM move keeps
// the submit wiring, the validation and the error copy) and puts it back
// when it closes. That way the public checkout reuses the very same
// registration form the page already offers — there is no second
// implementation to keep in sync.
//
// Contract with the form: a successful registration is announced with the
// cancelable `aj:registered` event (detail: { user, balance }). While the
// modal is open it consumes that event (preventDefault), so the visitor
// stays where they are — the checkout unlocks the pay button instead of
// navigating to the panel.

const MODAL_ID = 'register-modal';

// One modal per page, reused across openings.
let modal = null;
let state = null;

/**
 * Builds the modal shell (once) and returns it.
 *
 * @returns {HTMLElement|null}
 */
function ensureModal() {
  if (modal && document.body.contains(modal)) {
    return modal;
  }

  const existing = document.getElementById(MODAL_ID);

  if (existing) {
    modal = existing;
    return modal;
  }

  const element = document.createElement('div');
  element.id = MODAL_ID;
  element.className = 'fixed inset-0 z-[60] hidden';
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-modal', 'true');
  element.setAttribute('aria-labelledby', 'register-modal-title');
  element.innerHTML = `
    <div data-register-modal-backdrop class="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"></div>
    <div class="relative flex min-h-full items-center justify-center overflow-y-auto p-4">
      <div class="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h2 id="register-modal-title" class="text-lg font-semibold text-slate-900"></h2>
            <p id="register-modal-description" class="mt-1 text-sm leading-relaxed text-slate-600"></p>
          </div>
          <button type="button" data-register-modal-close aria-label="Cerrar"
                  class="-mr-1 -mt-1 rounded-lg p-2 text-slate-400 transition hover:bg-slate-50 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
        <div data-register-modal-body class="mt-4"></div>
      </div>
    </div>
  `;

  document.body.appendChild(element);
  modal = element;

  return modal;
}

/**
 * Puts the registration form back where it came from.
 */
function restoreForm() {
  if (!state || !state.form) return;

  const { form, home } = state;

  try {
    home.parent.insertBefore(form, home.next);
  } catch (error) {
    // The original anchor is gone (the page changed under us): the form
    // still goes back to its section, just at the end.
    home.parent.appendChild(form);
  }

  form.className = home.className;
  form.hidden = home.hidden;
  state.form = null;
}

/**
 * Closes the modal and restores the page.
 */
function closeModal() {
  if (!state) return;

  const returnFocus = state.returnFocus;

  document.removeEventListener('keydown', onKeydown, true);
  document.removeEventListener('aj:registered', onRegistered, true);
  restoreForm();
  state = null;

  if (modal) {
    modal.classList.add('hidden');
  }

  document.body.style.overflow = '';

  if (returnFocus && typeof returnFocus.focus === 'function') {
    returnFocus.focus({ preventScroll: true });
  }
}

function onKeydown(event) {
  if (event.key === 'Escape') {
    closeModal();
    return;
  }

  if (event.key !== 'Tab' || !modal) {
    return;
  }

  // Focus trap: while the modal is open the keyboard stays inside it, so a
  // screen reader never wanders to the page behind.
  const focusables = modal.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])'
  );

  if (!focusables.length) {
    return;
  }

  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * The registration succeeded: keep the visitor here (the checkout unlocks
 * the pay button) and close the modal.
 *
 * @param {CustomEvent} event
 */
function onRegistered(event) {
  event.preventDefault();
  closeModal();
}

/**
 * Opens the registration modal with the page's own registration form.
 *
 * @param {{ form: HTMLElement, title?: string, description?: string }} options
 */
export function openRegisterModal({ form, title, description }) {
  if (!form) return;

  const shell = ensureModal();

  if (!shell) return;

  const body = shell.querySelector('[data-register-modal-body]');
  const titleEl = shell.querySelector('#register-modal-title');
  const descriptionEl = shell.querySelector('#register-modal-description');

  if (!body) return;

  if (state) {
    // A modal is already open: restore its form before opening a new one.
    closeModal();
  }

  titleEl.textContent = title || 'Crea tu cuenta';
  descriptionEl.textContent = description || '';
  descriptionEl.classList.toggle('hidden', !description);

  state = {
    form,
    home: {
      parent: form.parentNode,
      next: form.nextSibling,
      className: form.className,
      hidden: form.hidden,
    },
    returnFocus: document.activeElement,
  };

  body.appendChild(form);
  form.hidden = false;
  form.classList.remove('hidden');

  shell.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('aj:registered', onRegistered, true);

  shell.querySelector('[data-register-modal-close]')?.addEventListener('click', closeModal);

  shell.querySelector('[data-register-modal-backdrop]')?.addEventListener('click', closeModal);

  const firstField = form.querySelector('input:not([type="hidden"]):not([type="checkbox"]), textarea');

  if (firstField) {
    firstField.focus({ preventScroll: true });
  } else {
    form.focus?.({ preventScroll: true });
  }
}
