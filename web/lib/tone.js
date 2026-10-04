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
// `ev` move the mids a lot and shadows / lights little (with diminishing returns,
// so the mids never eat the lights' headroom), and whose `rolloff` makes white an
// asymptote reached with slope < 1 — a soft shoulder.
// The display curve is applied to the pixel's max(R,G,B) and the resulting gain
// to all three channels (hue and saturation survive a brighter exposure, as with
// a real exposure change); only the inversion is per channel, which keeps the
// film's colour response.
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
  const logS = [], Y = [], C = [[], [], []];
  for (let k = 0; k < N; k++) {
    const cx = (k % COLS) * PATCH + PATCH / 2, cy = ((k / COLS) | 0) * PATCH + PATCH / 2;
    let s = 0, n = 0;
    const sc = [0, 0, 0];
    for (let y = cy - 8; y < cy + 8; y++) for (let x = cx - 8; x < cx + 8; x++) {
      const i = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) sc[c] += lin(out[i + c]);
      s += 0.2126 * lin(out[i]) + 0.7152 * lin(out[i + 1]) + 0.0722 * lin(out[i + 2]); n++;
    }
    logS.push(LO + (HI - LO) * k / (N - 1));
    Y.push(Math.max(s / n, k ? Y[k - 1] + 1e-7 : 1e-7));   // keep F strictly increasing
    for (let c = 0; c < 3; c++) C[c].push(sc[c] / n);         // per-channel response to neutral grey
  }
  return { logS, Y, C, white: Y[N - 1], floor: Y[0] / Y[N - 1] };
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
const MID_HEADROOM = XW - 1.1;       // mids stay ≥ 1.1 EV below white however far ev goes

function displayCurve(ev, rolloff) {
  const lift = 0.9 * ev;
  const mid = lift > 0 ? MID_HEADROOM * Math.tanh(lift / MID_HEADROOM) : lift, white = XW - 0.06 * rolloff;
  const shadows = Math.min(mid - 0.25 * 3.5, -3.5 + 0.15 * ev);
  const secant = (white - mid) / XW;
  return monotoneSpline(
    [[-10, -10], [-3.5, shadows], [0, mid], [XW, white]],
    [1, null, secant * (1 + 0.25 * rolloff), secant * (1 - 0.6 * rolloff)],
  );
}

// `look` mixes in the print curve channel by channel, which is what gives the
// mids their punch and colour. In deep shadows it double-toes: a warm dark
// colour (R > G > B) has G and B already in the paper's toe while R is not, so
// the hue swings to red/magenta and the chroma collapses (measured on an
// iPhone original: hue 51° → 36°, chroma ×0.56 at L* 10–20). So the print
// curve fades out below LOOK_FADE (EV under mid grey); there the inversion,
// which keeps hue exactly, takes over.
const LOOK_FADE = [-5, -2];

/** Scene-linear value for a display-linear value dc that has been through the display curve. */
function sceneValue(T, dc, look) {
  dc = Math.max(dc, 1e-5);
  const t = Math.max(0, Math.min(1, (Math.log2(dc / 0.18) - LOOK_FADE[0]) / (LOOK_FADE[1] - LOOK_FADE[0])));
  look *= t * t * (3 - 2 * t);
  return 0.18 * 2 ** ((1 - look) * inverse(T, Math.min(dc, 1)) + look * Math.log2(dc / 0.18));
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
  // Back off when much of the frame is already bright (backlight, sky through leaves):
  // lifting the mids there just washes the lights out.
  let bright = 0; for (const y of v) if (y > 0.5) bright++;
  const hold = Math.max(0, 1 - 2.5 * bright / v.length);
  const ev = Math.max(-1, Math.min(1.5, 0.6 * Math.log2(0.2 / median) * (median < 0.2 ? hold : 1)));
  const look = Math.max(0.2, Math.min(0.75, 0.4 + 0.12 * (2.5 - spread)));
  return { ev: Math.round(ev * 10) / 10, look: Math.round(look * 20) / 20 };
}

/**
 * Lookup tables for one (transfer, look, ev, rolloff), all over sqrt(display linear):
 *   gain[i]     display curve as a gain for a pixel whose max(R,G,B) is (i/N)²
 *   scene[i]    per-channel display value (i/N)² (after the gain) → scene light
 *   out8[j]     engine output (sRGB-encoded, j/4095) → display 8-bit after the white stretch
 * `packed` is gain ++ scene, as the WebGPU lens stage reads it.
 */
export function buildTone(T, { look, ev, rolloff = 0.6 }) {
  const curve = displayCurve(ev, rolloff);
  const gain = new Float32Array(SQRT_N + 1), scene = new Float32Array(SQRT_N + 1);
  for (let i = 0; i <= SQRT_N; i++) {
    const n = Math.max((i / SQRT_N) ** 2, 1e-6);
    gain[i] = (0.18 * 2 ** curve(Math.log2(n / 0.18))) / n;
    scene[i] = sceneValue(T, (i / SQRT_N) ** 2, look);
  }
  // White stretch, a soft floor at the paper black (scanner sharpening and
  // grain can undershoot locally, but a print is never darker than its Dmax),
  // then the scanner curve (SCAN_CURVE).
  const out8 = new Uint8ClampedArray(4096), f = T.floor * 0.85;
  for (let j = 0; j < 4096; j++) {
    const x = Math.min(1, lin(j / 4095) / T.white);
    out8[j] = Math.round(255 * enc(fromLstar(scanCurve(toLstar(Math.min(1, Math.sqrt(x * x + f * f)))))));
  }
  const packed = new Float32Array(2 * (SQRT_N + 1));
  packed.set(gain, 0); packed.set(scene, SQRT_N + 1);
  return { gain, scene, out8, packed, balance: (T.balance ||= greyBalance(T)) };
}

