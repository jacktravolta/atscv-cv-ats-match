// DOCX text extraction via mammoth.js.
//
// NOTE: we deliberately use `extractRawText` and NOT `convertToHtml`.
// mammoth does not sanitize HTML output, so converting to HTML would require a
// separate sanitization step before it could be rendered safely.

import { loadMammoth } from '../lib.js?v=4';

/**
 * Extracts the raw text from a .docx file.
 *
 * @param {File} file
 * @returns {Promise<string>}
 */
export async function extractDocx(file) {
  const mammoth = await loadMammoth();
  const arrayBuffer = await file.arrayBuffer();

  const result = await mammoth.extractRawText({ arrayBuffer });

  return result && typeof result.value === 'string' ? result.value : '';
}
