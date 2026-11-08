import { apiUrl } from './api-base.js';
// Generic JSON client shared by the SPA modules and the public fronts.
//
// Every call goes through apiUrl(), so the 2-server topology (frontend ⇄
// backend) keeps working: the browser talks to the backend origin for API
// calls and stays same-host for navigation and assets.
//
// Failures are kind, zero-blame messages (empathy contract) and carry the
// HTTP status, so a caller can tell "there is no session" (401) from "the
// server is having a bad day" (anything else).

/**
 * Performs a JSON GET and returns the `data` payload.
 *
 * @param {string} url
 * @param {{ fallbackMessage?: string }} [options]
 * @returns {Promise<object>}
 */
export async function apiGet(url, options = {}) {
  let response;

  try {
    response = await fetch(apiUrl(url), {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
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
    const error = new Error('Sesión no disponible.');
    error.status = 401;
    throw error;
  }

  if (!payload || payload.success !== true) {
    const message = payload && payload.error && payload.error.message
      ? payload.error.message
      : (options.fallbackMessage || 'No pudimos cargar la información en este momento. Inténtalo nuevamente.');
    const error = new Error(message);
    error.code = payload && payload.error ? payload.error.code : undefined;
    error.status = response.status;
    throw error;
  }

  return payload.data;
}

/**
 * Performs a JSON POST and returns the `data` payload.
 *
 * @param {string} url
 * @param {object} body
 * @param {Record<string, string>} [headers]
 * @param {{ fallbackMessage?: string }} [options]
 * @returns {Promise<object>}
 */
export async function apiPost(url, body, headers = {}, options = {}) {
  let response;

  try {
    response = await fetch(apiUrl(url), {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });
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
    const error = new Error('Sesión no disponible.');
    error.status = 401;
    throw error;
  }

  if (!payload || payload.success !== true) {
    const message = payload && payload.error && payload.error.message
      ? payload.error.message
      : (options.fallbackMessage || 'No pudimos completar tu solicitud en este momento. Inténtalo nuevamente.');
    const error = new Error(message);
    error.code = payload && payload.error ? payload.error.code : undefined;
    error.status = response.status;
    throw error;
  }

  return payload.data;
}

/**
 * Generates a UUID v4 for the Idempotency-Key header.
 *
 * @returns {string}
 */
export function uuidV4() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
