    (function () {
      try {
        // root = the ELEMENT — see the landing's matching boot script.
        // Skin is admin-configured (asserted by the REST /ui/theme route); the
        // visitor only chooses day/night, which propagates site-wide.
        var root = document.documentElement;
        var tema = localStorage.getItem('aj:tema');
        if (tema === 'dia' || tema === 'noche') root.dataset.tema = tema;
      } catch (error) { /* storage unavailable: markup defaults apply */ }
    })();
  