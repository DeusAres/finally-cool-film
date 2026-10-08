// Film grain, procedural, applied where it shows: in the final 8-bit pass
// (the engine's output pack shader, see spektrafilm-wasm `process_frame`),
// after the film + direct-scan chain, as the grain of a scanned negative reads.
//
// Why not the engine's own grain: measured on real Kodak Gold 200 scans
// (shopfront, cliffs, palms, two people on grass), grain is strongest in the
// shadows and low mids (L* ~20–60), fades in the deep blacks and falls to
// ~10% of its peak in the highlights (L* 78–96, structure-free flat patches:
// 8–16% of peak; the scan's shoulder flattens it). The engine's
// grain, after our tone inversion (which places display highlights mid-curve
// on the film), did the opposite: strongest at L* 60–90, weak in the shadows.
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

import { FRAME_UM, wf, wv3, wm3 } from './util.js';
import { SCAN_WGSL, invertCPU } from './scan.js';
import { srgbToLinear, linearToSrgb, LIN8, REC2020_TO_P3, LUMA_SRGB } from './color.js';

// Constants shared by GRAIN_WGSL and its CPU twin (outputColourCPU): one source,
// the WGSL gets them by interpolation.
// ACES-style soft gamut compression (rgc): threshold, the distance that maps to the edge, power.
const RGC = { thr: 0.9, lim: 1.3, pw: 1.2 };
// Smallest grain cell, in output pixels (see cell() in GRAIN_WGSL).
const GRAIN_MIN_PX = 1.6;
// Nero (fade): black lift (display-encoded) at slider 1 (0.15 → L* ~13), toe exponent.
const FADE_MAX = 0.15, FADE_P = 3.5;
// The scanner's shadow lift is tinted cyan-green, as when a lab scanner pulls up a thin negative:
// per channel weights (display RGB, ~zero luma) at full strength; the tint grows with Nero.
const FADE_TINT = [1 - 0.6 * 0.5, 1 + 0.15 * 0.5, 1 + 0.45 * 0.5];
// Gold toning (OKLab offsets on every pixel, by OKLab L), measured on 9 Gold 200 scans
// (IG screenshots): neutrals are pure yellow, Lab b* +6 in deep shadows, +12 through
// shadows and mids, +4 in the lights; a* ~0. bMid at L 0.30-0.62, easing to bHi by 0.90.
const GOLD = { a: 0.002, bMid: 0.036, bHi: 0.012, l0: 0.04, l1: 0.30, l2: 0.62, l3: 0.90 };
// Sky-blue rotation (skyHue): OKLab hue 235° direction, half-width (60°), rotation (5.5°), chroma ramp.
const SKY = { dir: [-0.5735764, -0.8191520], width: 1.0471976, theta: 0.0959931, c0: 0.015, c1: 0.045 };
// Rows: linear RGB → LMS (OKLab M1 composed with the primaries, rows normalised so white has a = b = 0), and back.
const SKY_LMS = { p3: [0.4813798, 0.4621184, 0.0565018, 0.228832, 0.6532168, 0.1179512, 0.0839458, 0.2241653, 0.691889],
  srgb: [0.4122215, 0.5363325, 0.051446, 0.2119035, 0.6806995, 0.107397, 0.0883025, 0.2817188, 0.6299787] };
const SKY_RGB = { p3: [3.1277694, -2.2571362, 0.1293668, -1.0910094, 2.413332, -0.3223227, -0.0260108, -0.5080414, 1.5340521],
  srgb: [4.0767417, -3.3077116, 0.2309699, -1.268438, 2.6097574, -0.3413194, -0.0041961, -0.7034186, 1.7076147] };
