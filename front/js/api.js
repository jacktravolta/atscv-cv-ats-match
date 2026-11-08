// Server API client.
//
// The server only receives already-extracted text. It never performs OCR or document conversion.

import { apiUrl } from './api-base.js';

const INGEST_ENDPOINT = apiUrl('/documents/ingest');

// Debug mode
const DEBUG_API = true;
function debugLog(...args) {
  if (DEBUG_API) {
    console.log('[DEBUG API]', new Date().toISOString(), ...args);
  }
}

/**
 * Sends the extracted text to the server.
 * Client-side extraction (OCR, PDF, DOCX) happens before calling this.
 * Server only receives extracted text + source_type.
 *
 * @param {{ text: string, sourceType: string }} params
 * @returns {Promise<object>} The server's `data` payload.
 */
export async function ingestDocument({ text, sourceType, name, extra }) {
  debugLog('ingestDocument called', { textLength: text?.length, sourceType, name });

  const form = new FormData();
  form.append('text', text);
  form.append('source_type', sourceType);
  // Original filename (display + prompt reference only; the file bytes stay
  // client-side — all processing happens in the browser).
  if (typeof name === 'string' && name.trim() !== '') {
    form.append('original_filename', name.trim());
  }
  // Host-injected extra fields (dev-only per-request heart override rides
  // along so panel attachments land in the panel heart's RAG).
  for (const [key, value] of Object.entries(extra || {})) {
    if (typeof value === 'string' || typeof value === 'number') {
      form.append(key, String(value));
    }
  }
  // NO enviamos el archivo original - todo el procesamiento es client-side

  let response;

  try {
    debugLog('Sending fetch to', INGEST_ENDPOINT);
    response = await fetch(INGEST_ENDPOINT, {
      method: 'POST',
      body: form,
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    debugLog('Response received', { status: response.status, ok: response.ok });
  } catch (networkError) {
    debugLog('Network error', networkError);
    throw new Error('No pudimos conectar con el servidor. Revisa tu conexión e inténtalo nuevamente.');
  }

  let payload;

  try {
    payload = await response.json();
    debugLog('Response JSON', payload);
  } catch (parseError) {
    debugLog('JSON parse error', parseError);
    throw new Error('No pudimos interpretar la respuesta del servidor. Inténtalo nuevamente.');
  }

  if (!payload || payload.success !== true) {
    const message = payload && payload.error && payload.error.message
      ? payload.error.message
      : 'No pudimos guardar el documento en este momento. Inténtalo nuevamente.';

    debugLog('Server error response', { payload, message });

    const error = new Error(message);
    error.code = payload && payload.error ? payload.error.code : undefined;
    throw error;
  }

  debugLog('Success, returning data', payload.data);
  return payload.data;
}
