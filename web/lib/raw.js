// Raw (DNG) photos: the bridge between dng.js and the app.
//
// A DNG is scene-linear light (Rec.2020, white-balanced, sensor clip = 1), the
// input a film simulation actually wants: no phone tone curve to invert, no HDR
// crunch, the whole highlight range. It goes to the GPU as a half-float frame
// (sf.alloc_frame_f16), alpha = sensor-clipped weight (feeds halation as the
// 8-bit path's clip mask does). The tone LUT for a raw frame is plain exposure
// (rawTone, see app.js ensureTone); everything after the input pass is shared.
// Orientation (EXIF 1–8) is applied by index mapping while converting strips,
// so the full-resolution float image is never copied.

import { decodeDNG } from './dng.js';
import { REC2020_TO_P3, linearToSrgb } from './color.js';

/** True for a DNG (by name/type, or a TIFF header when the name says nothing). */
export async function isRaw(file) {
  if (/\.dng$/i.test(file.name || '') || /dng/i.test(file.type || '')) return true;
  if (file.type && file.type !== 'application/octet-stream') return false;
  const h = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return (h[0] === 0x49 && h[1] === 0x49 && h[2] === 0x2a && h[3] === 0) || (h[0] === 0x4d && h[1] === 0x4d && h[2] === 0 && h[3] === 0x2a);
}

/** Decode (optionally downscaled); returns { w, h, rgb, baseline, orientation, fullW, fullH }, sizes AFTER orientation. */
export async function loadRaw(file, maxLongSide) {
  const d = await decodeDNG(await file.arrayBuffer(), maxLongSide ? { maxLongSide } : {});
  const o = d.meta?.orientation || 1, swap = o >= 5;
  const [cw, ch] = (d.meta?.crop || [0, 0, d.w, d.h]).slice(2);   // full (cropped) sensor size
  return { sw: d.w, sh: d.h, w: swap ? d.h : d.w, h: swap ? d.w : d.h, rgb: d.rgb, baseline: d.exposure || 0, orientation: o,
    fullW: swap ? ch : cw, fullH: swap ? cw : ch };
}

// Source pixel index of oriented pixel (x, y) (EXIF orientation semantics).
function srcIndex(r, x, y) {
  const W = r.sw, H = r.sh;
  switch (r.orientation) {
    case 2: return y * W + (W - 1 - x);
    case 3: return (H - 1 - y) * W + (W - 1 - x);
    case 4: return (H - 1 - y) * W + x;
    case 5: return x * W + y;
    case 6: return (H - 1 - x) * W + y;
    case 7: return (H - 1 - x) * W + (W - 1 - y);
    case 8: return x * W + (W - 1 - y);
    default: return y * W + x;
  }
}

// float32 → float16 bits (round to nearest, no NaN input).
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function half(v) {
  f32[0] = v; const x = u32[0];
  const s = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
  if (e <= 0) return e < -10 ? s : s | ((m | 0x800000) >>> (14 - e));
  if (e >= 31) return s | 0x7c00;
  return s | ((e << 10) + ((m + 0x1000) >>> 13));   // + : a mantissa carry bumps the exponent
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Upload the oriented raw as the GPU frame, in strips (alpha = sensor-clipped weight). */
export function uploadRaw(sf, r) {
  sf.alloc_frame_f16(r.w, r.h);
  const rows = Math.max(1, Math.floor((1 << 22) / (r.w * 8)));   // ~4 MB strips
  const buf = new Uint16Array(r.w * rows * 4), src = r.rgb;
  for (let y0 = 0; y0 < r.h; y0 += rows) {
    const n = Math.min(rows, r.h - y0);
    for (let y = 0, k = 0; y < n; y++) {
      for (let x = 0; x < r.w; x++, k += 4) {
        const i = srcIndex(r, x, y0 + y) * 3, R = src[i], G = src[i + 1], B = src[i + 2];
        buf[k] = half(R); buf[k + 1] = half(G); buf[k + 2] = half(B);
        buf[k + 3] = half(smooth(0.97, 1.0, Math.max(R, G, B)));
      }
    }
    sf.set_frame_rows_f16(buf.subarray(0, r.w * n * 4), y0);
  }
}

/** Scene luminance samples (linear Rec.2020 Y, after BaselineExposure) for Auto. */
function sceneY(r) {
  const n = r.sw * r.sh, step = Math.max(1, Math.floor(n / 60000)), g = 2 ** r.baseline;
  const Y = new Float32Array(Math.ceil(n / step));
  for (let p = 0, k = 0; p < n; p += step, k++) Y[k] = g * (0.2627 * r.rgb[3 * p] + 0.678 * r.rgb[3 * p + 1] + 0.0593 * r.rgb[3 * p + 2]);
  return Y.sort();
}

/** Auto for a raw: partial correction of the median towards a typical scene median (as autoTone). */
export function rawAuto(r) {
  const Y = sceneY(r), med = Math.max(Y[Y.length >> 1], 1e-4);
  const ev = Math.max(-1, Math.min(1.5, 0.6 * Math.log2(0.14 / med)));
  return { ev: Math.round(ev * 10) / 10 };
}

/** The 'before' view: the raw as plain Display P3 (exposure + baseline, clipped), RGBA 8-bit. */
export function rawPreviewRGBA(r, ev = 0) {
  const out = new Uint8ClampedArray(r.w * r.h * 4), g = 2 ** (r.baseline + ev), M = REC2020_TO_P3;
  const enc = new Uint8Array(4096); for (let i = 0; i < 4096; i++) enc[i] = Math.round(255 * linearToSrgb(i / 4095));
  const q = (v) => enc[Math.max(0, Math.min(4095, Math.round(v * 4095)))];
  for (let y = 0, k = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++, k += 4) {
      const i = srcIndex(r, x, y) * 3, R = r.rgb[i] * g, G = r.rgb[i + 1] * g, B = r.rgb[i + 2] * g;
      out[k] = q(M[0][0] * R + M[0][1] * G + M[0][2] * B);
      out[k + 1] = q(M[1][0] * R + M[1][1] * G + M[1][2] * B);
      out[k + 2] = q(M[2][0] * R + M[2][1] * G + M[2][2] * B);
      out[k + 3] = 255;
    }
  }
  return out;
}