const OK_LAB = [0.2104542553, 0.7936177850, -0.0040720468, 1.9779984951, -2.4285922050, 0.4505937099, 0.0259040371, 0.7827717662, -0.8086757660];
// Scanner saturation (vib): chroma ramp-in (greys untouched) and fade-out (saturated untouched).
const VIB = { c0: 0.008, c1: 0.022, f0: 0.025, f1: 0.2 };
// Interno (thin negative, low light): the scanner lifts shadows that sat in the film's toe,
// where the dye layers part: deep shadows drift olive/cyan, apart from the warm mids.
// OKLab offset at full strength (P[26] = 1), faded out by OKLab L TOE.l1.
const TOE = { a: -0.038, b: 0.002, l0: 0.10, l1: 0.50 };
const GRAIN_CHROMA = 0.08;

// Print character (printLook), chosen by eye on A/B variants: a print-like look
// applied after the scan (steeper mids around OKLab L 0.55, deeper toe, richer mid chroma) with
// Gold toning in GOLD (measured). OKLab units; all scaled by P[15].
const PRINT = { piv: 0.55, con: 0.30, toe: -0.012, cLo: 0.95, cMid: 1.15, cHi: 0.92 };
const OK_LMS = [1, 0.3963377774, 0.2158037573, 1, -0.1055613458, -0.0638541728, 1, -0.0894841775, -1.2914855480];

