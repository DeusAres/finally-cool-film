// Film grain, procedural, applied where it shows: in the final 8-bit pass
// (the engine's output pack shader, see spektrafilm-wasm `process_frame`),
// after the film/print/scan chain, as the grain of a scanned negative reads.
//
// Why not the engine's own grain: measured on real Kodak Gold 200 scans
// (shopfront, cliffs, palms, two people on grass), grain is strongest in the
// shadows and low mids (L* ~20–60), fades in the deep blacks and falls to
// ~10% of its peak in the highlights (L* 78–96, structure-free flat patches:
// 8–16% of peak; the print/scan shoulder flattens it). The engine's
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
//   - two scales: fine grain plus larger clumps (dye clouds coalesce), the
//     clumps carrying most of the energy: scanned grain is soft, ACF(1 px)
//     ≈ 0.7 on the KG200 scans at ~13–15 µm/px, not pixel-crisp;
//   - three dye layers grain independently: part of the noise is per
//     channel (chromatic), more so in the shadows, where it shows on scans.

const FRAME_UM = 36000;

export const GRAIN_WGSL = /* wgsl */`
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read> lut: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read> P: array<f32>;
// P[4] region width, P[5..6] region origin (frame px), P[7] µm per px,
// P[8] amplitude (8-bit levels), P[9] grain size (µm), P[10] seed,
// P[11] = 1: the chain output is Rec.2020 → convert to Display P3 here, with
// ACES-style per-channel soft gamut compression (see toP3); P[12] the paper
// black (8-bit / 255): grain softly floors there instead of clipping to 0;
// P[13] = 1: grey balance curves (tone.js greyBalance) from P[16], applied first.

fn bal(c: u32, v: f32) -> f32 {             // grey balance (tone.js greyBalance), P[16..]
  let f = clamp(v, 0.0, 1.0) * 1024.0; let i = u32(f); let base = 16u + c * 1025u;
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
  let l = select(pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
  let y = dot(l, vec3<f32>(0.2126, 0.7152, 0.0722));
  return select(903.3 * y, 116.0 * pow(y, 1.0 / 3.0) - 16.0, y > 0.008856);
}
fn sstep(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }

fn dec(v: vec3<f32>) -> vec3<f32> { return select(pow((v + 0.055) / 1.055, vec3<f32>(2.4)), v / 12.92, v <= vec3<f32>(0.04045)); }
fn encs(v: vec3<f32>) -> vec3<f32> { return select(1.055 * pow(max(v, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055, 12.92 * v, v <= vec3<f32>(0.0031308)); }
// One channel's distance from the achromatic axis compressed beyond THR so that
// LIM (the farthest a film colour lands outside P3) maps exactly to the gamut edge.
fn rgc(d: f32) -> f32 {
  let thr = 0.9; let lim = 1.3; let pw = 1.2;
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
  var p = vec3<f32>(
    dot(vec3<f32>(1.3435783, -0.2821797, -0.0613986), l),
    dot(vec3<f32>(-0.0652975, 1.0757879, -0.0104905), l),
    dot(vec3<f32>(0.0028218, -0.0195985, 1.0167767), l));
  let a = max(p.x, max(p.y, p.z));
  if (a > 0.0) {
    let d = (vec3<f32>(a) - p) / a;
    p = vec3<f32>(a) - vec3<f32>(rgc(d.x), rgc(d.y), rgc(d.z)) * a;
  }
  return encs(p);
}
// Partial sky-blue correction (CPU twin: skyHueCPU): the film turns blue skies
// cyan (tree: CIELAB hue 257° → 243°); rotate blues/cyans back ~5.5° in OKLab at
// constant L and C. Weight: raised cosine over ±60° around OKLab hue 235°, times
// smoothstep(0.015, 0.045, C) so neutrals, skin, greens and yellows are untouched.
// The step towards the rotated colour stops at the gamut edge (never leaves it).
fn skyHue(e: vec3<f32>) -> vec3<f32> {
  let p3 = P[11] > 0.5;
  let l = dec(clamp(e, vec3<f32>(0.0), vec3<f32>(1.0)));
  var lms: vec3<f32>;
  if (p3) {
    lms = l * mat3x3<f32>(vec3<f32>(0.4813798, 0.4621184, 0.0565018), vec3<f32>(0.228832, 0.6532168, 0.1179512), vec3<f32>(0.0839458, 0.2241653, 0.691889));
  } else {
    lms = l * mat3x3<f32>(vec3<f32>(0.4122215, 0.5363325, 0.051446), vec3<f32>(0.2119035, 0.6806995, 0.107397), vec3<f32>(0.0883025, 0.2817188, 0.6299787));
  }
  let lab = pow(max(lms, vec3<f32>(0.0)), vec3<f32>(1.0 / 3.0)) * mat3x3<f32>(vec3<f32>(0.2104542553, 0.7936177850, -0.0040720468),
    vec3<f32>(1.9779984951, -2.4285922050, 0.4505937099), vec3<f32>(0.0259040371, 0.7827717662, -0.8086757660));
  let C = length(lab.yz);
  let d = acos(clamp(dot(lab.yz, vec2<f32>(-0.5735764, -0.8191520)) / max(C, 1e-6), -1.0, 1.0));   // radians from 235°
  let w = select(0.0, 0.5 + 0.5 * cos(3.0 * d), d < 1.0471976) * sstep(0.015, 0.045, C);
  if (w <= 0.0) { return e; }
  let th = 0.0959931 * w;                      // 5.5°
  let cs = cos(th); let sn = sin(th);
  let m = vec3<f32>(lab.x, cs * lab.y - sn * lab.z, sn * lab.y + cs * lab.z) * mat3x3<f32>(vec3<f32>(1.0, 0.3963377774, 0.2158037573),
    vec3<f32>(1.0, -0.1055613458, -0.0638541728), vec3<f32>(1.0, -0.0894841775, -1.2914855480));
  var r: vec3<f32>;
  if (p3) {
    r = (m * m * m) * mat3x3<f32>(vec3<f32>(3.1277694, -2.2571362, 0.1293668), vec3<f32>(-1.0910094, 2.413332, -0.3223227), vec3<f32>(-0.0260108, -0.5080414, 1.5340521));
  } else {
    r = (m * m * m) * mat3x3<f32>(vec3<f32>(4.0767417, -3.3077116, 0.2309699), vec3<f32>(-1.268438, 2.6097574, -0.3413194), vec3<f32>(-0.0041961, -0.7034186, 1.7076147));
  }
  let lo = select(vec3<f32>(1.0), l / (l - r), r < vec3<f32>(0.0));
  let hi = select(vec3<f32>(1.0), (1.0 - l) / (r - l), r > vec3<f32>(1.0));
  let t = min(min(min(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
  return encs(l + t * (r - l));
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x + id.y * u32(P[1]);
  if (i >= u32(P[0])) { return; }
  var e = vec3<f32>(src[3u * i], src[3u * i + 1u], src[3u * i + 2u]);
  if (P[13] > 0.5) { e = vec3<f32>(bal(0u, e.x), bal(1u, e.y), bal(2u, e.z)); }
  if (P[11] > 0.5) { e = toP3(e); }
  e = skyHue(e);
  var c = vec3<f32>(q(e.x), q(e.y), q(e.z));
  if (P[8] > 0.0) {
    let w = u32(P[4]);
    let um = (vec2<f32>(f32(i % w), f32(i / w)) + vec2<f32>(P[5], P[6]) + 0.5) * P[7];
    let c1 = max(P[9], P[7]);                  // grain cell, never smaller than a pixel
    let c2 = max(P[9] * 2.3, P[7]);            // clump cell
    // A pixel integrates the grain over its area: σ falls as 1/√(1 + 0.59 r²),
    // r = pixel / cell (fit of box-averaged value noise), so every resolution
    // shows the same grain once viewed at the same size.
    let r1 = P[7] / P[9]; let r2 = r1 / 2.3;
    let b1 = inverseSqrt(1.0 + 0.59 * r1 * r1); let b2 = inverseSqrt(1.0 + 0.59 * r2 * r2);
    let s = u32(P[10]);
    let p = um / c1;
    let L = lstar(c);
    // GRAIN_SHAPE: measured on real scans (see grain.js).
    let shape = (0.6 + 0.4 * sstep(2.0, 22.0, L)) * (1.0 - 0.85 * sstep(55.0, 85.0, L));
    let chroma = mix(0.55, 0.2, sstep(10.0, 50.0, L));
    let mono = 0.47 * b1 * vnoise(p, s) + 0.7 * b2 * vnoise(um / c2 + 17.0, s + 1u);
    let n = b1 * vec3<f32>(vnoise(p + 31.0, s + 2u), vnoise(p + 57.0, s + 3u), vnoise(p + 83.0, s + 4u));
    c += (P[8] / 255.0) * shape * (mono + chroma * n);
  }
  // Soft floor at the paper black: unchanged a few levels above it, approaching
  // it below (softplus), so grain never punches pure-black specks into the
  // deepest shadows (measured: up to 4% of a frame at exactly 0).
  let k = 2.0 / 255.0; let b = P[12] - 2.0 * k;   // paper black maps to itself within 0.3 levels; grain has room below it
  let x = (c - b) / k;                         // stable softplus: max(x,0) + log(1 + e^-|x|)
  c = b + k * (max(x, vec3<f32>(0.0)) + log(vec3<f32>(1.0) + exp(-abs(x))));
  let o = vec3<u32>(round(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)) * 255.0));
  dst[i] = o.x | (o.y << 8u) | (o.z << 16u) | 0xff000000u;
}`;

