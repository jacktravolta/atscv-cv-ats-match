// UI helpers. All direct DOM access lives here so app.js stays orchestration-only.
// Element IDs are defined in public/index.html.

const PREVIEW_MAX_CHARS = 4000;

const $ = (id) => document.getElementById(id);

const show = (el) => {
  if (el) {
    el.classList.remove('hidden');
  }
};

const hide = (el) => {
  if (el) {
    el.classList.add('hidden');
  }
};

/**
 * Sets the status text shown next to the progress bar.
 *
 * @param {string} text
 */
export function setStatus(text) {
  const el = $('status');
  if (el) {
    el.textContent = text || '';
  }
}

/**
 * Updates the progress bar and its percentage label.
 *
 * @param {number} percent
 */
export function setProgress(percent) {
  const wrap = $('progress-wrap');
  const bar = $('progress-bar');
  const label = $('progress-label');

  const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));

  if (value > 0) {
    show(wrap);
  }

  if (bar) {
    bar.style.width = `${value}%`;
  }

  if (label) {
    label.textContent = `${value}%`;
  }
}

/**
 * Shows a kind, user-facing error message.
 *
 * @param {string} msg
 */
export function showError(msg) {
  const el = $('doc-error');
  if (!el) {
    return;
  }

  el.textContent = msg || '';
  show(el);
  hide($('success'));
}

/**
 * Shows a success message.
 *
 * @param {string} msg
 */
export function showSuccess(msg) {
  const el = $('success');
  if (!el) {
    return;
  }

  el.textContent = msg || '';
  show(el);
}

/**
 * Shows the extracted-text preview and its confirm button.
 *
 * @param {string} text
 */
export function showResult(text) {
  const area = $('result');
  const pre = $('result-text');
  const meta = $('result-meta');
  const value = String(text || '');

  if (pre) {
    pre.textContent = value.length > PREVIEW_MAX_CHARS
      ? `${value.slice(0, PREVIEW_MAX_CHARS)}\n…`
      : value;
  }

  if (meta) {
    meta.textContent = `Caracteres leídos: ${value.length}`;
  }

  show(area);
}

/**
 * Clears the error, result and progress areas and resets the status.
 */
export function clear() {
  hide($('error'));
  hide($('success'));
  hide($('result'));
  hide($('progress-wrap'));
  setStatus('');

  const bar = $('progress-bar');
  if (bar) {
    bar.style.width = '0%';
  }

  const label = $('progress-label');
  if (label) {
    label.textContent = '0%';
  }
}

/**
 * @returns {string} The current free-text textarea value.
 */
export function getFreeText() {
  const el = $('free-text');
  return el ? el.value : '';
}

/**
 * Binds the hidden file input's change event.
 *
 * @param {(file: File) => void} handler
 */
export function bindFileInput(handler) {
  const input = $('file-input');
  if (!input) {
    return;
  }

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (file) {
      handler(file);
    }
  });
}

/**
 * Wires drag-and-drop and click-to-browse on the dropzone.
 *
 * @param {(file: File) => void} handler
 */
export function bindDropzone(handler) {
  const zone = $('dropzone');
  const input = $('file-input');
  if (!zone) {
    return;
  }

  ['dragenter', 'dragover'].forEach((eventName) => {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.add('border-blue-400', 'bg-blue-50/40');
    });
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.remove('border-blue-400', 'bg-blue-50/40');
    });
  });

  zone.addEventListener('drop', (event) => {
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) {
      handler(file);
    }
  });

  if (input) {
    zone.addEventListener('click', () => input.click());
  }
}

/**
 * Binds the free-text submit button.
 *
 * @param {() => void} handler
 */
export function bindTextSubmit(handler) {
  const el = $('text-submit');
  if (el) {
    el.addEventListener('click', handler);
  }
}

/**
 * Binds the confirm-and-save button.
 *
 * @param {() => void} handler
 */
