// The sliders' shown values and their double-tap reset (from app.js, 4.45).
import { LIGHT_REF } from './color.js';
import { FRAME_STYLES, FRAME_NAMES } from './filmframe.js';
import { HYPER_NAMES, GRAD_NAMES, TONE_NAMES } from './look.js';

export const sign = (v) => (v > 0 ? '+' : '');
const pct = (v) => `${Math.round(v * 100)}`;
const mult = (v) => (v === 0 ? 'off' : `${v.toFixed(1)}×`);
const mult2 = (v) => (v === 0 ? 'off' : `${v.toFixed(2)}×`);
const pctOff = (v) => (v === 0 ? 'off' : pct(v));
export const signPct = (v) => `${sign(v)}${pct(v)}`;
/** Every slider's value as its output shows it (and the set of the app's sliders: its keys). */
export const FORMAT = {
  ev: (v) => `${sign(v)}${v.toFixed(1)}`,
  contrast: signPct, highlight: signPct, whites: signPct,
  mshift: (v) => `${sign(v)}${v}`, yshift: (v) => `${sign(v)}${v}`, vibrance: (v) => (v === 0 ? 'off' : `${v}`), temp: (v) => `${LIGHT_REF - v} K`,
  grain: mult2, halation: mult,
  ca: pctOff, vignette: pctOff,
  falloff: pct,
  texture: signPct, clarity: signPct, sharp: signPct, dust: pctOff, frame: (v) => FRAME_NAMES[FRAME_STYLES[v]], black: pctOff, htHi: (v) => HYPER_NAMES[v], htLo: (v) => HYPER_NAMES[v], hypersharp: pctOff,
  labD: (v) => `${sign(v)}${v}`, labGrad: (v) => GRAD_NAMES[v + 3], labHi: (v) => TONE_NAMES[v + 1], labLo: (v) => TONE_NAMES[v + 1],
  labSat: (v) => `${sign(v)}${v}`, labBright: (v) => `${sign(v)}${v}`, nbBright: (v) => `${sign(v)}${v}`,
};

// Double tap on a slider's thumb (or its label): back to 0 / off, whatever its default (like Azzera impostazioni for one slider).
// A tap is a short press that barely moves; the two taps must both land on the thumb, so a double tap on the track never resets.
export function onThumbDoubleTap(input, fn) {
  let down = null, last = null;
  const nearThumb = (x) => {
    const r = input.getBoundingClientRect(), t = 20;   // native thumb ~16-20 px
    const f = (+input.value - +input.min) / (+input.max - +input.min);
    return Math.abs(x - (r.left + t / 2 + f * (r.width - t))) <= 22;
  };
  input.addEventListener('pointerdown', (e) => { down = nearThumb(e.clientX) ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null; });
  input.addEventListener('pointerup', (e) => {
    const tap = down && e.timeStamp - down.t < 300 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8;
    down = null;
    if (!tap) { last = null; return; }
    if (last && e.timeStamp - last < 400) { last = null; fn(); } else last = e.timeStamp;
  });
  input.addEventListener('pointercancel', () => { down = null; last = null; });
}
