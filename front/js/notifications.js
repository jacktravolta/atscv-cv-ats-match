import { apiUrl } from './api-base.js';
// Notifications panel: bell badge + in-app inbox over /notifications*.
// DOM ids live in public/index.html (tpl-app header + tpl-notifications panel).
// Refresh points: boot (badge), panel show (list), and after each action.
// No aggressive polling: the inbox is event-driven, never a background timer.

import { loadQuillEditor } from './quill-loader.js';
import { avatarHtml, botAvatarHtml } from './avatar.js';
import { playChime, soundsEnabled } from './sounds.js';

const $ = (id) => document.getElementById(id);

// Notification fields are user-derived (display names ride in titles like
// "Respuesta de {name}"), so every interpolation goes through this before
// touching innerHTML.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The inbox is per heart: the panel always asks for the heart the user is
// viewing (same source the chat uses). Empty = installation heart.
function activeHeart() {
  return (localStorage.getItem('heart_id') || '').trim();
}

function heartQuery(separator) {
  const heart = activeHeart();

  return heart !== '' ? `${separator}heart=${encodeURIComponent(heart)}` : '';
}

const LEVEL_STYLES = {
  info: { dot: 'bg-blue-500', card: 'border-blue-100' },
  success: { dot: 'bg-emerald-500', card: 'border-emerald-100' },
  warning: { dot: 'bg-amber-500', card: 'border-amber-100' },
  critical: { dot: 'bg-red-500', card: 'border-red-100' },
};

let initialized = false;
let items = [];

// Last unread count observed from the server. `null` = no baseline yet: the
// first refresh sets it SILENTLY (pre-existing unread must never chime).
// Only the refresh functions below compare/update it; setBadge() stays pure
// rendering and never plays a sound.
let lastUnread = null;

/**
 * Compare a fresh server count against the baseline: chime ONLY when the
 * count increased, then always record it as the new baseline.
 *
 * @param {unknown} count server-provided unread count
 */
function noteUnread(count) {
  const value = Math.max(0, Number(count) || 0);

  if (lastUnread !== null && value > lastUnread && soundsEnabled()) {
    playChime('bell');
  }

  lastUnread = value;
}

/**
 * Minimal JSON fetch wrapper (cookie auth, cross-origin permitido). A 401 hides the
 * badge quietly: an anonymous visitor has no inbox, and that is not an error
 * worth showing.
 */
async function api(url, options = {}) {
  let response;

  try {
    response = await fetch(apiUrl(url), {
      credentials: 'include',
      headers: { Accept: 'application/json', ...(options.headers || {}) },
      ...options,
    });
  } catch (networkError) {
    throw new Error('No pudimos conectar con el servidor. Revisa tu conexión e inténtalo nuevamente.');
  }

  if (response.status === 401) {
    const error = new Error('Sesión no disponible.');
    error.code = 'UNAUTHORIZED';
    throw error;
  }

  let payload;

  try {
    payload = await response.json();
  } catch (parseError) {
    throw new Error('No pudimos interpretar la respuesta del servidor. Inténtalo nuevamente.');
  }

  if (!payload || payload.success !== true) {
    const error = new Error(
      payload && payload.error && payload.error.message
        ? payload.error.message
        : 'No pudimos completar tu solicitud en este momento. Inténtalo nuevamente.'
    );
    error.code = payload && payload.error ? payload.error.code : undefined;
    error.status = response.status;
    throw error;
  }

  return payload.data;
}

function setBadge(count) {
  const badge = $('notifications-badge');

  if (!badge) {
    return;
  }

  const value = Math.max(0, Number(count) || 0);

  if (value <= 0) {
    badge.classList.add('hidden');
    badge.textContent = '0';

    return;
  }

  badge.textContent = value > 99 ? '99+' : String(value);
  badge.classList.remove('hidden');
}