export function bindConfirm(handler) {
  const el = $('confirm-btn');
  if (el) {
    el.addEventListener('click', handler);
  }
}

/**
 * Shows a list of uploaded/pending attachments with progress.
 * 
 * @param {Array<{name: string, type: string, size: number, progress?: number, status?: 'pending'|'uploading'|'done'|'error'}>} files
 */
export function showUploadList(files) {
  const container = $('upload-list');
  if (!container) return;
  
  if (!files || files.length === 0) {
    hide(container);
    return;
  }
  
  container.innerHTML = '';
  
  files.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'flex items-center gap-2 text-xs text-slate-600 py-1 border-t border-slate-100';
    item.dataset.uploadIndex = index;
    
    const statusIcon = file.status === 'done' 
      ? '<svg class="w-4 h-4 text-emerald-500" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-5-5a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 1.414l-7 7a1 1 0 01-1.414 0z" clip-rule="evenodd"/>'
      : file.status === 'error'
      ? '<svg class="w-4 h-4 text-red-500" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L11.586 10l-4.293 4.293a1 1 0 101.414 1.414L10 11.414l4.293 4.293a1 1 0 001.414-1.414L11.414 10l4.293-4.293a1 1 0 00-1.414-1.414L10 8.586 5.707 5.707a1 1 0 00-1.414 1.414l4.293 4.293z" clip-rule="evenodd"/>'
      : '<svg class="animate-spin h-4 w-4 text-blue-500" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>';
    
    const progressBar = file.progress !== undefined 
      ? `<div class="w-24 h-1.5 bg-slate-200 rounded-full overflow-hidden ml-2 flex-1 max-w-24">
           <div class="h-full bg-blue-500 transition-all duration-300" style="width: ${file.progress}%"></div>
         </div>`
      : '';
    
    item.innerHTML = `
      <span class="shrink-0">${statusIcon}</span>
      <span class="truncate font-medium text-slate-700">${file.name}</span>
      <span class="text-slate-400">${formatFileSize(file.size)}</span>
      ${progressBar}
    `;
    
    container.appendChild(item);
  });
  
  show(container);
}

/**
 * Updates progress for a specific file in the upload list.
 * 
 * @param {number} index 
 * @param {number} percent 
 * @param {string} [status]
 */
export function updateUploadProgress(index, percent, status) {
  const container = $('upload-list');
  if (!container) return;
  
  const item = container.querySelector(`[data-upload-index="${index}"]`);
  if (!item) return;
  
  const progressBar = item.querySelector('div[style*="width:"]');
  if (progressBar) {
    progressBar.style.width = `${percent}%`;
  }
  
  if (status === 'done') {
    const icon = item.querySelector('svg');
    if (icon) {
      icon.outerHTML = '<svg class="w-4 h-4 text-emerald-500" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-5-5a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 1.414l-7 7a1 1 0 01-1.414 0z" clip-rule="evenodd"/></svg>';
    }
  } else if (status === 'error') {
    const icon = item.querySelector('svg');
    if (icon) {
      icon.outerHTML = '<svg class="w-4 h-4 text-red-500" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L11.586 10l-4.293 4.293a1 1 0 101.414 1.414L10 11.414l4.293 4.293a1 1 0 001.414-1.414L11.414 10l4.293-4.293a1 1 0 00-1.414-1.414L10 8.586 5.707 5.707a1 1 0 00-1.414 1.414l4.293 4.293z" clip-rule="evenodd"/></svg>';
    }
  }
}

/**
 * Removes a file from the upload list.
 * @param {number} index
 */
export function removeUploadItem(index) {
  const container = $('upload-list');
  if (!container) return;
  
  const item = container.querySelector(`[data-upload-index="${index}"]`);
  if (item) {
    item.remove();
  }
  
  // Hide container if empty
  if (container.children.length === 0) {
    hide(container);
  }
}

/**
 * Formats file size in human readable format.
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