export const GRAIN_WGSL = /* wgsl */`
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read> lut: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read> P: array<f32>;
// P[] layout (the engine prepends 4 slots, so grainParams' head[0] is P[4]):
//   P[4]  region width            P[5], P[6] region origin (frame px)
//   P[7]  µm per px               P[8]  amplitude (8-bit levels)
//   P[9]  grain size (µm)         P[10] seed
//   P[11] = 1: the engine output is Rec.2020 → convert to Display P3 here, with
//         ACES-style per-channel soft gamut compression (see toP3)
//   P[12] black floor (tone.out8[0] / 255): grain softly floors there instead of clipping to 0
//   P[13] = 1: grey balance curves (tone.js greyBalance) from P[27], applied after the scan inversion
//   P[14] scanner saturation strength (vib, 0 = off)
//   P[15] print look strength (Stampa, includes Gold toning)
//   P[16] Nero fade (black lift, already × FADE_MAX)
//   P[17..25] direct-scan inversion fit (scan.js): the engine output is the negative
//   P[26] Interno toe tint strength (0..1, toeTint)
//   P[27..] grey balance curves, 3 × 1025 floats (when P[13] = 1)

fn bal(c: u32, v: f32) -> f32 {             // grey balance (tone.js greyBalance), curves at P[27..]
  let f = clamp(v, 0.0, 1.0) * 1024.0; let i = u32(f); let base = 27u + c * 1025u;
  if (i >= 1024u) { return P[base + 1024u]; }
  return mix(P[base + i], P[base + i + 1u], f - f32(i));
}
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
  let y = dot(dec(c), ${wv3(LUMA_SRGB)});
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

fn dec(v: vec3<f32>) -> vec3<f32> { return select(pow((v + 0.055) / 1.055, vec3<f32>(2.4)), v / 12.92, v <= vec3<f32>(0.04045)); }
fn encs(v: vec3<f32>) -> vec3<f32> { return select(1.055 * pow(max(v, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055, 12.92 * v, v <= vec3<f32>(0.0031308)); }
${SCAN_WGSL(17)}
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
  let l = dec(e);
  var p = vec3<f32>(${REC2020_TO_P3.map((r) => `dot(${wv3(r)}, l)`).join(', ')});
  let a = max(p.x, max(p.y, p.z));
  if (a > 0.0) {
    let d = (vec3<f32>(a) - p) / a;
    p = vec3<f32>(a) - vec3<f32>(rgc(d.x), rgc(d.y), rgc(d.z)) * a;
  }
  return encs(p);
}
// OKLab helpers shared by skyHue and vib. The working space is P3 when P[11] = 1, else sRGB.
fn toOk(l: vec3<f32>) -> vec3<f32> {          // linear RGB → OKLab (L, a, b)
  var lms: vec3<f32>;
  if (P[11] > 0.5) {
    lms = l * ${wm3(SKY_LMS.p3)};
  } else {
    lms = l * ${wm3(SKY_LMS.srgb)};
  }
  return pow(max(lms, vec3<f32>(0.0)), vec3<f32>(1.0 / 3.0)) * ${wm3(OK_LAB)};
}
fn fromOk(lab: vec3<f32>) -> vec3<f32> {      // OKLab → linear RGB (unclamped)
  let m = lab * ${wm3(OK_LMS)};
  var r: vec3<f32>;
  if (P[11] > 0.5) {
    r = (m * m * m) * ${wm3(SKY_RGB.p3)};
  } else {
    r = (m * m * m) * ${wm3(SKY_RGB.srgb)};
  }
  return r;
}
// Step from l towards r (both linear), stopping at the gamut edge; sRGB-encoded.
fn toGamut(l: vec3<f32>, r: vec3<f32>) -> vec3<f32> {
  let lo = select(vec3<f32>(1.0), l / (l - r), r < vec3<f32>(0.0));
  let hi = select(vec3<f32>(1.0), (1.0 - l) / (r - l), r > vec3<f32>(1.0));
  let t = min(min(min(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
  return encs(l + t * (r - l));
}
// Partial sky-blue correction (CPU twin: skyHueCPU): the film turns blue skies
// cyan (tree: CIELAB hue 257° → 243°); rotate blues/cyans back ~5.5° in OKLab at
// constant L and C. Weight: raised cosine over ±60° around OKLab hue 235°, times
// smoothstep(0.015, 0.045, C) so neutrals, skin, greens and yellows are untouched.
// The step towards the rotated colour stops at the gamut edge (never leaves it).
fn skyHue(e: vec3<f32>) -> vec3<f32> {
  let l = dec(clamp(e, vec3<f32>(0.0), vec3<f32>(1.0)));
  let lab = toOk(l);
  let C = length(lab.yz);
  let d = acos(clamp(dot(lab.yz, vec2<f32>(${wf(SKY.dir[0])}, ${wf(SKY.dir[1])})) / max(C, 1e-6), -1.0, 1.0));   // radians from 235°
  let w = select(0.0, 0.5 + 0.5 * cos(3.0 * d), d < ${wf(SKY.width)}) * sstep(${wf(SKY.c0)}, ${wf(SKY.c1)}, C);
  if (w <= 0.0) { return e; }
  let th = ${wf(SKY.theta)} * w;
  let cs = cos(th); let sn = sin(th);
  return toGamut(l, fromOk(vec3<f32>(lab.x, cs * lab.y - sn * lab.z, sn * lab.y + cs * lab.z)));
}
// Scanner saturation (CPU twin: vibCPU), strength P[14] from scanSaturation():
// OKLab chroma gain 1 + P[14]·g(C) at constant L and hue. g ramps in over
// C 0.008–0.022 (greys stay grey) and fades out by C 0.2 (saturated colours
// keep theirs); C·(1 + s·g) stays monotonic in C for s ≤ 1. Same gamut clamp as skyHue.
fn vib(e: vec3<f32>) -> vec3<f32> {
  let l = dec(clamp(e, vec3<f32>(0.0), vec3<f32>(1.0)));
  let lab = toOk(l);
  let C = length(lab.yz);
  let g = P[14] * sstep(${wf(VIB.c0)}, ${wf(VIB.c1)}, C) * (1.0 - sstep(${wf(VIB.f0)}, ${wf(VIB.f1)}, C));
  if (g <= 0.0) { return e; }
  return toGamut(l, fromOk(vec3<f32>(lab.x, lab.yz * (1.0 + g))));
}

// Print character (PRINT, CPU twin printLookCPU) on the display-encoded output, strength s.
fn toeTint(c: vec3<f32>, s: f32) -> vec3<f32> {
  let l = dec(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)));
  let lab = toOk(l);
  let w = s * (1.0 - sstep(${wf(TOE.l0)}, ${wf(TOE.l1)}, lab.x)) * sstep(0.0, ${wf(TOE.l0)}, lab.x);
  if (w <= 0.0) { return c; }
  return toGamut(l, fromOk(vec3<f32>(lab.x, lab.y + w * ${wf(TOE.a)}, lab.z + w * ${wf(TOE.b)})));
}
fn printLook(c: vec3<f32>, s: f32) -> vec3<f32> {
  let l = dec(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)));
  let lab = toOk(l);
  let d = lab.x - ${wf(PRINT.piv)};
  var L = lab.x + s * ${wf(PRINT.con)} * d * (1.0 - min(1.0, abs(d) / ${wf(PRINT.piv)}));
  L = clamp(L + s * ${wf(PRINT.toe)} * (1.0 - sstep(0.0, 0.45, lab.x)), 0.0, 1.0);
  let lo = 1.0 - sstep(0.25, 0.45, L); let hi = sstep(0.75, 0.95, L); let mid = max(0.0, 1.0 - lo - hi);
  let k = ${wf(PRINT.cLo)} * lo + ${wf(PRINT.cMid)} * mid + ${wf(PRINT.cHi)} * hi;
  let kv = k + (1.0 - k) * sstep(0.12, 0.2, length(lab.yz)) * 0.6;   // vivid colours keep most of their bite
  var ab = lab.yz * (1.0 + s * (kv - 1.0));
  // Gold toning (GOLD): pure yellow neutrals, strongest in shadows and mids.
  let gr = sstep(${wf(GOLD.l0)}, ${wf(GOLD.l1)}, L);
  ab += s * vec2<f32>(${wf(GOLD.a)} * gr, ${wf(GOLD.bMid)} * gr - ${wf(GOLD.bMid - GOLD.bHi)} * sstep(${wf(GOLD.l2)}, ${wf(GOLD.l3)}, L));
  // Soft gamut stop: a colour that would leave the gamut goes only 85% of the way to its
  // edge (continuous at t = 1/0.85), so warm saturated tones are never flattened onto a
  // channel at 0 or 255 (measured: hard stop left 7% of basket's pixels with B = 0).
  let r = fromOk(vec3<f32>(L, ab));
  let gl = select(vec3<f32>(1e9), l / (l - r), r < vec3<f32>(0.0));
  let gh = select(vec3<f32>(1e9), (1.0 - l) / (r - l), r > vec3<f32>(1.0));
  let t = min(1.0, 0.85 * min(min(min(gl.x, gl.y), gl.z), min(min(gh.x, gh.y), gh.z)));
  return encs(l + t * (r - l));
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x + id.y * u32(P[1]);
  if (i >= u32(P[0])) { return; }
  var e = scanInv(vec3<f32>(src[3u * i], src[3u * i + 1u], src[3u * i + 2u]));   // negative → positive (scan.js)
  if (P[13] > 0.5) { e = vec3<f32>(bal(0u, e.x), bal(1u, e.y), bal(2u, e.z)); }
  if (P[11] > 0.5) { e = toP3(e); }
  e = skyHue(e);
  if (P[14] > 0.0) { e = vib(e); }
  var c = vec3<f32>(q(e.x), q(e.y), q(e.z));
  if (P[15] > 0.0) { c = printLook(c, P[15]); }
  if (P[26] > 0.0) { c = toeTint(c, P[26]); }   // Interno: thin-negative toe drift (TOE)
  // Nero (fade, P[16]): the scanner's lifted blacks, tinted cyan-green (FADE_TINT) in proportion;
  // the toe term (1 - c)^FADE_P leaves mids and highlights almost where they are.
  if (P[16] > 0.0) {
    c += P[16] * ${wv3(FADE_TINT)} * pow(max(vec3<f32>(1.0) - c, vec3<f32>(0.0)), vec3<f32>(${wf(FADE_P)}));
  }
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
    // Colour grain: the dye layers' coarse, independent mottle, not per-pixel speckle.
    // Colour grain: kept faint (Ektar/Gold scans: chroma noise ~0.1-0.15 of luma, coarser than it).
    let chroma = ${wf(GRAIN_CHROMA)} * (1.0 - 0.5 * sstep(10.0, 50.0, L));
    let n = vec3<f32>(grainField(um, 6.0, 31.0, s + 2u), grainField(um, 6.0, 57.0, s + 3u), grainField(um, 6.0, 83.0, s + 4u));
    c += (P[8] / 255.0) * shape * (mono + chroma * n);
  }
  // Soft floor at the black floor (P[12]): unchanged a few levels above it, approaching
  // it below (softplus), so grain never punches pure-black specks into the
  // deepest shadows (measured: up to 4% of a frame at exactly 0).
  let k = 2.0 / 255.0; let b = P[12] - 2.0 * k;   // the black floor maps to itself within 0.3 levels; grain has room below it
  let x = (c - b) / k;                         // stable softplus: max(x,0) + log(1 + e^-|x|)
  c = b + k * (max(x, vec3<f32>(0.0)) + log(vec3<f32>(1.0) + exp(-abs(x))));
  let o = vec3<u32>(round(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)) * 255.0));
  dst[i] = o.x | (o.y << 8u) | (o.z << 16u) | 0xff000000u;
}`;

