// Shared by the app and the benchmark page: engine boot + photo decoding.
import init, * as sf from '../pkg/spektrafilm_wasm.js';

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
// Linear Display P3 → linear Rec.2020 (both D65), derived from the primaries.
const P3_TO_REC2020 = [
  [0.75383303, 0.19859737, 0.0475696],
  [0.04574385, 0.94177722, 0.01247893],
  [-0.00121034, 0.01760172, 0.98360862],
];

export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const LIN8 = Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));

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

/** Input colour-space params matching what `readPixels` produced. */
export const inputParams = (p3) => (p3 ? REC2020_LINEAR_INPUT : SRGB_INPUT);

/**
 * Draw `bitmap` scaled to fit `longSide` and return engine-ready pixels:
 * linear Rec.2020 when the canvas can read Display P3, else sRGB-encoded.
 * `before` is the displayable original (ImageData, P3 when available).
 */
export function readPixels(bitmap, longSide = Infinity) {
  const s = Math.min(1, longSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * s), h = Math.round(bitmap.height * s);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { colorSpace: 'display-p3' });
  const p3 = ctx.getContextAttributes?.().colorSpace === 'display-p3';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  const src = (p3 ? ctx.getImageData(0, 0, w, h, { colorSpace: 'display-p3' }) : ctx.getImageData(0, 0, w, h)).data;
  const rgb = new Float32Array(w * h * 3);
  const M = P3_TO_REC2020;
  for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
    if (p3) {
      const r = LIN8[src[i]], g = LIN8[src[i + 1]], b = LIN8[src[i + 2]];
      rgb[j] = M[0][0] * r + M[0][1] * g + M[0][2] * b;
      rgb[j + 1] = M[1][0] * r + M[1][1] * g + M[1][2] * b;
      rgb[j + 2] = M[2][0] * r + M[2][1] * g + M[2][2] * b;
    } else {
      rgb[j] = src[i] / 255; rgb[j + 1] = src[i + 1] / 255; rgb[j + 2] = src[i + 2] / 255;
    }
  }
  const before = new ImageData(src, w, h, p3 ? { colorSpace: 'display-p3' } : undefined);
  return { rgb, w, h, p3, before };
}

/** Engine output (sRGB-encoded floats, interleaved RGB) → RGBA ImageData. */
export function toImageData(out, w, h) {
  const img = new ImageData(w, h);
  const d = img.data;
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    d[i] = out[j] * 255; d[i + 1] = out[j + 1] * 255; d[i + 2] = out[j + 2] * 255; d[i + 3] = 255;
  }
  return img;
}
