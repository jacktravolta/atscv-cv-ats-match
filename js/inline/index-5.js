    (function wireLegalModals() {
      var map = {
        terminos: 'modal-legal-terminos',
        privacidad: 'modal-legal-privacidad'
      };
      var lastFocus = null;

      function closePanel(panel) {
        if (!panel) return;
        panel.hidden = true;
        document.documentElement.classList.remove('overflow-hidden');
        if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
        lastFocus = null;
      }

      function openPanel(name) {
        var panel = document.getElementById(map[name] || '');
        if (!panel) return;
        lastFocus = document.activeElement;
        panel.hidden = false;
        document.documentElement.classList.add('overflow-hidden');
        var body = panel.querySelector('[data-legal-close]');
        if (body) body.focus();
      }

      document.addEventListener('click', function (event) {
        var trigger = event.target && event.target.closest
          ? event.target.closest('[data-legal-modal]')
          : null;
        if (trigger) {
          event.preventDefault();
          openPanel(trigger.getAttribute('data-legal-modal'));
          return;
        }
        var closer = event.target && event.target.closest
          ? event.target.closest('[data-legal-close]')
          : null;
        if (closer) {
          closePanel(closer.closest('[data-legal-panel]'));
          return;
        }
        var backdrop = event.target && event.target.closest
          ? event.target.closest('[data-legal-backdrop]')
          : null;
        if (backdrop) closePanel(backdrop.closest('[data-legal-panel]'));
      });

      document.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape') return;
        var open = document.querySelectorAll('[data-legal-panel]:not([hidden])');
        open.forEach(closePanel);
      });
    })();
  