// Peak amplitude (8-bit levels, per unit of noise) at amount 1.
const GRAIN_LEVELS = 13;

/**
 * Params for GRAIN_WGSL: region (x0, y0, w) of a frame whose long side is
 * `frameLong` px; `amount` is the Grana slider (0 = off), `seed` per photo.
 * `black` is the black floor in 8-bit levels (tone.out8[0]); `scanP` is the
 * 9-value scan fit from fitScan (required).
 */
export function grainParams(w, x0, y0, frameLong, amount, seed, rec2020ToP3 = false, black = 0, balance = null, vibrance = 0, print = 0, fade = 0, scanP = null, toe = 0) {
  if (!scanP) throw new Error('grainParams: scan fit missing');
  const umPerPx = FRAME_UM / frameLong;
  // Size grows a little with the amount (a coarser-looking stock); 12 µm at 1.
  const size = 12 * (0.75 + 0.25 * amount);
  // head[0] lands at P[4]: w, x0, y0, µm/px, amp, size, seed, p3, black, balance flag, vib (P[14]), print (P[15]), fade (P[16]), scan fit (P[17..25])
  const head = [w, x0, y0, umPerPx, GRAIN_LEVELS * amount, size, seed % 65536, rec2020ToP3 ? 1 : 0, black / 255, balance ? 1 : 0, vibrance, print, fade * FADE_MAX, ...scanP, toe];
  const p = new Float32Array(head.length + (balance ? balance.length : 0));
  p.set(head); if (balance) p.set(balance, head.length);   // balance curves start at P[26]
  return p;
}

