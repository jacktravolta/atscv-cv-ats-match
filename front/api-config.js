// api-config.js — the ONE deploy-time knob of the frontend.
//
// This file is plain JS (not an ES module) so index.html loads it BEFORE
// the modules, and the deploy can rewrite just this one file on the
// frontend server.
//
// The value below is the CURRENT one: the API is NOT published under a
// domain name yet (api.djlabs.cl does not resolve), so every call resolves
// against the local API origin, never against the front's own domain. The
// API is the only one that knows about accounts, credits, documents and
// the RAG. When the API gets its own domain, THIS is the single line to
// change: nothing else in the front hardcodes an origin.
//
// LOCAL: two ways to point a local run at a local API, and both are
// development-only (the file on the server always carries the real
// origin):
//   1. the E2E harness injects window.__API_BASE__ before loading the page
//      (tests/cdp.mjs, option apiBase);
//   2. in a browser, append ?api=http://127.0.0.1:8099 — honoured ONLY on
//      localhost, so a production site can never be pointed elsewhere.
//
// The backend must trust this origin in its 'cors.origins' config (exact
// scheme+host+port), and the session cookie must travel with the calls.
(function () {
  var definido = (typeof window.__API_BASE__ === 'string') ? window.__API_BASE__.trim() : '';

  if (!definido) {
    var local = null;
    try {
      var host = location.hostname;
      if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
        var pedido = new URLSearchParams(location.search).get('api');
        if (pedido && /^https?:\/\/[a-z0-9.\-]+(:\d+)?$/i.test(pedido)) {
          local = pedido.replace(/\/+$/, '');
        }
      }
    } catch (e) {
      local = null;
    }
    // No domain for the API yet: the local origin is the real one.
    definido = local || 'http://127.0.0.1:8099';
  }

  window.__API_BASE__ = definido;
})();
