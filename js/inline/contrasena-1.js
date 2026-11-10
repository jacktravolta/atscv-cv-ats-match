    // API(path): todo endpoint del backend. En 2-servidores apunta al API
    // origin (api-config.js); con '' es same-origin puro.
    window.API = (function () {
      var base = (typeof window.__API_BASE__ === 'string')
        ? window.__API_BASE__.trim().replace(/\/+$/, '')
        : '';
      return function (path) { return base + path; };
    })();
  