// CPU twin of the Nero fade in GRAIN_WGSL; px display-encoded 0..1, in place.
export function fadeCPU(px, fade) {
  const b = fade * FADE_MAX;
  for (let c = 0; c < 3; c++) px[c] += b * FADE_TINT[c] * Math.max(1 - px[c], 0) ** FADE_P;
}

// CPU twin of the colour steps of GRAIN_WGSL (grey balance, then Rec.2020 → P3),
// for the no-WebGPU path: `px` is one engine output pixel (sRGB-encoded), in place.
const RGC_SCL = (RGC.lim - RGC.thr) / (((1 - RGC.thr) / (RGC.lim - RGC.thr)) ** -RGC.pw - 1) ** (1 / RGC.pw);
const rgcCPU = (d) => { if (d < RGC.thr) return d; const x = (d - RGC.thr) / RGC_SCL; return RGC.thr + RGC_SCL * x / (1 + x ** RGC.pw) ** (1 / RGC.pw); };
// scanP defaults to null only for callers without a scan fit; the app always passes it.
export function outputColourCPU(px, rec2020ToP3, balance, vibrance = 0, scanP = null) {
  if (scanP) invertCPU(px, scanP);   // negative → positive, as scanInv
  if (balance) {
    for (let c = 0; c < 3; c++) {
      const f = Math.min(1, Math.max(0, px[c])) * 1024, i = f | 0, base = c * 1025;
      px[c] = i >= 1024 ? balance[base + 1024] : balance[base + i] + (balance[base + i + 1] - balance[base + i]) * (f - i);
    }
  }
  if (rec2020ToP3) {
    const r = srgbToLinear(px[0]), g = srgbToLinear(px[1]), b = srgbToLinear(px[2]);
    const [m0, m1, m2] = REC2020_TO_P3;   // no per-pixel allocation
    let p0 = m0[0] * r + m0[1] * g + m0[2] * b, p1 = m1[0] * r + m1[1] * g + m1[2] * b, p2 = m2[0] * r + m2[1] * g + m2[2] * b;
    const a = Math.max(p0, p1, p2);
    if (a > 0) { p0 = a - rgcCPU((a - p0) / a) * a; p1 = a - rgcCPU((a - p1) / a) * a; p2 = a - rgcCPU((a - p2) / a) * a; }
    px[0] = linearToSrgb(p0); px[1] = linearToSrgb(p1); px[2] = linearToSrgb(p2);
  }
  skyHueCPU(px, rec2020ToP3);
  if (vibrance > 0) vibCPU(px, rec2020ToP3, vibrance);
}

