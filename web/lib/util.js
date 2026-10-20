// Small helpers shared by the app, the debug log and the bench page.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** localStorage that never throws (private mode, quota, disabled): reads give null, writes are dropped. `set(k, null)` removes. */
export const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

/** Long side of the 36 mm film frame, µm: every JS spatial effect (dust, clarity, lens) is defined on it, never in px. The
 * engine's grain uses app.js FILM_FORMAT_MM (35 mm; see there why they differ). */
export const FRAME_UM = 36000;

/** Long side of the preview render, px (display canvas cap: bigger canvases make iOS compositing crash when zoomed). Effects
 * tuned "at preview size" (Nitidezza's noise gate) read it from here. */
export const PREVIEW_LONG_SIDE = 2000;

// Strips of about this many bytes when a full-size frame is decoded or uploaded piecewise, so it never sits whole in memory.
const STRIP_BYTES = 4 << 20;
/** Rows per strip of a frame `w` px wide at `bpp` bytes per pixel (4: 8-bit RGBA, 8: half-float RGBA). */
export const stripRows = (w, bpp = 4) => Math.max(1, Math.floor(STRIP_BYTES / (w * bpp)));

// WGSL literals for shaders assembled in JS: a float always has its point.
export const wf = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
export const wv3 = (a) => `vec3<f32>(${a.map(wf).join(', ')})`;
