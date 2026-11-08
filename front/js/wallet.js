import { apiGet as httpGet } from './http.js';
import {
  TOPUP_AMOUNTS,
  TOPUP_DEFAULT_AMOUNT,
  clearFieldError,
  collectTopupDocument,
  createTopupOrder,
  setFieldError,
} from './topup.js';
// Wallet panel: balance, movements, and active tariffs.
//
// The transport (http.js) and the top-up rules (topup.js) are shared with
// the PUBLIC checkout (the packs anyone can see): both surfaces validate
// the receipt data and create orders exactly the same way.
//
// Tokens live exclusively in httpOnly cookies set by the server, so every
// fetch below is a plain same-origin request — no token handling here.
// The SPA calls initWallet() once at startup.

const PAGE_SIZE = 10;

const TYPE_LABELS = {
  WELCOME_CREDIT: 'Bienvenida',
  PURCHASE_CREDIT: 'Recarga',
  USAGE_DEBIT: 'Uso del servicio',
  REFUND: 'Reembolso',
  ADMIN_ADJUSTMENT: 'Ajuste manual',
};

const numberFormat = new Intl.NumberFormat('es-CL');

/**
 * Last balance value actually rendered on screen. The topup celebration
 * animates FROM this number TO the credited one; null means "no previous
 * render" (first boot), which never animates.
 */
let lastDisplayedBalance = null;

// The wallet is per heart: the movements list follows the heart the user is
// viewing (same source notifications.js uses). Empty = installation heart.
function activeHeart() {
  return (localStorage.getItem('heart_id') || '').trim();
}

function heartQuery(separator) {
  const heart = activeHeart();

  return heart !== '' ? `${separator}heart=${encodeURIComponent(heart)}` : '';
}

// Override del heart de la billetera fijado por la VISTA: el panel de un solo
// heart (p. ej. ley-datos) lo define en su script de arranque, ANTES de que
// showPanel importe este módulo. Vacío/indefinido = sin override: el SPA
// principal no lo define y sus requests quedan exactamente como hoy.
function walletHeart() {
  const heart = typeof window.WALLET_HEART === 'string' ? window.WALLET_HEART.trim() : '';

  return heart !== '' ? heart : null;
}

// Agrega (o reemplaza, si heartQuery ya puso el del localStorage) el
// parámetro heart en una URL de billetera. Sin override la URL se devuelve
// intacta — byte a byte igual que antes.
function withHeart(url) {
  const heart = walletHeart();

  if (!heart) {
    return url;
  }

  const separatorAt = url.indexOf('?');
  const base = separatorAt === -1 ? url : url.slice(0, separatorAt);
  const query = separatorAt === -1 ? '' : url.slice(separatorAt + 1);
  const params = new URLSearchParams(query);

  params.set('heart', heart);

  return `${base}?${params.toString()}`;
}

let offset = 0;
let isInitialized = false;

// Última recarga creada en este navegador: si el pago quedó confirmado, el
// voucher se muestra al volver a la vista Billetera (tras el retorno real
// del gateway o al reabrir el panel). Expira en 24 h para no consultar
// comprobantes viejos para siempre.
const LAST_ORDER_KEY = 'ld_last_topup_order';
const LAST_ORDER_TTL_MS = 24 * 60 * 60 * 1000;

function rememberLastOrder(orderId) {
  try {
    localStorage.setItem(LAST_ORDER_KEY, JSON.stringify({ id: orderId, at: Date.now() }));
  } catch (storageError) {
    // Sin localStorage el voucher sigue accesible desde los movimientos.
  }
}

function lastOrderCandidate() {
  try {
    const raw = localStorage.getItem(LAST_ORDER_KEY);

    if (!raw) return null;

    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed.id !== 'string' || parsed.id === '') return null;
    if (typeof parsed.at !== 'number' || Date.now() - parsed.at > LAST_ORDER_TTL_MS) {
      localStorage.removeItem(LAST_ORDER_KEY);
      return null;
    }

    return parsed.id;
  } catch (storageError) {
    return null;
  }
}

function forgetLastOrder() {
  try {
    localStorage.removeItem(LAST_ORDER_KEY);
  } catch (storageError) {
    // Nada que hacer: la vista ya no lo consultará.
  }
}

/**
 * Friendly Spanish label for a movement type.
 *
 * @param {string} type
 * @returns {string}
 */
function typeLabel(type) {
  return TYPE_LABELS[type] || type;
}

