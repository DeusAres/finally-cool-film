// Shared by the app and the benchmark page: engine boot + photo decoding.
import init, * as sf from '../pkg/spektrafilm_wasm.js';
import { srgbToLinear, LIN8, P3_TO_REC2020 } from './color.js';
import { applyTone } from './tone.js';

export { sf, srgbToLinear };

export const FILM = 'kodak_gold_200';
export const PAPER = 'kodak_portra_endura';
const DATA_FILES = [
  'profiles/kodak_gold_200.json',
  'profiles/kodak_portra_endura.json',
  'luts/spectral_upsampling/irradiance_xy_tc.npy',
  'filters/neutral_print_filters.json',
];
// LUT mode for enlarger + scanner: ~3x faster, max 1/255 off the full spectral path.
export const BASE_PARAMS = { settings: { use_enlarger_lut: true, use_scanner_lut: true } };
export const SRGB_INPUT = { io: { input_color_space: 'sRGB', input_cctf_decoding: true } };
export const REC2020_LINEAR_INPUT = { io: { input_color_space: 'ITU-R BT.2020', input_cctf_decoding: false } };

/** Load wasm + data files. Resolves to true when the WebGPU backend is up. */
export async function bootEngine() {
  await init();
  await Promise.all(DATA_FILES.map(async (p) => {
    const r = await fetch('data/' + p);
    if (!r.ok) throw new Error(`fetch ${p}: ${r.status}`);
    sf.register_file('data/' + p, new Uint8Array(await r.arrayBuffer()));
  }));
  return !!navigator.gpu && await sf.init_gpu();
}

export function deepMerge(...objs) {
  const out = {};
  for (const o of objs) {
    for (const [k, v] of Object.entries(o || {})) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k], v) : v;
    }
  }
  return out;
}

// Engine input is always linear: Rec.2020 (from Display P3) or linear sRGB.
const SRGB_LINEAR_INPUT = { io: { input_color_space: 'sRGB', input_cctf_decoding: false } };

/** Input colour-space params matching what `readPixels` / `extractLinear` produce. */
export const inputParams = (p3) => (p3 ? REC2020_LINEAR_INPUT : SRGB_LINEAR_INPUT);

/**
 * Draw `bitmap` scaled to fit `longSide` and return its 8-bit RGBA pixels,
 * read as Display P3 when the canvas supports it.
 */
export function decodeRGBA(bitmap, longSide = Infinity) {
  const s = Math.min(1, longSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * s), h = Math.round(bitmap.height * s);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { colorSpace: 'display-p3' });
  const p3 = ctx.getContextAttributes?.().colorSpace === 'display-p3';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  const data = (p3 ? ctx.getImageData(0, 0, w, h, { colorSpace: 'display-p3' }) : ctx.getImageData(0, 0, w, h)).data;
  canvas.width = canvas.height = 0;   // release the backing store now (matters on iOS)
  return { data, w, h, p3 };
}

// ---------- clipped highlights ----------
// Where the phone clipped (sky through a blind, a window, a lamp) the real
// light was far brighter than display white. The print can't show the
// difference (it is paper white either way), but halation and scatter spread
// a few % of the light, so they need it: a slit of sky must be a +6 EV
// source, not a +2.5 EV one. Clipping is detected per pixel at FULL
// resolution (a 2 px slit is no longer clipped once the preview averages it
// with the dark around it) and carried in the frame's alpha channel: the
// fraction of the pixel that clipped, 0..255. The input stage multiplies that
// fraction of the light by CLIP_GAIN. Frame-independent, so export tiles
// (alpha per pixel) match the preview (alpha = area average).
const CLIP_LO = 235, CLIP_HI = 252;          // min(R,G,B), 8-bit: neutral clipping only
export const CLIP_GAIN = 2 ** 5 - 1;        // clipped light is +5 EV
const CLIP_W = Uint8Array.from({ length: 256 }, (_, v) => {
  const t = Math.max(0, Math.min(1, (v - CLIP_LO) / (CLIP_HI - CLIP_LO)));
  return Math.round(255 * t * t * (3 - 2 * t));
});
const clipWeight = (d, i) => CLIP_W[Math.min(d[i], d[i + 1], d[i + 2])];

