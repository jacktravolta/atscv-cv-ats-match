// Plain-text extraction.

/**
 * Reads a plain-text file (e.g. .txt, .md) as UTF-8 text.
 *
 * @param {File} file
 * @returns {Promise<string>}
 */
export async function extractText(file) {
  return file.text();
}
