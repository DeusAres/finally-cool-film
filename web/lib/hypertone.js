// Hyper Tone map (the Frontier scanner's local tone control; applied in the input pass, below): a low-resolution base of the
// frame's log exposure that is smooth inside regions and changes only at their edges, in EV from mid grey as the scanner
// renders it (0.18 x the gain: the film's exposure and the AutoSetup's density key, app.js syncHyperMap), beyond the dead zone
// (DEAD_EV_HI / DEAD_EV_LO): a recovery of the frame's extremes, not of what is dark or bright
// relative to the rest (a frame that is mostly dark rock has its median there, and its shadows were left alone).
// The input pass gives each pixel 2^(-level x this map) of light (hyperWGSL), so large bright areas reach the film darker and
// large dark ones lighter while the detail inside them stays (it is not in the map).
//
// Edges: a self-guided filter (He et al. 2010) on log2 luminance (EDGE_EV for the lights, EDGE_EV_LO for the shadows). Inside a window whose variance is below EDGE_EV² the
// output is the window mean (texture and small detail are flattened out of the base); across a step much larger than that
// it follows the step, so the base does not bleed over a skyline (no halo).
// No DOM: shared by app.js and node eval scripts.

import { NOISE_FLOOR_SIGMAS } from './util.js';

// Choices, not measurements (first version, to tune on photos): window radius as a fraction of the thumb's long side
// (the size of what counts as an "area"), the edge threshold in EV, the map's long side (the pass samples it bilinearly,
// so a step in the map is spread over frame / MAP_LONG pixels: at 96 that was a visible light rim on a 2000 px rock against
// the sky; 512 keeps it to ~4 px; built once per photo, transform and level of the scan, app.js syncHyperMap).
const RADIUS_FRAC = 1 / 10, EDGE_EV = 1, MAP_LONG = 512;
// The shadows' map is smoother (2026-11-22, user: Ombre "non è uniforme"): with EDGE_EV 1 a shadow area kept its own texture
// in the map (log2 of a dark luminance swings over more than 1 EV: shutters, roof tiles, a dome's carving at dusk, P5282720 /
// IDG_20261022_182651_466), so each pixel got its own lift, an HDR-like mottle instead of an area lifted evenly. 2 EV: the lift
// is even inside the area and still follows a strong silhouette (the dome against the sky); 3 bled past it (by eye on the node
// prototype of this map, Ombre 5). A choice, not a measurement. The lights keep EDGE_EV (their numbers below were measured with it).
const EDGE_EV_LO = 2;
// Recovery, not flattening (user, v4, 3f88b0b: the first map, from the frame's median with no dead zone, flattened whole
// photos): areas within the dead zone around mid grey are left alone (the mids keep their contrast); beyond it only the excess
// acts (a sky 2.5 EV over mid grey moved as if it were 1.5 EV over). 1 EV each side was a choice, never measured.
// 2026-11-14, the lights: 1 -> 0.5 (user: a white cat's fur in sun "si impasta" even with Hyper Tone luci). The fur and sunlit
// clouds sit ~+2..+2.5 EV over mid grey as the scanner renders them (Frontier D+1 Hard1), where the curve gives 4-6 L* per EV
// against ~20 at mid grey: their detail comes back only as far as the area moves down. Measured in the app (browser, WebGPU,
// grain on), cat IDG_20261008_160856_907 / clouds IDG_20261011_135459_749, in the areas at L* 88-93 without Hyper Tone (local
// contrast = std of L* - gauss(6 px); off 1.17 / 0.84): level 3 1.67 / 1.25 -> 2.05 / 1.51, level 5 2.12 / 1.68 -> 2.85 /
// 2.27; their L* (off 90.1 / 90.8) level 3 85.8 / 86.0 -> 82.9 / 83.2, level 5 81.7 / 80.9 -> 75.4 / 74.2. The price: the
// light mids (L* 65-80) come down, level 3 70.6 / 75.1 -> 67.1 / 73.7, level 5 70.3 / 74.9 -> 64.5 / 72.5 (their detail kept,
// 3.44 -> 3.59 / 3.69 on the cat), and the map's rim at a bright / dark edge (the bright side within 25 px of the dark one,
// lighter than the area inside) level 3 +1.7 / +2.6 -> +2.7 / +3.6 L*, level 5 +3.3 / +5.2 -> +4.8 / +7.5. A CPU prototype of
// this map (sf-eval) for the alternatives: 0.25 gives little more detail for darker mids; HYPER_MAX 1.2 turns the fur grey
// (L* 66 at level 5); a larger EDGE_EV or a smaller radius widen the rim. The shadows keep 1 (their side was not asked; its
// SHADOW_CYAN lift was measured with it).
const DEAD_EV_HI = 0.5, DEAD_EV_LO = 1;
// The shadows' dead zone ends in a soft knee KNEE_EV wide (quadratic, C1): with a hard corner, an area whose base hovers around
// -1 EV broke into lifted and unlifted islands. 0.5 a choice (same prototype).
const KNEE_EV = 0.5;
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

