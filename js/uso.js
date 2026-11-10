import { apiUrl } from './api-base.js';
// Usage panel: stat cards + charts of the caller's own aggregate usage.
//
// The payload (/usage/summary) is aggregate-only (counts and sums, filtered
// by the caller's user id): no queries, document contents, or PII ever reach
// this module. Tokens live exclusively in httpOnly cookies set by the
// server, so every fetch below carries the session cookie (credentials:
// 'include') — no token
// handling here. Mirrors wallet.js's module style (init once + refresh on
// every panel open).

const numberFormat = new Intl.NumberFormat('es-CL');
const shortDayFormat = new Intl.DateTimeFormat('es-CL', { day: 'numeric', month: 'short' });
const fullDayFormat = new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium' });

// Friendly Spanish label per operation key (covers startsWith groups too).
const OPERATION_LABELS = [
  ['chat_simple', 'Chat simple'],
  ['chat_doc', 'Chat con documentos'],
  ['doc_analysis', 'Análisis de documento'],
  ['draft_prepare', 'Preparar borrador'],
  ['draft_review', 'Revisión de borrador'],
  ['pdf_generate', 'Generar PDF'],
  ['document_download', 'Descarga de documento'],
  ['url_analysis', 'Análisis de página web'],
  ['tts', 'Texto a voz'],
];

const CHART_IDS = ['chart-usage-days', 'chart-usage-ops', 'chart-usage-credits'];
const CHART_VERSION = '1';

let isInitialized = false;
let charts = [];

// The wallet is per heart: the ledger/balance shown here follows the heart
// the view fixed (window.WALLET_HEART), falling back to localStorage
// heart_id. Empty = installation heart.
function activeHeart() {
  return (localStorage.getItem('heart_id') || '').trim();
}

function heartQuery(separator) {
  const heart = activeHeart();

  return heart !== '' ? `${separator}heart=${encodeURIComponent(heart)}` : '';
}

function walletHeart() {
  const heart = typeof window.WALLET_HEART === 'string' ? window.WALLET_HEART.trim() : '';

  return heart !== '' ? heart : null;
}

// Adds (or replaces) the ?heart= parameter on a URL only when the view fixed
// WALLET_HEART (single-heart panel); otherwise the URL passes through intact.
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

/**
 * Same-origin JSON GET returning the payload data (wallet.js pattern).
 *
 * @param {string} url
 * @returns {Promise<object>}
 */
async function apiGet(url) {
  let response;

  try {
    response = await fetch(apiUrl(url), {
      credentials: 'include', headers: { Accept: 'application/json' } });
  } catch (networkError) {
    throw new Error('No pudimos conectar con el servidor. Revisa tu conexión e inténtalo nuevamente.');
  }

  let payload;

  try {
    payload = await response.json();
  } catch (parseError) {
    throw new Error('No pudimos interpretar la respuesta del servidor. Inténtalo nuevamente.');
  }

  if (response.status === 401) {
    throw new Error('Sesión no disponible.');
  }

  if (!payload || payload.success !== true) {
    const message = payload && payload.error && payload.error.message
      ? payload.error.message
      : 'No pudimos cargar tu resumen de uso en este momento. Inténtalo nuevamente.';
    const error = new Error(message);
    error.code = payload && payload.error ? payload.error.code : undefined;
    throw error;
  }

  return payload.data;
}

/**
 * Compact number for stat cards and chart ticks: 900, 3.2k, 1.1M.
 *
 * @param {number} value
 * @returns {string}
 */
function formatCompact(value) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);

  if (abs < 1000) return String(n);

  const round1 = (x) => (Math.round(x * 10) / 10).toString().replace(/\.0$/, '');

  if (abs < 1e6) return `${round1(n / 1e3)}k`;

  return `${round1(n / 1e6)}M`;
}