/**
 * Params for GRAIN_WGSL: region (x0, y0, w) of a frame whose long side is
 * `frameLong` px; `amount` is the Grana slider (0 = off), `seed` per photo.
 */
export function grainParams(w, x0, y0, frameLong, amount, seed, rec2020ToP3 = false, black = 0, balance = null) {
  const umPerPx = FRAME_UM / frameLong;
  // Size grows a little with the amount (a coarser-looking stock); 12 µm at 1.
  const size = 12 * (0.75 + 0.25 * amount);
  const head = [w, x0, y0, umPerPx, GRAIN_LEVELS * amount, size, seed % 65536, rec2020ToP3 ? 1 : 0, black / 255, balance ? 1 : 0, 0, 0];
  const p = new Float32Array(head.length + (balance ? balance.length : 0));
  p.set(head); if (balance) p.set(balance, head.length);   // balance starts at P[16]
  return p;
}

// Peak amplitude (8-bit levels, per unit of noise) at amount 1.
const GRAIN_LEVELS = 13;

// CPU twin of the colour steps of GRAIN_WGSL (grey balance, then Rec.2020 → P3),
// for the no-WebGPU path: `px` is one engine output pixel (sRGB-encoded), in place.
const decs = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const encsCPU = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);
const RGC_SCL = (1.3 - 0.9) / (((1 - 0.9) / (1.3 - 0.9)) ** -1.2 - 1) ** (1 / 1.2);
const rgcCPU = (d) => { if (d < 0.9) return d; const x = (d - 0.9) / RGC_SCL; return 0.9 + RGC_SCL * x / (1 + x ** 1.2) ** (1 / 1.2); };
export function outputColourCPU(px, rec2020ToP3, balance) {
  if (balance) {
    for (let c = 0; c < 3; c++) {
      const f = Math.min(1, Math.max(0, px[c])) * 1024, i = f | 0, base = c * 1025;
      px[c] = i >= 1024 ? balance[base + 1024] : balance[base + i] + (balance[base + i + 1] - balance[base + i]) * (f - i);
    }
  }
  if (rec2020ToP3) {
    const r = decs(px[0]), g = decs(px[1]), b = decs(px[2]);
    let p0 = 1.3435783 * r - 0.2821797 * g - 0.0613986 * b;
    let p1 = -0.0652975 * r + 1.0757879 * g - 0.0104905 * b;
    let p2 = 0.0028218 * r - 0.0195985 * g + 1.0167767 * b;
    const a = Math.max(p0, p1, p2);
    if (a > 0) { p0 = a - rgcCPU((a - p0) / a) * a; p1 = a - rgcCPU((a - p1) / a) * a; p2 = a - rgcCPU((a - p2) / a) * a; }
    px[0] = encsCPU(p0); px[1] = encsCPU(p1); px[2] = encsCPU(p2);
  }
  skyHueCPU(px, rec2020ToP3);
}

