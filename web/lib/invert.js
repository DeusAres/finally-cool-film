// v4: what is impressed on the Gold 200 negative, shown as a positive with a neutral inversion (no paper, no scanner look).
//
// The engine returns the developed negative as a scan (`scanner.model = null`: transmittance through the film, orange
// mask included, display-encoded). Per channel the density d = -log10(T) is, along the film's straight line, its gamma times
// the scene's log exposure; the toe and shoulder are the film's own. The inversion is the one a camera scan of a negative
// gets, with every number taken from the frame itself:
//   - black / white: per-channel density at the frame's thinnest / densest points (percentiles), so the brightest
//     highlight the film recorded lands exactly on white (nothing clips) and the orange mask and any overall cast go;
//   - mid grey: the frame's median density lands on display mid grey (0.18 linear);
//   - between the anchors, density maps linearly to log display light (density is log exposure): the film's toe and
//     shoulder shape the shadows and highlights, nothing else does.
// Magenta ↔ Verde / Giallo ↔ Blu shift the G / B channel's position between its black and white.
//
// No DOM: shared by the GPU output pass (grain.js) and the CPU path (app.js).

const LO_PCT = 0.005, HI_PCT = 0.998;   // black / white percentiles: robust to a few dust-like extremes
const MID = 0.18;                       // display mid grey (linear)
const BLACK = 0.004;                    // display black (linear, ~L* 3.6): not 0, so the deepest film shadows keep their shape
const KEY = 0.003;                      // colour key per slider step, in normalised density (±30 -> ±0.09 of the frame's range)
const T_MIN = 1e-6;

const srgbDec = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const srgbEnc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];

/** Inversion anchors from the engine's negative scan of a thumb (RGB, display-encoded): { lo[3], hi[3], xm }. */
export function invertAnchors(scan) {
  const n = scan.length / 3, d = [0, 1, 2].map(() => new Float32Array(n)), mean = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) d[c][i] = -Math.log10(Math.max(T_MIN, srgbDec(scan[3 * i + c])));
  }
  const lo = [], hi = [];
  for (let c = 0; c < 3; c++) {
    const s = Float32Array.from(d[c]).sort();
    lo.push(pct(s, LO_PCT)); hi.push(pct(s, HI_PCT));
  }
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let c = 0; c < 3; c++) m += (d[c][i] - lo[c]) / Math.max(1e-4, hi[c] - lo[c]);
    mean[i] = m / 3;
  }
  return { lo, hi, xm: pct(mean.sort(), 0.5) };
}

/** Uniform values for INVERT_WGSL: lo[3], 1 / range[3], xm, then the G / B key offsets. */
export function invertUniform({ lo, hi, xm }, mshift = 0, yshift = 0) {
  return [...lo, ...hi.map((h, c) => 1 / Math.max(1e-4, h - lo[c])), xm, mshift * KEY, yshift * KEY];
}

/** Display light (linear) of normalised density x: log-linear through (0, BLACK), (xm, MID), (1, 1). */
function displayLin(x, xm) {
  const l = x < xm ? Math.log(BLACK) + (Math.log(MID) - Math.log(BLACK)) * (x / xm) : Math.log(MID) * (1 - (x - xm) / (1 - xm));
  return Math.min(1, Math.exp(l));
}

/** CPU twin of the output pass's inversion: `px` (one engine output pixel, display-encoded negative scan) -> display-encoded
 * positive, in place; `u` = invertUniform(...). */
export function invertCPU(px, u) {
  const off = [0, u[7], u[8]];
  for (let c = 0; c < 3; c++) {
    const x = (-Math.log10(Math.max(T_MIN, srgbDec(px[c]))) - u[c]) * u[3 + c] + off[c];
    px[c] = srgbEnc(displayLin(x, u[6]));
  }
}

/** WGSL: `invertNeg(c, P, o)`, the same as invertCPU on a display-encoded pixel, with the uniforms at P[o..o+8]; returns
 * linear light. Needs srgbDec (color.js SRGB_WGSL). */
export const INVERT_WGSL = /* wgsl */`
fn invDisplay(x: vec3<f32>, xm: f32) -> vec3<f32> {
  let lb = log(${BLACK.toFixed(6)}); let lm = log(${MID.toFixed(6)});
  let lo = vec3<f32>(lb) + (lm - lb) * (x / xm);
  let hi = vec3<f32>(lm) * (vec3<f32>(1.0) - (x - vec3<f32>(xm)) / (1.0 - xm));
  return min(vec3<f32>(1.0), exp(select(hi, lo, x < vec3<f32>(xm))));
}
fn invertNeg(c: vec3<f32>, o: u32) -> vec3<f32> {
  let d = -log(max(srgbDec(c), vec3<f32>(${T_MIN.toExponential()}))) / log(10.0);
  let lo = vec3<f32>(P[o], P[o + 1u], P[o + 2u]);
  let k = vec3<f32>(P[o + 3u], P[o + 4u], P[o + 5u]);
  let x = (d - lo) * k + vec3<f32>(0.0, P[o + 7u], P[o + 8u]);
  return invDisplay(x, P[o + 6u]);
}`;
export const INVERT_LEN = 9;
