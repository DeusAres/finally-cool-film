// Raw photos (DNG; Olympus ORF via orf.js): the bridge between the raw decoders and the app.
//
// A DNG is scene-linear light (Rec.2020, white-balanced, sensor clip = 1), the
// input a film simulation actually wants: no phone tone curve to invert, no HDR
// crunch, the whole highlight range. It goes to the GPU as a half-float frame
// (sf.alloc_frame_f16), alpha = 1.
// Exposure (BaselineExposure + Esposizione) is applied in the input pass; everything
// after it is shared with the JPEG path.
// Orientation (EXIF 1–8) is applied by index mapping while converting strips,
// so the full-resolution float image is never copied.

import { decodeDNG, tiffMagic } from './dng.js';
import { decodeORF, isORFHeader } from './orf.js';
import { REC2020_TO_P3, linearToSrgb } from './color.js';
import { stripRows } from './util.js';

/** True for a DNG or an Olympus ORF (by name/type, or a TIFF / ORF header when the name says nothing). */
export async function isRaw(file) {
  if (/\.(dng|orf)$/i.test(file.name || '') || /dng|orf/i.test(file.type || '')) return true;
  if (file.type && file.type !== 'application/octet-stream') return false;
  return tiffMagic(new Uint8Array(await file.slice(0, 4).arrayBuffer())) !== 0;
}

/** Decode raw bytes (DNG or ORF by header) at most `opt.maxLongSide` px: { w, h, rgb, exposure, meta }. */
export const decodeRawBuffer = (buf, opt) => (isORFHeader(new Uint8Array(buf, 0, 4)) ? decodeORF : decodeDNG)(buf, opt);

/** The app's raw object for a decode `d`, turned by `rot` (see withRotation). */
export function rawObject(d, rot = 0) {
  const o = d.meta?.orientation || 1, swap = o >= 5;
  const [cw, ch] = (d.meta?.crop || [0, 0, d.w, d.h]).slice(2);   // full (cropped) sensor size
  const ow = swap ? d.h : d.w, oh = swap ? d.w : d.h, ofw = swap ? ch : cw, ofh = swap ? cw : ch;
  return withRotation({ sw: d.w, sh: d.h, ow, oh, ofw, ofh, rgb: d.rgb, baseline: d.exposure || 0, orientation: o }, rot);
}

/** Decode and assemble, in this thread (the worker's job; here only as the fallback and in node). */
export async function decodeRaw(buf, { maxLongSide, rot = 0 } = {}) {
  return rawObject(await decodeRawBuffer(buf, maxLongSide ? { maxLongSide } : {}), rot);
}

// In a page each decode runs in its own raw-worker.js, terminated when it is done (its garbage, the file and the CFA, goes
// with it) or aborted (a newer photo); the file's bytes are transferred to it, not copied. A worker that cannot start or
// dies decodes here instead, for the rest of the session (the bytes are read again: the transfer emptied them); so do
// node scripts (eval/dng2npy.mjs).
//   Preview: the worker posts { r } (the float image transferred) and main keeps it (turns, 'before' view, thumbs).
//   Export (`sf` given): the worker posts { head } (r without pixels); main allocates the GPU frame and asks for one
//   half-float strip at a time ('more' -> { strip, y0 }, transferred), uploading each before asking for the next. So the
//   full f16 image never exists and main converts nothing. Worker peak: file + CFA + float image during the decode, then the
//   float image + one strip while streaming (measured, 12 MP DNG: <= 199 MB, then 146 MB); main holds one strip at a time.
const canWork = typeof Worker !== 'undefined' && typeof document !== 'undefined';
let workerOk = canWork;
function decodeInWorker(file, buf, opt, sf, signal) {
  let w;
  try {
    // the worker URL carries the page's cache-busting query (scripts/stamp-version.sh stamps raw.js's import)
    w = new Worker(new URL('./raw-worker.js' + new URL(import.meta.url).search, import.meta.url), { type: 'module' });
  } catch { workerOk = false; return null; }
  return new Promise((resolve, reject) => {
    let over = false, head = null;
    const end = () => { over = true; w.terminate(); signal?.removeEventListener('abort', abort); };
    const abort = () => { if (!over) { end(); reject(signal.reason); } };
    const fallback = () => {   // the worker died or never loaded: from now on decode here
      if (over) return;
      end(); workerOk = false;
      file.arrayBuffer().then((b) => { signal?.throwIfAborted(); return decodeHere(b, opt, sf); }).then(resolve, reject);
    };
    w.onmessage = ({ data }) => {
      if (over) return;   // an event queued before terminate()
      try {
        if ('error' in data) { end(); reject(new Error(data.error)); } else if (data.r) { end(); resolve({ ...data.r, decodedIn: 'worker' }); } else if (data.head) {
          head = data.head; sf.alloc_frame_f16(head.w, head.h); w.postMessage('more');
        } else {
          sf.set_frame_rows_f16(data.strip, data.y0);
          if (data.y0 + data.strip.length / (4 * head.w) < head.h) w.postMessage('more'); else { end(); resolve({ ...head, decodedIn: 'worker' }); }
        }
      } catch (e) { end(); reject(e); }   // a GPU upload error
    };
    w.onerror = (e) => { e.preventDefault?.(); fallback(); };
    w.onmessageerror = fallback;
    signal?.addEventListener('abort', abort);
    w.postMessage({ buf, opt: { ...opt, stream: !!sf } }, [buf]);
  });
}