/**
 * Formats an ISO timestamp for display in Chile time.
 *
 * @param {string} value
 * @returns {string}
 */
function formatDate(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('es-CL', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Santiago',
  }).format(date);
}

/**
 * Renders the balance card.
 *
 * @param {{ balance: number, updated_at: string|null }} data
 */
function renderBalance(data) {
  // The header balance pill (`#balance`) lives in the main SPA only: the
  // ley-datos panel dropped it in favor of the avatar menu (owner redesign,
  // commit 640d36a), whose saldo display is its single source of truth. A
  // null here means the surface has no such element — skip the write
  // instead of crashing with "Cannot set properties of null".
  const balanceEl = document.getElementById('balance');
  if (balanceEl) balanceEl.textContent = numberFormat.format(Number(data.balance));

  // Same shared-module contract as #balance above: these meta lines only
  // exist on some surfaces. A missing element is skipped, never a crash.
  const updated = document.getElementById('balance-updated');
  const hint = document.getElementById('balance-hint');

  if (data.updated_at) {
    if (updated) updated.textContent = `Actualizado ${formatDate(data.updated_at)}`;
    if (hint) hint.textContent = 'Tu saldo nunca puede quedar en negativo: cada cargo se valida antes de aplicarse.';
  } else {
    if (updated) updated.textContent = '';
    if (hint) hint.textContent = 'Aún no tienes movimientos. Cuando recargues créditos o uses el servicio, aparecerán aquí.';
  }

  // El panel de ley-datos escucha este evento: re-consulta /auth/me (su
  // fuente heart-correcta) en vez de que su guard revierta el número al
  // valor congelado del boot tras una recarga.
  document.dispatchEvent(new CustomEvent('wallet:balance-updated', { detail: { balance: Number(data.balance) } }));

  // Remember the last rendered value: the topup celebration animates
  // FROM this number TO the credited one (no fake movement when they
  // match, no animation before the first render).
  lastDisplayedBalance = Number(data.balance);
}

/**
 * Renders one movement row. PURCHASE_CREDIT rows carry their payment order
 * reference (operation_id 'order:<uuid>'): they become clickable and open
 * the movement's voucher.
 *
 * @param {object} movement
 * @returns {HTMLTableRowElement}
 */
function movementRow(movement) {
  const row = document.createElement('tr');

  const amount = Number(movement.amount);
  const amountClass = amount < 0 ? 'text-rose-600' : 'text-emerald-600';
  const amountText = `${amount >= 0 ? '+' : '−'}${numberFormat.format(Math.abs(amount))}`;

  const cells = [
    { text: formatDate(movement.created_at), class: 'text-slate-500' },
    { text: typeLabel(movement.type), class: 'text-slate-800' },
    { text: amountText, class: `${amountClass} text-right` },
    { text: numberFormat.format(Number(movement.balance_after)), class: 'text-slate-600 text-right' },
  ];

  for (const cell of cells) {
    const td = document.createElement('td');
    td.className = `px-4 py-3 ${cell.class}`;
    td.textContent = cell.text;
    row.appendChild(td);
  }

  const orderId = movementOrderId(movement);

  if (orderId) {
    row.dataset.orderId = orderId;
    row.classList.add('cursor-pointer', 'transition', 'hover:bg-slate-50');
    row.title = 'Ver el comprobante de esta recarga';
  }

  return row;
}

/**
 * Extracts the payment order id from a movement, when it has one.
 *
 * @param {object} movement
 * @returns {string|null}
 */
function movementOrderId(movement) {
  if (movement.type !== 'PURCHASE_CREDIT') return null;

  const operation = typeof movement.operation_id === 'string' ? movement.operation_id : '';

  return operation.startsWith('order:') ? operation.slice('order:'.length) || null : null;
}

/**
 * Renders the movements table and pagination state.
 *
 * @param {object} data
 */
function renderMovements(data) {
  const body = document.getElementById('movements-body');
  const empty = document.getElementById('movements-empty');
  const prev = document.getElementById('movements-prev');
  const next = document.getElementById('movements-next');

  body.textContent = '';

  if (data.movements.length === 0) {
    empty.classList.remove('hidden');
    prev.disabled = true;
    next.disabled = true;
    return;
  }

  empty.classList.add('hidden');

  for (const movement of data.movements) {
    body.appendChild(movementRow(movement));
  }

  prev.disabled = offset === 0;
  next.disabled = data.movements.length < PAGE_SIZE;
}