/**
 * 'yyyy-mm-dd' (UTC bucket from the backend) → short Spanish label '12 oct',
 * parsed in UTC so the label matches the bucket the backend grouped by.
 *
 * @param {string} day
 * @returns {string}
 */
function dayLabel(day) {
  const date = new Date(`${day}T00:00:00Z`);

  if (Number.isNaN(date.getTime())) return day;

  return shortDayFormat.format(date);
}

function fullDayLabel(day) {
  const date = new Date(`${day}T00:00:00Z`);

  if (Number.isNaN(date.getTime())) return day;

  return fullDayFormat.format(date);
}

/**
 * Friendly Spanish label for an operation key (prefix-aware for groups like
 * 'doc_analysis_*'); unknown keys show cleaned up as-is, never PII.
 *
 * @param {string} operation
 * @returns {string}
 */
function operationLabel(operation) {
  const raw = String(operation || '');

  for (const [prefix, label] of OPERATION_LABELS) {
    if (raw === prefix || raw.startsWith(prefix)) return label;
  }

  return raw.replace(/_/g, ' ');
}

/**
 * Resolves the theme's accent palette from the CSS tokens (dia/noche +
 * teal/indigo skins all change --c-accent), so charts follow the active
 * theme instead of hard-coded colors.
 *
 * @returns {{ accent: string, accentSoft: string, slate: string, grid: string, text: string }}
 */
function chartPalette() {
  const style = getComputedStyle(document.documentElement);

  const triplet = (name, fallback) => {
    const raw = (style.getPropertyValue(name) || '').trim();
    return raw !== '' ? raw : fallback;
  };

  const accent = triplet('--c-accent', '14 92 85');
  const accentSoft = triplet('--c-accent-soft', '228 243 240');
  const muted = triplet('--c-text-muted', '100 116 139');
  const border = triplet('--c-border-soft', '226 232 240');
  const text = triplet('--c-text', '15 23 42');

  const rgb = (t, alpha = 1) => `rgba(${t.trim().split(/\s+/).join(',')}, ${alpha})`;

  return {
    accent: rgb(accent),
    accentStrong: rgb(triplet('--c-accent-strong', '10 59 54')),
    accentSoft: rgb(accentSoft),
    slate: rgb(muted),
    grid: rgb(border, 0.7),
    text: rgb(text),
  };
}

/**
 * Destroys the previous chart instances: Chart.js refuses to draw on a
 * canvas that already belongs to a chart, so every refresh must tear the
 * old instances down first.
 */
function destroyCharts() {
  for (const chart of charts.splice(0)) {
    try {
      chart.destroy();
    } catch (destroyError) {
      // A stale instance must never break the next render.
    }
  }
}

/**
 * Shows or clears the inline warm notice for the panel.
 *
 * @param {string|null} message
 */
function showError(message) {
  const box = document.getElementById('uso-error');

  if (!box) return;

  box.textContent = message || '';
  box.classList.toggle('hidden', !message);
}

/**
 * Builds one stat card (soft gradient border, brand-consistent).
 *
 * @param {string} label
 * @param {string} value
 * @param {string} hint
 * @returns {HTMLDivElement}
 */
function statCard(label, value, hint) {
  const card = document.createElement('div');
  card.className = 'rounded-2xl border border-slate-200 bg-gradient-to-br from-white via-white to-brand-50/50 p-4 shadow-sm';

  const title = document.createElement('p');
  title.className = 'text-xs font-medium uppercase tracking-wide text-slate-500';
  title.textContent = label;

  const number = document.createElement('p');
  number.className = 'mt-1 text-2xl font-semibold text-slate-900';
  number.textContent = value;

  const note = document.createElement('p');
  note.className = 'mt-1 text-xs leading-relaxed text-slate-500';
  note.textContent = hint;

  card.append(title, number, note);

  return card;
}

/**
 * Renders the 6 stat cards from the summary totals.
 *
 * @param {{ operations?: number, tokens_total?: number, documents?: number, conversations?: number }} totals
 * @param {number|null} balance
 * @param {number} creditsSpent
 */
