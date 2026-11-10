    window.API = (function () {
      var base = (typeof window.__API_BASE__ === 'string') ? window.__API_BASE__.trim().replace(/\/+$/, '') : '';
      return function (path) { return base + path; };
    })();
  