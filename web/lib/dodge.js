// Debug v3: automatic highlight dodging, Frontier "Hyper Tone"-style (digital dodging of the
// minilabs: the low-frequency brightness of the bright areas is shifted down, the detail is kept).
// Runs in the GPU input pass (scene light, before the film), from a base map computed here on the
// AutoSetup thumbnail of the whole frame: preview, export tiles and any resolution see the same map.
//
// base  B = guided filter (self-guided, radius DODGE_R of the long side, eps DODGE_EPS) of log2 luma.
// shift s(b) = A (1 - exp(-rho (b - knee) / A)) for b > knee, b = max(B, own pixel log2 luma):
//   slope <= rho < 1, so a darker pixel never ends up brighter than a lighter one (no halo, no rim),
//   and inside a bright area the shift is ~constant (cloud modelling kept).
// knee = median(B) + DODGE_KNEE; A is solved so that the bright base (P = 99th pct) lands at
// median + head(contrast): the higher the contrast, the earlier the scanner shoulder, the more dodging.

const DODGE_R = 0.08, DODGE_EPS = 1.0, DODGE_KNEE = 1.0, DODGE_RHO = 0.8, DODGE_PCT = 0.99;
/** Statistics only over lit pixels (black letterbox / night: the median must not sit on the floor);
 * below DODGE_MIN_LIT of lit pixels nothing is dodged; the shift never exceeds DODGE_MAX_EV. */
const DODGE_LIT_EV = -12, DODGE_MIN_LIT = 0.1, DODGE_MAX_EV = 3;
/** EV above the median the bright base may sit at, by contrast (tuned on the samples, eval/V3.md). */
const head = (c) => (c >= 0 ? 2.6 - 1.2 * c : 2.6 - 1.5 * c);

/** Box mean of radius r over a w×h array (summed-area table, edges clamped to the inside). */
function boxMean(a, w, h, r) {
  const S = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += a[y * w + x]; S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row; }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      out[y * w + x] = (S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/** Self-guided filter (He et al.) of `I` (log2 luma). */
function guided(I, w, h, r, eps) {
  const n = w * h, II = new Float32Array(n);
  for (let i = 0; i < n; i++) II[i] = I[i] * I[i];
  const mI = boxMean(I, w, h, r), mII = boxMean(II, w, h, r), a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = mII[i] - mI[i] * mI[i];
    a[i] = v / (v + eps); b[i] = mI[i] - a[i] * mI[i];
  }
  const ma = boxMean(a, w, h, r), mb = boxMean(b, w, h, r), q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = ma[i] * I[i] + mb[i];
  return q;
}

/**
 * Base map of a linear-RGB thumbnail (`rgb` w×h×3, same light domain as the input pass before
 * the exposure gain), `luma` the weights of its primaries. Returns { w, h, base, M, P }.
 */
export function dodgeBase(rgb, w, h, luma) {
  const L = new Float32Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 3) L[i] = Math.log2(Math.max(1e-6, luma[0] * rgb[j] + luma[1] * rgb[j + 1] + luma[2] * rgb[j + 2]));
  const base = guided(L, w, h, Math.max(1, Math.round(DODGE_R * Math.max(w, h))), DODGE_EPS);
  const s = Float32Array.from(base.filter((_, i) => L[i] > DODGE_LIT_EV)).sort();
  if (s.length < DODGE_MIN_LIT * w * h) return { w, h, base, M: 0, P: 0, none: true };
  return { w, h, base, M: s[Math.floor(0.5 * (s.length - 1))], P: s[Math.floor(DODGE_PCT * (s.length - 1))] };
}

/** { knee, A, rho } for a base and the Contrasto key (A = 0: nothing to dodge). */
export function dodgeParams(d, contrast) {
  const knee = d.M + DODGE_KNEE, rho = DODGE_RHO, e = Math.max(d.P - knee, 1e-6);
  const target = Math.min(d.P - (d.M + head(contrast)), 0.97 * rho * e, DODGE_MAX_EV);
  if (d.none || !(target > 0)) return { knee, A: 0, rho };
  let lo = target, hi = 50 * target;   // A (1 - exp(-rho e / A)) = target, increasing in A
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (mid * (1 - Math.exp(-rho * e / mid)) < target) lo = mid; else hi = mid;
  }
  return { knee, A: hi, rho };
}

// Contrasto luci (local contrast inside the highlights): the tones of a bright area that sit below its own
// base (a cloud's shaded side, grey edges) move by k (L - B), L - B clamped to [-2, 0] EV; the brightest
// tones (L >= B) never move, so nothing is pushed into the shoulder. Weighted by smoothstep(knee, pv) of
// both the pixel and its base: mids, shadows and dark objects next to a bright sky are untouched.
// Hue-safe (one gain on RGB). pv = halfway from the knee to the bright base P.
const HLC_UP = 0.9, HLC_DOWN = 0.6;
export const hlcGain = (v) => (v > 0 ? HLC_UP * v : HLC_DOWN * v);

/** Header + base appended to the input pass's gain array (read by dodgeWGSL from `at0`):
 * [dodge on, base w, base h, knee, A, rho, highlight-contrast k, pivot]. */
