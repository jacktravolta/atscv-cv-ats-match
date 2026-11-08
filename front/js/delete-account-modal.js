// Account-deletion modal: permanent "Eliminar mi cuenta" confirmation.
//
// Unlike the work-data modal (modules/delete-modal.js), this one demands a
// real typed confirmation: the user must literally write BORRAR in an input,
// matching the backend contract (POST /account/delete requires
// { confirm: "BORRAR" }). A stray click can never destroy an account.
//
// The copy stays warm and honest (empathy principle): exactly what is deleted,
// exactly what is conserved, and no promises beyond that.

const CONFIRM_WORD = 'BORRAR';

/**
 * Open the account-deletion modal.
 *
 * @param {object} options
 * @param {(confirmValue: string, reason: string) => Promise<void>} options.onConfirm
 *        Called with the typed confirmation word and the optional
 *        free-text reason (trimmed; empty when the user skipped it);
 *        resolves on success (the modal then closes itself). Throw to
 *        keep the modal open and show the error inline.
 * @param {() => void} [options.onCancel] Called when the modal is dismissed.
 * @returns {void}
 */
export function showDeleteAccountModal({ onConfirm, onCancel }) {
  if (document.getElementById('delete-account-modal')) {
    return;
  }

  const modalHtml = `
        <div id="delete-account-modal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 sm:p-6">
            <div role="dialog" aria-modal="true" aria-labelledby="delete-account-modal-title"
                 class="bg-white rounded-xl w-full max-w-md max-h-[85vh] overflow-y-auto p-6 sm:p-8 shadow-2xl border border-rose-200">
                <div class="flex items-start justify-between mb-4">
                    <div>
                        <h2 id="delete-account-modal-title" class="text-2xl font-bold text-rose-700 mb-1">Eliminar mi cuenta</h2>
                        <p class="text-sm text-rose-600">Esta acción es irreversible</p>
                    </div>
                    <button
                        id="delete-account-modal-close"
                        type="button"
                        class="p-2 rounded-full hover:bg-rose-50 transition-colors"
                        aria-label="Cerrar sin eliminar"
                    >
                        <svg class="w-5 h-5 text-rose-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                        </svg>
                    </button>
                </div>

                <div class="space-y-3 text-slate-600">
                    <p class="text-sm">
                        Antes de decidir, esto es lo que ocurre si confirmas — con cariño y sin sorpresas:
                    </p>

                    <ul class="text-sm space-y-2">
                        <li>
                            <span class="font-medium text-slate-700">Se elimina todo:</span>
                            tu cuenta, tu base de conocimiento, tus documentos,
                            tus conversaciones y el historial completo de tu saldo.
                        </li>
                        <li>
                            <span class="font-medium text-slate-700">No hay vuelta atrás:</span>
                            nada de esto se puede recuperar después.
                        </li>
                        <li>
                            <span class="font-medium text-slate-700">Se conserva un registro mínimo de bajas:</span>
                            tu correo, tu nombre, tu teléfono y — si lo escribiste — tu motivo,
                            para fines internos del servicio. Es lo único que queda
                            con tus datos; el resto se elimina. Además, una versión
                            cifrada (hash) de tu correo hace que, si vuelves a
                            registrarte con el mismo correo, el bono de bienvenida
                            no se entregue de nuevo.
                        </li>
                        <li>
                            <span class="font-medium text-slate-700">Tu derecho:</span>
                            si quieres una copia de tus datos, solicítala
                            <strong class="font-semibold">antes</strong> de eliminar la
                            cuenta; después no quedará nada que copiar.
                        </li>
                    </ul>

                    <p class="text-sm">
                        Para confirmar, escribe <span class="font-semibold text-rose-700">BORRAR</span> abajo:
                    </p>

                    <input
                        id="delete-account-modal-confirm-input"
                        type="text"
                        autocomplete="off"
                        spellcheck="false"
                        placeholder="BORRAR"
                        aria-label="Escribe BORRAR para confirmar la eliminación de tu cuenta"
                        class="w-full rounded-xl border border-rose-300 bg-rose-50/50 px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-rose-500 focus:ring-2 focus:ring-rose-100"
                    />
                </div>

                <div class="pt-3">
                    <label for="account-delete-reason" class="text-sm font-medium text-slate-700 block mb-1">
                        ¿Quieres contarnos el motivo? (totalmente opcional)
                    </label>
                    <textarea
                        id="account-delete-reason"
                        rows="3"
                        maxlength="1000"
                        placeholder="(opcional) ¿Hubo algo que no funcionó para ti?"
                        class="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                    ></textarea>
                </div>

                <div class="space-y-3 pt-4 border-t border-rose-100 mt-4">
                    <p id="delete-account-modal-status" class="hidden text-sm text-slate-500" role="status" aria-live="polite">
                        Eliminando tu cuenta y tus datos… un momento.
                    </p>

                    <p id="delete-account-modal-error" class="hidden text-sm text-rose-700" role="alert"></p>

                    <button
                        id="delete-account-modal-cancel"
                        type="button"
                        class="w-full py-2 px-4 rounded-lg text-sm font-medium text-slate-700 bg-slate-50 hover:bg-slate-100 transition-colors"
                    >
                        Mejor no, volvamos
                    </button>

                    <button
                        id="delete-account-modal-confirm"
                        type="button"
                        class="w-full py-2 px-4 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-700 transition-colors disabled:opacity-60"
                        aria-label="Eliminar mi cuenta de forma permanente"
                    >
                        Eliminar mi cuenta
                    </button>
                </div>
            </div>
        </div>
    `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  const modal = document.getElementById('delete-account-modal');
  const input = document.getElementById('delete-account-modal-confirm-input');
  const reasonBox = document.getElementById('account-delete-reason');
  const confirmButton = document.getElementById('delete-account-modal-confirm');
  const cancelButton = document.getElementById('delete-account-modal-cancel');
  const closeButton = document.getElementById('delete-account-modal-close');
  const statusBox = document.getElementById('delete-account-modal-status');
  const errorBox = document.getElementById('delete-account-modal-error');

  if (!modal || !input || !confirmButton || !cancelButton || !closeButton || !statusBox || !errorBox) {
    return;
  }

  const close = () => {
    modal.remove();
    document.removeEventListener('keydown', handleEscape);
  };

  const stillOpen = () => document.getElementById('delete-account-modal') === modal;

  const leave = () => {
    close();
    if (onCancel) {
      onCancel();
    }
  };

  function handleEscape(event) {
    if (event.key === 'Escape' && stillOpen()) {
      leave();
    }
  }

  const confirm = async () => {
    const typed = input.value.trim();

    if (typed !== CONFIRM_WORD) {
      // Honest guard: only the exact word unlocks the deletion.
      errorBox.textContent = 'Escribe BORRAR (en mayúsculas) para confirmar. Tómate el tiempo que necesites.';
      errorBox.classList.remove('hidden');
      return;
    }

    errorBox.classList.add('hidden');

    // One-way door: freeze the controls while the deletion runs.
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    closeButton.disabled = true;
    input.readOnly = true;
    if (reasonBox) {
      reasonBox.readOnly = true;
    }
    statusBox.classList.remove('hidden');

    try {
      // The reason is optional: skipped → empty string (the backend stores
      // NULL for both absent key and empty).
      await onConfirm(typed, reasonBox ? reasonBox.value.trim() : '');
      close();
    } catch (error) {
      errorBox.textContent =
        error && error.message
          ? error.message
          : 'No pudimos eliminar tu cuenta ahora. Elige "Mejor no, volvamos" o inténtalo más tarde.';
      errorBox.classList.remove('hidden');
      statusBox.classList.add('hidden');

      confirmButton.disabled = false;
      cancelButton.disabled = false;
      closeButton.disabled = false;
      input.readOnly = false;
      if (reasonBox) {
        reasonBox.readOnly = false;
      }
    }
  };

  closeButton.addEventListener('click', leave);
  cancelButton.addEventListener('click', leave);
  confirmButton.addEventListener('click', confirm);

  // Enter in the input triggers the confirmation attempt.
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      confirm();
    }
  });

  document.addEventListener('keydown', handleEscape);

  // Focus management: opening focus lands on the input (the decision point).
  input.focus();
}
