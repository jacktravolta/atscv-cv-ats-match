// Image OCR via Tesseract.js (WASM).
//
// Tesseract.js needs its worker/core/language data; for the MVP we rely on its
// default CDN resolution (the library handles this automatically).

import { loadTesseract } from '../lib.js?v=4';

/**
 * Creates a Tesseract worker for Spanish, falling back to English if the
 * Spanish language data cannot be loaded.
 *
 * @param {object} Tesseract
 * @param {(message: object) => void} logger
 * @returns {Promise<object>}
 */
async function createOcrWorker(Tesseract, logger) {
  try {
    return await Tesseract.createWorker('spa', 1, { logger });
  } catch (spaError) {
    return await Tesseract.createWorker('eng', 1, { logger });
  }
}

/**
 * Runs OCR over any Tesseract-compatible image input (File, Blob, data URL,
 * HTMLCanvasElement, ...). Shared by image uploads and by the PDF fallback.
 *
 * @param {File|Blob|string|HTMLCanvasElement} input
 * @param {(percent: number) => void} [onProgress]
 * @returns {Promise<string>}
 */
export async function ocrImageInput(input, onProgress = () => {}) {
  const Tesseract = await loadTesseract();

  const logger = (message) => {
    if (message && typeof message.progress === 'number') {
      const percent = Math.max(0, Math.min(100, Math.round(message.progress * 100)));
      onProgress(percent);
    }
  };

  let worker = null;

  try {
    worker = await createOcrWorker(Tesseract, logger);

    const result = await worker.recognize(input);
    const text = result && result.data ? result.data.text : '';

    return typeof text === 'string' ? text : '';
  } finally {
    if (worker) {
      try {
        await worker.terminate();
      } catch (terminateError) {
        // Ignore cleanup failures; the result has already been produced.
      }
    }
  }
}

/**
 * Extracts text from an image file.
 *
 * @param {File} file
 * @param {(percent: number) => void} [onProgress]
 * @returns {Promise<string>}
 */
export async function extractImage(file, onProgress = () => {}) {
  return ocrImageInput(file, onProgress);
}
