// v4: what is impressed on the Gold 200 negative, shown as a positive with a neutral inversion (no paper, no scanner look).
//
// The engine returns the developed negative as a scan (`scanner.model = "narrowband"`, display-encoded). Per channel the density
// d = -log10(T) is, along the film's straight line, its gamma times the scene's log exposure; the toe and shoulder are the film's
// own. Two kinds of scan:
//   - shared (the app, `narrowband.setup`): the engine has already put each channel on the stock's grey axis (film-type setup,
//     engine narrowband.rs: a grey the film recorded is equal in the three channels, base and mask removed), so one black and
//     one white for the three channels: the frame's thinnest / densest channel (percentiles), nothing clips and the film's
//     colours stay as it recorded them, less the overall cast read on near-neutral pixels (NEUTRAL_SIGMA);
//   - per channel (raw scans of a real negative, eval/gold200: their stock's grey axis is not known): each channel's own black /
//     white from the frame, so the orange mask and any overall cast go. On a frame with a strong cast this stretches the channel
//     with the least range: a sunset (IDG_20261022_182651_466) came out with a cyan sky the DNG does not have (v4 until 3.48);
//   - mid grey: the frame's median density lands on display mid grey (0.18 linear);
//   - between the anchors, density maps linearly to log display light (density is log exposure): the film's toe and
//     shoulder shape the shadows and highlights, nothing else does.
// Magenta ↔ Verde / Giallo ↔ Blu shift the G / B channel's position between its black and white; Luminosità moves where the
// mid grey lands (EV over MID): the black and white anchors stay, so nothing clips.
//
// No DOM: shared by the GPU output pass (output.js) and the CPU path (app.js).

import { srgbToLinear as srgbDec, linearToSrgb as srgbEnc } from './color.js';

// Choices, not measurements (v4 prototype): black / white percentiles (a few extreme pixels, specular glints, do not set the
// range; the soft ends below take them), display black (linear, ~L* 3.6: not 0, so the deepest film shadows keep their shape),
// colour key per slider step in normalised density (±30 -> ±0.09 of the frame's range).
const LO_PCT = 0.005, HI_PCT = 0.998;
const MID = 0.18;                       // display mid grey (linear, 18 %)
const BLACK = 0.004;
const KEY = 0.003;
// Soft ends in log display light: past the white / black anchors the frame still has a few pixels (the anchors are
// percentiles), so instead of clipping them the curve approaches white (ln 1 = 0) and FLOOR asymptotically, with slope 1 at
// the join. SOFT_W: width of the white roll-off in ln units (0.12: the white anchor lands at 0.957 linear, 250/255);
// FLOOR = BLACK / 8 with the same width at the bottom (the deepest film shadows never reach 0).
const SOFT_W = 0.12, FLOOR = Math.log(BLACK / 8);
const T_MIN = 1e-6;
// Degenerate frames: a channel whose black and white are closer than MIN_RANGE density (a flat or
// near-flat frame) gets that range, so it is shown as a mid tone instead of being stretched; the mid-grey anchor is kept in
// [XM_MIN, XM_MAX] of the range, or a frame half black / half white puts it on an end and the curve divides by zero.
const MIN_RANGE = 0.05, XM_MIN = 0.1, XM_MAX = 0.9;
// Shared scans: the overall cast (light, white balance) is read from near-neutral pixels and taken out, as a lab's colour
// setup does: each pixel's weight is 1 / (1 + (chroma / NEUTRAL_SIGMA)^2), chroma = its largest |D_c - D_G| (density), so a
// sunset's saturated sky and clouds barely count while a rock in blue shade, near grey, does. 0.06: the v4 Frontier AutoSetup's
// (app.js V4_NEUTRAL_SIGMA, same role). Measured: the rock (IDG_20261011_134131_210) read B-G +0.076 / R-G -0.022 and came out
// blue-violet without it, grey with it as in the DNG; the sunset's cast 0.034 / 0.016 (its sky stays grey-blue, clouds red).
const NEUTRAL_SIGMA = 0.06;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];

/** Inversion anchors from the engine's negative scan of a thumb (RGB, display-encoded): { lo[3], hi[3], xm }; `shared`: one
 * black / white for the three channels (a scan on the stock's grey axis, see above). */