// Scanner curve, in L* (output → output), per channel like a lab scanner's.
// Fitted to real Kodak Gold 200 scans the user likes (shopfront, two people on
// grass, cliffs over the sea), measured against the grey ramp through this
// pipeline: the black point sits at L* ~2.5 (the scans reach 1–4; paper Dmax
// alone leaves ~7), the deep shadows rise steeply from it, the low shadows are
// lifted +6–8 L* (cast shadows in those scans are ~1.5 stops under the sunlit
// side, not ~3: luminous, open), and the lift fades out by L* ~65. The steep
// stretch between the deep black and the lifted shadows is the soft
// "detachment" between shadows and mids. Highlights are untouched up to L* ~92;
// above, a short shoulder puts paper white at L* 98 (the scans' brightest areas
// sit at 94–96, 3 of 4 never reach 100). Unclipped photo white only reaches
// ~95.5 here (the inversion's guard below paper white); the rest is light the
// phone clipped (CLIP_GAIN, common.js), which used to jump 95.5 → 100 between
// input 250 and 252: a hard contour around blown skies. Now 95.1 → 97.9.
const SCAN_PTS = [[0, 0], [7.2, 2.5], [11.8, 9], [13.2, 14], [14.7, 19], [16.6, 23], [18.9, 27],
  [25.3, 33], [33.2, 39], [41.1, 45], [52.8, 54.5], [64, 64.5], [76.6, 76.6], [88, 88], [95.5, 95.2], [100, 98]];
const scanCurve = monotoneSpline(SCAN_PTS, SCAN_PTS.map(() => null));
const toLstar = (Y) => (Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y);
const fromLstar = (L) => (L > 8 ? ((L + 16) / 116) ** 3 : Math.max(0, L) / 903.3);

/**
 * Grey balance, as a lab scanner sets it: three curves over the engine's
 * encoded output (1025 entries each, R ++ G ++ B) mapping each channel's
 * response to the neutral chart onto the patch's luminance, so a neutral
 * grey comes out neutral at every level. Measured need: in the film/paper
 * toe the channels part slightly, and the scanner curve's steep shadow
 * stretch turned that into a green-yellow cast on dark neutrals
 * (a* −5, b* +3 at L* 17 on a grey ramp).
 */
export function greyBalance(T) {
  const n = SQRT_N + 1, out = new Float32Array(3 * n);
  for (let c = 0; c < 3; c++) {
    // (x, y) = (channel's encoded output, encoded luminance) per patch, x strictly increasing.
    const xs = [], ys = [];
    for (let k = 0; k < T.Y.length; k++) {
      const x = enc(T.C[c][k]), y = enc(T.Y[k]);
      if (!xs.length || x > xs[xs.length - 1] + 1e-5) { xs.push(x); ys.push(y); }
    }
    for (let i = 0; i < n; i++) {
      const u = i / SQRT_N;
      let v;
      if (u <= xs[0]) v = u * ys[0] / Math.max(xs[0], 1e-6);
      else if (u >= xs[xs.length - 1]) v = ys[ys.length - 1] + (u - xs[xs.length - 1]);
      else { let a = 0, b = xs.length - 1; while (b - a > 1) { const m = (a + b) >> 1; if (xs[m] < u) a = m; else b = m; }
        v = ys[a] + (ys[b] - ys[a]) * (u - xs[a]) / (xs[b] - xs[a]); }
      out[c * n + i] = Math.min(1, Math.max(0, v));
    }
  }
  return out;
}

const lookup = (lut, c) => {
  const f = Math.sqrt(c <= 0 ? 0 : c >= 1 ? 1 : c) * SQRT_N, i = f | 0;
  return i >= SQRT_N ? lut[SQRT_N] : lut[i] + (lut[i + 1] - lut[i]) * (f - i);
};

/** Display-linear RGB → scene-linear RGB (written to out[o..o+2]). CPU twin of the shader. */
export function applyTone(tone, r, g, b, out, o) {
  const k = lookup(tone.gain, Math.max(r, g, b));
  out[o] = lookup(tone.scene, r * k); out[o + 1] = lookup(tone.scene, g * k); out[o + 2] = lookup(tone.scene, b * k);
}

export const TONE_SQRT_N = SQRT_N;

/** For inspection/tests: the display curve as a function of display-linear d (neutral pixels). */
export const displayTone = (ev, rolloff) => { const c = displayCurve(ev, rolloff); return (d) => 0.18 * 2 ** c(Math.log2(Math.max(d, 1e-5) / 0.18)); };
