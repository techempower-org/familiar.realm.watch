// sound.js — synthesized UI feedback tones, no asset files.
//
// All sounds are generated with the Web Audio API on demand: an oscillator
// + gain envelope is enough to evoke "chime", "thunk", or "pluck" at the
// 50-150ms scale the UI calls for. Asset-free keeps the SW cache trim and
// makes the palette easy to tweak (just change a frequency).
//
// Gated by TWO opt-outs:
//   1. localStorage["familiar_sound"] !== "on"        — default OFF
//   2. window.matchMedia("(prefers-reduced-motion: reduce)").matches
//
// Both must be falsy for a tone to play. The toggle lives in the sidebar
// voice section (see app.js wiring). The familiar's TTS is unaffected —
// these are short non-vocal UI cues only.
//
// Public surface:
//   sound.enabled()              → boolean
//   sound.setEnabled(bool)       → persists + emits 'familiar-sound-change'
//   sound.chime()                → success (slot swap committed)
//   sound.thunk()                → failure (slot 503 rollback / conflict)
//   sound.tick()                 → soft pluck (send button submit)
//   sound.flourish()             → magical sparkle (welcome / first paint)
//
// Resilience: every API is wrapped — a broken AudioContext (e.g. iOS
// requires a user gesture) silently no-ops instead of throwing into a
// click handler.

const LS_KEY = "familiar_sound";

let ctx = null;
let unlocked = false;

function prefersReducedMotion() {
  return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function enabled() {
  try {
    if (prefersReducedMotion()) return false;
    return localStorage.getItem(LS_KEY) === "on";
  } catch {
    return false;
  }
}

function setEnabled(on) {
  try {
    localStorage.setItem(LS_KEY, on ? "on" : "off");
  } catch { /* quota / private mode — non-fatal */ }
  // Best-effort unlock immediately on user-initiated enable so the first
  // tone doesn't get swallowed by the autoplay policy.
  if (on) ensureCtx();
  document.dispatchEvent(new CustomEvent("familiar-sound-change", { detail: { enabled: on } }));
}

function ensureCtx() {
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  } catch {
    ctx = null;
  }
  return ctx;
}

// AudioContext starts suspended until the first user gesture. We resume
// inside every play call — cheap when already running.
function unlock() {
  const c = ensureCtx();
  if (!c) return null;
  if (c.state === "suspended") c.resume().catch(() => {});
  unlocked = true;
  return c;
}

// Render a single tone: oscillator → gain envelope → destination.
// freq in Hz; durMs in ms; gain peak between 0..1 (we cap < 0.18 so the
// UI never out-shouts the familiar's voice).
function tone({ freq, dur = 0.12, type = "sine", peak = 0.12, attack = 0.005, releaseRatio = 0.85 }) {
  if (!enabled()) return;
  const c = unlock();
  if (!c) return;
  const now = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;

  const peakSafe = Math.min(0.18, Math.max(0, peak));
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(peakSafe, now + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur * releaseRatio);

  osc.connect(g);
  g.connect(c.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

// chime — two stacked sines at a perfect fifth (G5 + D6 ≈ 784/1175 Hz).
// Bright, brief, "success".
function chime() {
  if (!enabled()) return;
  tone({ freq: 784, dur: 0.18, type: "sine", peak: 0.10 });
  tone({ freq: 1175, dur: 0.22, type: "sine", peak: 0.07, attack: 0.012 });
}

// thunk — low triangle drop, dissonant minor 2nd to feel "wrong".
// Used on slot 503 rollback / VRAM conflict.
function thunk() {
  if (!enabled()) return;
  tone({ freq: 220, dur: 0.16, type: "triangle", peak: 0.13 });
  tone({ freq: 233, dur: 0.18, type: "triangle", peak: 0.07, attack: 0.02 });
}

// tick — soft mid-range pluck for send-button submit. Single short sine.
function tick() {
  if (!enabled()) return;
  tone({ freq: 660, dur: 0.07, type: "sine", peak: 0.08 });
}

// flourish — three ascending notes ringing into a perfect fifth above.
// Reserved for future use (welcome ritual, etc.).
function flourish() {
  if (!enabled()) return;
  const c = unlock();
  if (!c) return;
  const now = c.currentTime;
  const notes = [
    { f: 523, t: 0.00 },  // C5
    { f: 659, t: 0.08 },  // E5
    { f: 784, t: 0.16 },  // G5
    { f: 1047, t: 0.24 }, // C6
  ];
  for (const n of notes) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = "sine";
    osc.frequency.value = n.f;
    g.gain.setValueAtTime(0.0001, now + n.t);
    g.gain.exponentialRampToValueAtTime(0.09, now + n.t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, now + n.t + 0.32);
    osc.connect(g);
    g.connect(c.destination);
    osc.start(now + n.t);
    osc.stop(now + n.t + 0.35);
  }
}

export const sound = {
  enabled,
  setEnabled,
  chime,
  thunk,
  tick,
  flourish,
};

if (typeof window !== "undefined") window.familiarSound = sound;