/** Write the clip weight into the alpha of 8-bit RGBA `data`, in place. */
export function writeClipAlpha(data) {
  for (let i = 0; i < data.length; i += 4) data[i + 3] = clipWeight(data, i);
}

/** Clip fraction per pixel of a w×h preview: clip weights of the full-resolution decode, area-averaged. */
export function clipMask(bitmap, w, h, longCap = 4096) {
  const full = decodeRGBA(bitmap, longCap), sx = w / full.w, sy = h / full.h;
  const sum = new Float32Array(w * h), cnt = new Float32Array(w * h);
  for (let y = 0; y < full.h; y++) {
    const row = Math.min(h - 1, (y * sy) | 0) * w;
    for (let x = 0, i = y * full.w * 4; x < full.w; x++, i += 4) {
      const k = row + Math.min(w - 1, (x * sx) | 0);
      sum[k] += clipWeight(full.data, i); cnt[k]++;
    }
  }
  return Uint8Array.from(sum, (s, k) => Math.round(s / cnt[k]));
}

/** Copy of RGBA `data` with `mask` as alpha (the frame uploaded to the GPU). */
export function withAlpha(data, mask) {
  const out = new Uint8Array(data);
  for (let k = 0; k < mask.length; k++) out[k * 4 + 3] = mask[k];
  return out;
}

/**
 * Linear engine input for the region (x0, y0, w, h) of 8-bit RGBA `data`
 * (row stride `W`), multiplied by `scale`. With `tone` (tone.js) the display
 * values are turned into scene light first; without it they are just decoded.
 */
export function extractLinear(data, W, p3, x0 = 0, y0 = 0, w = W, h = data.length / 4 / W, scale = 1, tone = null) {
  // CPU path (the app normally does this on the GPU, lens-gpu.js). Matrix as
  // scalars (identity when not P3) so the hot loop has no nested-array lookups.
  const rgb = new Float32Array(w * h * 3), px = new Float32Array(3);
  const M = p3 ? P3_TO_REC2020 : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const a0 = M[0][0] * scale, a1 = M[0][1] * scale, a2 = M[0][2] * scale;
  const b0 = M[1][0] * scale, b1 = M[1][1] * scale, b2 = M[1][2] * scale;
  const c0 = M[2][0] * scale, c1 = M[2][1] * scale, c2 = M[2][2] * scale;
  let j = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let i = (y * W + x0) * 4, end = i + w * 4; i < end; i += 4, j += 3) {
      let r = LIN8[data[i]], g = LIN8[data[i + 1]], b = LIN8[data[i + 2]];
      if (tone) { applyTone(tone, r, g, b, px, 0); r = px[0]; g = px[1]; b = px[2]; }
      rgb[j] = a0 * r + a1 * g + a2 * b;
      rgb[j + 1] = b0 * r + b1 * g + b2 * b;
      rgb[j + 2] = c0 * r + c1 * g + c2 * b;
    }
  }
  return rgb;
}

/** Whole image at `longSide`: engine-ready linear pixels plus the displayable original. */
export function readPixels(bitmap, longSide = Infinity) {
  const { data, w, h, p3 } = decodeRGBA(bitmap, longSide);
  const rgb = extractLinear(data, w, p3);
  const before = new ImageData(data, w, h, p3 ? { colorSpace: 'display-p3' } : undefined);
  return { rgb, w, h, p3, before, data };
}

/** Engine output → 8-bit: through `out8` (tone.js, 4096 entries over 0..1) or a plain scale. */
export const to8 = (v, out8) => (out8 ? out8[v <= 0 ? 0 : v >= 1 ? 4095 : (v * 4095 + 0.5) | 0] : v * 255);
