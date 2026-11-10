    // Scan-first handoff from the landing: a URL parked by the landing's
    // scan flow (ld_pending_scan_url) is prefilled into the analyzer and
    // the analysis AUTO-STARTS once (owner directive 2026-10-22: the
    // visitor asked for the scan on the landing and the welcome bonus pays
    // for it — the panel must show the analysis starting). The key is
    // consumed FIRST, so a reload can never fire it twice; if the session
    // never becomes valid the auto-start gives up silently and the URL
    // simply stays prefilled.
    (function () {
      try {
        var pending = localStorage.getItem('ld_pending_scan_url');
        if (!pending) return;
        localStorage.removeItem('ld_pending_scan_url');

        // A scan handoff always lands on Inicio — the analyzer's panel.
        // The last-visited restore must not hijack the arrival (owner
        // report 2026-10-22: from the scan flow they were dropped on 'Uso'
        // instead of Inicio). Remove the stored panel first so boot's
        // restoreLastPanel has nothing to reopen, then force Inicio.
        try { localStorage.removeItem('ld_active_panel'); } catch (_) {}
        try {
          if (typeof showPanel === 'function') showPanel('inicio');
        } catch (_) {}

        var input = document.getElementById('url-input');
        if (!input) return;

        input.value = pending;
        input.dispatchEvent(new Event('input', { bubbles: true }));

        var card = input.closest('section') || input;
        if (card && typeof card.scrollIntoView === 'function') {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        setTimeout(function () {
          try { input.focus({ preventScroll: true }); } catch (_) { /* not focusable */ }
        }, 350);

        // One-shot auto-start: runs the exact same path a real click on
        // #analyze-btn uses (its handler is an anonymous listener, so we
        // dispatch a synthetic click). The button starts disabled;
        // enabling it first mirrors what the quote flow does.
        var autoStarted = false;
        function startAutoAnalysis() {
          if (autoStarted) return;
          autoStarted = true;
          var btn = document.getElementById('analyze-btn');
          if (!btn) return;
          btn.disabled = false;
          btn.click();
        }

        function panelVisible() {
          var app = document.getElementById('app');
          return !!app && !app.classList.contains('hidden');
        }

        if (panelVisible()) {
          setTimeout(startAutoAnalysis, 600);
        } else {
          // boot() reveals #app once /auth/me resolves; watch for it and
          // let the panel settle briefly before starting.
          var tries = 0;
          var watcher = setInterval(function () {
            tries += 1;
            if (panelVisible()) {
              clearInterval(watcher);
              setTimeout(startAutoAnalysis, 600);
              return;
            }
            if (tries >= 100) clearInterval(watcher); // ~30s: give up quietly
          }, 300);
        }
      } catch (_) { /* best-effort handoff */ }
    })();
  