export function invertAnchors(scan, { shared = false } = {}) {
  const n = scan.length / 3, d = [0, 1, 2].map(() => new Float32Array(n)), mean = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) d[c][i] = -Math.log10(Math.max(T_MIN, srgbDec(scan[3 * i + c])));
  }
  const range = (sLo, sHi) => {
    const l = pct(sLo, LO_PCT), h = pct(sHi, HI_PCT), pad = Math.max(0, MIN_RANGE - (h - l)) / 2;
    return [l - pad, h + pad];
  };
  const lo = [], hi = [];
  if (shared) {
    const cast = [0, 0, 0];
    let wsum = 0;
    for (let i = 0; i < n; i++) {
      const r = d[0][i] - d[1][i], b = d[2][i] - d[1][i], w = 1 / (1 + (Math.max(Math.abs(r), Math.abs(b)) / NEUTRAL_SIGMA) ** 2);
      cast[0] += w * r; cast[2] += w * b; wsum += w;
    }
    cast[0] /= wsum; cast[2] /= wsum;
    const dmin = new Float32Array(n), dmax = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = d[0][i] - cast[0], g = d[1][i], bl = d[2][i] - cast[2];
      dmin[i] = Math.min(r, g, bl); dmax[i] = Math.max(r, g, bl);
    }
    const [l, h] = range(dmin.sort(), dmax.sort());
    for (let c = 0; c < 3; c++) { lo.push(l + cast[c]); hi.push(h + cast[c]); }   // the cast as each channel's offset
  } else {
    for (let c = 0; c < 3; c++) {
      const s = Float32Array.from(d[c]).sort(), [l, h] = range(s, s);
      lo.push(l); hi.push(h);
    }
  }
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let c = 0; c < 3; c++) m += (d[c][i] - lo[c]) / (hi[c] - lo[c]);
    mean[i] = m / 3;
  }
  return { lo, hi, xm: Math.min(XM_MAX, Math.max(XM_MIN, pct(mean.sort(), 0.5))) };
}

/** Uniform values for INVERT_WGSL: lo[3], 1 / range[3], xm, the G / B key offsets, then the mid grey's offset (ln units);
 * `ev`: where the mid grey lands, EV over MID. */
export function invertUniform({ lo, hi, xm }, { mshift = 0, yshift = 0, ev = 0 } = {}) {
  return [...lo, ...hi.map((h, c) => 1 / (h - lo[c])), xm, mshift * KEY, yshift * KEY, ev * Math.LN2];
}

/** Display light (linear) of normalised density x: log-linear through (0, BLACK), (xm, MID e^dm), (1, 1), soft at both ends. */
function displayLin(x, xm, dm) {
  const lm = Math.log(MID) + dm;
  let l = x < xm ? Math.log(BLACK) + (lm - Math.log(BLACK)) * (x / xm) : lm * (1 - (x - xm) / (1 - xm));
  if (l > -SOFT_W) l = -SOFT_W * Math.exp(-(l + SOFT_W) / SOFT_W);
  else if (l < FLOOR + SOFT_W) l = FLOOR + SOFT_W * Math.exp((l - FLOOR - SOFT_W) / SOFT_W);
  return Math.exp(l);
}

/** CPU twin of the output pass's inversion: `px` (one engine output pixel, display-encoded negative scan) -> display-encoded
 * positive, in place; `u` = invertUniform(...). */
export function invertCPU(px, u) {
  for (let c = 0; c < 3; c++) {
    const x = (-Math.log10(Math.max(T_MIN, srgbDec(px[c]))) - u[c]) * u[3 + c] + (c ? u[6 + c] : 0);   // keys: u[7] G, u[8] B
    px[c] = srgbEnc(displayLin(x, u[6], u[9]));
  }
}

/** WGSL: `invertNeg(c, o)`, the same as invertCPU on a display-encoded pixel, with the uniforms at P[o..o+9]; returns
 * linear light. Needs srgbDec (color.js SRGB_WGSL). */
export const INVERT_WGSL = /* wgsl */`
fn invDisplay(x: vec3<f32>, xm: f32, dm: f32) -> vec3<f32> {
  let lb = log(${BLACK.toFixed(6)}); let lm = log(${MID.toFixed(6)}) + dm;
  let lo = vec3<f32>(lb) + (lm - lb) * (x / xm);
  let hi = vec3<f32>(lm) * (vec3<f32>(1.0) - (x - vec3<f32>(xm)) / (1.0 - xm));
  var l = select(hi, lo, x < vec3<f32>(xm));
  let w = ${SOFT_W.toFixed(4)}; let f = ${FLOOR.toFixed(6)};
  l = select(l, -w * exp(-(l + w) / w), l > vec3<f32>(-w));
  l = select(l, f + w * exp((l - f - w) / w), l < vec3<f32>(f + w));
  return exp(l);
}
fn invertNeg(c: vec3<f32>, o: u32) -> vec3<f32> {
  let d = -log(max(srgbDec(c), vec3<f32>(${T_MIN.toExponential()}))) / log(10.0);
  let lo = vec3<f32>(P[o], P[o + 1u], P[o + 2u]);
  let k = vec3<f32>(P[o + 3u], P[o + 4u], P[o + 5u]);
  let x = (d - lo) * k + vec3<f32>(0.0, P[o + 7u], P[o + 8u]);
  return invDisplay(x, P[o + 6u], P[o + 9u]);
}`;
export const INVERT_LEN = 10;