/**
 * Renders the active tariffs table.
 *
 * @param {Array<{ operation: string, credits_cost: number, token_limit: number|null }>} tariffs
 */
function renderTariffs(tariffs) {
  const body = document.getElementById('tariffs-body');
  const empty = document.getElementById('tariffs-empty');

  body.textContent = '';

  if (!tariffs || tariffs.length === 0) {
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  for (const tariff of tariffs) {
    const row = document.createElement('tr');

    const operation = document.createElement('td');
    operation.className = 'px-4 py-3 text-slate-800';
    operation.textContent = tariff.operation;

    const cost = document.createElement('td');
    cost.className = 'px-4 py-3 text-right text-slate-800';
    cost.textContent = numberFormat.format(Number(tariff.credits_cost));

    const limit = document.createElement('td');
    limit.className = 'px-4 py-3 text-right text-slate-500';
    limit.textContent = tariff.token_limit === null ? 'Sin límite' : numberFormat.format(Number(tariff.token_limit));

    row.appendChild(operation);
    row.appendChild(cost);
    row.appendChild(limit);
    body.appendChild(row);
  }
}

/**
 * Shows a kind error message.
 *
 * @param {string} message
 */
function showError(message) {
  const box = document.getElementById('wallet-error');
  box.textContent = message;
  box.classList.remove('hidden');
}

/**
 * Performs a same-origin JSON GET and returns the payload data.
 *
 * @param {string} url
 * @returns {Promise<object>}
 */
async function apiGet(url) {
  return httpGet(url, {
    fallbackMessage: 'No pudimos cargar tu billetera en este momento. Inténtalo nuevamente.',
  });
}

/**
 * Recarga por packs: montos válidos y pack por defecto (Pack 2 · Constante,
 * el antiguo default del select). Si un valor viejo reaparece (p. ej. el
 * monto intermedio retirado 2000), vuelve al pack por defecto en vez de
 * enviar un monto que ya no existe. Los montos viven en topup.js, el módulo
 * compartido con el checkout público.
 */

/**
 * Reads the amount selected by the pack cards (kept in #topup-amount),
 * falling back to the default pack for any stale/unknown value.
 */
function selectedTopupAmount() {
  const input = document.getElementById('topup-amount');
  const amount = Number(input && input.value);

  return TOPUP_AMOUNTS.has(amount) ? amount : TOPUP_DEFAULT_AMOUNT;
}

/**
 * Único escritor del estado disabled del botón de pago. Tras un pago
 * confirmado el botón queda deshabilitado hasta que el usuario elija un
 * pack de nuevo (decisión del dueño, 2026-10-22).
 */
function setTopupSubmitDisabled(disabled) {
  const button = document.getElementById('topup-submit');

  if (button) {
    button.disabled = disabled;
  }
}

/**
 * Creates the top-up order and redirects to the provider's payment page.
 * In fake mode the confirmation runs in place (same idempotent endpoint the
 * gateway page calls): the user never leaves the wallet view.
 */
/**
 * Eases the count-up so the number starts fast and settles gently.
 */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Counts one balance element up from `from` to `to`. Respects
 * prefers-reduced-motion (jumps straight to the final value). Numbers stay
 * in the es-CL format the panel already uses.
 */
function animateBalanceNumber(el, from, to) {
  const reduced = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduced || from === null || from === to) {
    el.textContent = numberFormat.format(to);
    return;
  }

  const start = performance.now();
  const DURATION_MS = 1200;

  const step = (now) => {
    const progress = Math.min(1, (now - start) / DURATION_MS);
    const value = Math.round(from + (to - from) * easeOutCubic(progress));
    el.textContent = numberFormat.format(value);
    if (progress < 1) {
      requestAnimationFrame(step);
    }
  };

  requestAnimationFrame(step);
}

/**
 * One floating "+N créditos" chip per big balance card: appears with the
 * count-up, fades out, removes itself. aria-hidden (the number itself is
 * the accessible signal); respects prefers-reduced-motion (skipped).
 */
