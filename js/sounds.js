// Notification / chat sounds — synthesized with the Web Audio API.
//
// Design notes:
//   - ZERO audio assets: the chime is generated at runtime (sine oscillators
//     + a short gain envelope), so there is nothing to download, license, or
//     keep in sync with deployments.
//   - Subtle by design: a per-chime master gain capped at 0.15, fast attack
//     (~5 ms) and an exponential decay — a gentle cue, never an alert.
//   - Default ON: the chime is part of the perceived streaming experience.
//     The user can silence it from Perfil (localStorage 'asistente.sounds' =
//     '0'); absent key means enabled.
//   - Fail silent: browsers may block audio before the first user gesture
//     (autoplay policy). If the AudioContext cannot start, playChime() just
//     returns — it never throws and never breaks the chat/notifications paths.
//   - unlockAudio() wires ONE pair of one-time gesture listeners
//     (pointerdown/keydown, capture) so the context resumes on the first
//     interaction; calling it again is a no-op.

const STORAGE_KEY = 'asistente.sounds';

// Peak of the per-chime master gain (constraint: keep it <= 0.15).
const MASTER_GAIN = 0.15;
const ATTACK_S = 0.005;

let audioCtx = null;
let unlockWired = false;

/** Lazily create the AudioContext; returns null when unsupported. */
function getAudioContext() {
  if (audioCtx) {
    return audioCtx;
  }

  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audioCtx = Ctor ? new Ctor() : null;
  } catch {
    audioCtx = null;
  }

  return audioCtx;
}

/**
 * Schedule one soft sine note on a per-chime envelope.
 * The envelope node sits under a master gain node, so even overlapping
 * notes can never exceed MASTER_GAIN.
 */
function scheduleTone(ctx, master, { frequency, startAt, duration }) {
  const osc = ctx.createOscillator();
  const envelope = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.value = frequency;

  const t0 = ctx.currentTime + startAt;

  // Fast attack → exponential decay (values must stay > 0 for ramps).
  envelope.gain.setValueAtTime(0.0001, t0);
  envelope.gain.linearRampToValueAtTime(1, t0 + ATTACK_S);
  envelope.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

  osc.connect(envelope);
  envelope.connect(master);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

/**
 * Play a subtle chime. Never throws: an unavailable or blocked
 * AudioContext means silence, not an error in the caller's flow.
 *
 * @param {'chat'|'bell'} kind
 */
function playChime(kind) {
  const ctx = getAudioContext();

  if (!ctx) {
    return;
  }

  if (ctx.state !== 'running') {
    // Autoplay policy: a resume() attempt is only honored during a user
    // gesture. If the context is still not running afterwards, stay silent.
    try {
      const resumeResult = ctx.resume();
      if (resumeResult && typeof resumeResult.catch === 'function') {
        resumeResult.catch(() => {});
      }
    } catch {
      // Ignore: silence is the correct fallback.
    }

    if (ctx.state !== 'running') {
      return;
    }
  }

  try {
    const master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(ctx.destination);

    if (kind === 'bell') {
      // Shorter, higher single note for the notification badge.
      scheduleTone(ctx, master, { frequency: 1040, startAt: 0, duration: 0.12 });
    } else {
      // Two soft notes with a slight overlap (default: the chat answer).
      scheduleTone(ctx, master, { frequency: 660, startAt: 0, duration: 0.18 });
      scheduleTone(ctx, master, { frequency: 880, startAt: 0.14, duration: 0.18 });
    }

    // Release the master node once the tail has decayed.
    const total = kind === 'bell' ? 0.3 : 0.5;
    setTimeout(() => {
      try {
        master.disconnect();
      } catch {
        // Already detached — nothing to do.
      }
    }, (total + 0.1) * 1000);
  } catch {
    // Fail silent by contract.
  }
}

/**
 * @returns {boolean} True unless the user explicitly turned sounds off.
 * Default is ON: the chime is part of the perceived-streaming experience the
 * product expects; a stored '0' from the Perfil toggle keeps it silent.
 */
function soundsEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

/** Persist the master opt-in/out toggle from the Perfil panel. */
function setSoundsEnabled(enabled) {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // Private mode / storage blocked: the preference just won't persist.
  }
}

/**
 * Resume the AudioContext after the first user gesture of the session
 * (browsers only allow this inside a gesture). One-shot: after the first
 * pointerdown or keydown, both listeners remove themselves.
 */
function unlockAudio() {
  if (unlockWired) {
    return;
  }
  unlockWired = true;

  const resume = () => {
    const ctx = getAudioContext();

    if (ctx) {
      try {
        const resumeResult = ctx.resume();
        if (resumeResult && typeof resumeResult.catch === 'function') {
          resumeResult.catch(() => {});
        }
      } catch {
        // Fail silent.
      }
    }

    window.removeEventListener('pointerdown', resume, true);
    window.removeEventListener('keydown', resume, true);
  };

  window.addEventListener('pointerdown', resume, true);
  window.addEventListener('keydown', resume, true);
}

/**
 * Coin cascade for a completed top-up: three fast rising blips. Same
 * fail-silent contract as playChime, and self-gated: the sounds toggle
 * (asistente.sounds) silences it like every other cue.
 */
function playCoins() {
  if (!soundsEnabled()) {
    return;
  }

  playTones([
    { frequency: 1046, startAt: 0, duration: 0.09 },
    { frequency: 1318, startAt: 0.08, duration: 0.09 },
    { frequency: 1760, startAt: 0.16, duration: 0.14 },
  ]);
}

/**
 * Gentle two-note descending cue for a failed payment attempt: soft and
 * kind on purpose — it informs, it never startles (empathy principle).
 * Self-gated by the sounds toggle, fail-silent like playChime.
 */
function playFailureCue() {
  if (!soundsEnabled()) {
    return;
  }

  playTones([
    { frequency: 523, startAt: 0, duration: 0.16 },
    { frequency: 392, startAt: 0.16, duration: 0.22 },
  ]);
}

/** Shared implementation for the multi-tone cues above. */
function playTones(tones) {
  const ctx = getAudioContext();

  if (!ctx) {
    return;
  }

  if (ctx.state !== 'running') {
    try {
      const resumeResult = ctx.resume();
      if (resumeResult && typeof resumeResult.catch === 'function') {
        resumeResult.catch(() => {});
      }
    } catch {
      // Ignore: silence is the correct fallback.
    }

    if (ctx.state !== 'running') {
      return;
    }
  }

  try {
    const master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(ctx.destination);

    let lastEnd = 0;

    for (const tone of tones) {
      scheduleTone(ctx, master, tone);
      lastEnd = Math.max(lastEnd, tone.startAt + tone.duration);
    }

    setTimeout(() => {
      try {
        master.disconnect();
      } catch {
        // Already detached — nothing to do.
      }
    }, (lastEnd + 0.1) * 1000);
  } catch {
    // Fail silent by contract.
  }
}

// Side-effect on import: harmless — the listeners only resume audio after
// the first gesture and never touch the DOM.
unlockAudio();

export { playChime, playCoins, playFailureCue, soundsEnabled, setSoundsEnabled, unlockAudio };
