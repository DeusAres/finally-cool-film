// Tone inversion: turn a display-referred photo (iPhone JPEG/HEIC, its tone curve
// already applied) into the scene-linear light spektrafilm expects.
//
// spektrafilm models film → print → scan from SCENE light. Feeding it a rendered
// photo applies a tone curve twice (iPhone's + the print system's, gamma ~1.5–2
// per channel), which also raises colour ratios to that power: dark, contrasty,
// over-saturated output. We measure the pipeline's grey transfer F (scene → output
// luminance) on uniform patches, and build the per-channel pre-curve P = F⁻¹ so a
// display value d comes out as d again. What remains is the film's own colour
// signature (layer cross-talk, dye spectra, couplers), grain, halation, DIR edges.
// `look` k blends towards the plain exposure (k = 1: the full print curve):
//   log2 s = (1 − k)·log2 F⁻¹(d) + k·log2 d
// Above a knee the target rolls off exponentially below the paper white G (where
// F is flat and F⁻¹ explodes), and the output is stretched by 1/G so paper white
// lands on display white, as a lab scanner sets its white point. Shadows compress
// linearly into the paper's real maximum density (scanner black correction off):
// blacks are never pure, as on any print.
// `ev` is a midtone exposure: a bell in log space centred on mid grey, so the
// mids move a lot and shadows / highlights little; applied before the shoulder,
// it cannot clip highlights.
import { LIN8 } from './color.js';

const LO = -12, HI = 8, N = 81;      // patch exposures: log2(s / 0.18), EV
const PATCH = 64, COLS = 9;          // 9×9 grid of 64 px patches, one engine run
const KNEE = 0.6, TOP = 0.985;       // identity below KNEE·G, shoulder up to TOP·G
const MID_SIGMA = 2.2;               // EV width of the midtone exposure bell
const SQRT_N = 1024;                 // LUT over sqrt(display linear) for interpolated samples

const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const enc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);

/** Grey chart for measuring F: N uniform patches, scene-linear (neutral, any RGB space). */
export function transferChart() {
  const rows = Math.ceil(N / COLS), w = COLS * PATCH, h = rows * PATCH;
  const rgb = new Float32Array(w * h * 3);
  for (let k = 0; k < N; k++) {
    const v = 0.18 * 2 ** (LO + (HI - LO) * k / (N - 1));
    const x0 = (k % COLS) * PATCH, y0 = ((k / COLS) | 0) * PATCH;
    for (let y = y0; y < y0 + PATCH; y++) rgb.fill(v, (y * w + x0) * 3, (y * w + x0 + PATCH) * 3);
  }
  return { rgb, w, h };
}

/** F from the engine's render of `transferChart()` (sRGB-encoded output). */
export function readTransfer(out, w) {
  const logS = [], Y = [];
  for (let k = 0; k < N; k++) {
    const cx = (k % COLS) * PATCH + PATCH / 2, cy = ((k / COLS) | 0) * PATCH + PATCH / 2;
    let s = 0, n = 0;
    for (let y = cy - 8; y < cy + 8; y++) for (let x = cx - 8; x < cx + 8; x++) {
      const i = (y * w + x) * 3;
      s += 0.2126 * lin(out[i]) + 0.7152 * lin(out[i + 1]) + 0.0722 * lin(out[i + 2]); n++;
    }
    logS.push(LO + (HI - LO) * k / (N - 1));
    Y.push(Math.max(s / n, k ? Y[k - 1] + 1e-7 : 1e-7));   // keep F strictly increasing
  }
  return { logS, Y, white: Y[N - 1], floor: Y[0] / Y[N - 1] };
}

// log2(s/0.18) with F(s) = target(d).
function inverse(T, d) {
  const { logS, Y, white: G, floor } = T;
  let t = floor * 1.02 + (1 - floor * 1.02) * d;      // shadows land softly on the paper black
  if (t > KNEE) { const r = TOP - KNEE; t = KNEE + r * (1 - Math.exp(-(t - KNEE) / r)); }
  t *= G;
  if (t <= Y[0]) return logS[0];
  let a = 0, b = Y.length - 1;
  while (b - a > 1) { const m = (a + b) >> 1; if (Y[m] < t) a = m; else b = m; }
  const f = (Math.log(t) - Math.log(Y[a])) / (Math.log(Y[b]) - Math.log(Y[a]));
  return logS[a] + f * (logS[b] - logS[a]);
}

/** Scene-linear value for display-linear d. */
function sceneValue(T, d, look, ev) {
  const x = Math.log2(Math.max(d, 1e-5) / 0.18);
  d = 0.18 * 2 ** (x + ev * Math.exp(-(x * x) / (2 * MID_SIGMA * MID_SIGMA)));
  return 0.18 * 2 ** ((1 - look) * inverse(T, Math.min(d, 1)) + look * Math.log2(d / 0.18));
}

/**
 * Starting point from the photo's own luminance (display-linear Y samples):
 * lift the mids half-way towards a balanced median, and add print contrast in
 * proportion to how flat the photo is. Tuned towards "a touch brighter and
 * punchier", which is where manual edits kept going.
 */
export function autoTone(Ys) {
  const v = Float32Array.from(Ys).sort();
  const q = (p) => Math.max(v[Math.floor(p * (v.length - 1))], 1e-4);
  const median = q(0.5), spread = Math.log2(q(0.75) / q(0.25));
  const ev = Math.max(-1, Math.min(1.5, 0.6 * Math.log2(0.2 / median)));
  const look = Math.max(0.2, Math.min(0.75, 0.4 + 0.12 * (2.5 - spread)));
  return { ev: Math.round(ev * 10) / 10, look: Math.round(look * 20) / 20 };
}

/**
 * Lookup tables for one (transfer, look, ev):
 *   lut8[code]          8-bit display code value → scene-linear
 *   lutSqrt[i]          display-linear c = (i/SQRT_N)² → scene-linear (for interpolated samples)
 *   out8[i]             engine output (sRGB-encoded, i/4095) → display 8-bit after the white stretch
 */
export function buildTone(T, { look, ev }) {
  const lut8 = Float32Array.from(LIN8, (d) => sceneValue(T, d, look, ev));
  const lutSqrt = new Float32Array(SQRT_N + 1);
  for (let i = 0; i <= SQRT_N; i++) lutSqrt[i] = sceneValue(T, (i / SQRT_N) ** 2, look, ev);
  // White stretch, plus a soft floor at the paper black: scanner sharpening and
  // grain can undershoot locally, but a print is never darker than its Dmax.
  const out8 = new Uint8ClampedArray(4096), f = T.floor * 0.85;
  for (let i = 0; i < 4096; i++) {
    const x = Math.min(1, lin(i / 4095) / T.white);
    out8[i] = Math.round(255 * enc(Math.min(1, Math.sqrt(x * x + f * f))));
  }
  return { lut8, lutSqrt, out8 };
}

/** Scene value for an interpolated display-linear sample (CPU twin of the shader lookup). */
export function sceneFromLinear(lutSqrt, c) {
  const f = Math.sqrt(Math.max(0, Math.min(1, c))) * SQRT_N, i = f | 0;
  return i >= SQRT_N ? lutSqrt[SQRT_N] : lutSqrt[i] + (lutSqrt[i + 1] - lutSqrt[i]) * (f - i);
}

export const TONE_SQRT_N = SQRT_N;