function showGainedChip(host, gained) {
  const reduced = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduced || gained <= 0 || !host) {
    return;
  }

  const chip = document.createElement('span');
  chip.textContent = `+${numberFormat.format(gained)} créditos`;
  chip.setAttribute('aria-hidden', 'true');
  chip.className = 'pointer-events-none absolute right-5 top-4 rounded-full bg-white/15 px-3 py-1 text-sm font-semibold text-white shadow transition-opacity duration-700';
  chip.style.opacity = '1';

  const card = host.closest('section') || host.parentElement;

  if (!card) {
    return;
  }

  if (getComputedStyle(card).position === 'static') {
    card.style.position = 'relative';
  }

  card.appendChild(chip);
  setTimeout(() => {
    chip.style.opacity = '0';
  }, 1400);
  setTimeout(() => {
    chip.remove();
  }, 2200);
}

/**
 * Payment sound through the shared sounds module. Dynamic import with its
 * own catch: a missing/blocked module is silence, never a broken payment.
 *
 * @param {'coins'|'failure'} kind
 */
function playPaymentCue(kind) {
  import('./sounds.js?v=2')
    .then((m) => {
      if (kind === 'coins') {
        m.playCoins();
      } else {
        m.playFailureCue();
      }
    })
    .catch(() => {});
}

/**
 * The topup celebration: scroll to the balance title, count the credited
 * amount up in place, float the "+N" chip, and play the coins cue.
 * Reduced motion users get the final value without the theater.
 */
function celebrateBalance(prev, next) {
  for (const id of ['wallet-balance', 'balance']) {
    const el = document.getElementById(id);

    if (!el) {
      continue;
    }

    animateBalanceNumber(el, prev, next);

    const card = el.closest('section') || el.parentElement;

    if (card && typeof card.scrollIntoView === 'function') {
      const reduced = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      card.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
    }

    showGainedChip(el, next - (prev === null ? next : prev));
  }

  const mobile = document.getElementById('mobile-balance');

  if (mobile) {
    mobile.textContent = `${numberFormat.format(next)} créditos`;
  }

  playPaymentCue('coins');
}

async function submitTopup() {
  const amount = selectedTopupAmount();
  const { body: documentBody, invalid } = collectTopupDocument();

  if (invalid.length > 0) {
    // Marcar cada campo con su error inline y enfocar el primero: el
    // formulario avisa ANTES de enviar nada al servidor.
    for (const f of invalid) {
      const input = document.getElementById(f.id);
      if (input) setFieldError(input, f.message);
    }
    const first = document.getElementById(invalid[0].id);
    if (first) first.focus();
    showError('Revisa los campos marcados en rojo antes de pagar.');
    return;
  }

  setTopupSubmitDisabled(true);
  let orderCreated = false;
  // Un pago confirmado deja el botón deshabilitado hasta elegir un pack de
  // nuevo (decisión del dueño); errores y salida al gateway re-habilitan.
  let paidInPlace = false;
  // Feedback inmediato en la tarjeta del comprobante mientras corre la
  // orden + confirmación + recarga de datos (el botón deshabilitado solo
  // no explica la espera).
  setVoucherPending('Procesando tu pago…', { spinner: true });

  try {
    const order = await createTopupOrder({
      amount,
      document: documentBody,
      heart: walletHeart(),
    });

    rememberLastOrder(order.order_id);
    orderCreated = true;

    const redirectUrl = typeof order.redirect_url === 'string' ? order.redirect_url : '';

    if (redirectUrl.includes('/payments/fake/confirm')) {
      // Modo prueba: confirmar aquí mismo (endpoint idempotente, mismas
      // cookies) y quedarse en esta vista. El saldo cuenta hacia arriba en
      // vivo y el comprobante aparece 2 s después del efecto: primero el
      // número, después el papel (flujo pedido por el dueño).
      await fetch(redirectUrl, { headers: { Accept: 'application/json' }, credentials: 'include' });
      paidInPlace = true;
      const prevBalance = lastDisplayedBalance;
      offset = 0;
      await loadAll();
      celebrateBalance(prevBalance, lastDisplayedBalance);
      setTimeout(() => {
        showVoucher(order.order_id, { fromStorage: true, noticeOnError: true, reveal: true });
      }, 2000);
      return;
    }

    window.location.href = redirectUrl;
  } catch (err) {
    showError(err.message);

    if (orderCreated) {
      // La orden existe: el pago todavía puede confirmar — aviso ámbar de
      // espera, NUNCA una tarjeta de fallo (no sabemos que falló).
      setVoucherPending('No pudimos confirmar el pago todavía: ' + err.message, { tone: 'error' });
    } else {
      // Nada se creó: la transacción no ocurrió. Comprobante rojo + sonido
      // amable; el dinero nunca se movió (no hubo orden que cobrar).
      playPaymentCue('failure');
      showFailedVoucherCard(err.message, null);
    }
  } finally {
    // Tras un pago confirmado el botón queda deshabilitado: para volver a
    // pagar hay que elegir un pack de nuevo. En error (o salida al gateway,
    // donde la página se va de todos modos) se re-habilita el formulario.
    if (!paidInPlace) {
      setTopupSubmitDisabled(false);
    }
  }
}

