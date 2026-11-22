// Hyper Tone map (the Frontier scanner's local tone control; applied in the input pass, below): a low-resolution base of the
// frame's log exposure that is smooth inside regions and changes only at their edges, in EV from mid grey as the scanner
// renders it (0.18 x the gain: the film's exposure and the AutoSetup's density key, app.js syncHyperMap), beyond the dead zone
// (DEAD_EV_HI / DEAD_EV_LO): a recovery of the frame's extremes, not of what is dark or bright
// relative to the rest (a frame that is mostly dark rock has its median there, and its shadows were left alone).
// The input pass gives each pixel 2^(-level x this map) of light (hyperWGSL), so large bright areas reach the film darker and
// large dark ones lighter while the detail inside them stays (it is not in the map).
//
// Edges: a self-guided filter (He et al. 2010) on log2 luminance. Inside a window whose variance is below EDGE_EV² the
// output is the window mean (texture and small detail are flattened out of the base); across a step much larger than that
// it follows the step, so the base does not bleed over a skyline (no halo).
// No DOM: shared by app.js and node eval scripts.

import { NOISE_FLOOR_SIGMAS, wf, wv3 } from './util.js';

// Choices, not measurements (first version, to tune on photos): window radius as a fraction of the thumb's long side
// (the size of what counts as an "area"), the edge threshold in EV, the map's long side (the pass samples it bilinearly,
// so a step in the map is spread over frame / MAP_LONG pixels: at 96 that was a visible light rim on a 2000 px rock against
// the sky; 512 keeps it to ~4 px; built once per photo, transform and level of the scan, app.js syncHyperMap).
const RADIUS_FRAC = 1 / 10, EDGE_EV = 1, MAP_LONG = 512;
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
// Shadows (2026-11-22, calibrated on Frontier at Ombre 3 / 5: pub IDG_20261026_204630_265, cafe IDG_20261027_115516_955,
// synthetic flash frame synth3; image metrics in output L*a*b*, scratchpad htsh/metrics.py). The base is a bilateral grid
// (areas, not windows: no halo, a dark area next to a bright one is lifted as much as one in the middle of the dark).
// SIGMA_FRAC_LO / SIGMA_EV_LO: the grid's spatial (fraction of the long side) and range (EV) sigma; choice, kept from the
// first version (CPU map sweep: 1/10 halves the synthetic frame's spread but opens holes on pub, 0.08 of the area; 2.5 EV
// lets the bright side bleed in, synth3 spread 0.39 -> 0.82).
// KNEE_EV_LO: half width (EV) of the quadratic entry below the dead zone; choice (1 EV: no change in the CPU map sweep).
// LIFT_SLOPE / LIFT_MAX_EV: EV of light per EV of depth, and the ceiling. Slope 1 / ceiling 3 (batch 2) took cafe's colour
// blotches 0.98 -> 1.78 and the dots 0.6 -> 11.6 at Ombre 5; 0.85 / 2.5 keep them near the old map's (cafe 1.22 vs 0.93).
// SNR_MIN: the lift's ceiling keeps the area SNR_MIN x its noise floor above it (raw only: a JPEG has no noise floor);
// 8 left cafe's face in shadow at L* 4 (old map 16), 4 a choice between that and no cap (L* 10, blotches 1.08).
const SIGMA_FRAC_LO = 1 / 20, SIGMA_EV_LO = 1.5, KNEE_EV_LO = 0.5, LIFT_SLOPE = 0.85, LIFT_MAX_EV = 2.5, SNR_MIN = 4;
// The toe's colour: where an area is TOE_EV (EV below mid grey, smoothstep) deep its lift brings Gold's olive shadow with it,
// R and B down by OLIVE_RB EV per EV of lift (G up, below), the scene colour first desaturated by TOE_DESAT at the ceiling
// (the sensor's colour noise lifted with the light). Target: the kg200 real scans' shadows, L* 12-22 at a* ~ -10, b* ~ +14,
// C* 17-19; measured cafe Ombre 5 a* -10.5 b* +13.4 C* 17.7 (old map -3.4 / +5.8 / 7.5). TOE_DESAT 0.7: 0.4 took cafe's
// dots 0.6 -> 11.6 (batch 2). OLIVE_RB [0.6, 0.7] from 2 EV overshot (cafe C* 23), [1.0, 1.2] more (C* 25).
// WARM / WARM_GUARD: a warm pixel ((R - B) / (R + G + B), smoothstep; skin ~0.2) keeps 1 - WARM_GUARD of the cast, so a face
// in shadow is not turned green (cafe face a* -7.6 vs +0.7 unguarded at [0.6, 0.7]; -2.4 guarded); choice, first values.
const OLIVE_RB = [0.55, 0.6], TOE_EV = [2, 3.5], TOE_DESAT = 0.7, WARM = [0.08, 0.2], WARM_GUARD = 0.7;
// G gets the luminance back (Rec.2020 weights): the cast moves the colour, not the lift
const OLIVE = [OLIVE_RB[0], -(0.2627 * OLIVE_RB[0] + 0.0593 * OLIVE_RB[1]) / 0.678, OLIVE_RB[1]];
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
/** Self-guided filter (He et al. 2010) of `L` (w×h), window radius `r` px, edge threshold `edge` EV: the base. */
function guided(L, w, h, r, edge) {
  const n = w * h, eps = edge * edge, LL = L.map((v) => v * v), mL = box(L, w, h, r), mLL = box(LL, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, mLL[i] - mL[i] * mL[i]);
    a[i] = v / (v + eps); b[i] = mL[i] - a[i] * mL[i];
  }
  const ma = box(a, w, h, r), mb = box(b, w, h, r), base = new Float32Array(n);
  for (let i = 0; i < n; i++) base[i] = ma[i] * L[i] + mb[i];
  return base;
}

