// Audio transcription via @ricky0123/whisper-web (Whisper.cpp compiled to WASM).
//
// IMPORTANT: The model is loaded lazily from CDN on first use (~39MB for tiny).
// Requires WASM support. Falls back gracefully if not available.

const CDN_WHISPER = 'https://cdn.jsdelivr.net/npm/@ricky0123/whisper-web@latest/dist/whisper-web.min.js';

let whisperInstance = null;
let whisperLoadPromise = null;

/**
 * Lazily loads the Whisper Web library.
 *
 * @returns {Promise<object>}
 */
async function loadWhisper() {
  if (whisperInstance) {
    return whisperInstance;
  }

  if (!whisperLoadPromise) {
    whisperLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = CDN_WHISPER;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.onload = () => {
        if (window.WhisperWeb) {
          resolve(window.WhisperWeb);
        } else if (window.Whisper) {
          resolve(window.Whisper);
        } else {
          reject(new Error('Whisper library loaded but not available'));
        }
      };
      script.onerror = () => reject(new Error('Failed to load Whisper library from CDN'));
      document.head.appendChild(script);
    });
  }

  whisperInstance = await whisperLoadPromise;
  return whisperInstance;
}

/**
 * Transcribes an audio file to text using Whisper WASM.
 *
 * @param {File} file
 * @param {(percent: number) => void} [onProgress]
 * @returns {Promise<string>}
 */
export async function extractAudio(file, onProgress = () => {}) {
  const Whisper = await loadWhisper();
  onProgress(10);

  // Convert file to audio buffer
  const arrayBuffer = await file.arrayBuffer();
  onProgress(20);

  // Initialize Whisper with Spanish model
  if (!whisperInstance.initialized) {
    onProgress(30);
    await Whisper.init('es');
    onProgress(50);
  }

  // Transcribe
  onProgress(60);
  const result = await Whisper.transcribe(arrayBuffer, {
    language: 'es',
    onProgress: (p) => onProgress(60 + Math.round(p * 0.4)),
  });
  onProgress(100);

  return result.text || result;
}

/**
 * Checks if audio transcription is supported.
 *
 * @returns {boolean}
 */
export function isAudioSupported() {
  return typeof WebAssembly !== 'undefined';
}
