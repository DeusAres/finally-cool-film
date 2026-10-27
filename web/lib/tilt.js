// Raddrizza (tilt, Trasforma tab): the photo turned by a small angle about the frame centre and zoomed in just enough that the
// output frame (same size and aspect as without tilt) holds no empty corner, like the iPhone's Straighten.
// Ritaglia (crop, v4.9): a rectangle of that turned frame, in fractions of it ({x, y, w, h}, FULL = all of it). The crop IS the
// output frame: the lens (vignette / falloff / CA), grain, dust, Hyper Tone's map, the histogram and the export see only it, as
// if the photo had been framed so (user). The metering (Auto, AutoSetup) stays on the whole negative, as a lab scans it.
// It is a sampling transform of the input pass (lens-gpu.js `src`, lens.js extractLens, dodge.js): every tap of the output pixel at
// `pos` (frame px, pixel centres at integers, full-frame coordinates also for export tiles) reads the source at
//   src = c + k R(-a) (pos - c),   c = ((W - 1) / 2, (H - 1) / 2),   k = TILT crop scale (<= 1)
// so the lens (vignette / falloff / CA), grain, dust and the export mat stay on the output frame: only the scene turns.
// Angle in degrees, > 0 = the photo turns clockwise. 0 = no transform at all (bit-identical to the app without it).

export const TILT_MAX = 45;
export const FULL = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });
export const isFull = (c) => c.x === 0 && c.y === 0 && c.w === 1 && c.h === 1;

/** The crop `c` of a W×H frame in whole px: { ox, oy, w, h } (offset into the turned frame, output size). */
export function cropPx(W, H, c) {
  const ox = Math.round(c.x * W), oy = Math.round(c.y * H);
  return { ox, oy, w: Math.max(1, Math.min(W - ox, Math.round(c.w * W))), h: Math.max(1, Math.min(H - oy, Math.round(c.h * H))) };
}

/** The crop after a quarter turn of the frame (`q` = +1 clockwise, -1 counter-clockwise): the same rectangle of the photo. */
export const turnCrop = (c, q) => (q > 0 ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w });

/** Source px per output px: the largest W×H rectangle (same aspect) inside the W×H frame turned by `deg`. */
export function tiltScale(W, H, deg) {
  const t = Math.abs(deg) * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  return Math.min(W / (W * c + H * s), H / (W * s + H * c));
}

/** [a, b] with src - c = [a (x) + b (y), a (y) - b (x)] for the offset (x, y) = pos - c; null when there is no tilt. */
export function tiltCoef(W, H, deg) {
  if (!deg) return null;
  const k = tiltScale(W, H, deg), t = deg * Math.PI / 180;
  return [k * Math.cos(t), k * Math.sin(t)];
}

/** CPU: a function (x, y, out) writing the source position [sx, sy] of output px (x, y) (the crop's own frame) of a W×H source
 * frame turned by `deg` and cropped to `crop` into `out`; null when there is neither (output = source). */
export function frameMap(W, H, deg, crop = FULL) {
  const ab = tiltCoef(W, H, deg), { ox, oy } = cropPx(W, H, crop);
  if (!ab && !ox && !oy) return null;
  const [a, b] = ab || [1, 0], cx = (W - 1) / 2, cy = (H - 1) / 2;
  return (x, y, o) => { const dx = x + ox - cx, dy = y + oy - cy; o[0] = cx + a * dx + b * dy; o[1] = cy + a * dy - b * dx; };
}

/** `ch`-channel `data` (W×H; 8-bit or float) turned and cropped like the render (bilinear, in its own values): { data, w, h }.
 * The A/B 'before' view (RGBA 8-bit) and the Hyper Tone map's thumb (RGB float) are made with it. */
export function frameImage(data, W, H, ch, deg, crop = FULL) {
  const { w, h } = cropPx(W, H, crop), map = frameMap(W, H, deg, crop);
  if (!map) return { data, w, h };
  const out = new data.constructor(w * h * ch), T = new Float64Array(2);
  for (let y = 0, o = 0; y < h; y++) {
    for (let x = 0; x < w; x++, o += ch) {
      map(x, y, T);
      let sx = T[0], sy = T[1];
      sx = sx < 0 ? 0 : sx > W - 1 ? W - 1 : sx; sy = sy < 0 ? 0 : sy > H - 1 ? H - 1 : sy;
      const x0 = sx | 0, y0 = sy | 0, x1 = x0 < W - 1 ? x0 + 1 : x0, y1 = y0 < H - 1 ? y0 + 1 : y0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * W + x0) * ch, i01 = (y0 * W + x1) * ch, i10 = (y1 * W + x0) * ch, i11 = (y1 * W + x1) * ch;
      for (let c = 0; c < ch; c++) {
        const t = data[i00 + c] + (data[i01 + c] - data[i00 + c]) * fx;
        out[o + c] = t + (data[i10 + c] + (data[i11 + c] - data[i10 + c]) * fx - t) * fy;   // a clamped 8-bit array rounds
      }
    }
  }
  return { data: out, w, h };
}
