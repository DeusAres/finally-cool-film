// Hyper Tone map (the Frontier scanner's local tone control; engine params.rs HyperToneParams): a low-resolution base of the
// frame's log exposure that is smooth inside regions and changes only at their edges, in EV from the frame's median.
// The engine moves each pixel's film density along the stock's grey ramp by -amount x this map, so large bright areas are
// scanned darker and large dark ones lighter while the detail inside them stays (it is not in the map).
//
// Edges: a self-guided filter (He et al. 2010) on log2 luminance. Inside a window whose variance is below EDGE_EV² the
// output is the window mean (texture and small detail are flattened out of the base); across a step much larger than that
// it follows the step, so the base does not bleed over a skyline (no halo).
// No DOM: shared by app.js and node eval scripts.

// Choices, not measurements (first version, to tune on photos): window radius as a fraction of the thumb's long side
// (the size of what counts as an "area"), the edge threshold in EV, the map's long side (the engine samples it bilinearly,
// so a step in the map is spread over frame / MAP_LONG pixels: at 96 that was a visible light rim on a 2000 px rock against
// the sky; 512 keeps it to ~4 px; the map goes to the engine once per photo, Engine.set_hyper_tone_map).
const RADIUS_FRAC = 1 / 10, EDGE_EV = 1, MAP_LONG = 512;
const Y_MIN = 1e-5;   // floor of the luminance before log2 (black pixels)

/** Box filter (mean over a (2r+1)² window, clamped at the edges) of a w×h Float32Array, separable, O(n). */
function box(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {   // rows
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = s / (2 * r + 1);
      s += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {   // columns
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / (2 * r + 1);
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Area-average downscale of a w×h Float32Array to tw×th. */
function shrink(src, w, h, tw, th) {
  const out = new Float32Array(tw * th);
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * h / th), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / th));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * w / tw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / tw));
      let s = 0;
      for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) s += src[j * w + i];
      out[y * tw + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/**
 * The Hyper Tone map of a scene-linear thumb (`rgb` w×h×3, upright as rendered) with luminance weights `luma`:
 * { map: Float32Array (EV from the median, bright > 0), w, h } at MAP_LONG on the long side.
 */
export function hyperToneMap(rgb, w, h, luma) {
  const n = w * h, L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = Math.log2(Math.max(Y_MIN, luma[0] * rgb[3 * i] + luma[1] * rgb[3 * i + 1] + luma[2] * rgb[3 * i + 2]));
  const r = Math.max(1, Math.round(RADIUS_FRAC * Math.max(w, h))), eps = EDGE_EV * EDGE_EV;
  const LL = L.map((v) => v * v), mL = box(L, w, h, r), mLL = box(LL, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, mLL[i] - mL[i] * mL[i]);
    a[i] = v / (v + eps); b[i] = mL[i] - a[i] * mL[i];
  }
  const ma = box(a, w, h, r), mb = box(b, w, h, r), base = new Float32Array(n);
  for (let i = 0; i < n; i++) base[i] = ma[i] * L[i] + mb[i];
  const s = Math.min(1, MAP_LONG / Math.max(w, h)), mw = Math.max(1, Math.round(w * s)), mh = Math.max(1, Math.round(h * s));
  const map = shrink(base, w, h, mw, mh), median = Float32Array.from(map).sort()[map.length >> 1];
  for (let i = 0; i < map.length; i++) map[i] -= median;
  return { map, w: mw, h: mh };
}