function renderStats(totals, balance, creditsSpent) {
  const container = document.getElementById('uso-cards');

  if (!container) return;

  container.textContent = '';
  container.append(
    statCard('Consultas totales', numberFormat.format(Number(totals.operations) || 0), 'Todas las operaciones de tu cuenta.'),
    statCard('Tokens totales', formatCompact(totals.tokens_total), 'Texto enviado a la IA y generado por ella.'),
    statCard('Créditos gastados', numberFormat.format(creditsSpent), 'Débitos en tu cuenta de este corazón.'),
    statCard('Saldo actual', balance === null ? '—' : numberFormat.format(Number(balance)), 'Créditos disponibles ahora mismo.'),
    statCard('Documentos', numberFormat.format(Number(totals.documents) || 0), 'Documentos activos sin eliminar.'),
    statCard('Conversaciones', numberFormat.format(Number(totals.conversations) || 0), 'Chats que iniciaste en la plataforma.'),
  );
}

/**
 * Common Chart.js option scaffolding (fonts follow the tokens, subtle grid,
 * responsive against the fixed-height wrappers in the markup).
 *
 * @param {ReturnType<typeof chartPalette>} palette
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function baseOptions(palette, overrides = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        labels: { color: palette.text, boxWidth: 12, font: { size: 11 } },
      },
      tooltip: { titleFont: { size: 12 }, bodyFont: { size: 12 } },
    },
    ...overrides,
  };
}

/**
 * Renders the three charts. When Chart.js is unavailable (CDN blocked) the
 * caller renders plain tables instead — this function is never reached.
 *
 * @param {object} data /usage/summary data payload
 */
