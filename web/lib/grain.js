// Film grain, procedural, applied where it shows: in the final 8-bit pass
// (the engine's output pack shader, see spektrafilm-wasm `process_frame`),
// after the film + Frontier scan, as the grain of a scanned negative reads.
// The same pass converts Rec.2020 → Display P3 (soft gamut compression) for P3 photos.
//
// Why not the engine's own grain: measured on real Kodak Gold 200 scans
// (shopfront, cliffs, palms, two people on grass), grain is strongest in the
// shadows and low mids (L* ~20–60), fades in the deep blacks and falls to
// ~10% of its peak in the highlights (L* 78–96, structure-free flat patches:
// 8–16% of peak; the scan's shoulder flattens it). The engine's
// grain, in the scene's highlights, did the opposite: strongest at L* 60–90, weak in the shadows.
//
// Model:
//   - amplitude follows that measured response, GRAIN_SHAPE(L*) below;
//   - noise lives in µm on the 36 mm frame, so preview and every export tile
//     draw the same grain;
//   - value noise normalised to unit variance at every point (plain value
//     noise is 2× weaker mid-cell than on the lattice: a faint grid ripple);
//   - a pixel integrates the grain over its area: each scale's σ is the
//     box-average of the field, 1/√(1 + 0.59 (px/cell)²) (fit, ±3%), so the
//     grain reads the same at preview size and at 12 MP once viewed at the
//     same size (before: the 12 MP export, downsized, was 1.45× the preview);
//   - the grain's size follows the exposure, as in a two-speed emulsion: the
//     fast layer's coarse grains (clumps 2.3×, mottle 5× the grain size)
//     carry the shadows, the slow layer's fine grain the mids and
//     highlights. Measured on the palms scan (13.5 µm/px, flat areas, DoG
//     octaves 0.5–1|1–2|2–4|4–8 px): L* 50–75 falls 1.38:1:0.53:0.26 (fine),
//     the shadows rise toward the coarse octaves; the old mix was the same
//     at every L* (mids 1.06:1:0.64:0.40, now 1.29:1:0.64:0.38);
//   - the fine grain clusters (its amplitude rides the clump field, as dye
//     clouds bunch): grain residuals on the scans are heavy-tailed, kurtosis
//     3.8–4.2 in the mids (palms, shop), the old grain 2.7–2.8; now 4.0–4.2,
//     skew still ~0;
//   - colour grain is coarse mottle, not per-pixel speckle: on every scan
//     the R−G / B−G residual octaves are flat or rise toward 2–8 px (palms
//     L* 50–75 0.37:0.37:0.51:0.48; women, 4:4:4 JPEG, the same), and the
//     fine residuals of the channels correlate 0.9–0.96. The old per-pixel
//     chroma fell 1.36:1:0.58:0.26 (a phone's colour noise); now 6× cells,
//     0.58:1:1.45:1.22, fine correlation 0.94;
//   - amplitude stays luminance-driven, the same in R, G, B: in the scans'
//     blue skies σR/σB = 1.00 (palms, shop, women), so no per-layer
//     amplitude from each channel's own density (tried: 1.8, wrong).
// No spatial filtering here: edge spread on the palms scan (10–90% 27 µm,
// overshoot ~12% over ~4 px) already matches the app's (tree export: 28 µm,
// same profile within 0.02), so a film MTF / adjacency step would only add
// taps and drift from the scans.

import { FRAME_UM, wf, wv3 } from './util.js';
import { SRGB_WGSL, LUMA, REC2020_TO_P3, srgbToLinear, linearToSrgb } from './color.js';

// ACES-style soft gamut compression (rgc): threshold, the distance that maps to the edge, power.
const RGC = { thr: 0.9, lim: 1.3, pw: 1.2 };
// Smallest grain cell, in output pixels (see cell() in GRAIN_WGSL).
const GRAIN_MIN_PX = 1.6;
const GRAIN_CHROMA = 0.08;

