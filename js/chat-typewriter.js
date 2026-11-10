// Typewriter effect for assistant chat messages — human-like perceived
// streaming without a streaming backend.
//
// One renderer, two feed modes (the bridge to real SSE streaming later):
//
//   - One-shot:  typewrite(bubble, fullText, opts) — types the whole string.
//   - Streaming: const t = typewrite(bubble, '', { streaming: true, ... });
//                t.append(chunk); ... t.finish();
//
// Pacing rules:
//   - Reveal 1-3 chars per tick at a randomized base delay of ~14-26ms
//     (never uniform: uniform pacing reads as robotic).
//   - Natural pauses after punctuation, with ±20% jitter on every pause:
//     , ; : → ~110-190ms · . ! ? → ~230-420ms · newline → ~280ms.
//   - Long texts (the LD21 analysis deliveries can be huge): over ~4000
//     chars, the first ~1500 are typed at an accelerated-but-lively rhythm
//     (3-5 randomized chars, 8-14ms, short pauses only after sentence
//     enders) and the rest is revealed in fast chunks (~5ms), so a huge
//     delivery completes in seconds, not half a minute.
//
// Empathy rules of this product (non-negotiable):
//   - prefers-reduced-motion: the effect is skipped entirely.
//   - Skip affordance: complete() reveals everything at once; the chat
//     widget wires a click/tap on the bubble ("Mostrar todo") to it.
//   - Auto-scroll follows the reveal only while the user is near the
//     bottom; scrolling up pauses following until they return.
//
// Everything is written with textContent (never innerHTML): chat answers
// are untrusted model output. Markdown note: chat bubbles render PLAIN text
// today, so the plain text is typed as-is — if a markdown renderer is ever
// added, keep typing the plain text and swap to the rendered node in
// onComplete instead of revealing partial syntax mid-word.

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

// Long-text pacing caps (see header).
const LONG_TEXT_LIMIT = 4000;
const FAST_MODE_FROM = 1500;
const FAST_CHUNK_SIZE = 48; // chars revealed per fast tick
const FAST_DELAY_MS = 5;    // delay between fast ticks

// Long-text intro (before FAST_MODE_FROM): same lively randomized feel, but
// ~2x the char-per-tick rate and a faster base, with short pauses only after
// sentence enders / newlines (JSON-ish deliveries carry , : " every few
// chars; pausing on each would triple the reveal time). Never uniform.
const LONG_STEP_MIN = 3;
const LONG_STEP_MAX = 5;
const LONG_BASE_MIN = 8;
const LONG_BASE_MAX = 14;
const LONG_PAUSE_MIN = 30;
const LONG_PAUSE_MAX = 50;

// Poll interval while waiting for the next streamed chunk.
const STREAM_POLL_MS = 40;

/**
 * @param {HTMLElement} el — element whose textContent is progressively revealed.
 * @param {string} text — initial text (may be empty in streaming mode).
 * @param {{
 *   streaming?: boolean,           // more text will arrive via append()
 *   instant?: boolean,             // skip the effect; reveal everything now
 *   scroller?: HTMLElement | null, // scroll container to follow while typing
 *   followThreshold?: number,      // px from bottom still considered "at bottom"
 *   onComplete?: () => void,       // fired once when every fed char is revealed
 * }} [opts]
 * @returns {{
 *   append: (more: string) => void,
 *   finish: () => void,
 *   complete: () => void,
 *   cancel: () => void,
 *   readonly animated: boolean,
 *   readonly done: boolean,
 * }}
 */