// CPU twins of skyHue and vib in GRAIN_WGSL (same constants, same helpers).
const m3 = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
const sstepCPU = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const linCPU = (px) => [0, 1, 2].map((c) => srgbToLinear(Math.min(1, Math.max(0, px[c]))));
function toOkCPU(l, sp) {
  const lms = m3(SKY_LMS[sp], l[0], l[1], l[2]);
  return m3(OK_LAB, Math.cbrt(Math.max(lms[0], 0)), Math.cbrt(Math.max(lms[1], 0)), Math.cbrt(Math.max(lms[2], 0)));
}
function fromOkCPU(L, a, b, sp) { const m = m3(OK_LMS, L, a, b); return m3(SKY_RGB[sp], m[0] ** 3, m[1] ** 3, m[2] ** 3); }
function toGamutCPU(px, l, r) {
  let t = 1;
  for (let c = 0; c < 3; c++) {
    if (r[c] < 0) t = Math.min(t, l[c] / (l[c] - r[c]));
    if (r[c] > 1) t = Math.min(t, (1 - l[c]) / (r[c] - l[c]));
  }
  for (let c = 0; c < 3; c++) px[c] = linearToSrgb(l[c] + t * (r[c] - l[c]));
}
function skyHueCPU(px, p3) {
  const sp = p3 ? 'p3' : 'srgb';
  const l = linCPU(px);
  const [L, a, b] = toOkCPU(l, sp);
  const C = Math.hypot(a, b);
  const d = Math.acos(Math.min(1, Math.max(-1, (a * SKY.dir[0] + b * SKY.dir[1]) / Math.max(C, 1e-6))));
  const w = (d < SKY.width ? 0.5 + 0.5 * Math.cos(3 * d) : 0) * sstepCPU(SKY.c0, SKY.c1, C);
  if (w <= 0) return;
  const th = SKY.theta * w, cs = Math.cos(th), sn = Math.sin(th);
  toGamutCPU(px, l, fromOkCPU(L, cs * a - sn * b, sn * a + cs * b, sp));
}
/** CPU twin of vib: `px` sRGB-encoded in P3 (p3) or sRGB, in place; s = strength. */
export function vibCPU(px, p3, s) {
  const sp = p3 ? 'p3' : 'srgb';
  const l = linCPU(px);
  const [L, a, b] = toOkCPU(l, sp);
  const C = Math.hypot(a, b);
  const g = s * sstepCPU(VIB.c0, VIB.c1, C) * (1 - sstepCPU(VIB.f0, VIB.f1, C));
  if (g <= 0) return;
  toGamutCPU(px, l, fromOkCPU(L, a * (1 + g), b * (1 + g), sp));
}