/** Edge-preserving smoothing of `L` (w×h, log2 luminance): a bilateral grid (Chen, Paris & Durand 2007) with spatial sigma
 * `ss` px and range sigma `sr` (EV): splatted into cells ss px and sr EV wide, blurred [1 4 6 4 1] / 16 along each axis (about
 * one cell's sigma) and read back trilinearly. Areas within ~sr of each other average together whatever their texture; across a
 * step of a few sr the two sides barely touch (no halo, unlike the guided filter, whose windows straddle the step). */
function bilateral(L, w, h, ss, sr) {
  let lo = Infinity, hi = -Infinity;
  for (const v of L) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const gx = Math.ceil(w / ss) + 3, gy = Math.ceil(h / ss) + 3, gz = Math.ceil((hi - lo) / sr) + 3, n = gx * gy * gz;
  let sum = new Float32Array(n), cnt = new Float32Array(n);
  const cell = (x, y, v) => ((Math.round(v) * gy + Math.round(y)) * gx + Math.round(x));
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    const c = cell(x / ss + 1, y / ss + 1, (L[i] - lo) / sr + 1);
    sum[c] += L[i]; cnt[c] += 1;
  }
  const blur = (a, stride, len) => {   // [1 4 6 4 1] / 16 along one axis (cells `stride` apart, `len` of them), zero outside
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = Math.floor(i / stride) % len;
      let s = 6 * a[i];
      if (k > 0) s += 4 * a[i - stride]; if (k > 1) s += a[i - 2 * stride];
      if (k < len - 1) s += 4 * a[i + stride]; if (k < len - 2) s += a[i + 2 * stride];
      out[i] = s / 16;
    }
    return out;
  };
  for (const [st, len] of [[1, gx], [gx, gy], [gx * gy, gz]]) { sum = blur(sum, st, len); cnt = blur(cnt, st, len); }
  const out = new Float32Array(w * h);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    const fx = x / ss + 1, fy = y / ss + 1, fz = (L[i] - lo) / sr + 1;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz), tx = fx - x0, ty = fy - y0, tz = fz - z0;
    let s = 0, c = 0;
    for (let k = 0; k < 8; k++) {
      const dx = k & 1, dy = (k >> 1) & 1, dz = k >> 2, wt = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
      const j = ((z0 + dz) * gy + y0 + dy) * gx + x0 + dx;
      s += wt * sum[j]; c += wt * cnt[j];
    }
    out[i] = c > 1e-6 ? s / c : L[i];
  }
  return out;
}

/**
 * The Hyper Tone map of a scene-linear thumb (`rgb` w×h×3, upright as rendered) with luminance weights `luma`, exposed for the
 * film by `gain` (the exposure gain the render applies): { map, w, h } at MAP_LONG on the long side, `map` MAP_CH channels per
 * texel: the lights' EV beyond the dead zone from mid grey (> 0; x the level's strength in hyperArray), the shadows' lift at
 * the top level (EV >= 0, shadowLift) and its share in the toe (0..1, TOE_EV). `noise`: the thumb's luminance noise floor (dng.js noiseFloor at its pitch; 0: unknown),
 * the log's offset (util.js NOISE_FLOOR_SIGMAS): in log2 of the bare luminance, a frame's darkest areas, all sensor noise, spread
 * over many stops, the filter kept that as edges and the map lifted it as speckle (night frame IDG_20261028_222823_718); and the
 * shadows' cap (SNR_MIN).
 */
