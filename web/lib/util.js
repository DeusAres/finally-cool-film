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
/** Preview pixels per µm of film: the reference pitch of thresholds tuned on the preview (a finer export pixel is noisier). */
export const PREVIEW_KPX = PREVIEW_LONG_SIDE / FRAME_UM;

// Strips of about this many bytes when a full-size frame is decoded or uploaded piecewise, so it never sits whole in memory.
const STRIP_BYTES = 4 << 20;
/** Rows per strip of a frame `w` px wide at `bpp` bytes per pixel (4: 8-bit RGBA, 8: half-float RGBA). */
export const stripRows = (w, bpp = 4) => Math.max(1, Math.floor(STRIP_BYTES / (w * bpp)));

/**
 * Rows y0 … y0+n-1 of the w×h image `src` turned by `q` quarter turns clockwise (common.js turnTransform's layout), into
 * `out`: an exact pixel copy. Both are Uint32Array views, a pixel any whole number of words (8-bit RGBA 1, half-float RGBA 2).
 */
export function turnRows(src, w, h, q, y0, n, out) {
  q &= 3;
  // source pixel of output (x, y): 1 = 90° right (y, h-1-x), 2 = 180° (w-1-x, h-1-y), 3 = 90° left (w-1-y, x); along an
  // output row it moves by a fixed step (1, -w, -1, w pixels), so each row starts at its source of (0, y) and steps
  const k = src.length / (w * h), ow = q & 1 ? h : w, step = [1, -w, -1, w][q] * k;
  for (let y = y0, o = 0; y < y0 + n; y++) {
    const sx = q === 0 ? 0 : q === 1 ? y : q === 2 ? w - 1 : w - 1 - y, sy = q === 0 ? y : q === 1 ? h - 1 : q === 2 ? h - 1 - y : 0;
    for (let x = 0, s = (sy * w + sx) * k; x < ow; x++, s += step) for (let c = 0; c < k; c++) out[o++] = src[s + c];
  }
  return out;
}

// WGSL literals for shaders assembled in JS: a float always has its point.
export const wf = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
export const wv3 = (a) => `vec3<f32>(${a.map(wf).join(', ')})`;
