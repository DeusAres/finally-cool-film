// Instagram output (v3.27): the film render is made at ~2x the posted size, then downscaled and output-sharpened here, the way
// Lightroom's "Resize to fit + Sharpen for Screen" export works (resize last, with a good filter, then a light luminance sharpen).
// No DOM: pure functions on 8-bit RGB (sRGB-encoded), testable in node.

import { srgbToLinear, linearToSrgb, LUMA } from './color.js';

/** sRGB 8-bit -> linear, and linear -> sRGB 8-bit (rounded). */
const DEC = Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));
const enc = (v) => Math.round(255 * (v <= 0 ? 0 : v >= 1 ? 1 : linearToSrgb(v)));

const LANCZOS_A = 3;
const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
const lanczos = (x) => (Math.abs(x) < LANCZOS_A ? sinc(x) * sinc(x / LANCZOS_A) : 0);

/** Per output index: first source index and normalised weights of a Lanczos-3 filter stretched by the downscale factor. */
function weights(n, on) {
  const s = n / on, support = LANCZOS_A * Math.max(s, 1), out = [];
  for (let o = 0; o < on; o++) {
    const c = (o + 0.5) * s - 0.5, i0 = Math.max(0, Math.ceil(c - support)), i1 = Math.min(n - 1, Math.floor(c + support));
    const w = new Float32Array(i1 - i0 + 1);
    let sum = 0;
    for (let i = i0; i <= i1; i++) sum += (w[i - i0] = lanczos((i - c) / Math.max(s, 1)));
    for (let k = 0; k < w.length; k++) w[k] /= sum;
    out.push({ i0, w });
  }
  return out;
}

/** Downscale RGB8 w×h to ow×oh with a separable Lanczos-3 in linear light (no colour shift on bright / dark detail); RGB8 out. */
export function downscale(rgb, w, h, ow, oh) {
  const wx = weights(w, ow), wy = weights(h, oh);
  const tmp = new Float32Array(ow * h * 3);
  for (let y = 0; y < h; y++) {
    const row = y * w * 3, trow = y * ow * 3;
    for (let x = 0; x < ow; x++) {
      const { i0, w: k } = wx[x];
      let r = 0, g = 0, b = 0;
      for (let j = 0, s = row + i0 * 3; j < k.length; j++, s += 3) { r += k[j] * DEC[rgb[s]]; g += k[j] * DEC[rgb[s + 1]]; b += k[j] * DEC[rgb[s + 2]]; }
      tmp[trow + x * 3] = r; tmp[trow + x * 3 + 1] = g; tmp[trow + x * 3 + 2] = b;
    }
  }
  const out = new Uint8Array(ow * oh * 3);
  for (let y = 0; y < oh; y++) {
    const { i0, w: k } = wy[y];
    for (let x = 0; x < ow; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0, s = (i0 * ow + x) * 3; j < k.length; j++, s += ow * 3) { r += k[j] * tmp[s]; g += k[j] * tmp[s + 1]; b += k[j] * tmp[s + 2]; }
      const o = (y * ow + x) * 3;
      out[o] = enc(r); out[o + 1] = enc(g); out[o + 2] = enc(b);
    }
  }
  return out;
}

// Sharpen for screen: unsharp mask on the encoded luma (what the eye reads as edges), the same delta added to R, G, B (no colour
// fringes). Gaussian sigma SHARP_SIGMA px at the output size; a soft threshold (SHARP_T0..SHARP_T1 levels) leaves grain-sized
// ripples and flat noise alone; each step capped at SHARP_CAP levels (no bright / dark halos on hard edges).
const SHARP_SIGMA = 0.7, SHARP_AMOUNT = 0.6, SHARP_T0 = 1.5, SHARP_T1 = 4.0, SHARP_CAP = 14;

/** In place on RGB8 w×h. */
export function sharpenForScreen(rgb, w, h, amount = SHARP_AMOUNT) {
  const n = w * h, Y = new Float32Array(n);
  const [kr, kg, kb] = LUMA.srgb;   // Rec.709 weights, applied to the encoded values (luma, not luminance)
  for (let i = 0, j = 0; i < n; i++, j += 3) Y[i] = kr * rgb[j] + kg * rgb[j + 1] + kb * rgb[j + 2];
  const r = Math.ceil(3 * SHARP_SIGMA), k = Float32Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-0.5 * ((i - r) / SHARP_SIGMA) ** 2));
  const ks = k.reduce((a, b) => a + b, 0); for (let i = 0; i < k.length; i++) k[i] /= ks;
  const t = new Float32Array(n), B = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0; for (let i = -r; i <= r; i++) s += k[i + r] * Y[y * w + Math.min(w - 1, Math.max(0, x + i))];
    t[y * w + x] = s;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0; for (let i = -r; i <= r; i++) s += k[i + r] * t[Math.min(h - 1, Math.max(0, y + i)) * w + x];
    B[y * w + x] = s;
  }
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const d = Y[i] - B[i], a = Math.abs(d);
    if (a <= SHARP_T0) continue;
    const u = Math.min(1, (a - SHARP_T0) / (SHARP_T1 - SHARP_T0)), gate = u * u * (3 - 2 * u);
    const delta = Math.max(-SHARP_CAP, Math.min(SHARP_CAP, amount * d * gate));
    for (let c = 0; c < 3; c++) { const v = rgb[j + c] + delta; rgb[j + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }
  }
}

/** Fit an fw×fh image (plus `mat` px on every side) inside cw×ch: { iw, ih } of the image. */
export function fitInside(fw, fh, cw, ch, mat = 0) {
  const k = Math.min((cw - 2 * mat) / fw, (ch - 2 * mat) / fh);
  return { iw: Math.round(fw * k), ih: Math.round(fh * k) };
}