// Per-frame scanner saturation, as a lab scanner operator sets it: measured
// once on the preview (8-bit RGBA, P3 or sRGB, as rendered before levels and
// vib), returns the vib strength (0 = untouched). Colourfulness = √(p50·p90)
// of OKLab C over a pixel subsample. Measured: normal iPhone frames through the
// pipeline 0.049–0.13, KG200 scans 0.039–0.096, flat hazy frames 0.018–0.036.
// Only frames below SAT_NORMAL are lifted, proportionally to the deficit, and
// never beyond SAT_MAX (≈ ×1.7 chroma at most, only for low-chroma colours).
const SAT_NORMAL = 0.045, SAT_GAIN = 1.6, SAT_MAX = 0.8;
export function scanSaturation(rgba, p3) {
  const sp = p3 ? 'p3' : 'srgb';
  const lin = LIN8;
  const n = rgba.length >> 2, step = Math.max(1, Math.floor(n / 100000));
  const Cs = new Float32Array(Math.ceil(n / step));
  let k = 0;
  for (let i = 0; i < n; i += step) {
    const [, a, b] = toOkCPU([lin[rgba[4 * i]], lin[rgba[4 * i + 1]], lin[rgba[4 * i + 2]]], sp);
    Cs[k++] = Math.hypot(a, b);
  }
  const c = Cs.subarray(0, k).sort();
  if (!k) return 0;
  const q = (p) => c[Math.floor(p * (k - 1))];
  const score = Math.sqrt(q(0.5) * q(0.9));
  return Math.min(SAT_MAX, Math.max(0, SAT_GAIN * (1 - score / SAT_NORMAL)));
}

/** CPU twin of printLook: `px` display-encoded (P3 or sRGB), in place; s = strength. */
export function printLookCPU(px, p3, s) {
  const sp = p3 ? 'p3' : 'srgb';
  const l = linCPU(px);
  const [L0, a0, b0] = toOkCPU(l, sp);
  const d = L0 - PRINT.piv;
  let L = L0 + s * PRINT.con * d * (1 - Math.min(1, Math.abs(d) / PRINT.piv));
  L = Math.min(1, Math.max(0, L + s * PRINT.toe * (1 - sstepCPU(0, 0.45, L0))));
  const lo = 1 - sstepCPU(0.25, 0.45, L), hi = sstepCPU(0.75, 0.95, L), mid = Math.max(0, 1 - lo - hi);
  const k = PRINT.cLo * lo + PRINT.cMid * mid + PRINT.cHi * hi;
  const kv = k + (1 - k) * sstepCPU(0.12, 0.2, Math.hypot(a0, b0)) * 0.6;
  const g = 1 + s * (kv - 1);
  const gr = sstepCPU(GOLD.l0, GOLD.l1, L);
  const a = a0 * g + s * GOLD.a * gr;
  const b = b0 * g + s * (GOLD.bMid * gr - (GOLD.bMid - GOLD.bHi) * sstepCPU(GOLD.l2, GOLD.l3, L));
  const r = fromOkCPU(L, a, b, sp);   // soft gamut stop, as printLook
  let t = 1e9;
  for (let c = 0; c < 3; c++) {
    if (r[c] < 0) t = Math.min(t, l[c] / (l[c] - r[c]));
    if (r[c] > 1) t = Math.min(t, (1 - l[c]) / (r[c] - l[c]));
  }
  t = Math.min(1, 0.85 * t);
  for (let c = 0; c < 3; c++) px[c] = linearToSrgb(l[c] + t * (r[c] - l[c]));
}