/**
 * Fetches and renders the voucher of one order. With fromStorage the last
 * order marker is cleared once the payment shows APPROVED (before that the
 * marker stays so the next visit retries). With reveal (the just-finished
 * top-up) the rendered card is scrolled into view and focused.
 *
 * @param {string} orderId
 * @param {{ fromStorage?: boolean, noticeOnError?: boolean, reveal?: boolean }} [options]
 */
async function showVoucher(orderId, options = {}) {
  try {
    const voucher = await apiGet(`/payments/orders/${encodeURIComponent(orderId)}/voucher`);

    if (voucher.status === 'APPROVED') {
      renderVoucher(voucher, { reveal: options.reveal === true });

      if (options.fromStorage) {
        forgetLastOrder();
        // Pago recién confirmado (retorno del gateway): el botón queda
        // deshabilitado hasta que se elija un pack de nuevo.
        setTopupSubmitDisabled(true);
      }

      // Return-from-gateway completion: the balance credited while the user
      // was away. Celebrate with the number they HAD before this refresh
      // (captured in loadAll before renderBalance). No-op when equal.
      if (typeof options.celebrate === 'number') {
        celebrateBalance(options.celebrate, lastDisplayedBalance);
      }

      return;
    }

    // Final failures (gateway rejected/canceled the payment): honest red
    // receipt. The cue only plays on LIVE completions (reveal/fromStorage),
    // never when re-reading an old voucher from the movements table.
    if (voucher.status === 'REJECTED' || voucher.status === 'CANCELED' || voucher.status === 'FAILED') {
      renderFailedVoucher(voucher);

      if (options.reveal || options.fromStorage) {
        playPaymentCue('failure');
      }

      if (options.fromStorage) {
        forgetLastOrder();
      }

      return;
    }

    // Pago aún sin confirmar: estado visible en la tarjeta (sin spinner
    // eterno — el marcador persiste para reintentar en la próxima visita).
    if (options.noticeOnError) {
      setVoucherPending('Esperando confirmación del pago…');
    }
  } catch (err) {
    if (options.fromStorage) {
      // La orden ya no existe o no es propia: dejar de consultarla.
      forgetLastOrder();
      if (options.noticeOnError) {
        setVoucherPending('No pudimos cargar el comprobante todavía. Revisa tus movimientos en unos minutos.', { tone: 'error' });
      }
    }
  }
}

/**
 * Red failure receipt: the transaction did not go through. Kind, zero-blame
 * copy (empathy principle): state what happened, what did NOT happen (no
 * charge), and the next step. Used both for final gateway failures (with
 * the order data) and pre-order errors (reason only).
 *
 * @param {string} reason
 * @param {object|null} voucher null when no order was ever created
 */
/**
 * Diagonal watermark behind the voucher data ("Aprobado"/"Rechazado"):
 * decorative — title, colors and the Estado row already carry the verdict
 * for assistive tech, so the mark is aria-hidden and non-interactive.
 */
function voucherWatermark(label, toneClass) {
  const mark = document.createElement('span');

  mark.setAttribute('aria-hidden', 'true');
  mark.className = 'pointer-events-none absolute inset-0 -z-10 flex select-none items-center justify-center text-6xl font-black uppercase tracking-widest opacity-10 sm:text-7xl ' + toneClass;
  mark.style.transform = 'rotate(-18deg)';
  mark.textContent = label;

  return mark;
}