export const GRAIN_WGSL = /* wgsl */`
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read> lut: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read> P: array<f32>;
// P[] layout (the engine prepends 4 slots, so grainParams' first value is P[4]):
//   P[4]  region width            P[5], P[6] region origin (frame px)
//   P[7]  µm per px               P[8]  amplitude (8-bit levels)
//   P[9]  grain size (µm)         P[10] seed
//   P[11] = 1: the engine output is Rec.2020 → convert to Display P3 here, with
//         ACES-style per-channel soft gamut compression (see toP3)
fn q(v: f32) -> f32 { return f32(lut[u32(clamp(v * 4095.0 + 0.5, 0.0, 4095.0))]) / 255.0; }

fn pcg(v0: vec3<u32>) -> u32 {                 // pcg3d hash
  var v = v0 * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3<u32>(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x;
}
fn lattice(p: vec2<i32>, s: u32) -> f32 {      // ~N(0,1): sum of two uniforms, rescaled
  let h = pcg(vec3<u32>(bitcast<u32>(p.x), bitcast<u32>(p.y), s));
  let a = f32(h & 0xffffu) / 65535.0;
  let b = f32(h >> 16u) / 65535.0;
  return (a + b - 1.0) * 2.45;
}
fn vnoise(p: vec2<f32>, s: u32) -> f32 {       // value noise, smooth interpolation, unit variance everywhere
  let i = vec2<i32>(floor(p)); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  let w = (1.0 - u) * (1.0 - u) + u * u;       // Σ weights² per axis: plain value noise has 4× less variance mid-cell
  return mix(mix(lattice(i, s), lattice(i + vec2<i32>(1, 0), s), u.x),
             mix(lattice(i + vec2<i32>(0, 1), s), lattice(i + vec2<i32>(1, 1), s), u.x), u.y) * inverseSqrt(w.x * w.y);
}
fn lstar(c: vec3<f32>) -> f32 {
  let y = dot(srgbDec(c), select(${wv3(LUMA.srgb)}, ${wv3(LUMA.p3)}, P[11] > 0.5));   // c is in the output primaries
  return select(903.3 * y, 116.0 * pow(y, 1.0 / 3.0) - 16.0, y > 0.008856);
}
fn sstep(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
// A pixel integrates the grain over its area: σ of a field with cells k × P[9] µm
// falls as 1/√(1 + 0.59 r²), r = pixel / cell (fit of box-averaged value noise),
// so every resolution shows the same grain once viewed at the same size.
fn bpx(k: f32) -> f32 { let r = P[7] / (P[9] * k); return inverseSqrt(1.0 + 0.59 * r * r); }
// Grain field with cells k × P[9] µm, as one pixel sees it. Never finer than
// GRAIN_MIN_PX pixels: a scanner's optics spread even the finest grain over more
// than one pixel (1-px cells read as a phone sensor's noise). Each field's lattice
// is rotated by its own angle (from o): no axis-aligned value-noise structure.
fn cell(um: vec2<f32>, k: f32, o: f32, s: u32) -> f32 {
  let th = 0.4636476 + 0.137 * o; let cs = cos(th); let sn = sin(th);
  let ru = vec2<f32>(cs * um.x - sn * um.y, sn * um.x + cs * um.y);
  return vnoise(ru / max(P[9] * k, ${wf(GRAIN_MIN_PX)} * P[7]) + o, s);
}
fn grainField(um: vec2<f32>, k: f32, o: f32, s: u32) -> f32 { return bpx(k) * cell(um, k, o, s); }

${SRGB_WGSL}
// One channel's distance from the achromatic axis compressed beyond THR so that
// LIM (the farthest a film colour lands outside P3) maps exactly to the gamut edge.
fn rgc(d: f32) -> f32 {
  let thr = ${wf(RGC.thr)}; let lim = ${wf(RGC.lim)}; let pw = ${wf(RGC.pw)};
  if (d < thr) { return d; }
  let scl = (lim - thr) / pow(pow((1.0 - thr) / (lim - thr), -pw) - 1.0, 1.0 / pw);
  let x = (d - thr) / scl;
  return thr + scl * x / pow(1.0 + pow(x, pw), 1.0 / pw);
}
// Rec.2020 (sRGB-encoded) → Display P3 (sRGB-encoded). Film colours a little
// outside P3 (dark saturated browns, deep reds) are pulled in along their own
// channel instead of clipping to 0, which would rotate the hue and flatten them.
fn toP3(e: vec3<f32>) -> vec3<f32> {
  let l = srgbDec(e);
  var p = vec3<f32>(${REC2020_TO_P3.map((r) => `dot(${wv3(r)}, l)`).join(', ')});
  let a = max(p.x, max(p.y, p.z));
  if (a > 0.0) {
    let d = (vec3<f32>(a) - p) / a;
    p = vec3<f32>(a) - vec3<f32>(rgc(d.x), rgc(d.y), rgc(d.z)) * a;
  }
  return srgbEnc(p);
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x + id.y * u32(P[1]);
  if (i >= u32(P[0])) { return; }
  var c = vec3<f32>(src[3u * i], src[3u * i + 1u], src[3u * i + 2u]);   // the engine's positive, sRGB-encoded
  if (P[11] > 0.5) { c = toP3(c); }
  c = vec3<f32>(q(c.x), q(c.y), q(c.z));
  if (P[8] > 0.0) {
    let w = u32(P[4]);
    let um = (vec2<f32>(f32(i % w), f32(i / w)) + vec2<f32>(P[5], P[6]) + 0.5) * P[7];
    let s = u32(P[10]);
    let L = lstar(c);
    // GRAIN_SHAPE: measured on real scans (see grain.js).
    let shape = (0.6 + 0.4 * sstep(2.0, 22.0, L)) * (1.0 - 0.85 * sstep(55.0, 85.0, L));
    // Emulsion layers (see grain.js): the fast, coarse one carries the shadows,
    // the slow, fine one the mids and highlights.
    let sh = 1.0 - sstep(10.0, 50.0, L);
    let wF = 0.8 - 0.25 * sh; let wC = 0.35 + 0.1 * sh; let wK = 0.05 + 0.35 * sh;
    let vC = cell(um, 2.3, 17.0, s + 1u);   // clump field, also the clustering of the fine grain
    let fine = grainField(um, 1.0, 0.0, s) * (1.0 + 0.2121 * (vC * vC - 1.0)) * 0.9578;
    let mono = 0.95 * inverseSqrt(wF * wF + wC * wC + wK * wK)
             * (wF * fine + wC * bpx(2.3) * vC + wK * grainField(um, 5.0, 41.0, s + 5u));
    // Colour grain: the dye layers' coarse, independent mottle, not per-pixel speckle;
    // kept faint (Ektar/Gold scans: chroma noise ~0.1-0.15 of luma, coarser than it).
    let chroma = ${wf(GRAIN_CHROMA)} * (1.0 - 0.5 * sstep(10.0, 50.0, L));
    let n = vec3<f32>(grainField(um, 6.0, 31.0, s + 2u), grainField(um, 6.0, 57.0, s + 3u), grainField(um, 6.0, 83.0, s + 4u));
    c += (P[8] / 255.0) * shape * (mono + chroma * n);
  }
  // Soft floor at black: unchanged a few levels above it, approaching it below (softplus),
  // so grain never punches pure-black specks into the deepest shadows (measured: up to 4% of
  // a frame at exactly 0). Black itself comes from the scanner (frontier.black_lift).
  let k = 2.0 / 255.0; let b = -2.0 * k;          // black maps to itself within 0.3 levels; grain has room below it
  let x = (c - b) / k;                         // stable softplus: max(x,0) + log(1 + e^-|x|)
  c = b + k * (max(x, vec3<f32>(0.0)) + log(vec3<f32>(1.0) + exp(-abs(x))));
  let o = vec3<u32>(round(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)) * 255.0));
  dst[i] = o.x | (o.y << 8u) | (o.z << 16u) | 0xff000000u;
}`;

