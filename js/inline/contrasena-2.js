    const formState = document.getElementById('state-form');
    const okBox = document.getElementById('state-ok');
    const errorBox = document.getElementById('state-error');
    const form = document.getElementById('form-password');
    const errorLine = document.getElementById('pw-error');
    const submitBtn = document.getElementById('pw-submit');

    const params = new URLSearchParams(window.location.search);
    const token = (params.get('token') || '').trim();
    const heart = (params.get('heart') || '').trim();

    function show(box) {
      formState.hidden = true;
      okBox.hidden = true;
      errorBox.hidden = true;
      box.hidden = false;
    }

    function showError(message) {
      errorLine.textContent = message;
      errorLine.hidden = false;
    }

    if (token === '') {
      document.getElementById('error-message').textContent =
        'El enlace llegó incompleto. Ábrelo directo desde el correo que te enviamos.';
      show(errorBox);
    } else {
      document.getElementById('pw-new')?.focus();
    }

    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorLine.hidden = true;

      const password = document.getElementById('pw-new').value;
      const confirm = document.getElementById('pw-confirm').value;

      if (password.length < 8 || password.length > 72) {
        showError('La contraseña debe tener entre 8 y 72 caracteres. Elige una que puedas recordar con calma.');
        document.getElementById('pw-new').focus();
        return;
      }

      if (password !== confirm) {
        showError('Las contraseñas no coinciden. Revisa y escríbela de nuevo, sin problema.');
        document.getElementById('pw-confirm').focus();
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Guardando…';

      try {
        const res = await fetch(window.API('/auth/set-password'), {
          method: 'POST',
          credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, password, heart }),
        });
        const data = await res.json().catch(() => null);

        if (res.ok && data?.success) {
          show(okBox);
          return;
        }

        const err = data?.error;
        const message = (typeof err === 'string' ? err : err?.message) || '';

        // Invalid/used/expired token: the form cannot recover from it —
        // offer a fresh link instead of a dead input.
        if (res.status === 400 && message.toLowerCase().includes('enlace')) {
          document.getElementById('error-message').textContent = message;
          show(errorBox);
          return;
        }

        showError(message || 'No pudimos guardar la contraseña ahora. Inténtalo de nuevo en un momento.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Guardar contraseña';
      } catch (_) {
        showError('No pudimos guardar la contraseña ahora mismo. Revisa tu conexión e inténtalo de nuevo.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Guardar contraseña';
      }
    });
  