function relativeTime(value) {
  if (!value) {
    return '';
  }

  const date = new Date(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
  const diffMs = Date.now() - date.getTime();

  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return 'ahora';
  }

  const minutes = Math.floor(diffMs / 60000);

  if (minutes < 1) {
    return 'ahora';
  }
  if (minutes < 60) {
    return `hace ${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `hace ${hours} h`;
  }

  const days = Math.floor(hours / 24);

  if (days < 30) {
    return `hace ${days} ${days === 1 ? 'día' : 'días'}`;
  }

  return date.toLocaleDateString('es-CL', { day: 'numeric', month: 'short', year: 'numeric' });
}

function showPanelState({ error = null, empty = null, list = null }) {
  const errorEl = $('notifications-error');
  const emptyEl = $('notifications-empty');
  const listEl = $('notifications-list');

  if (errorEl) {
    errorEl.textContent = error || '';
    errorEl.classList.toggle('hidden', !error);
  }
  if (emptyEl) {
    emptyEl.classList.toggle('hidden', !empty);
  }
  if (listEl) {
    listEl.classList.toggle('hidden', !list);
    if (!list) {
      listEl.innerHTML = '';
    }
  }
}

function rowHtml(item) {
  const style = LEVEL_STYLES[item.level] || LEVEL_STYLES.info;
  const action =
    item.action_url && item.action_label
      ? `<a href="${escapeHtml(item.action_url)}" class="mt-1 inline-block text-sm font-medium text-brand-700 underline-offset-2 hover:underline">${escapeHtml(item.action_label)}</a>`
      : '';
  const markRead =
    item.read
      ? ''
      : `<button type="button" data-action="read" data-id="${escapeHtml(item.id)}" class="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700">Marcar leída</button>`;
  const reply = item.created_by
    ? `<button type="button" data-action="reply" data-id="${escapeHtml(item.id)}" class="rounded-lg px-2.5 py-1.5 text-xs font-medium text-brand-700 transition hover:bg-brand-50">Responder</button>`
    : '';
  // Human circle when the row has an author (admin message, "Respuesta de…");
  // the assistant icon for system-generated rows.
  const avatar = item.created_by
    ? avatarHtml({ name: item.created_by_name || '', id: item.created_by, avatar: item.created_by_avatar }, 'sm')
    : botAvatarHtml(null, 'sm');

  return `
    <li class="rounded-2xl border ${style.card} bg-white p-4 shadow-sm ${item.read ? 'opacity-70' : ''}">
      <div class="flex items-start gap-3">
        <span class="relative mt-0.5 shrink-0">${avatar}<span class="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ${style.dot} ${item.read ? 'opacity-0' : ''}" aria-hidden="true"></span></span>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline justify-between gap-3">
            <p class="text-sm font-semibold ${item.read ? 'text-slate-600' : 'text-slate-900'}">${escapeHtml(item.title)}</p>
            <span class="shrink-0 text-xs text-slate-400">${relativeTime(item.created_at)}</span>
          </div>
          <p class="mt-1 text-sm whitespace-pre-line text-slate-600">${escapeHtml(item.body)}</p>
          ${action}
          <div class="mt-2 flex justify-end gap-1">
            ${reply}
            ${markRead}
            <button type="button" data-action="delete" data-id="${escapeHtml(item.id)}" class="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-400 transition hover:bg-red-50 hover:text-red-600" aria-label="Borrar notificación">Borrar</button>
          </div>
        </div>
      </div>
    </li>`;
}

function renderNotifications() {
  const listEl = $('notifications-list');

  if (!listEl) {
    return;
  }

  if (!items || items.length === 0) {
    showPanelState({ empty: true, list: false });

    return;
  }

  listEl.innerHTML = items.map(rowHtml).join('');
  showPanelState({ list: true });
}

async function refreshNotifications() {
  showPanelState({ list: false });

  try {
    const data = await api('/notifications?limit=50' + heartQuery('&'));

    items = Array.isArray(data.notifications) ? data.notifications : [];
    noteUnread(data.unread_count);
    setBadge(data.unread_count);
    renderNotifications();
  } catch (e) {
    if (e && e.code === 'UNAUTHORIZED') {
      setBadge(0);

      return;
    }

    showPanelState({
      error: 'No pudimos cargar tus notificaciones en este momento. Inténtalo nuevamente en unos minutos.',
      list: false,
    });
  }
}

async function refreshUnreadBadge() {
  try {
    const data = await api('/notifications/unread-count' + heartQuery('?'));

    noteUnread(data.unread_count);
    setBadge(data.unread_count);
  } catch (e) {
    if (!e || e.code !== 'UNAUTHORIZED') {
      // Badge stays as-is on transient failures; never shout at the user.
      return;
    }

    setBadge(0);
  }
}

async function markRead(id) {
  try {
    const data = await api(`/notifications/${encodeURIComponent(id)}/read` + heartQuery('?'), { method: 'POST' });

    items = items.map((item) => (item.id === id ? { ...item, read: true } : item));
    renderNotifications();
    setBadge(data && typeof data.unread_count === 'number' ? data.unread_count : 0);
  } catch (e) {
    showPanelState({ error: e.message || 'No pudimos marcar la notificación como leída.' });
  }
}

async function deleteOne(id) {
  try {
    await api(`/notifications/${encodeURIComponent(id)}` + heartQuery('?'), { method: 'DELETE' });

    items = items.filter((item) => item.id !== id);
    renderNotifications();
    await refreshUnreadBadge();
  } catch (e) {
    showPanelState({ error: e.message || 'No pudimos borrar la notificación.' });
  }
}

async function markAllRead() {
  try {
    await api('/notifications/read-all' + heartQuery('?'), { method: 'POST' });

    items = items.map((item) => ({ ...item, read: true }));
    renderNotifications();
    // All read → the count is deterministically 0: reset the baseline so a
    // later increase (new notification after read-all) chimes again.
    lastUnread = 0;
    setBadge(0);
  } catch (e) {
    showPanelState({ error: e.message || 'No pudimos marcar todas como leídas.' });
  }
}

async function clearAll() {
  const pending = items.slice();

  if (pending.length === 0) {
    return;
  }

  const failures = [];

  for (const item of pending) {
    try {
      await api(`/notifications/${encodeURIComponent(item.id)}` + heartQuery('?'), { method: 'DELETE' });
    } catch (e) {
      failures.push(item.id);
    }
  }

  await refreshNotifications();
}

// ----- Reply to a message the team sent (same editor the admin uses) -----

let replyQuill = null;
let replyTarget = null;

function showPanelOk(text) {
  const okEl = $('notifications-ok');

  if (okEl) {
    okEl.textContent = text || '';
    okEl.classList.toggle('hidden', !text);
  }

  const errorEl = $('notifications-error');
  if (errorEl && text) {
    errorEl.classList.add('hidden');
  }
}

function openReplyModal(item) {
  const modal = $('reply-modal');

  if (!modal) {
    return;
  }

  replyTarget = item.id;

  const targetEl = $('reply-target');
  if (targetEl) {
    // Same counterpart rule as the inbox row: human circle with author,
    // assistant icon for system rows. escapeHtml: item.title can embed
    // user-controlled display names.
    const avatar = item.created_by
      ? avatarHtml({ name: item.created_by_name || '', id: item.created_by, avatar: item.created_by_avatar }, 'sm')
      : botAvatarHtml(null, 'sm');

    targetEl.innerHTML =
      `<span class="flex items-center gap-2">${avatar}<span>En respuesta a: ${escapeHtml(item.title)}</span></span>`;
  }

  const errorEl = $('reply-error');
  if (errorEl) {
    errorEl.classList.add('hidden');
  }

  if (replyQuill) {
    replyQuill.setText('');
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');

  ensureReplyQuill().catch((error) => {
    if (errorEl) {
      errorEl.textContent = error.message || 'No pudimos cargar el editor.';
      errorEl.classList.remove('hidden');
    }
  });
}

function closeReplyModal() {
  const modal = $('reply-modal');

  if (!modal) {
    return;
  }

  modal.classList.add('hidden');
  modal.classList.remove('flex');
  replyTarget = null;
}

async function ensureReplyQuill() {
  if (replyQuill) {
    return replyQuill;
  }

  const host = $('reply-quill');

  if (!host) {
    return null;
  }

  const Quill = await loadQuillEditor();
  replyQuill = new Quill(host, {
    theme: 'snow',
    placeholder: 'Escribe tu respuesta con calma.',
    modules: {
      toolbar: [['bold', 'italic', 'underline'], [{ list: 'ordered' }, { list: 'bullet' }], ['clean']],
    },
  });

  return replyQuill;
}

async function sendReply() {
  const sendButton = $('reply-send');

  if (!sendButton || !replyTarget) {
    return;
  }

  const body = replyQuill ? replyQuill.getText().replace(/\n+$/, '').trim() : '';
  const errorEl = $('reply-error');

  const fail = (message) => {
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.classList.remove('hidden');
    }
  };

  if (body === '') {
    fail('Escribe tu respuesta antes de enviarla.');
    return;
  }

  sendButton.disabled = true;
  sendButton.textContent = 'Enviando…';

  try {
    await api(`/notifications/${encodeURIComponent(replyTarget)}/reply` + heartQuery('?'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });

    closeReplyModal();
    showPanelOk('Respuesta enviada. El equipo la verá en su campana.');
  } catch (e) {
    fail(e.message || 'No pudimos enviar tu respuesta en este momento. Inténtalo nuevamente.');
  } finally {
    sendButton.disabled = false;
    sendButton.textContent = 'Enviar respuesta';
  }
}

function initNotifications() {
  if (initialized) {
    return;
  }

  const list = $('notifications-list');

  if (!list) {
    // Template not mounted yet; retry on the next panel show.
    return;
  }

  // Event delegation: one listener covers every row's action buttons.
  list.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');

    if (!button) {
      return;
    }

    const { action, id } = button.dataset;

    if (action === 'read' && id) {
      markRead(id);
    } else if (action === 'delete' && id) {
      deleteOne(id);
    } else if (action === 'reply' && id) {
      const item = items.find((entry) => entry.id === id);
      if (item) {
        openReplyModal(item);
      }
    }
  });

  const replyCancel = $('reply-cancel');
  if (replyCancel) {
    replyCancel.addEventListener('click', closeReplyModal);
  }

  const replySend = $('reply-send');
  if (replySend) {
    replySend.addEventListener('click', sendReply);
  }

  const replyModal = $('reply-modal');
  if (replyModal) {
    replyModal.addEventListener('click', (event) => {
      if (event.target === replyModal) {
        closeReplyModal();
      }
    });
  }

  const readAll = $('notifications-read-all');

  if (readAll) {
    readAll.addEventListener('click', markAllRead);
  }

  const clear = $('notifications-clear');

  if (clear) {
    clear.addEventListener('click', clearAll);
  }

  initialized = true;
}

export { initNotifications, refreshNotifications, refreshUnreadBadge };
