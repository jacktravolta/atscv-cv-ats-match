// Theme controller: day/night ("tema") and accent skin ("skin").
//
// The visual system is a set of CSS custom properties in /css/tokens.css,
// selected by data attributes on <html>. Every page runs a tiny inline script
// in <head> that applies the stored values before first paint (no flash); this
// module wires the on-screen controls and keeps them in sync.
//
// Usage (static markup):
//   <button type="button" data-theme-toggle aria-label="Cambiar tema">…</button>
//   <button type="button" data-skin-toggle aria-label="Cambiar color de acento">…</button>
//
// Usage (programmatic, e.g. the shared nav):
//   import { createThemeToggle } from '/js/theme.js';
//   container.append(createThemeToggle({ withSkin: true }));

const STORAGE_TEMA = 'aj:tema';
const STORAGE_SKIN = 'aj:skin';

const THEMES = ['dia', 'noche'];
const SKINS = ['teal', 'indigo', 'esmeralda', 'ambar', 'rosa', 'violeta'];

/**
 * Valid accent skin names (mirrors the data-skin blocks in /css/tokens.css).
 *
 * @typedef {'teal'|'indigo'|'esmeralda'|'ambar'|'rosa'|'violeta'} SkinName
 */

const THEME_LABELS = {
  dia: 'Activar modo noche',
  noche: 'Activar modo día',
};

const SKIN_LABELS = {
  teal: 'verde azulado',
  indigo: 'índigo',
  esmeralda: 'esmeralda',
  ambar: 'ámbar',
  rosa: 'rosa',
  violeta: 'violeta',
};

const root = document.documentElement;

function readStored(key, fallback) {
  try {
    return window.localStorage.getItem(key) || fallback;
  } catch (error) {
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    // Storage may be unavailable (private mode); the theme still applies.
  }
}

/**
 * @returns {'dia'|'noche'} The active theme.
 */
export function getTema() {
  return THEMES.includes(root.dataset.tema) ? root.dataset.tema : 'dia';
}

/**
 * @returns {SkinName} The active accent skin.
 */
export function getSkin() {
  return SKINS.includes(root.dataset.skin) ? root.dataset.skin : 'teal';
}

/**
 * Applies a theme to <html> and persists it.
 *
 * @param {'dia'|'noche'} tema
 * @param {boolean} [persist=true]
 * @returns {'dia'|'noche'}
 */
export function applyTema(tema, persist = true) {
  const next = THEMES.includes(tema) ? tema : 'dia';
  root.dataset.tema = next;

  if (persist) {
    writeStored(STORAGE_TEMA, next);
  }

  syncControls();
  return next;
}

/**
 * Applies an accent skin to <html> and persists it.
 *
 * @param {SkinName} skin
 * @param {boolean} [persist=true]
 * @returns {SkinName}
 */
export function applySkin(skin, persist = true) {
  const next = SKINS.includes(skin) ? skin : 'teal';
  root.dataset.skin = next;

  if (persist) {
    writeStored(STORAGE_SKIN, next);
  }

  syncControls();
  return next;
}

/**
 * Flips between day and night.
 *
 * @returns {'dia'|'noche'}
 */
export function toggleTema() {
  return applyTema(getTema() === 'dia' ? 'noche' : 'dia');
}

/**
 * Cycles to the next accent skin.
 *
 * @returns {SkinName}
 */
export function cycleSkin() {
  const index = SKINS.indexOf(getSkin());
  return applySkin(SKINS[(index + 1) % SKINS.length]);
}

function syncControls() {
  const tema = getTema();

  document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
    button.setAttribute('aria-label', THEME_LABELS[tema]);
    button.setAttribute('title', THEME_LABELS[tema]);
    button.setAttribute('aria-pressed', String(tema === 'noche'));
  });

  const skin = getSkin();
  const nextSkin = SKINS[(SKINS.indexOf(skin) + 1) % SKINS.length];

  document.querySelectorAll('[data-skin-toggle]').forEach((button) => {
    button.setAttribute('aria-label', `Cambiar color de acento a ${SKIN_LABELS[nextSkin]}`);
    button.setAttribute('title', `Color de acento: ${SKIN_LABELS[skin]}`);
    button.dataset.skinCurrent = skin;
  });
}

function wireButton(button, handler) {
  if (button.dataset.themeWired === 'true') {
    return;
  }

  button.dataset.themeWired = 'true';
  button.addEventListener('click', handler);
}

const SUN_ICON = '<svg class="icon-sun h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2m0 14v2M5.6 5.6l1.4 1.4m10 10l1.4 1.4M3 12h2m14 0h2M5.6 18.4l1.4-1.4m10-10l1.4-1.4M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>';
const MOON_ICON = '<svg class="icon-moon h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12.8A8.5 8.5 0 1111.2 3a6.6 6.6 0 009.8 9.8z"/></svg>';
const SKIN_ICON = '<svg class="h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3a9 9 0 000 18c1.1 0 2-.9 2-2 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.2 0-1 .8-1.8 1.8-1.8H16a5 5 0 005-5c0-4-4-7.7-9-7.7z"/><path stroke-linecap="round" stroke-linejoin="round" d="M7.5 10.5h.01M10.5 7.5h.01M14.5 7.5h.01"/></svg>';

const DEFAULT_BUTTON_CLASS = 'inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:border-brand-400 hover:text-brand-700';

/**
 * Builds a theme (and optionally skin) toggle control.
 *
 * @param {{ withSkin?: boolean, buttonClass?: string }} [options]
 * @returns {HTMLElement}
 */
export function createThemeToggle(options = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'flex items-center gap-1';

  const buttonClass = options.buttonClass || DEFAULT_BUTTON_CLASS;

  const themeButton = document.createElement('button');
  themeButton.type = 'button';
  themeButton.setAttribute('data-theme-toggle', '');
  themeButton.setAttribute('aria-label', 'Cambiar tema');
  themeButton.className = buttonClass;
  themeButton.innerHTML = SUN_ICON + MOON_ICON;
  wrap.append(themeButton);

  if (options.withSkin) {
    const skinButton = document.createElement('button');
    skinButton.type = 'button';
    skinButton.setAttribute('data-skin-toggle', '');
    skinButton.setAttribute('aria-label', 'Cambiar color de acento');
    skinButton.className = buttonClass;
    skinButton.innerHTML = SKIN_ICON;
    wrap.append(skinButton);
  }

  wireButton(themeButton, () => toggleTema());

  if (options.withSkin) {
    wireButton(wrap.lastElementChild, () => cycleSkin());
  }

  syncControls();
  return wrap;
}

/**
 * Wires every toggle already present in the DOM and keeps labels in sync.
 * Idempotent: safe to call again after mounting new controls.
 */
export function initTheme() {
  if (!root.dataset.tema) {
    applyTema(readStored(STORAGE_TEMA, 'dia'), false);
  }

  if (!root.dataset.skin) {
    applySkin(readStored(STORAGE_SKIN, 'teal'), false);
  }

  document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
    wireButton(button, () => toggleTema());
  });

  document.querySelectorAll('[data-skin-toggle]').forEach((button) => {
    wireButton(button, () => cycleSkin());
  });

  syncControls();
}

initTheme();
