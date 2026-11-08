// Client-side library loader / configuration.
//
// All extraction libraries are loaded lazily from a CDN, only when a given
// file format needs them. No bundler and no build step: this file is a plain
// ES module, and classic libraries are injected with a <script> tag.
//
// Chosen CDN URLs (and why):
//   - Tesseract.js v5 (OCR, WASM):
//       https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js
//     Exposes the global `Tesseract`. Tesseract resolves its worker, core and
//     language data from the same CDN by default (no extra config needed).
//   - pdf.js v4 (PDF parsing):
//       https://cdn.jsdelivr.net/npm/pdfjs-dist@4/legacy/build/pdf.min.mjs
//       https://cdn.jsdelivr.net/npm/pdfjs-dist@4/legacy/build/pdf.worker.min.mjs
//     pdfjs-dist v4 is ESM-only (the legacy UMD `pdf.min.js` build was removed
//     in v4 and returns 404 on the CDN). We therefore load the legacy ESM build
//     with a dynamic import() and point `GlobalWorkerOptions.workerSrc` at the
//     matching legacy worker module. pdf.js wraps cross-origin workers
//     internally, so this works without a bundler. The `legacy` build is used
//     for broader browser support.
//   - mammoth.js v1 (DOCX parsing):
//       https://cdn.jsdelivr.net/npm/mammoth@1/mammoth.browser.min.js
//     Exposes the global `mammoth`.

export const CDN = {
  tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
  pdfjs: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4/legacy/build/pdf.min.mjs',
  pdfjsWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4/legacy/build/pdf.worker.min.mjs',
  mammoth: 'https://cdn.jsdelivr.net/npm/mammoth@1/mammoth.browser.min.js',
};

// Cache of in-flight / resolved script loads, keyed by URL.
const scriptLoads = new Map();

/**
 * Injects a classic <script> tag once and resolves when it has loaded.
 * Repeated calls for the same URL reuse the same promise.
 *
 * @param {string} url
 * @returns {Promise<void>}
 */
export function loadScript(url) {
  if (scriptLoads.has(url)) {
    return scriptLoads.get(url);
  }

  const promise = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = url;
    el.async = true;
    el.crossOrigin = 'anonymous';
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(
      'No pudimos cargar una librería necesaria. Revisa tu conexión e inténtalo nuevamente.'
    ));
    document.head.appendChild(el);
  });

  scriptLoads.set(url, promise);
  return promise;
}

/**
 * Lazily loads Tesseract.js and returns the global `Tesseract`.
 *
 * @returns {Promise<object>}
 */
export async function loadTesseract() {
  if (window.Tesseract) {
    return window.Tesseract;
  }

  await loadScript(CDN.tesseract);

  if (!window.Tesseract) {
    throw new Error('No pudimos iniciar el lector de imágenes. Lo siento, no pudimos cargar el lector. Por favor, actualiza la página e inténtalo nuevamente.');
  }

  return window.Tesseract;
}

/**
 * Lazily loads mammoth.js and returns the global `mammoth`.
 *
 * @returns {Promise<object>}
 */
export async function loadMammoth() {
  if (window.mammoth) {
    return window.mammoth;
  }

  await loadScript(CDN.mammoth);

  if (!window.mammoth) {
    throw new Error('No pudimos iniciar el lector de documentos Word. Lo siento, no pudimos cargar el lector de documentos. Por favor, verifica tu archivo e inténtalo nuevamente.');
  }

  return window.mammoth;
}

// Cache of the in-flight / resolved pdf.js module import.
let pdfjsPromise = null;

/**
 * Lazily imports the pdf.js legacy ESM build and configures its worker.
 *
 * @returns {Promise<object>} The pdf.js library namespace.
 */
export function loadPdfJs() {
  if (pdfjsPromise) {
    return pdfjsPromise;
  }

  pdfjsPromise = import(CDN.pdfjs)
    .then((mod) => {
      const pdfjsLib = mod.default ?? mod;

      if (pdfjsLib.GlobalWorkerOptions) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = CDN.pdfjsWorker;
      }

      return pdfjsLib;
    })
    .catch(() => {
      // Allow a retry on the next call instead of caching the failure.
      pdfjsPromise = null;
      throw new Error('No pudimos cargar el lector de PDF. Lo siento, hay un problema técnico con el visor de PDF. Por favor, verifica tu conexión e inténtalo nuevamente.');
    });

  return pdfjsPromise;
}
