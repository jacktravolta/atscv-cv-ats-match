// Shared Tailwind (Play CDN) configuration.
//
// Loaded as a classic script right after cdn.tailwindcss.com on every page.
// Maps the design tokens in /css/tokens.css onto Tailwind's colour names so a
// theme or skin change is a custom-property swap. Do not put literal colours
// here: every value must resolve to a token variable.
//
// Colour variables are stored as RGB channels, so utilities with an opacity
// modifier (bg-surface/80, divide-slate-100) keep working through the
// `rgb(var(--x) / <alpha-value>)` form.

(function () {
  'use strict';

  var rgb = function (name) {
    return 'rgb(var(' + name + ') / <alpha-value>)';
  };

  // Accent scale shared by `brand-*` (marketing pages) and `blue-*` (app pages).
  var accent = {
    50: rgb('--c-accent-soft'),
    100: rgb('--c-accent-soft'),
    200: rgb('--c-accent-soft'),
    300: rgb('--c-accent'),
    400: rgb('--c-accent'),
    500: rgb('--c-accent'),
    600: rgb('--c-accent'),
    700: rgb('--c-accent-hover'),
    800: rgb('--c-accent-strong'),
    900: rgb('--c-accent-strong'),
  };

  // Neutral scale: surfaces, borders and text.
  var neutral = {
    50: rgb('--c-surface-2'),
    100: rgb('--c-border-soft'),
    200: rgb('--c-border'),
    300: rgb('--c-border-strong'),
    400: rgb('--c-text-subtle'),
    500: rgb('--c-text-subtle'),
    600: rgb('--c-text-muted'),
    700: rgb('--c-text-muted'),
    800: rgb('--c-text'),
    900: rgb('--c-text'),
    950: rgb('--c-text'),
  };

  var status = function (soft, border, text) {
    return {
      50: rgb(soft),
      100: rgb(soft),
      200: rgb(border),
      300: rgb(border),
      400: rgb(border),
      500: rgb(text),
      600: rgb(text),
      700: rgb(text),
      800: rgb(text),
      900: rgb(text),
    };
  };

  var config = {
    theme: {
      extend: {
        colors: {
          brand: accent,
          blue: accent,
          indigo: accent,
          slate: neutral,
          emerald: status('--c-success-soft', '--c-success-border', '--c-success-text'),
          amber: status('--c-warning-soft', '--c-warning-border', '--c-warning-text'),
          rose: status('--c-danger-soft', '--c-danger-border', '--c-danger-text'),
          sky: status('--c-info-soft', '--c-info-border', '--c-info-text'),
        },
        fontFamily: {
          sans: ['var(--font-body)'],
          display: ['var(--font-display)'],
        },
      },
    },
  };

  // The Play CDN reads `tailwind.config` after it loads. This script runs right
  // after the CDN script, so the global exists; guard anyway for safety.
  if (typeof window !== 'undefined') {
    window.tailwind = window.tailwind || {};
    window.tailwind.config = config;

    try {
      // eslint-disable-next-line no-undef
      tailwind.config = config;
    } catch (error) {
      // The CDN may not be ready yet; window.tailwind.config above covers it.
    }
  }
})();