export function dodgeArray(gainLut, d, prm, hlc = 0) {
  const at0 = gainLut.length, out = new Float32Array(at0 + 8 + (d ? d.w * d.h : 0));
  out.set(gainLut);
  if (d) {
    out.set([prm.dodge && prm.A > 0 ? 1 : 0, d.w, d.h, prm.knee, prm.A, prm.rho, hlcGain(hlc), 0.5 * (prm.knee + d.P)], at0);
    out.set(d.base, at0 + 8);
  }
  return out;
}

/** WGSL: dodging of `c` (scene light before the exposure gain) at frame position `pos`. */
export const dodgeWGSL = (arr, at0) => /* wgsl */`
fn dodgeBaseAt(pos: vec2<f32>) -> f32 {
  let bw = ${arr}[${at0}u + 1u]; let bh = ${arr}[${at0}u + 2u];
  let q = clamp((pos + 0.5) / p.frame * vec2<f32>(bw, bh) - 0.5, vec2<f32>(0.0), vec2<f32>(bw - 1.0, bh - 1.0));
  let i0 = vec2<u32>(floor(q)); let i1 = min(i0 + 1u, vec2<u32>(u32(bw) - 1u, u32(bh) - 1u)); let f = q - floor(q);
  let o = ${at0}u + 8u; let W = u32(bw);
  let a = mix(${arr}[o + i0.y * W + i0.x], ${arr}[o + i0.y * W + i1.x], f.x);
  let b = mix(${arr}[o + i1.y * W + i0.x], ${arr}[o + i1.y * W + i1.x], f.x);
  return mix(a, b, f.y);
}
fn dodge(c0: vec3<f32>, pos: vec2<f32>) -> vec3<f32> {
  var c = c0;
  let knee = ${arr}[${at0}u + 3u]; let A = ${arr}[${at0}u + 4u]; let rho = ${arr}[${at0}u + 5u];
  let hk = ${arr}[${at0}u + 6u];
  if (hk != 0.0) {   // Contrasto luci
    let pv = max(${arr}[${at0}u + 7u], knee + 0.25);
    let L = log2(max(dot(c, p.luma.xyz), 1e-6)); let B = dodgeBaseAt(pos);
    let w = smoothstep(knee, pv, L) * smoothstep(knee, pv, B);
    c *= exp2(hk * clamp(L - B, -2.0, 0.0) * w);
  }
  if (${arr}[${at0}u] < 0.5) { return c; }
  let b = max(dodgeBaseAt(pos), log2(max(dot(c, p.luma.xyz), 1e-6)));
  let e = max(b - knee, 0.0);
  return c * exp2(-A * (1.0 - exp(-rho * e / A)));
}`;

/** CPU fallback (no WebGPU): dodgeWGSL on a linear RGB region `rgb` (w×h×3, already × `expo`) at
 * (x0, y0) of an fw×fh frame, with the array from dodgeArray (header at `at0`). In place. */
export function dodgeCPU(rgb, w, h, x0, y0, fw, fh, expo, arr, at0, luma) {
  const on = arr[at0], bw = arr[at0 + 1], bh = arr[at0 + 2];
  if (!bw) return;
  const knee = arr[at0 + 3], A = arr[at0 + 4], rho = arr[at0 + 5], hk = arr[at0 + 6];
  const pv = Math.max(arr[at0 + 7], knee + 0.25), o = at0 + 8, le = Math.log2(expo);
  if (on < 0.5 && hk === 0) return;
  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let y = 0, j = 0; y < h; y++) {
    const qy = Math.min(bh - 1, Math.max(0, (y0 + y + 0.5) / fh * bh - 0.5)), iy = Math.floor(qy), iy1 = Math.min(iy + 1, bh - 1), fy = qy - iy;
    for (let x = 0; x < w; x++, j += 3) {
      const qx = Math.min(bw - 1, Math.max(0, (x0 + x + 0.5) / fw * bw - 0.5)), ix = Math.floor(qx), ix1 = Math.min(ix + 1, bw - 1), fx = qx - ix;
      const a = arr[o + iy * bw + ix] + (arr[o + iy * bw + ix1] - arr[o + iy * bw + ix]) * fx;
      const b = arr[o + iy1 * bw + ix] + (arr[o + iy1 * bw + ix1] - arr[o + iy1 * bw + ix]) * fx;
      const B = a + (b - a) * fy;
      let L = Math.log2(Math.max(1e-6, luma[0] * rgb[j] + luma[1] * rgb[j + 1] + luma[2] * rgb[j + 2])) - le, g = 0;
      if (hk !== 0) { g += hk * Math.min(0, Math.max(-2, L - B)) * sstep(knee, pv, L) * sstep(knee, pv, B); L += g; }
      if (on >= 0.5) { const e = Math.max(Math.max(B, L) - knee, 0); g -= A * (1 - Math.exp(-rho * e / A)); }
      if (g !== 0) { const k = 2 ** g; rgb[j] *= k; rgb[j + 1] *= k; rgb[j + 2] *= k; }
    }
  }
}