function renderFailedVoucher(voucher) {
  const card = document.getElementById('topup-voucher');

  if (!card) return;

  // Stacking context: the -z-10 watermark paints above the card background
  // but below the voucher data.
  card.classList.add('relative', 'isolate', 'overflow-hidden');

  const statusLabel = voucher.status === 'CANCELED'
    ? 'Anulado'
    : (voucher.status === 'REJECTED' ? 'Rechazado por el medio de pago' : 'Fallido');

  const title = document.createElement('h3');
  title.className = 'text-lg font-semibold text-rose-900';
  title.textContent = 'No se pudo realizar la transacción';

  const subtitle = document.createElement('p');
  subtitle.className = 'mt-1 text-sm leading-relaxed text-rose-800';
  subtitle.textContent = `El pago quedó como "${statusLabel}" y no se realizó ningún cobro. Vuelve a intentarlo cuando quieras; si el problema persiste, escríbenos y lo revisamos contigo.`;

  const list = document.createElement('dl');
  list.className = 'mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2';

  const rows = [
    ['Fecha', formatDate(voucher.created_at)],
    ['Monto intentado', `$${numberFormat.format(Number(voucher.amount_clp))} CLP`],
    ['Estado', statusLabel],
  ];

  for (const [label, value] of rows) {
    const term = document.createElement('dt');
    term.className = 'text-xs font-medium uppercase tracking-wide text-rose-700/80';
    term.textContent = label;

    const detail = document.createElement('dd');
    detail.className = 'break-words text-sm text-slate-800';
    detail.textContent = value;

    const item = document.createElement('div');
    item.className = 'flex flex-col';
    item.append(term, detail);
    list.append(item);
  }

  const watermark = voucherWatermark(voucher.status === 'CANCELED' ? 'Anulado' : 'Rechazado', 'text-rose-700');

  card.replaceChildren(watermark, title, subtitle, list);
  card.classList.remove('hidden');
  card.classList.remove('border-emerald-200', 'bg-emerald-50/60', 'border-amber-300', 'bg-amber-50/60');
  card.classList.add('border-rose-300', 'bg-rose-50');
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/**
 * Pre-order failure (validation/network): no order was ever created, so
 * there is no voucher to read — a red inline card with the reason.
 *
 * @param {string} reason
 */
function showFailedVoucherCard(reason) {
  const card = document.getElementById('topup-voucher');

  if (!card) return;

  const title = document.createElement('h3');
  title.className = 'text-lg font-semibold text-rose-900';
  title.textContent = 'No se pudo realizar la transacción';

  const body = document.createElement('p');
  body.className = 'mt-2 text-sm leading-relaxed text-rose-800';
  body.textContent = `Tu dinero no se movió: no hubo ningún cobro. Vuelve a intentarlo cuando quieras.${reason ? ' Detalle: ' + reason : ''}`;

  card.replaceChildren(title, body);
  card.classList.remove('hidden');
  card.classList.remove('border-emerald-200', 'bg-emerald-50/60', 'border-amber-300', 'bg-amber-50/60');
  card.classList.add('border-rose-300', 'bg-rose-50');
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/**
 * Puts the voucher card in a transient state while there is no data to
 * render yet: spinner while the payment is processing, plain notice while
 * waiting for confirmation, amber note on failure. renderVoucher later
 * replaces the whole content.
 *
 * @param {string} message
 * @param {{ spinner?: boolean, tone?: 'neutral'|'error' }} [options]
 */
function setVoucherPending(message, options = {}) {
  const card = document.getElementById('topup-voucher');

  if (!card) return;

  const row = document.createElement('div');
  row.className = options.tone === 'error'
    ? 'flex items-center gap-3 text-amber-800'
    : 'flex items-center gap-3 text-slate-700';

  if (options.spinner) {
    const spin = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    spin.setAttribute('class', 'h-5 w-5 animate-spin text-brand-600');
    spin.setAttribute('viewBox', '0 0 24 24');
    spin.setAttribute('fill', 'none');
    spin.setAttribute('aria-hidden', 'true');
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('class', 'opacity-25');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '10');
    circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '4');
    const arc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arc.setAttribute('class', 'opacity-75');
    arc.setAttribute('fill', 'currentColor');
    arc.setAttribute('d', 'M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z');
    spin.append(circle, arc);
    row.append(spin);
  }

  const label = document.createElement('span');
  label.className = 'text-sm font-medium';
  label.textContent = message;
  row.append(label);

  card.replaceChildren(row);
  card.classList.remove('hidden');
  card.classList.remove('border-rose-300', 'bg-rose-50');
  card.classList.toggle('border-amber-300', options.tone === 'error');
  card.classList.toggle('bg-amber-50/60', options.tone === 'error');
  card.classList.toggle('border-emerald-200', options.tone !== 'error');
  card.classList.toggle('bg-emerald-50/60', options.tone !== 'error');
}