// The fallback: decode in this thread; with `sf`, upload and drop the float image (the export's form).
async function decodeHere(buf, opt, sf) {
  const r = await decodeRaw(buf, opt);
  if (!sf) return { ...r, decodedIn: 'main' };
  uploadRaw(sf, r);
  return { ...r, rgb: null, decodedIn: 'main' };
}

/**
 * Decode (optionally downscaled); returns { w, h, rgb, baseline, orientation, fullW, fullH, decodedIn ('worker' | 'main') },
 * sizes AFTER orientation. `rot`: the user's extra quarter turns clockwise (withRotation). `sf`: upload the frame to the GPU
 * as it decodes (export) and return the same object without pixels (rgb null). `signal`: an AbortSignal that stops the
 * decode (a newer photo); the load then rejects with its reason.
 */
export async function loadRaw(file, maxLongSide, rot = 0, { sf = null, signal = null } = {}) {
  signal?.throwIfAborted();
  const buf = await file.arrayBuffer(), opt = { maxLongSide, rot };
  signal?.throwIfAborted();   // aborted while the file was read (hundreds of ms for a big raw)
  const p = workerOk && decodeInWorker(file, buf, opt, sf, signal);
  return p ? p : decodeHere(buf, opt, sf);
}

/** The same decoded raw turned by `rot` quarter turns clockwise after its EXIF orientation (no pixel copy:
 * srcIndex maps every read). w/h and fullW/fullH are the turned sizes. */
export function withRotation(r, rot = 0) {
  rot &= 3;
  const odd = rot & 1;
  return { ...r, rot, w: odd ? r.oh : r.ow, h: odd ? r.ow : r.oh, fullW: odd ? r.ofh : r.ofw, fullH: odd ? r.ofw : r.ofh };
}

// Source pixel index of displayed pixel (x, y): the user's turn (r.rot, as common.js turnTransform),
// then the EXIF orientation.
function srcIndex(r, x, y) {
  if (r.rot) {
    const t = x;
    switch (r.rot) {
      case 1: x = y; y = r.oh - 1 - t; break;
      case 2: x = r.ow - 1 - x; y = r.oh - 1 - y; break;
      case 3: x = r.ow - 1 - y; y = t; break;
    }
  }
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

/** Rows y0 … y0+n-1 of the oriented raw as half-float RGBA (alpha = 1), into `out` (or a new array). */
export function f16Rows(r, y0, n, out = new Uint16Array(r.w * n * 4)) {
  const src = r.rgb;
  for (let y = 0, k = 0; y < n; y++) {
    for (let x = 0; x < r.w; x++, k += 4) {
      const i = srcIndex(r, x, y0 + y) * 3;
      out[k] = half(src[i]); out[k + 1] = half(src[i + 1]); out[k + 2] = half(src[i + 2]); out[k + 3] = 0x3c00;
    }
  }
  return out;
}

/** The export strips of `r`, in order: [y0, n] (raw-worker.js). */
export function* stripsOf(r) {
  const rows = stripRows(r.w, 8);   // half-float RGBA
  for (let y0 = 0; y0 < r.h; y0 += rows) yield [y0, Math.min(rows, r.h - y0)];
}

/** Upload the oriented raw as the GPU frame, in strips. */
export function uploadRaw(sf, r) {
  sf.alloc_frame_f16(r.w, r.h);
  const buf = new Uint16Array(r.w * stripRows(r.w, 8) * 4);
  for (const [y0, n] of stripsOf(r)) sf.set_frame_rows_f16(f16Rows(r, y0, n, buf).subarray(0, r.w * n * 4), y0);
}

/** Scene-linear Rec.2020 thumb (sensor values, oriented, no baseline) for the engine's auto-exposure / AutoSetup. */
export function rawThumb(r, longSide) {
  const s = Math.min(1, longSide / Math.max(r.w, r.h)), w = Math.max(1, Math.round(r.w * s)), h = Math.max(1, Math.round(r.h * s));
  const rgb = new Float32Array(w * h * 3);
  for (let y = 0, o = 0; y < h; y++) {
    for (let x = 0; x < w; x++, o += 3) {
      const i = srcIndex(r, Math.min(r.w - 1, Math.floor((x + 0.5) / s)), Math.min(r.h - 1, Math.floor((y + 0.5) / s))) * 3;
      rgb[o] = r.rgb[i]; rgb[o + 1] = r.rgb[i + 1]; rgb[o + 2] = r.rgb[i + 2];
    }
  }
  return { rgb, w, h };
}

/** The 'before' view: the raw as plain Display P3 (exposure + baseline, clipped), RGBA 8-bit. */
export function rawPreviewRGBA(r) {
  const out = new Uint8ClampedArray(r.w * r.h * 4), g = 2 ** r.baseline, M = REC2020_TO_P3;
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

