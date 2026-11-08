// PDF text extraction via pdf.js, with an OCR fallback for scanned pages.
//
// IMPORTANT: Tesseract.js does NOT read PDFs directly. For pages that carry no
// selectable text (i.e. scanned images), pdf.js renders the page to a canvas
// and Tesseract OCRs that canvas.

import { loadPdfJs } from '../lib.js?v=4';
import { ocrImageInput } from './image.js';

// Pages with fewer non-space characters than this are treated as scanned.
const MIN_TEXT_CHARS = 20;
const RENDER_SCALE = 2;

/**
 * Extracts text from a PDF file.
 *
 * @param {File} file
 * @param {(percent: number) => void} [onProgress]
 * @returns {Promise<string>}
 */
export async function extractPdf(file, onProgress = () => {}) {
  const pdfjsLib = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();

  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPages = pdf.numPages;
  const pages = [];

  try {
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      let text = '';

      try {
        const content = await page.getTextContent();
        text = content.items
          .map((item) => (item && typeof item.str === 'string' ? item.str : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      } catch (textError) {
        text = '';
      }

      const nonSpaceChars = text.replace(/\s/g, '').length;

      if (nonSpaceChars < MIN_TEXT_CHARS) {
        // Scanned page: render it and OCR the canvas.
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);

        const context = canvas.getContext('2d');
        await page.render({ canvasContext: context, viewport }).promise;

        text = await ocrImageInput(canvas, (percent) => {
          const pageFraction = (pageNumber - 1 + percent / 100) / totalPages;
          onProgress(Math.round(pageFraction * 100));
        });
      }

      pages.push(text.trim());
      onProgress(Math.round((pageNumber / totalPages) * 100));
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }

  return pages.filter((page) => page !== '').join('\n\n');
}