/** Self-guided filter (He et al. 2010) of `L` (w×h), window radius `r`, edge threshold `edge` (EV): the area base. */
function guided(L, w, h, r, edge) {
  const n = w * h, eps = edge * edge, mL = box(L, w, h, r), mLL = box(L.map((v) => v * v), w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, mLL[i] - mL[i] * mL[i]);
    a[i] = v / (v + eps); b[i] = mL[i] - a[i] * mL[i];
  }
  const ma = box(a, w, h, r), mb = box(b, w, h, r), base = new Float32Array(n);
  for (let i = 0; i < n; i++) base[i] = ma[i] * L[i] + mb[i];
  return base;
}

/** The shadows' excess beyond the dead zone (`d` EV below mid grey, > 0), through the soft knee: 0 up to DEAD_EV_LO - KNEE_EV/2,
 * then d - DEAD_EV_LO beyond DEAD_EV_LO + KNEE_EV/2. */
function shadowExcess(d) {
  const t = KNEE_EV / 2, x = d - DEAD_EV_LO;
  return x <= -t ? 0 : x >= t ? x : (x + t) * (x + t) / (4 * t);
}

/**
 * The Hyper Tone map of a scene-linear thumb (`rgb` w×h×3, upright as rendered) with luminance weights `luma`, exposed for the
 * film by `gain` (the exposure gain the render applies): { map: Float32Array (EV beyond the dead zone from mid grey, bright > 0), w, h }
 * at MAP_LONG on the long side. `noise`: the thumb's luminance noise floor (dng.js noiseFloor at its pitch; 0: unknown), the
 * log's offset (util.js NOISE_FLOOR_SIGMAS): in log2 of the bare luminance, a frame's darkest areas, all sensor noise, spread
 * over many stops, the filter kept that as edges and the map lifted it as speckle (night frame IDG_20261028_222823_718).
 * Two bases: the lights' (EDGE_EV) and the smoother shadows' (EDGE_EV_LO); where the lights' says bright it wins (a sky next to
 * a dark roof is never lifted by the shadows' wider base).
 */
export function hyperToneMap(rgb, w, h, luma, gain = 1, noise = 0) {
  const n = w * h, L = new Float32Array(n), off = NOISE_FLOOR_SIGMAS * noise;
  for (let i = 0; i < n; i++) L[i] = Math.log2(Math.max(Y_MIN, off + luma[0] * rgb[3 * i] + luma[1] * rgb[3 * i + 1] + luma[2] * rgb[3 * i + 2]));
  const r = Math.max(1, Math.round(RADIUS_FRAC * Math.max(w, h))), ref = Math.log2(MID_GREY / gain);
  const hi = guided(L, w, h, r, EDGE_EV), lo = guided(L, w, h, r, EDGE_EV_LO), full = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const up = hi[i] - ref - DEAD_EV_HI;
    full[i] = up > 0 ? up : -shadowExcess(ref - lo[i]);
  }
  const s = Math.min(1, MAP_LONG / Math.max(w, h)), mw = Math.max(1, Math.round(w * s)), mh = Math.max(1, Math.round(h * s));
  return { map: shrink(full, w, h, mw, mh), w: mw, h: mh };
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
