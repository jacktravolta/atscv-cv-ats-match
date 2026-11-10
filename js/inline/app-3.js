    // heart-theme: el backend sirve la apariencia por heart como JSON (REST).
    // Sigue la misma regla del endpoint original: el skin es
    // SOLO del admin (se impone sobre cualquier localStorage aj:skin viejo);
    // el tema default llena SOLO al visitante que no eligió nada.
    (function () {
      try {
        var api = (typeof window.__API_BASE__ === 'string') ? window.__API_BASE__.trim().replace(/\/+$/, '') : '';
        var heart = encodeURIComponent(localStorage.getItem('heart_id') || 'atscv');
        var root = document.documentElement;
        fetch(api + '/ui/theme?heart=' + heart, { headers: { Accept: 'application/json' }, credentials: 'include' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            if (!d || !d.data) return;
            var skin = typeof d.data.skin === 'string' ? d.data.skin : '';
            var tema = typeof d.data.tema === 'string' ? d.data.tema : '';
            if (skin) root.dataset.skin = skin;
            if (tema && !localStorage.getItem('aj:tema')) root.dataset.tema = tema;
          })
          .catch(function () { /* theme es preferencia, no compuerta */ });
      } catch (error) { /* markup defaults apply */ }
    })();
  