function renderCharts(data) {
  const palette = chartPalette();
  const byDay = Array.isArray(data.by_day) ? data.by_day : [];
  const byOperation = Array.isArray(data.by_operation) ? data.by_operation : [];
  const days = byDay.map((row) => row.date);
  const dayLabels = days.map(dayLabel);
  const tooltipTitles = days.map(fullDayLabel);

  destroyCharts();

  const daysCanvas = document.getElementById('chart-usage-days');

  if (daysCanvas) {
    charts.push(new window.Chart(daysCanvas, {
      type: 'line',
      data: {
        labels: dayLabels,
        datasets: [
          {
            label: 'Consultas',
            data: byDay.map((row) => row.operations || 0),
            yAxisID: 'y',
            borderColor: palette.accent,
            backgroundColor: 'transparent',
            borderWidth: 2,
            tension: 0.35,
            pointRadius: 2,
            pointHoverRadius: 4,
          },
          {
            label: 'Tokens',
            data: byDay.map((row) => (row.tokens_in || 0) + (row.tokens_out || 0)),
            yAxisID: 'y1',
            borderColor: palette.slate,
            backgroundColor: 'transparent',
            borderWidth: 2,
            borderDash: [6, 4],
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 4,
          },
        ],
      },
      options: {
        ...baseOptions(palette, {
          plugins: {
            legend: { labels: { color: palette.text, boxWidth: 12, font: { size: 11 } } },
            tooltip: {
              titleFont: { size: 12 },
              bodyFont: { size: 12 },
              callbacks: {
                title: (items) => tooltipTitles[items[0].dataIndex] || items[0].label,
              },
            },
          },
          scales: {
            x: {
              grid: { color: palette.grid },
              ticks: { color: palette.slate, maxTicksLimit: 10, font: { size: 10 } },
            },
            y: {
              beginAtZero: true,
              grid: { color: palette.grid },
              ticks: { color: palette.slate, precision: 0, font: { size: 10 }, callback: (v) => formatCompact(v) },
            },
            y1: {
              position: 'right',
              beginAtZero: true,
              grid: { drawOnChartArea: false },
              ticks: { color: palette.slate, font: { size: 10 }, callback: (v) => formatCompact(v) },
            },
          },
        }),
      },
    }));
  }

  const opsCanvas = document.getElementById('chart-usage-ops');

  if (opsCanvas) {
    // Doughnut shades stay inside the brand family: accent at stepped
    // alphas (no rainbow) — deep slices first, light remnant last.
    const opColors = byOperation.map((_, index) => {
      // "rgba(r, g, b, a)" → ["r", "g", "b"] for per-slice alpha steps.
      const parts = palette.accent.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/) || [];
      const alphas = [1, 0.8, 0.62, 0.46, 0.32, 0.2, 0.12];
      const alpha = index < alphas.length ? alphas[index] : 0.08;

      return parts.length < 4 ? palette.accent : `rgba(${parts[1]}, ${parts[2]}, ${parts[3]}, ${alpha})`;
    });

    charts.push(new window.Chart(opsCanvas, {
      type: 'doughnut',
      data: {
        labels: byOperation.map((row) => operationLabel(row.operation)),
        datasets: [{
          data: byOperation.map((row) => row.count || 0),
          backgroundColor: opColors,
          borderWidth: 1,
          borderColor: palette.accentSoft,
        }],
      },
      options: {
        ...baseOptions(palette),
        cutout: '60%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: palette.text, boxWidth: 10, font: { size: 11 } },
          },
          tooltip: {
            titleFont: { size: 12 },
            bodyFont: { size: 12 },
            callbacks: {
              label: (item) => `${item.label}: ${numberFormat.format(Number(item.raw) || 0)} consultas`,
            },
          },
        },
      },
    }));
  }

  const creditsCanvas = document.getElementById('chart-usage-credits');

  if (creditsCanvas) {
    charts.push(new window.Chart(creditsCanvas, {
      type: 'bar',
      data: {
        labels: dayLabels,
        datasets: [{
          label: 'Créditos gastados',
          data: byDay.map((row) => row.credits_spent || 0),
          backgroundColor: palette.accent,
          borderRadius: 4,
          maxBarThickness: 24,
        }],
      },
      options: {
        ...baseOptions(palette, {
          plugins: {
            legend: { display: false },
            tooltip: {
              titleFont: { size: 12 },
              bodyFont: { size: 12 },
              callbacks: {
                title: (items) => tooltipTitles[items[0].dataIndex] || items[0].label,
                label: (item) => ` Créditos: ${numberFormat.format(Number(item.raw) || 0)}`,
              },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { color: palette.slate, maxTicksLimit: 10, font: { size: 10 } },
            },
            y: {
              beginAtZero: true,
              grid: { color: palette.grid },
              ticks: { color: palette.slate, precision: 0, font: { size: 10 } },
            },
          },
        }),
      },
    }));
  }
}

/**
 * Builds one simple two-to-five column table into the fallback container.
 * Used only when Chart.js is unavailable: same datasets, plain tables, and
 * the page never breaks because a CDN was blocked.
 *
 * @param {string} title
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {HTMLDivElement}
 */
