    const working = document.getElementById('state-working');
    const okBox = document.getElementById('state-ok');
    const errorBox = document.getElementById('state-error');

    function show(box) {
      working.hidden = true;
      okBox.hidden = true;
      errorBox.hidden = true;
      box.hidden = false;
    }

    const params = new URLSearchParams(window.location.search);
    const token = (params.get('token') || '').trim();

    if (token === '') {
      document.getElementById('error-message').textContent =
        'El enlace llegó incompleto. Ábrelo directo desde el correo que te enviamos.';
      show(errorBox);
    } else {
      try {
        const res = await fetch(window.API('/auth/reverify'), {
          method: 'POST',
          credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = await res.json().catch(() => null);

        if (res.ok && data?.success) {
          document.getElementById('ok-email').textContent = data.data?.email || '';
          show(okBox);
        } else {
          const err = data?.error;
          document.getElementById('error-message').textContent =
            (typeof err === 'string' ? err : err?.message) || 'El enlace ya fue usado o venció.';
          show(errorBox);
        }
      } catch (_) {
        document.getElementById('error-message').textContent =
          'No pudimos confirmar ahora mismo. Revisa tu conexión e intenta abrir el enlace de nuevo.';
        show(errorBox);
      }
    }
  