// Peak amplitude (8-bit levels, per unit of noise) at amount 1.
const GRAIN_LEVELS = 13;

/**
 * Params for GRAIN_WGSL (P[4..11]): region (x0, y0, w) of a frame whose long side is
 * `frameLong` px; `amount` is the Grana slider (0 = off), `seed` per photo,
 * `rec2020ToP3`: the engine output is Rec.2020 and the photo is Display P3.
 */
export function grainParams(w, x0, y0, frameLong, amount, seed, rec2020ToP3 = false) {
  const umPerPx = FRAME_UM / frameLong;
  // Size grows a little with the amount (a coarser-looking stock); 12 µm at 1.
  const size = 12 * (0.75 + 0.25 * amount);
  return new Float32Array([w, x0, y0, umPerPx, GRAIN_LEVELS * amount, size, seed % 65536, rec2020ToP3 ? 1 : 0]);
}

// CPU twin of toP3 in GRAIN_WGSL, for the no-WebGPU path and the export mat: `px` is one
// engine output pixel (sRGB-encoded Rec.2020), converted in place to sRGB-encoded Display P3.
const RGC_SCL = (RGC.lim - RGC.thr) / (((1 - RGC.thr) / (RGC.lim - RGC.thr)) ** -RGC.pw - 1) ** (1 / RGC.pw);
const rgcCPU = (d) => { if (d < RGC.thr) return d; const x = (d - RGC.thr) / RGC_SCL; return RGC.thr + RGC_SCL * x / (1 + x ** RGC.pw) ** (1 / RGC.pw); };
export function toP3CPU(px) {
  const r = srgbToLinear(px[0]), g = srgbToLinear(px[1]), b = srgbToLinear(px[2]);
  const [m0, m1, m2] = REC2020_TO_P3;   // no per-pixel allocation
  let p0 = m0[0] * r + m0[1] * g + m0[2] * b, p1 = m1[0] * r + m1[1] * g + m1[2] * b, p2 = m2[0] * r + m2[1] * g + m2[2] * b;
  const a = Math.max(p0, p1, p2);
  if (a > 0) { p0 = a - rgcCPU((a - p0) / a) * a; p1 = a - rgcCPU((a - p1) / a) * a; p2 = a - rgcCPU((a - p2) / a) * a; }
  px[0] = linearToSrgb(p0); px[1] = linearToSrgb(p1); px[2] = linearToSrgb(p2);
}
