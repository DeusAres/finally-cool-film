// Raddrizza (tilt, Trasforma tab): the photo turned by a small angle about the frame centre and zoomed in just enough that the
// output frame (same size and aspect as without tilt) holds no empty corner, like the iPhone's Straighten.
// It is a sampling transform of the input pass (lens-gpu.js `src`, lens.js extractLens, dodge.js): every tap of the output pixel at
// `pos` (frame px, pixel centres at integers, full-frame coordinates also for export tiles) reads the source at
//   src = c + k R(-a) (pos - c),   c = ((W - 1) / 2, (H - 1) / 2),   k = TILT crop scale (<= 1)
// so the lens (vignette / falloff / CA), grain, dust and the export mat stay on the output frame: only the scene turns.
// Angle in degrees, > 0 = the photo turns clockwise. 0 = no transform at all (bit-identical to the app without it).

export const TILT_MAX = 45;

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

/** CPU: a function (x, y, out) writing the source position [sx, sy] of output px (x, y) of a W×H frame into `out`; null when
 * there is no tilt. */
export function tiltMap(W, H, deg) {
  const ab = tiltCoef(W, H, deg);
  if (!ab) return null;
  const [a, b] = ab, cx = (W - 1) / 2, cy = (H - 1) / 2;
  return (x, y, o) => { const dx = x - cx, dy = y - cy; o[0] = cx + a * dx + b * dy; o[1] = cy + a * dy - b * dx; };
}

/** 8-bit RGBA `data` (w×h) turned and cropped like the render (bilinear, in the encoded values): the A/B 'before' view. */
export function tiltRGBA(data, w, h, deg) {
  const map = tiltMap(w, h, deg), out = new Uint8ClampedArray(w * h * 4), T = new Float64Array(2);
  for (let y = 0, o = 0; y < h; y++) {
    for (let x = 0; x < w; x++, o += 4) {
      map(x, y, T);
      let sx = T[0], sy = T[1];
      sx = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx; sy = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy;
      const x0 = sx | 0, y0 = sy | 0, x1 = x0 < w - 1 ? x0 + 1 : x0, y1 = y0 < h - 1 ? y0 + 1 : y0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * w + x0) * 4, i01 = (y0 * w + x1) * 4, i10 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const t = data[i00 + c] + (data[i01 + c] - data[i00 + c]) * fx;
        out[o + c] = t + (data[i10 + c] + (data[i11 + c] - data[i10 + c]) * fx - t) * fy;   // clamped array: rounds
      }
      out[o + 3] = 255;
    }
  }
  return out;
}
