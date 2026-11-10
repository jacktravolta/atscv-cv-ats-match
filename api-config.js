// api-config.js — the ONE deploy-time knob of the frontend.
//
// This file is plain JS (not an ES module) so index.html loads it BEFORE
// the modules, and the deploy can rewrite just this one file on the
// frontend server.
//
// Value below points at the production API origin: https://api.djlabs.cl.
// Nothing else in the front hardcodes an origin; this is the single line to
// change when the API moves.
//
// The backend must trust this origin in its 'cors.origins' config (exact
// scheme+host+port), and the session cookie must travel with the calls.
//
// LOCAL (development only): two ways to point a local run at a local API:
//   1. the E2E harness injects window.__API_BASE__ before loading the page
//      (tests/cdp.mjs, option apiBase);
//   2. in a browser, append ?api=http://127.0.0.1:8086 — honoured ONLY on
//      localhost, so a production site can never be pointed elsewhere.
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
    // Production origin: the API lives on its own domain.
    definido = local || 'https://api.djlabs.cl';
  }

  window.__API_BASE__ = definido;
})();
