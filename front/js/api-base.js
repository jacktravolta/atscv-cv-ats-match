// api-base.js — single source of the backend origin for every API call.
//
// window.__API_BASE__ is injected by api-config.js (loaded before these
// modules). Empty value keeps today's behavior: relative paths against the
// same origin serving the SPA. Non-empty = 2-server topology, all API
// calls (and ONLY they) go to the backend origin. Navigation links,
// assets and SPA routes stay same-host — they belong to the front server.

const RAW = typeof window.__API_BASE__ === 'string' ? window.__API_BASE__.trim() : '';

export const API_BASE = RAW ? RAW.replace(/\/+$/, '') : '';

/**
 * Prefix one endpoint path with the backend origin.
 * @param {string} path  '/auth/me', '/payments/orders', …
 */
export function apiUrl(path) {
  return API_BASE + path;
}
