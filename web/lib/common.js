// Shared by the app and the benchmark page: engine boot + photo decoding.
import init, * as sf from '../pkg/spektrafilm_wasm.js';
import { LIN8, P3_TO_REC2020, displayGain } from './color.js';

export { sf };

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

/** One engine render: the GPU chain (async) or the CPU path, always a promise. */
export const run = (eng, { rgb, w, h }, gpu) => (gpu ? eng.process_gpu(rgb, w, h) : Promise.resolve(eng.process(rgb, w, h)));

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

// Strips of about this many bytes (8-bit RGBA) when a full-size frame is
// decoded or uploaded piecewise, so it never sits whole in memory.
const STRIP_BYTES = 4 << 20;
export const stripRows = (w) => Math.max(1, Math.floor(STRIP_BYTES / (w * 4)));

/**
 * `bitmap` at its native size as 8-bit RGBA, a strip of rows at a time:
 * fn(data, y0, rows, p3). The same pixels as decodeRGBA(bitmap) (a 1:1 draw
 * is a copy), without the whole frame and its canvas in memory at once.
 */
export function forEachStrip(bitmap, fn) {
  const w = bitmap.width, H = bitmap.height, step = stripRows(w);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = Math.min(step, H);
  const ctx = canvas.getContext('2d', { colorSpace: 'display-p3' });
  const p3 = ctx.getContextAttributes?.().colorSpace === 'display-p3';
  ctx.imageSmoothingEnabled = false;   // 1:1: an exact copy, strip edges included
  for (let y0 = 0; y0 < H; y0 += step) {
    const rows = Math.min(step, H - y0);
    ctx.clearRect(0, 0, w, rows);
    ctx.drawImage(bitmap, 0, y0, w, rows, 0, 0, w, rows);
    fn((p3 ? ctx.getImageData(0, 0, w, rows, { colorSpace: 'display-p3' }) : ctx.getImageData(0, 0, w, rows)).data, y0, rows, p3);
  }
  canvas.width = canvas.height = 0;
}

// ---------- clipped highlights ----------
// Where the phone clipped (sky through a blind, a window, a lamp) the real
// light was far brighter than display white. The scan can't show the
// difference (it is white either way), but halation and scatter spread
// a few % of the light, so they need it: a slit of sky must be a +6 EV
// source, not a +2.5 EV one. Clipping is detected per pixel at FULL
// resolution (a 2 px slit is no longer clipped once the preview averages it
// with the dark around it) and carried in the frame's alpha channel: the
// fraction of the pixel that clipped, 0..255. The input stage multiplies that
// fraction of the light by CLIP_GAIN. Frame-independent, so export tiles
// (alpha per pixel) match the preview (alpha = area average).
const CLIP_LO = 250, CLIP_HI = 254;          // min(R,G,B), 8-bit: true neutral clipping only (near-white fur at 235–250 is not clipped)
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
  // Integer sums: exact, as the float ones were.
  const sum = new Uint32Array(w * h), cnt = new Uint16Array(w * h);
  const add = (data, fw, fh, y0, rows) => {
    const sx = w / fw, sy = h / fh;
    for (let y = y0; y < y0 + rows; y++) {
      const row = Math.min(h - 1, (y * sy) | 0) * w;
      for (let x = 0, i = (y - y0) * fw * 4; x < fw; x++, i += 4) {
        const k = row + Math.min(w - 1, (x * sx) | 0);
        sum[k] += clipWeight(data, i); cnt[k]++;
      }
    }
  };
  if (Math.max(bitmap.width, bitmap.height) <= longCap) {
    // Native size: in strips (a 12 MP decode is ~100 MB of canvas + pixels).
    forEachStrip(bitmap, (data, y0, rows) => add(data, bitmap.width, bitmap.height, y0, rows));
  } else {
    const full = decodeRGBA(bitmap, longCap);
    add(full.data, full.w, full.h, 0, full.h);
  }
  return Uint8Array.from(sum, (s, k) => Math.round(s / cnt[k]));
}

/**
 * Linear engine input for the region (x0, y0, w, h) of 8-bit RGBA `data`
 * (row stride `W`), multiplied by `scale`. With `inverse` the display values are turned
 * into scene light first (color.js displayToScene); without it they are just decoded.
 */
export function extractLinear(data, W, p3, x0 = 0, y0 = 0, w = W, h = data.length / 4 / W, scale = 1, inverse = false) {
  // CPU path (the app normally does this on the GPU, lens-gpu.js). Matrix as
  // scalars (identity when not P3) so the hot loop has no nested-array lookups.
  const rgb = new Float32Array(w * h * 3);
  const M = p3 ? P3_TO_REC2020 : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const a0 = M[0][0] * scale, a1 = M[0][1] * scale, a2 = M[0][2] * scale;
  const b0 = M[1][0] * scale, b1 = M[1][1] * scale, b2 = M[1][2] * scale;
  const c0 = M[2][0] * scale, c1 = M[2][1] * scale, c2 = M[2][2] * scale;
  let j = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let i = (y * W + x0) * 4, end = i + w * 4; i < end; i += 4, j += 3) {
      let r = LIN8[data[i]], g = LIN8[data[i + 1]], b = LIN8[data[i + 2]];
      if (inverse) { const k = displayGain(Math.max(r, g, b)); r *= k; g *= k; b *= k; }
      rgb[j] = a0 * r + a1 * g + a2 * b;
      rgb[j + 1] = b0 * r + b1 * g + b2 * b;
      rgb[j + 2] = c0 * r + c1 * g + c2 * b;
    }
  }
  return rgb;
}

/** Output-pack LUT of the GPU chain (4096 entries over 0..1 → 8-bit): identity, the engine output is already display-encoded. */
export const PACK_LUT = Uint8Array.from({ length: 4096 }, (_, j) => Math.round(255 * j / 4095));

export const THUMB_PX = 256;   // long side of the thumb the engine's auto-exposure / AutoSetup read
/** Scene-linear thumb of an 8-bit preview in the engine's input space (display→scene inverse, no lens, no exposure). */
export function jpegThumb({ data, w, h, p3 }, longSide = THUMB_PX) {
  const s = Math.min(1, longSide / Math.max(w, h)), tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
  const small = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const row = Math.min(h - 1, Math.floor((y + 0.5) / s)) * w;
    for (let x = 0, o = y * tw * 4; x < tw; x++, o += 4) {
      const i = (row + Math.min(w - 1, Math.floor((x + 0.5) / s))) * 4;
      small[o] = data[i]; small[o + 1] = data[i + 1]; small[o + 2] = data[i + 2];
    }
  }
  return { rgb: extractLinear(small, tw, p3, 0, 0, tw, th, 1, true), w: tw, h: th };
}

/** Whole image at `longSide`: engine-ready linear pixels plus the displayable original. */
export function readPixels(bitmap, longSide = Infinity) {
  const { data, w, h, p3 } = decodeRGBA(bitmap, longSide);
  const rgb = extractLinear(data, w, p3);
  const before = new ImageData(data, w, h, p3 ? { colorSpace: 'display-p3' } : undefined);
  return { rgb, w, h, p3, before, data };
}