/**
 * Renders the inline voucher card (payment + document data). With the
 * reveal option (the top-up that JUST finished) the card is scrolled into
 * view and focused so the user lands on their comprobante without looking
 * for it; the movements-click path renders silently in place.
 *
 * @param {object} voucher
 * @param {{ reveal?: boolean }} [options]
 */
function renderVoucher(voucher, options = {}) {
  const card = document.getElementById('topup-voucher');

  if (!card) return;

  const isFactura = Number(voucher.document_type) === 33;
  const rows = [
    ['Fecha', formatDate(voucher.created_at)],
    ['Monto', `$${numberFormat.format(Number(voucher.amount_clp))} CLP`],
    ['Créditos acreditados', numberFormat.format(Number(voucher.credits))],
    ['Documento', isFactura ? 'Factura electrónica' : 'Boleta electrónica'],
    ['Folio', voucher.folio ? String(voucher.folio) : 'En emisión'],
    ['Estado del pago', voucher.status === 'APPROVED' ? 'Aprobado' : String(voucher.status)],
  ];

  if (voucher.invoice_status) {
    const invoiceState = voucher.invoice_status === 'EMITTED'
      ? 'Emitida'
      : (voucher.invoice_status === 'FAILED' ? 'Con problemas — lo estamos revisando' : 'En emisión');
    rows.push([`Estado de la ${isFactura ? 'factura' : 'boleta'}`, invoiceState]);
  }

  if (isFactura) {
    rows.push(
      ['RUT', String(voucher.buyer_rut || '')],
      ['Razón social', String(voucher.buyer_razon_social || '')],
      ['Giro', String(voucher.buyer_giro || '')],
      ['Dirección', `${String(voucher.buyer_direccion || '')}, ${String(voucher.buyer_comuna || '')}`],
      ['Correo de contacto', String(voucher.buyer_email || '')],
    );
  }

  const title = document.createElement('h3');
  title.className = 'text-lg font-semibold text-emerald-900';
  title.textContent = 'Comprobante de tu recarga';

  const subtitle = document.createElement('p');
  subtitle.className = 'mt-1 text-xs leading-relaxed text-emerald-800';
  subtitle.textContent = `Orden ${String(voucher.order_id).slice(0, 8)}… · También queda en tus movimientos de recarga.`;

  const list = document.createElement('dl');
  list.className = 'mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2';

  for (const [label, value] of rows) {
    const term = document.createElement('dt');
    term.className = 'text-xs font-medium uppercase tracking-wide text-emerald-700/80';
    term.textContent = label;

    const detail = document.createElement('dd');
    detail.className = 'break-words text-sm text-slate-800';
    detail.textContent = value;

    const item = document.createElement('div');
    item.className = 'flex flex-col';
    item.append(term, detail);
    list.append(item);
  }

  card.classList.add('relative', 'isolate', 'overflow-hidden');
  card.replaceChildren(voucherWatermark('Aprobado', 'text-emerald-700'), title, subtitle, list);
  card.classList.remove('hidden');
  card.classList.remove('border-rose-300', 'bg-rose-50', 'border-amber-300', 'bg-amber-50/60');
  card.classList.add('border-emerald-200', 'bg-emerald-50/60');

  if (options.reveal) {
    // Recién terminado el pago: llevar al comprobante (scroll suave + foco
    // accesible; preventScroll evita que el navegador pelee el scroll).
    card.tabIndex = -1;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.focus({ preventScroll: true });
  }
}

/**
 * Loads balance, movements, tariffs, and top-up limits in parallel.
 */
