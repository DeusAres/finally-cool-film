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
// Before the inversion, a display tone curve shapes the result (displayCurve):
// a monotone spline in log space (EV around mid grey) whose control points make
// `ev` move the mids a lot and shadows / lights little, and whose `rolloff`
// lowers the lights and makes white an asymptote reached with slope < 1 — a soft
// shoulder that lets the mids climb without clipping the highlights.
import { LIN8 } from './color.js';

const LO = -12, HI = 8, N = 81;      // patch exposures: log2(s / 0.18), EV
const PATCH = 64, COLS = 9;          // 9×9 grid of 64 px patches, one engine run
const KNEE = 0.85, TOP = 0.985;      // numerical guard only: F is flat near paper white
const XW = Math.log2(1 / 0.18);      // display white, EV above mid grey (2.47)
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

// Monotone cubic Hermite through points [x, y] with slopes M (null = average of
// the neighbouring secants), limited Fritsch–Carlson style so it never overshoots.
function monotoneSpline(P, M) {
  const n = P.length, d = [];
  for (let i = 0; i < n - 1; i++) d.push((P[i + 1][1] - P[i][1]) / (P[i + 1][0] - P[i][0]));
  const m = M.map((v, i) => (v ?? (i === 0 ? d[0] : i === n - 1 ? d[n - 2] : (d[i - 1] + d[i]) / 2)));
  for (let i = 0; i < n - 1; i++) {
    if (d[i] <= 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= P[0][0]) return P[0][1] + (x - P[0][0]) * m[0];
    if (x >= P[n - 1][0]) return P[n - 1][1];
    let i = 0; while (x > P[i + 1][0]) i++;
    const h = P[i + 1][0] - P[i][0], t = (x - P[i][0]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * P[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * P[i + 1][1] + (t3 - t2) * h * m[i + 1];
  };
}

/**
 * Display tone curve in log2 space around mid grey (x = log2(d / 0.18)):
 *   deep shadows fixed, shadows +0.15·ev, mids +0.9·ev;
 *   above the mids a concave shoulder: slope starts at (1 + 0.25·rolloff)× the
 *   mid→white secant and falls to (1 − 0.6·rolloff)× at white, so the lights
 *   spread evenly and white is approached gently (no band where the iPhone
 *   clipped); with full rolloff white lands just below 1, like paper.
 */
function displayCurve(ev, rolloff) {
  const mid = 0.9 * ev, white = XW - 0.06 * rolloff;
  const shadows = Math.min(mid - 0.25 * 3.5, -3.5 + 0.15 * ev);
  const secant = (white - mid) / XW;
  return monotoneSpline(
    [[-10, -10], [-3.5, shadows], [0, mid], [XW, white]],
    [1, null, secant * (1 + 0.25 * rolloff), secant * (1 - 0.6 * rolloff)],
  );
}

/** Scene-linear value for display-linear d, through the display curve `curve`. */
function sceneValue(T, d, look, curve) {
  const y = curve(Math.log2(Math.max(d, 1e-5) / 0.18));
  const dc = 0.18 * 2 ** y;
  return 0.18 * 2 ** ((1 - look) * inverse(T, Math.min(dc, 1)) + look * y);
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
export function buildTone(T, { look, ev, rolloff = 0.6 }) {
  const curve = displayCurve(ev, rolloff);
  const lut8 = Float32Array.from(LIN8, (d) => sceneValue(T, d, look, curve));
  const lutSqrt = new Float32Array(SQRT_N + 1);
  for (let i = 0; i <= SQRT_N; i++) lutSqrt[i] = sceneValue(T, (i / SQRT_N) ** 2, look, curve);
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

/** For inspection/tests: the display curve as a function of display-linear d. */
export const displayTone = (ev, rolloff) => { const c = displayCurve(ev, rolloff); return (d) => 0.18 * 2 ** c(Math.log2(Math.max(d, 1e-5) / 0.18)); };