export function hyperToneMap(rgb, w, h, luma, gain = 1, noise = 0) {
  const n = w * h, L = new Float32Array(n), off = NOISE_FLOOR_SIGMAS * noise, long = Math.max(w, h);
  for (let i = 0; i < n; i++) L[i] = Math.log2(Math.max(Y_MIN, off + luma[0] * rgb[3 * i] + luma[1] * rgb[3 * i + 1] + luma[2] * rgb[3 * i + 2]));
  const s = Math.min(1, MAP_LONG / long), mw = Math.max(1, Math.round(w * s)), mh = Math.max(1, Math.round(h * s));
  const hi = shrink(guided(L, w, h, Math.max(1, Math.round(RADIUS_FRAC * long)), EDGE_EV), w, h, mw, mh);
  const lo = shrink(bilateral(L, w, h, Math.max(1, SIGMA_FRAC_LO * long), SIGMA_EV_LO), w, h, mw, mh);
  const map = new Float32Array(MAP_CH * mw * mh), ref = Math.log2(MID_GREY / gain);
  for (let i = 0, j = 0; i < mw * mh; i++, j += MAP_CH) {
    map[j] = Math.max(0, hi[i] - ref - DEAD_EV_HI);
    map[j + 1] = shadowLift(ref - lo[i], 2 ** lo[i] - off, noise);
    map[j + 2] = smoothstep(TOE_EV[0], TOE_EV[1], ref - lo[i]);
  }
  return { map, w: mw, h: mh };
}

/** The shadows' lift at the top level (EV) of an area `depth` EV below mid grey with mean luminance `y` (thumb units) and noise
 * floor `noise` (0: unknown, no cap): a graded entry around DEAD_EV_LO (a quadratic knee KNEE_EV_LO wide each side: no area
 * just below the dead zone is cut off while its neighbour is lifted), rising with LIFT_SLOPE (< 1: a deeper area stays darker,
 * a falloff keeps its order) towards the ceiling LIFT_MAX_EV (every deep area gets about the same lift: its own gradients and
 * contrast stay), the ceiling lowered to the area's signal: log2(y / (SNR_MIN x noise)), so no area is lifted into its own
 * sensor noise. tanh for both: smooth, never steeper than the line it bends. */
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function shadowLift(depth, y, noise) {
  const e = depth - DEAD_EV_LO, x = e <= -KNEE_EV_LO ? 0 : e >= KNEE_EV_LO ? e : (e + KNEE_EV_LO) ** 2 / (4 * KNEE_EV_LO);
  const up = LIFT_MAX_EV * Math.tanh(LIFT_SLOPE * x / LIFT_MAX_EV);
  if (!(noise > 0)) return up;
  const cap = Math.log2(Math.max(y, 0) / (SNR_MIN * noise));
  return cap > 0 ? cap * Math.tanh(up / cap) : 0;
}

// In the input pass (v4.9): the map moves the LIGHT that reaches the film, scene x 2^ev before the exposure gain, ev the
// lights' map x minus their level's strength plus the shadows' lift x their level. As a density lift in the scanner (the first
// version) a shadow left in the film's toe came out milky grey-green with the fog and grain of a thin negative, mottled (user,
// cafe IDG_20261027_115516_955); given light, the film renders the shadow's own detail with its own toe and colours. The map
// rides after the display-gain LUT in the pass's storage array: header [map w, map h], then the map (EV per texel).
const HDR = 2, MAP_CH = 3;

/** The input pass's storage array: `lut` (color.js DISPLAY_GAIN_LUT), then the header and the map of `hyper` ({ map, w, h },
 * hyperToneMap) at the lights' strength `kHi` (look.js hyperLevel) and the shadows' level `fLo` (0..1 of the top level). */
export function hyperArray(lut, hyper, kHi, fLo) {
  const n = hyper.w * hyper.h, out = new Float32Array(lut.length + HDR + 2 * n), o = lut.length + HDR, m = hyper.map;
  out.set(lut);
  out.set([hyper.w, hyper.h], lut.length);
  for (let i = 0, j = 0; i < n; i++, j += MAP_CH) {
    const up = fLo * m[j + 1];
    out[o + 2 * i] = up - kHi * m[j]; out[o + 2 * i + 1] = up * m[j + 2];
  }
  return out;
}