function fallbackTable(title, headers, rows) {
  const wrap = document.createElement('div');
  wrap.className = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm overflow-x-auto';

  const heading = document.createElement('h3');
  heading.className = 'text-base font-semibold text-slate-900';
  heading.textContent = title;

  const table = document.createElement('table');
  table.className = 'mt-3 w-full text-sm';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const header of headers) {
    const th = document.createElement('th');
    th.className = 'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-500';
    th.scope = 'col';
    th.textContent = header;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  const tbody = document.createElement('tbody');
  for (const cells of rows) {
    const tr = document.createElement('tr');
    for (const cell of cells) {
      const td = document.createElement('td');
      td.className = 'px-3 py-2 text-slate-700';
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  table.append(thead, tbody);

  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'mt-3 text-sm text-slate-500';
    empty.textContent = 'Sin datos todavía.';
    wrap.append(heading, empty);

    return wrap;
  }

  wrap.append(heading, table);

  return wrap;
}

/**
 * Renders the same chart datasets as plain tables into #uso-charts-fallback.
 *
 * @param {object} data /usage/summary data payload
 */
function renderFallbackTables(data) {
  const container = document.getElementById('uso-charts-fallback');

  if (!container) return;

  container.textContent = '';
  container.classList.remove('hidden');

  const byDay = Array.isArray(data.by_day) ? data.by_day : [];
  const byOperation = Array.isArray(data.by_operation) ? data.by_operation : [];

  container.append(
    fallbackTable(
      'Consultas y tokens por día (últimos 30 días)',
      ['Día', 'Consultas', 'Tokens'],
      byDay.map((row) => [
        fullDayLabel(row.date),
        numberFormat.format(row.operations || 0),
        formatCompact((row.tokens_in || 0) + (row.tokens_out || 0)),
      ]),
    ),
    fallbackTable(
      'Uso por operación',
      ['Operación', 'Consultas', 'Tokens', 'Créditos'],
      byOperation.map((row) => [
        operationLabel(row.operation),
        numberFormat.format(row.count || 0),
        formatCompact(row.tokens_total || 0),
        numberFormat.format(row.credits_charged || 0),
      ]),
    ),
    fallbackTable(
      'Créditos gastados por día (con actividad)',
      ['Día', 'Créditos'],
      byDay
        .filter((row) => (row.credits_spent || 0) > 0)
        .map((row) => [fullDayLabel(row.date), numberFormat.format(row.credits_spent || 0)]),
    ),
  );
}

/**
 * Fetches the usage summary and renders the whole panel.
 * Called every time the panel becomes visible.
 */
export async function refreshUso() {
  const data = await apiGet(withHeart('/usage/summary'));

  hideRefreshNotice();

  // The backend ships the per-heart wallet balance; when an older backend
  // omits it, fall back to the /credits/balance endpoint.
  let balance = typeof data.balance === 'number' ? data.balance : null;

  if (balance === null) {
    balance = await apiGet(withHeart('/credits/balance'))
      .then((payload) => (typeof payload.balance === 'number' ? payload.balance : null))
      .catch(() => null);
  }

  // Credits actually debited from the wallet (ledger is the authority);
  // USAGE_DEBIT rows are stored negative, so spend is their positive sum.
  const ledger = Array.isArray(data.credits_ledger) ? data.credits_ledger : [];
  const spentRow = ledger.find((row) => row.type === 'USAGE_DEBIT');
  const creditsSpent = spentRow ? Math.abs(Number(spentRow.total) || 0) : 0;

  renderStats(data.totals || {}, balance, creditsSpent);

  if (typeof window.Chart === 'function') {
    try {
      renderCharts(data);
    } catch (chartError) {
      // A chart that refuses to draw degrades to tables, never a dead panel.
      console.error('uso charts failed:', chartError);
      destroyCharts();
      renderFallbackTables(data);
    }
  } else {
    renderFallbackTables(data);
  }
}

/**
 * Hides a previously shown error notice once data loads fine.
 */
function hideRefreshNotice() {
  showError(null);
}

/**
 * Wires the usage panel. Called once at panel first open.
 */
export function initUso() {
  if (isInitialized) return;
  isInitialized = true;

  const refreshButton = document.getElementById('uso-refresh');

  if (refreshButton) {
    refreshButton.addEventListener('click', async () => {
      refreshButton.disabled = true;
      try {
        await refreshUso();
      } catch (err) {
        showError(err && err.message ? err.message : 'No pudimos actualizar tu resumen de uso. Inténtalo nuevamente.');
      } finally {
        refreshButton.disabled = false;
      }
    });
  }
}

/**
 * Tears charts down so a re-entry (or panel removal) starts clean.
 */
export function destroyUso() {
  destroyCharts();
}