// CPU twin of skyHue in GRAIN_WGSL (same constants). Rows: linear RGB → LMS (OKLab M1 composed
// with the primaries, rows normalised so white has a = b = 0), and back.
const SKY_LMS = { p3: [0.4813798, 0.4621184, 0.0565018, 0.228832, 0.6532168, 0.1179512, 0.0839458, 0.2241653, 0.691889],
  srgb: [0.4122215, 0.5363325, 0.051446, 0.2119035, 0.6806995, 0.107397, 0.0883025, 0.2817188, 0.6299787] };
const SKY_RGB = { p3: [3.1277694, -2.2571362, 0.1293668, -1.0910094, 2.413332, -0.3223227, -0.0260108, -0.5080414, 1.5340521],
  srgb: [4.0767417, -3.3077116, 0.2309699, -1.268438, 2.6097574, -0.3413194, -0.0041961, -0.7034186, 1.7076147] };
const OK_LAB = [0.2104542553, 0.7936177850, -0.0040720468, 1.9779984951, -2.4285922050, 0.4505937099, 0.0259040371, 0.7827717662, -0.8086757660];
const OK_LMS = [1, 0.3963377774, 0.2158037573, 1, -0.1055613458, -0.0638541728, 1, -0.0894841775, -1.2914855480];
const m3 = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
function skyHueCPU(px, p3) {
  const sp = p3 ? 'p3' : 'srgb';
  const l = [0, 1, 2].map((c) => decs(Math.min(1, Math.max(0, px[c]))));
  const lms = m3(SKY_LMS[sp], l[0], l[1], l[2]);
  const [L, a, b] = m3(OK_LAB, Math.cbrt(Math.max(lms[0], 0)), Math.cbrt(Math.max(lms[1], 0)), Math.cbrt(Math.max(lms[2], 0)));
  const C = Math.hypot(a, b);
  const d = Math.acos(Math.min(1, Math.max(-1, (a * -0.5735764 + b * -0.8191520) / Math.max(C, 1e-6))));
  const t0 = Math.min(1, Math.max(0, (C - 0.015) / 0.03));
  const w = (d < 1.0471976 ? 0.5 + 0.5 * Math.cos(3 * d) : 0) * t0 * t0 * (3 - 2 * t0);
  if (w <= 0) return;
  const th = 0.0959931 * w, cs = Math.cos(th), sn = Math.sin(th);
  const m = m3(OK_LMS, L, cs * a - sn * b, sn * a + cs * b);
  const r = m3(SKY_RGB[sp], m[0] ** 3, m[1] ** 3, m[2] ** 3);
  let t = 1;
  for (let c = 0; c < 3; c++) {
    if (r[c] < 0) t = Math.min(t, l[c] / (l[c] - r[c]));
    if (r[c] > 1) t = Math.min(t, (1 - l[c]) / (r[c] - l[c]));
  }
  for (let c = 0; c < 3; c++) px[c] = encsCPU(l[c] + t * (r[c] - l[c]));
}
