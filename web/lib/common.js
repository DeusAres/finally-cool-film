// Shared by the app and the benchmark page: engine boot + photo decoding.
import init, * as sf from '../pkg/spektrafilm_wasm.js';
import { srgbToLinear, LIN8, P3_TO_REC2020 } from './color.js';

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

/**
 * Linear engine input for the region (x0, y0, w, h) of 8-bit RGBA `data`
 * (row stride `W`), multiplied by `scale`. `lut` maps each 8-bit code value to
 * linear light (default: plain sRGB decode; tone.js supplies the scene-referred one).
 */
export function extractLinear(data, W, p3, x0 = 0, y0 = 0, w = W, h = data.length / 4 / W, scale = 1, lut = LIN8) {
  const rgb = new Float32Array(w * h * 3);
  const M = P3_TO_REC2020;
  let j = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let i = (y * W + x0) * 4, end = i + w * 4; i < end; i += 4, j += 3) {
      const r = lut[data[i]] * scale, g = lut[data[i + 1]] * scale, b = lut[data[i + 2]] * scale;
      if (p3) {
        rgb[j] = M[0][0] * r + M[0][1] * g + M[0][2] * b;
        rgb[j + 1] = M[1][0] * r + M[1][1] * g + M[1][2] * b;
        rgb[j + 2] = M[2][0] * r + M[2][1] * g + M[2][2] * b;
      } else {
        rgb[j] = r; rgb[j + 1] = g; rgb[j + 2] = b;
      }
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

/** Engine output (sRGB-encoded floats, interleaved RGB) → RGBA ImageData. */
export function toImageData(out, w, h, out8) {
  const img = new ImageData(w, h);
  const d = img.data;
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    d[i] = to8(out[j], out8); d[i + 1] = to8(out[j + 1], out8); d[i + 2] = to8(out[j + 2], out8); d[i + 3] = 255;
  }
  return img;
}