async function loadAll() {
  try {
    const [balance, movements, tariffs, limits] = await Promise.all([
      // withHeart: agrega ?heart= solo cuando la vista fijó WALLET_HEART
      // (panel de un solo heart); sin override las URLs quedan igual que
      // siempre.
      apiGet(withHeart('/credits/balance')),
      apiGet(withHeart(`/credits/movements?limit=${PAGE_SIZE}&offset=${offset}${heartQuery('&')}`)),
      apiGet('/tariffs'),
      apiGet('/payments/limits'),
    ]);

    // Capture BEFORE the refresh renders the credited balance: the
    // return-from-gateway path below may need the previous number for the
    // live count-up celebration.
    const prevBalance = lastDisplayedBalance;

    renderBalance(balance);
    renderMovements(movements);
    renderTariffs(tariffs.tariffs);

    // Sin tope mensual (decisión del dueño): solo informamos el rango por
    // operación que valida el servidor.
    const cap = document.getElementById('topup-cap');
    cap.textContent = `Sin tope mensual: puedes recargar entre $${numberFormat.format(Number(limits.min_clp))} y $${numberFormat.format(Number(limits.max_clp))} CLP por operación.`;

    if (limits.provider === 'fake') {
      document.getElementById('topup-fake-note').classList.remove('hidden');
    }

    // Si hay una recarga reciente esperando confirmación (retorno real del
    // gateway o reapertura del panel), intenta mostrar su voucher.
    const lastOrder = lastOrderCandidate();

    if (lastOrder) {
      await showVoucher(lastOrder, { fromStorage: true, celebrate: prevBalance });
    }
  } catch (err) {
    showError(err.message);
  }
}

/**
 * Refreshes wallet data. Called when the wallet panel is shown.
 */
export function refreshWallet() {
  offset = 0;
  loadAll();
}

/**
 * Wires the wallet panel. Called once at app startup.
 */
export function initWallet() {
  if (isInitialized) return;
  isInitialized = true;

  const prevButton = document.getElementById('movements-prev');
  const nextButton = document.getElementById('movements-next');
  const topupSubmit = document.getElementById('topup-submit');
  const fiscalBox = document.getElementById('topup-fiscal');

  // Factura revela los datos tributarios; boleta los mantiene fuera de la
  // vista para que el formulario siga siendo breve por defecto.
  for (const radio of document.querySelectorAll('input[name="topup-doc-type"]')) {
    radio.addEventListener('change', () => {
      if (fiscalBox) {
        fiscalBox.classList.toggle('hidden', radio.value !== '33' || !radio.checked);
      }
    });
  }

  if (topupSubmit) {
    topupSubmit.addEventListener('click', submitTopup);
  }

  // Errores inline del formulario fiscal: al corregir un campo su marca
  // roja desaparece al instante (sin esperar otro submit).
  for (const fiscalId of ['topup-rut', 'topup-razon', 'topup-giro', 'topup-direccion', 'topup-comuna', 'topup-email']) {
    const field = document.getElementById(fiscalId);
    if (field) {
      field.addEventListener('input', () => clearFieldError(field));
    }
  }

  // Packs de recarga: una tarjeta seleccionada a la vez. El monto elegido se
  // guarda en #topup-amount (input oculto) y submitTopup lo lee igual que
  // antes leía el select. Cualquier valor viejo fuera de los packs
  // (p. ej. 2000, retirado) vuelve al pack por defecto.
  const topupAmountInput = document.getElementById('topup-amount');

  if (topupAmountInput && !TOPUP_AMOUNTS.has(Number(topupAmountInput.value))) {
    topupAmountInput.value = String(TOPUP_DEFAULT_AMOUNT);
  }

  for (const packs of document.querySelectorAll('[data-topup-packs]')) {
    packs.addEventListener('click', (event) => {
      const card = event.target instanceof Element ? event.target.closest('button.topup-pack') : null;

      if (!card || !TOPUP_AMOUNTS.has(Number(card.dataset.amount))) return;

      for (const other of packs.querySelectorAll('button.topup-pack')) {
        other.setAttribute('aria-pressed', String(other === card));
      }

      if (topupAmountInput) {
        topupAmountInput.value = card.dataset.amount;
      }

      // Volver a elegir un pack re-habilita el pago tras un cobro exitoso.
      if (topupSubmit) {
        topupSubmit.disabled = false;
      }
    });
  }

  // Un solo listener para toda la tabla: las filas de recarga con orden de
  // pago (data-order-id) abren su voucher.
  const movementsBody = document.getElementById('movements-body');

  if (movementsBody) {
    movementsBody.addEventListener('click', (event) => {
      const row = event.target instanceof Element ? event.target.closest('tr[data-order-id]') : null;

      if (row && row.dataset.orderId) {
        showVoucher(row.dataset.orderId);
      }
    });
  }

  if (prevButton) {
    prevButton.addEventListener('click', () => {
      offset = Math.max(0, offset - PAGE_SIZE);
      loadAll();
    });
  }

  if (nextButton) {
    nextButton.addEventListener('click', () => {
      offset += PAGE_SIZE;
      loadAll();
    });
  }
}

export function destroyWallet() {
  // All listeners are bound to the DOM which persists.
}