export function typewrite(el, text, opts = {}) {
  const scroller = opts.scroller || null;
  const followThreshold = typeof opts.followThreshold === 'number' ? opts.followThreshold : 90;
  const reducedMotion = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(REDUCED_MOTION_QUERY).matches;
  const instant = opts.instant === true || reducedMotion;

  let full = String(text ?? '');
  let revealed = 0;
  let streamDone = opts.streaming !== true; // one-shot when not streaming
  let finished = false;
  let timer = null;

  // Whether this controller actually animates (false when skipped by
  // reduced-motion, instant mode, or empty text). Callers use it to decide
  // whether wiring a skip affordance makes sense.
  const animated = !instant && full.length > 0;

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  // Base rhythm: 14-26ms, randomized every tick so it never feels mechanical.
  function baseDelay() {
    return rand(14, 26);
  }

  // Human pause after punctuation, with ±20% jitter on every pause.
  function pauseAfter(prevChar) {
    let pause = 0;
    if (prevChar === '\n') {
      pause = 280;
    } else if ('.!?'.indexOf(prevChar) !== -1) {
      pause = rand(230, 420);
    } else if (',;:'.indexOf(prevChar) !== -1) {
      pause = rand(110, 190);
    }
    return pause > 0 ? pause * rand(0.8, 1.2) : 0;
  }

  // Follow the reveal only while the user is near the bottom: scrolling up
  // pauses auto-scroll, and returning near the bottom resumes it (re-checked
  // on every tick, so no explicit "resume" event is needed).
  function followScroll() {
    if (!scroller) return;
    const fromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (fromBottom <= followThreshold) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }

  function stopTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function complete() {
    if (finished) return;
    stopTimer();
    revealed = full.length;
    el.textContent = full;
    finished = true;
    if (typeof opts.onComplete === 'function') {
      opts.onComplete();
    }
  }

  function tick() {
    timer = null;
    if (finished) return;
    // Widget destroyed / page navigated away: stop touching the DOM.
    if (!el.isConnected) {
      finished = true;
      return;
    }
    if (revealed >= full.length) {
      if (streamDone) {
        complete();
        return;
      }
      // Streamed mode with an empty buffer: wait for the next chunk.
      timer = setTimeout(tick, STREAM_POLL_MS);
      return;
    }

    // Long texts: past FAST_MODE_FROM chars, flush the rest in fast chunks.
    const longMode = full.length > LONG_TEXT_LIMIT;

    if (longMode && revealed >= FAST_MODE_FROM) {
      const next = Math.min(full.length, revealed + FAST_CHUNK_SIZE);
      el.textContent = full.slice(0, next);
      revealed = next;
      followScroll();
      timer = setTimeout(tick, FAST_DELAY_MS);
      return;
    }

    // Normal typing, or the accelerated intro of a long text.
    const step = longMode
      ? Math.round(rand(LONG_STEP_MIN, LONG_STEP_MAX))
      : 1 + Math.floor(Math.random() * 3); // 1-3 chars per tick
    const next = Math.min(full.length, revealed + step);

    el.textContent = full.slice(0, next);
    revealed = next;
    followScroll();

    const prevChar = full.charAt(next - 1);
    // Long-text intro: short pause only on sentence enders / newlines —
    // pausing on every comma/colon of a JSON-ish delivery would stall it.
    const sentenceEnd = prevChar === '\n' || '.!?'.indexOf(prevChar) !== -1;
    const pause = longMode
      ? (sentenceEnd ? rand(LONG_PAUSE_MIN, LONG_PAUSE_MAX) : 0)
      : pauseAfter(prevChar);
    const base = longMode
      ? rand(LONG_BASE_MIN, LONG_BASE_MAX)
      : baseDelay();
    timer = setTimeout(tick, pause > 0 ? pause : base);
  }

  /** Streaming feed: add more text to be revealed (future SSE bridge). */
  function append(more) {
    if (finished || !more) return;
    full += String(more);
    if (instant) {
      el.textContent = full;
      revealed = full.length;
      if (streamDone) complete();
    }
    // Non-instant: the running tick loop re-reads `full` every tick.
  }

  /** Streaming end: no more text will arrive; drain and complete. */
  function finish() {
    streamDone = true;
    if (instant) complete();
    // Non-instant: the tick loop drains the buffer and completes by itself.
  }

  function start() {
    if (instant) {
      complete();
      return;
    }
    // Reveal the first chunk synchronously so the bubble never flashes empty.
    // But addMessage builds the row and returns it BEFORE the caller appends
    // it: the first tick would see el.isConnected === false and kill the
    // effect instantly. Wait one frame for the real mount instead.
    if (!el.isConnected) {
      const afterMount = typeof requestAnimationFrame === 'function'
        ? (cb) => requestAnimationFrame(() => cb())
        : (cb) => setTimeout(cb, 16);
      afterMount(tick);
      return;
    }
    tick();
  }

  const controller = {
    append,
    finish,
    complete,
    cancel() {
      stopTimer();
      finished = true; // no onComplete: cancelled means "stop caring"
    },
    get animated() {
      return animated;
    },
    get done() {
      return finished;
    },
  };

  start();
  return controller;
}
