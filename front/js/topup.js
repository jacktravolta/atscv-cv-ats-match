import { apiPost, uuidV4 } from './http.js';
// Top-up rules shared by the logged-in wallet panel and the PUBLIC checkout
// (the packs anyone can see, the pay gated by a real account).
//
// One source of truth: the same pack amounts, the same receipt (boleta /
// factura) validation and the same order creation for both surfaces. The
// server stays the authority — this module only avoids sending what the
// server would reject anyway.

/**
 * Valid top-up amounts (CLP) and the default pack.
 */
export const TOPUP_AMOUNTS = new Set([1000, 5000, 10000]);
export const TOPUP_DEFAULT_AMOUNT = 5000;

/**
 * RUT chileno: formato libre de puntos/guiones + dígito verificador
 * módulo 11 (multiplicadores 2..7 cíclicos, DV 0..9/K). Espejo exacto de
 * la regla del servidor (PaymentService::isValidRutCl) para que el
 * formulario avise antes de enviar.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isValidRutCl(value) {
  const clean = String(value || '').toUpperCase().replace(/[\s.\-]/g, '');
  const match = clean.match(/^(\d{7,8})([\dK])$/);

  if (!match) return false;

  const digits = match[1].split('').reverse();
  let sum = 0;
  let multiplier = 2;

  for (const d of digits) {
    sum += Number(d) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }

  const remainder = 11 - (sum % 11);
  const expected = remainder === 11 ? '0' : remainder === 10 ? 'K' : String(remainder);

  return match[2] === expected;
}

/**
 * Marca o limpia el error inline de un campo del formulario fiscal:
 * borde rojo + nota bajo el campo (sin toasts).
 *
 * @param {HTMLInputElement|null} input
 * @param {string} message
 */
export function setFieldError(input, message) {
  if (!input) return;

  clearFieldError(input);
  input.classList.add('border-red-500', 'focus:border-red-500');
  const note = document.createElement('p');
  note.className = 'mt-1 text-[11px] leading-relaxed text-red-600 field-error';
  note.textContent = message;
  const holder = input.closest('label') || input.parentElement;
  if (holder) holder.appendChild(note);
}

/**
 * Quita la marca de error inline del campo (al corregir, desaparece al
 * instante).
 *
 * @param {HTMLInputElement|null} input
 */
export function clearFieldError(input) {
  if (!input) return;

  input.classList.remove('border-red-500', 'focus:border-red-500');
  const holder = input.closest('label') || input.parentElement;
  if (!holder) return;
  const stale = holder.querySelector('.field-error');
  if (stale) stale.remove();
}

/**
 * Validates + collects the document payload for the top-up. Factura (33)
 * requires the fiscal fields WITH format (RUT módulo 11, email plausible,
 * textos completos) — mirrors the server rules 1:1 so the form warns
 * BEFORE sending. Returns per-field errors for inline marking.
 *
 * The prefix names the surface: 'topup' (wallet panel) or 'checkout' (the
 * public checkout). The ids follow the same prefix.
 *
 * @param {string} [prefix]
 * @returns {{ body: object, invalid: Array<{id: string, message: string}> }}
 */
export function collectTopupDocument(prefix = 'topup') {
  const checked = document.querySelector(`input[name="${prefix}-doc-type"]:checked`);
  const documentType = checked ? Number(checked.value) : 46;
  const body = { document_type: documentType };
  const invalid = [];

  if (documentType !== 33) {
    return { body, invalid };
  }

  const fields = {
    buyer_rut: `${prefix}-rut`,
    buyer_razon_social: `${prefix}-razon`,
    buyer_giro: `${prefix}-giro`,
    buyer_direccion: `${prefix}-direccion`,
    buyer_comuna: `${prefix}-comuna`,
    buyer_email: `${prefix}-email`,
  };

  for (const [key, id] of Object.entries(fields)) {
    const input = document.getElementById(id);
    const value = input ? input.value.trim() : '';

    if (value === '') {
      invalid.push({ id, message: 'Este campo es obligatorio para la factura.' });
      continue;
    }

    if (key === 'buyer_rut' && !isValidRutCl(value)) {
      invalid.push({ id, message: 'El RUT no es válido: revisa el dígito verificador (ej: 12.345.678-5).' });
      continue;
    }

    if (key === 'buyer_email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      invalid.push({ id, message: 'El correo no parece válido. Revísalo, por favor.' });
      continue;
    }

    if (key !== 'buyer_email' && key !== 'buyer_rut' && value.length < 3) {
      invalid.push({ id, message: 'Muy corto: escribe el dato completo.' });
      continue;
    }

    body[key] = value;
  }

  return { body, invalid };
}

/**
 * Creates the top-up order (pending) and returns the server payload.
 *
 * The Idempotency-Key header makes replays safe: the same key always
 * returns the original order, never a second charge.
 *
 * @param {{ amount: number, document: object, heart?: string|null }} params
 * @returns {Promise<object>}
 */
export async function createTopupOrder({ amount, document: documentBody, heart }) {
  const body = { amount_clp: amount, ...documentBody };

  // Single-heart surfaces (e.g. ley-datos) bind the order to the wallet they
  // show and spend. The confirmation never re-reads it from the client — the
  // order is the authority.
  if (heart) {
    body.heart = heart;
  }

  return apiPost('/payments/orders', body, { 'Idempotency-Key': uuidV4() });
}