/** WGSL: the gain at output-frame position `pos` (frame `p.frame`), from the array `arr` with the header at `at0`, and the
 * EV it adds (hyperLift: > 0 in the shadows). */
export const hyperWGSL = (arr, at0) => /* wgsl */`
fn hyperMap(pos: vec2<f32>) -> vec2<f32> {   // [EV added, its part in the toe] at pos, bilinear
  let mw = ${arr}[${at0}u]; let mh = ${arr}[${at0}u + 1u];
  let q = clamp((pos + 0.5) / p.frame * vec2<f32>(mw, mh) - 0.5, vec2<f32>(0.0), vec2<f32>(mw - 1.0, mh - 1.0));
  let i0 = vec2<u32>(floor(q)); let i1 = min(i0 + 1u, vec2<u32>(u32(mw) - 1u, u32(mh) - 1u)); let f = q - floor(q);
  let W = u32(mw); let o = ${at0}u + ${HDR}u;
  let t00 = o + 2u * (i0.y * W + i0.x); let t01 = o + 2u * (i0.y * W + i1.x); let t10 = o + 2u * (i1.y * W + i0.x); let t11 = o + 2u * (i1.y * W + i1.x);
  return mix(mix(vec2<f32>(${arr}[t00], ${arr}[t00 + 1u]), vec2<f32>(${arr}[t01], ${arr}[t01 + 1u]), f.x),
             mix(vec2<f32>(${arr}[t10], ${arr}[t10 + 1u]), vec2<f32>(${arr}[t11], ${arr}[t11 + 1u]), f.x), f.y);
}
fn hyperEv(pos: vec2<f32>) -> f32 { return hyperMap(pos).x; }
fn hyperTone(pos: vec2<f32>, c: vec3<f32>) -> vec3<f32> {   // the scene colour c with the map's light (and the toe's cast) at pos
  let m = hyperMap(pos);
  let d = ${wf(TOE_DESAT)} * clamp(m.y / ${wf(LIFT_MAX_EV)}, 0.0, 1.0);
  let warm = (c.r - c.b) / max(c.r + c.g + c.b, ${wf(Y_MIN)});
  let ol = m.y * (1.0 - ${wf(WARM_GUARD)} * smoothstep(${wf(WARM[0])}, ${wf(WARM[1])}, warm));
  return mix(c, vec3<f32>(dot(c, p.luma.xyz)), d) * exp2(vec3<f32>(m.x) - ol * ${wv3(OLIVE)});
}`;

/** CPU twin of hyperWGSL's hyperTone: the scene colour `c` (RGB, luminance weights `luma`) at output-frame px (x, y) of an
 * fw×fh frame, changed in place. */
export function hyperToneCPU(arr, at0, x, y, fw, fh, c, luma) {
  const mw = arr[at0], mh = arr[at0 + 1], o = at0 + HDR;
  const qx = Math.min(mw - 1, Math.max(0, (x + 0.5) / fw * mw - 0.5)), qy = Math.min(mh - 1, Math.max(0, (y + 0.5) / fh * mh - 0.5));
  const x0 = Math.floor(qx), y0 = Math.floor(qy), x1 = Math.min(x0 + 1, mw - 1), y1 = Math.min(y0 + 1, mh - 1), fx = qx - x0, fy = qy - y0;
  const at = (k, ch) => arr[o + 2 * k + ch], lerp = (a, b, t) => a + (b - a) * t;
  const [ev, toe] = [0, 1].map((ch) => lerp(lerp(at(y0 * mw + x0, ch), at(y0 * mw + x1, ch), fx), lerp(at(y1 * mw + x0, ch), at(y1 * mw + x1, ch), fx), fy));
  const d = TOE_DESAT * Math.min(1, Math.max(0, toe / LIFT_MAX_EV)), Y = luma[0] * c[0] + luma[1] * c[1] + luma[2] * c[2];
  const cast = toe * (1 - WARM_GUARD * smoothstep(WARM[0], WARM[1], (c[0] - c[2]) / Math.max(c[0] + c[1] + c[2], Y_MIN)));
  for (let k = 0; k < 3; k++) c[k] = (c[k] + (Y - c[k]) * d) * 2 ** (ev - cast * OLIVE[k]);
  return c;
}
