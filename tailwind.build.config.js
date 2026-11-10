// Tailwind configuration for the BUILD (CLI).
//
// This is the same design system the Play CDN used, expressed in the format
// the Tailwind CLI understands, so the stylesheet can be compiled ahead of
// time and served from our own origin.
//
// Why this file exists: the Play CDN (cdn.tailwindcss.com) compiled the CSS
// in the visitor's browser, which forced the Content-Security-Policy to
// allow 'unsafe-eval' and made the front depend on a third party at runtime.
// Compiling it here removes both problems: no CDN, no 'unsafe-eval'.
//
// It maps the design tokens in /css/tokens.css onto Tailwind's colour names,
// so a theme or skin change stays a pure custom-property swap. Do not put
// literal colours here: every value must resolve to a token variable.
//
// Colour variables are stored as RGB channels, so utilities with an opacity
// modifier (bg-surface/80, divide-slate-100) keep working through the
// `rgb(var(--x) / <alpha-value>)` form.
//
// Build: npm run build:css

const rgb = (name) => `rgb(var(${name}) / <alpha-value>)`;

// Accent scale shared by `brand-*` (marketing pages) and `blue-*` (app pages).
const accent = {
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
const neutral = {
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

const status = (soft, border, text) => ({
  50: rgb(soft),
  100: rgb(soft),
  200: rgb(border),
  300: rgb(border),
  400: rgb(text),
  500: rgb(text),
  600: rgb(text),
  700: rgb(text),
  800: rgb(text),
  900: rgb(text),
});

module.exports = {
  content: ['./*.html', './**/*.html', './js/**/*.js'],
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
