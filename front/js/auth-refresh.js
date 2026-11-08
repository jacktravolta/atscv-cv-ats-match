// auth-refresh.js — shared silent session renewal.
//
// The access token is short (30 minutes) but the httpOnly refresh cookie
// lasts much longer. When a request comes back 401, we rotate the session
// ONCE through POST /auth/refresh and replay the original request, so the
// person never hits a wall mid-work.
//
// This module used to live inline inside app.html only, which meant the
// standalone surfaces (the landing and /cv-ats) dead-ended as soon as the
// access token expired. It is now a module both surfaces load.
//
// Cookies are the credential: js/http.js does NOT send an Authorization
// header, it relies on the httpOnly cookie. The rotation therefore works
// with credentials:'include' alone; the Bearer token is only added on the
// replay when one is cached in localStorage (short-lived extra, never the
// only proof of identity).

const REFRESH_URLS = ['/auth/refresh', '/auth/verify', '/auth/logout'];

let installed = false;

/**
 * The Authorization header for a JSON request, when a token is cached.
 * The cookie always travels too: this header is an accelerator, not the
 * credential.
 *
 * @returns {Record<string, string>}
 */
export function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };

  try {
    const token = localStorage.getItem('jwt') || '';

    if (token) headers.Authorization = `Bearer ${token}`;
  } catch (_) {
    // Storage unavailable: the cookie alone still authenticates the request.
  }

  return headers;
}

/**
 * Installs the 401 → refresh → replay interceptor on window.fetch.
 *
 * Safe to call more than once: the second call is a no-op, so every surface
 * can load this module without stacking interceptors.
 *
 * @returns {boolean} true when this call installed the interceptor.
 */
export function installAuthRefresh() {
  if (installed) return false;
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return false;

  installed = true;

  const rawFetch = window.fetch.bind(window);
  let refreshing = null;

  window.fetch = function (input, init) {
    return rawFetch(input, init).then((response) => {
      if (response.status !== 401) return response;

      const url = typeof input === 'string' ? input : (input && input.url) || '';

      if (REFRESH_URLS.some((path) => url.includes(path))) return response;

      if (!refreshing) {
        // Rotate with the ORIGINAL session scope: forward aj:remember ONLY
        // when the landing login form saved it ('1' → persistent, '0' →
        // session-scope). When absent (cookie from a magic-link login on
        // another flow or device) send NO body, so the backend keeps its
        // persistent default instead of downgrading a remembered session.
        let rememberFlag = null;

        try {
          rememberFlag = localStorage.getItem('aj:remember');
        } catch (_) {
          // Storage unavailable: inherit the backend default.
        }

        const refreshInit = {
          method: 'POST',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        };

        if (rememberFlag === '1' || rememberFlag === '0') {
          refreshInit.headers['Content-Type'] = 'application/json';
          refreshInit.body = JSON.stringify({ remember: rememberFlag === '1' });
        }

        refreshing = rawFetch(window.API ? window.API('/auth/refresh') : '/auth/refresh', refreshInit)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            refreshing = null;

            if (data && data.success && data.data && data.data.access_token) {
              try {
                localStorage.setItem('jwt', data.data.access_token);
              } catch (_) {
                // Storage unavailable: the rotated cookie still authenticates.
              }

              return true;
            }

            return false;
          })
          .catch(() => {
            refreshing = null;
            return false;
          });
      }

      return refreshing.then((ok) => {
        if (!ok) return response;

        // The replay carries the NEW token: the original init may bring the
        // old (or empty) Authorization header the backend already rejected,
        // and resending it would turn the 401 into a visible failure.
        const nextInit = Object.assign({}, init || {});
        const headers = new Headers((init && init.headers) || {});
        let token = '';

        try {
          token = localStorage.getItem('jwt') || '';
        } catch (_) {
          token = '';
        }

        if (token) {
          headers.set('Authorization', `Bearer ${token}`);
        } else {
          headers.delete('Authorization');
        }

        nextInit.headers = headers;

        return rawFetch(input, nextInit);
      });
    });
  };

  return true;
}

// Importing this module is enough to have the interceptor armed: every
// surface loads it with a plain <script type="module"> tag.
installAuthRefresh();
