// Direct film scan, no paper (Instagram is RGB on a screen: no print step).
// With io.scan_film the engine returns the developed NEGATIVE as a scanner sees it
// (orange mask included). We invert it as a lab scanner does, per channel:
//   T = Tbase · E^(-γ)  →  E = (T / Tbase)^(-1/γ), scaled so mid grey lands on 0.18,
// then a soft S in log2 exposure (SCAN): asymptotic toe and shoulder, no paper
// black or paper white. Tbase (mask + fog), γ and the scale are fitted per channel
// on the neutral transfer chart (tone.js), so greys come out neutral.
import { wf } from './util.js';

// S-curve: mid slope, toe and shoulder ranges (EV) in display log2 around mid grey.
export const SCAN = { s: 1.3, lo: 6.5, hi: Math.log2(1 / 0.18) };
// MID/SPAN must match tone.js LO/HI/N (LO = -12, HI = 8, N = 81; not exported): MID is the chart
// patch at mid grey (log2 s/0.18 = 0), SPAN = ±2 EV at 0.25 EV per patch. fitScan asserts MID.
const MID = 48, SPAN = 8;

/** Per-channel [Tbase×3, 1/γ×3, scale×3] from readTransfer() of the raw negative chart. */
export function fitScan(T) {
  if (T.logS && Math.abs(T.logS[MID]) > 1e-6) throw new Error('fitScan: chart mid patch moved');
  const p = new Array(9);
  for (let c = 0; c < 3; c++) {
    const C = T.C[c], tb = Math.max(C[0], 1e-6);
    const g = Math.max(0.2, -(Math.log10(Math.max(C[MID + SPAN], 1e-6)) - Math.log10(Math.max(C[MID - SPAN], 1e-6))) / (2 * SPAN / 4 * Math.log10(2)));
    p[c] = tb; p[3 + c] = 1 / g;
    p[6 + c] = 0.18 / (Math.max(C[MID], 1e-6) / tb) ** (-1 / g);
  }
  return p;
}

const dec = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const enc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);
const sCurve = (e) => {
  const x = SCAN.s * Math.log2(Math.max(e, 1e-6) / 0.18);
  return 0.18 * 2 ** (x > 0 ? SCAN.hi * Math.tanh(x / SCAN.hi) : SCAN.lo * Math.tanh(x / SCAN.lo));
};
/** In place over interleaved RGB (display-encoded engine output). */
export function invertCPU(rgb, p) {
  for (let i = 0; i < rgb.length; i += 3) for (let c = 0; c < 3; c++) {
    const T = Math.max(dec(rgb[i + c]), 1e-6);
    rgb[i + c] = enc(sCurve(Math.min(1e6, Math.max(1e-6, p[6 + c] * (T / p[c]) ** (-p[3 + c])))));
  }
}

/** WGSL: params at P[base..base+8]; needs dec/enc from GRAIN_WGSL. */
export const SCAN_WGSL = (base) => /* wgsl */`
fn scanS(e: f32) -> f32 {
  let x = ${wf(SCAN.s)} * log2(max(e, 1e-6) / 0.18);
  return 0.18 * exp2(select(${wf(SCAN.lo)} * tanh(x / ${wf(SCAN.lo)}), ${wf(SCAN.hi)} * tanh(x / ${wf(SCAN.hi)}), x > 0.0));
}
fn scanInv(e: vec3<f32>) -> vec3<f32> {
  let T = max(dec(e), vec3<f32>(1e-6));
  let tb = vec3<f32>(P[${base}u], P[${base + 1}u], P[${base + 2}u]);
  let ig = vec3<f32>(P[${base + 3}u], P[${base + 4}u], P[${base + 5}u]);
  let sc = vec3<f32>(P[${base + 6}u], P[${base + 7}u], P[${base + 8}u]);
  let E = clamp(sc * pow(T / tb, -ig), vec3<f32>(1e-6), vec3<f32>(1e6));
  return encs(vec3<f32>(scanS(E.x), scanS(E.y), scanS(E.z)));
}`;
