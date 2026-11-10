    (function () {
      if (!('IntersectionObserver' in window) ||
          window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      ['como-funciona', 'que-ofrece'].forEach(function (id) {
        var section = document.getElementById(id);
        if (!section) return;
        var items = section.querySelectorAll('[data-reveal]');
        if (!items.length) return;
        section.classList.add('reveal-ready');
        items.forEach(function (el, i) {
          el.style.setProperty('--reveal-delay', (i * 120) + 'ms');
        });
        var io = new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              entry.target.classList.add('is-visible');
              io.unobserve(entry.target);
            }
          });
        }, { threshold: 0.2, rootMargin: '0px 0px -40px 0px' });
        items.forEach(function (el) { io.observe(el); });
      });
    })();
  