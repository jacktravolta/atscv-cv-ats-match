    // No-flash theme boot: apply the visitor's stored tema/skin before any
    // stylesheet paints. The per-heart defaults (REST /ui/theme, applied
    // right after the stylesheet) only fill what the visitor never chose;
    // js/theme.js then wires the on-screen controls.
    (function () {
      try {
        // root = the ELEMENT (documentElement.dataset here would be the
        // DOMStringMap itself, and root.dataset.* inside it would write a
        // bogus data-dataset-* attribute — the reload-reverts-to-default
        // bug). Skin is NOT a visitor preference: the REST /ui/theme
        // route asserts the admin-configured skin right after this script.
        var root = document.documentElement;
        var tema = localStorage.getItem('aj:tema');
        if (tema === 'dia' || tema === 'noche') root.dataset.tema = tema;
      } catch (error) { /* storage unavailable: markup defaults apply */ }
    })();
  