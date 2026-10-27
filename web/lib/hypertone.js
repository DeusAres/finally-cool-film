// Hyper Tone map (the Frontier scanner's local tone control; applied in the input pass, below): a low-resolution base of the
// frame's log exposure that is smooth inside regions and changes only at their edges, in EV from mid grey as the scanner
// renders it (0.18 x the gain: the film's exposure and the AutoSetup's density key, app.js syncHyperMap), beyond DEAD_EV: a recovery of the frame's extremes, not of what is dark or bright
// relative to the rest (a frame that is mostly dark rock has its median there, and its shadows were left alone).
// The input pass gives each pixel 2^(-level x this map) of light (hyperWGSL), so large bright areas reach the film darker and
// large dark ones lighter while the detail inside them stays (it is not in the map).
//
// Edges: a self-guided filter (He et al. 2010) on log2 luminance. Inside a window whose variance is below EDGE_EV² the
// output is the window mean (texture and small detail are flattened out of the base); across a step much larger than that
// it follows the step, so the base does not bleed over a skyline (no halo).
// No DOM: shared by app.js and node eval scripts.

// Choices, not measurements (first version, to tune on photos): window radius as a fraction of the thumb's long side
// (the size of what counts as an "area"), the edge threshold in EV, the map's long side (the pass samples it bilinearly,
// so a step in the map is spread over frame / MAP_LONG pixels: at 96 that was a visible light rim on a 2000 px rock against
// the sky; 512 keeps it to ~4 px; built once per photo, transform and level of the scan, app.js syncHyperMap).
const RADIUS_FRAC = 1 / 10, EDGE_EV = 1, MAP_LONG = 512;
// Recovery, not flattening (user, v4): areas within DEAD_EV of mid grey are left alone (the mids keep their contrast);
// beyond it only the excess acts (a sky 2.5 EV over mid grey moves as if it were 1.5 EV over). A choice.
const DEAD_EV = 1;
const MID_GREY = 0.18;   // scene-linear mid grey (the engine's meter target)
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
 * The Hyper Tone map of a scene-linear thumb (`rgb` w×h×3, upright as rendered) with luminance weights `luma`, exposed for the
 * film by `gain` (the exposure gain the render applies): { map: Float32Array (EV beyond DEAD_EV from mid grey, bright > 0), w, h }
 * at MAP_LONG on the long side.
 */
export function hyperToneMap(rgb, w, h, luma, gain = 1) {
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
  const map = shrink(base, w, h, mw, mh), ref = Math.log2(MID_GREY / gain);
  for (let i = 0; i < map.length; i++) { const m = map[i] - ref; map[i] = m - Math.max(-DEAD_EV, Math.min(DEAD_EV, m)); }
  return { map, w: mw, h: mh };
}

// In the input pass (v4.9): the map moves the LIGHT that reaches the film, scene x 2^(-k x map) before the exposure gain, k the
// level's strength on the lights (map > 0) or the shadows (map < 0). As a density lift in the scanner (the first version) a
// shadow left in the film's toe came out milky grey-green with the fog and grain of a thin negative, mottled (user, cafe
// IDG_20261027_115516_955); given light, the film renders the shadow's own detail with its own toe and colours. The map rides
// after the display-gain LUT in the pass's storage array: header [map w, map h, k lights, k shadows], then the map.
// The machine's cool lifted shadows (wanted, user: its red layer records less in the toe, so a lift shows cyan) are kept as
// the red light getting SHADOW_CYAN less of a shadow lift (in EV): per AREA (the map), smooth, so no pixel of grain decides
// it (the per-pixel version came out in blotches). 0.18 = Gold 200's red toe shortfall, 1 - 0.283 / 0.346 (the red and green
// toe slopes, engine pipeline.rs stock_toe, which measures it from the stock's curves; eval/V4.md).
const HDR = 4, SHADOW_CYAN = 0.18;

/** The input pass's storage array: `lut` (color.js DISPLAY_GAIN_LUT), then the header and the map `hyper` ({ map, w, h }). */
export function hyperArray(lut, hyper, kHi, kLo) {
  const out = new Float32Array(lut.length + HDR + hyper.map.length);
  out.set(lut);
  out.set([hyper.w, hyper.h, kHi, kLo], lut.length);
  out.set(hyper.map, lut.length + HDR);
  return out;
}

/** WGSL: the gain at output-frame position `pos` (frame `p.frame`), from the array `arr` with the header at `at0`. */
export const hyperWGSL = (arr, at0) => /* wgsl */`
fn hyperGain(pos: vec2<f32>) -> vec3<f32> {
  let mw = ${arr}[${at0}u]; let mh = ${arr}[${at0}u + 1u];
  let q = clamp((pos + 0.5) / p.frame * vec2<f32>(mw, mh) - 0.5, vec2<f32>(0.0), vec2<f32>(mw - 1.0, mh - 1.0));
  let i0 = vec2<u32>(floor(q)); let i1 = min(i0 + 1u, vec2<u32>(u32(mw) - 1u, u32(mh) - 1u)); let f = q - floor(q);
  let W = u32(mw); let o = ${at0}u + ${HDR}u;
  let m = mix(mix(${arr}[o + i0.y * W + i0.x], ${arr}[o + i0.y * W + i1.x], f.x), mix(${arr}[o + i1.y * W + i0.x], ${arr}[o + i1.y * W + i1.x], f.x), f.y);
  let ev = -m * select(${arr}[${at0}u + 3u], ${arr}[${at0}u + 2u], m > 0.0);
  return exp2(vec3<f32>(ev * select(1.0, ${1 - SHADOW_CYAN}, ev > 0.0), ev, ev));
}`;

/** CPU twin of hyperWGSL: the gains [R, G, B] at output-frame px (x, y) of an fw×fh frame, into `out`. */
export function hyperGainCPU(arr, at0, x, y, fw, fh, out) {
  const mw = arr[at0], mh = arr[at0 + 1], o = at0 + HDR;
  const qx = Math.min(mw - 1, Math.max(0, (x + 0.5) / fw * mw - 0.5)), qy = Math.min(mh - 1, Math.max(0, (y + 0.5) / fh * mh - 0.5));
  const x0 = Math.floor(qx), y0 = Math.floor(qy), x1 = Math.min(x0 + 1, mw - 1), y1 = Math.min(y0 + 1, mh - 1), fx = qx - x0, fy = qy - y0;
  const a = arr[o + y0 * mw + x0] + (arr[o + y0 * mw + x1] - arr[o + y0 * mw + x0]) * fx;
  const b = arr[o + y1 * mw + x0] + (arr[o + y1 * mw + x1] - arr[o + y1 * mw + x0]) * fx;
  const m = a + (b - a) * fy;
  const ev = -m * (m > 0 ? arr[at0 + 2] : arr[at0 + 3]);
  out[0] = 2 ** (ev > 0 ? ev * (1 - SHADOW_CYAN) : ev); out[1] = out[2] = 2 ** ev;
  return out;
}
