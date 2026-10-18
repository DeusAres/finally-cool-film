// WebGPU input stage: lens (lens.js has the model and the CPU reference) + display→scene
// inverse (JPEG) + exposure + colour matrix, run by the engine as the first pass of its GPU chain
// (spektrafilm-wasm `process_frame`), so the photo crosses to the GPU once, as
// an 8-bit texture, and no float frame ever crosses JS↔wasm. The texture is
// rgba8unorm-srgb: the sampler decodes to LINEAR light before filtering, so
// every bilinear tap is interpolated in linear light, as in the CPU path.
// Output: linear Rec.2020 (p3) or linear sRGB floats, interleaved RGB, for the region.
import { LENS_CONST, lensGeometry } from './lens.js';
import { P3_TO_REC2020, LUMA, RGB_TO_XYZ, inv3, displayGainWGSL, DISPLAY_GAIN_LUT } from './color.js';
import { dodgeWGSL } from './dodge.js';
import { FRAME_UM, wf, wv3 } from './util.js';

const { CA_TAPS, ANISO_Y, VIG_T, VIG_KNEE, WARM_R, WARM_B } = LENS_CONST;

// Slider mapping (Texture, Chiarezza) and the stages they drive, in µm on the 36 mm frame.
// Colour-noise reduction (always on): ring radii (frame px), luminance range k (per stop²).
const CHROMA_R1 = 1.5, CHROMA_R2 = 3.0, CHROMA_K = 8.0;
// Texture = micro-contrast: scale (µm), range k (per stop²), midtone width (stops), strength at ±1.
const MICRO_UM = 60, MICRO_K = 0.4, MICRO_MID_STOPS = 2.5, MICRO_MAX = 0.8;
// Chiarezza (v3.26, bipolar, replaces the old Orton glow): local midtone contrast (Lightroom-like Clarity) at CLAR_UM, edge-aware
// (range k per stop²: taps ~1 stop away barely count, no halos), strength at +1 / -1, cap (EV), midtone width (stops). In scene light
// before the film, so the film's own curve rolls the result off. Below 0 it flattens the local tones towards their base (softer,
// no veil, no blur of the edges).
const CLAR_UM = 500, CLAR_K = 1.0, CLAR_UP = 1.0, CLAR_DOWN = 0.6, CLAR_CAP = 0.7, CLAR_MID_STOPS = 3.5;
// Nitidezza (v3.30, one slider, -1..+1): edge acutance in scene light BEFORE the film, so the film's grain (added in the negative,
// later) is never sharpened. Base = Gaussian-like 17 taps at SHARP_UM (1 + 2 rings), detail d = log luma - base.
//  > 0: d x SHARP_MAX x slider, gated by a sensor-noise threshold (SHARP_T0 log2 at the preview pitch, x2 per 2 stops below mid
//       grey up to x4, x the pixel pitch vs preview: finer export pixels are noisier), result clamped to the local min / max (+-SHARP_TOL):
//       sharper edges, no halo, flat noisy areas untouched. No Amount / Radius / Detail / Masking to set.
//  < 0: towards the base (soft lens), d x SHARP_SOFT x slider, no gate.
const SHARP_UM = 25, SHARP_MAX = 2.2, SHARP_SOFT = 0.8, SHARP_T0 = 0.03, SHARP_TOL = 0.04, SHARP_KPX_REF = 2000 / 36000;
// Vividezza (manual only: the slider is the only input, 0..100 -> p.vib.x 0..1; 0 skips the stage, bit-identical to the app without
// it). A vibrance on the scene light BEFORE the film, after the colour matrix and before the per-channel light gains (wb, so it acts
// on the subject's colours, never on a light colour); the Gold 200 film and the Frontier keep their own look on a more colourful
// scene. GPU path only (as Texture / Chiarezza / Nitidezza; preview and export share it). In OkLCh of the engine input (linear
// Rec.2020 or sRGB, scene-referred: mid grey 0.18 -> L 0.57, as on a display), L and hue kept, chroma only:
//   added = s x VIB_K x C x (1 - C / VIB_CREF)^2                strong on dull colours, ~0 on saturated ones
//           x smoothstep(N0(h), N1(h), C / L)                   near-greys (and their casts) untouched: grey stays grey. The film's
//                                                               neutral zone is much wider on the cool side, in the shadows above all
//                                                               (measured on the check renders: scene C / L up to 0.06-0.12 at hue
//                                                               250-300, L ~0.2-0.4, comes out grey (sky-lit rock shadows), ~0.015 for
//                                                               warm / green: the model's grey balance, toe, cool_neutral_warm), so
//                                                               the ramp is VIB_N (warm / green) and, in VIB_COOL_H, VIB_N_COOL (dark
//                                                               to mid, L < VIB_COOL_L[0]) easing to VIB_N_COOL_LIGHT (L > [1])
//           x smoothstep(VIB_D0, VIB_D1, L)                     deep shadows (sensor chroma noise) untouched
//           x (1 - VIB_SKIN x skin band)                        scene OkLCh hue VIB_SKIN_H (skin of the check DNGs: ~-10..45 deg in
//                                                               the scene, 25-48 on the output, ~ Lab 20-60), smooth edges (red hair
//                                                               sits there too: attenuated alike, no hard cut)
//   then the added part alone is compressed into the room below the Gold 200 ceiling for the hue, in scene terms (VIB_SCENE_CEIL):
//   C' = C + room x tanh(added / room), room = max(ceil(h) - C, 0): never above the ceiling, never below the original chroma
//   (a pixel already over the ceiling gets 0). Last, if the result left the gamut (a channel < 0) it is blended back towards the
//   original in linear light just enough to stay >= 0.
// VIB_CEIL: OkLCh chroma ceiling per 10 deg hue bin (centres 5, 15, ... 355 deg), p99 of the 20 real Gold 200 scans in samples/kg200,
// smoothed (scripts/eval/kg200_chroma_ceiling.py). It is a pure limit (it decides no amount) and an approximation: measured on final
// scans (film + scanner, display sRGB) but applied here to the scene before the film, by scene hue. The film does not keep chroma
// (Gold 200 + Frontier lift warm / green scene chroma ~1.5-1.9x, blues ~1x), so the scene limit is VIB_CEIL x VIB_FILM x VIB_MARGIN, VIB_FILM = the
// scene chroma that came out at the ceiling / the ceiling (p25 per scene hue bin, capped at 1, smoothed; measured on the app's renders
// at Vividezza 0, same script --film). Exposure, scanner sliders and the scene move the real transfer: verified on output with
// scripts/eval/vibrance_stats.py. The magenta-violet bins (270-340 deg) are low because the scans hold few saturated purples:
// Vividezza adds little there.
const VIB_K = 1.5, VIB_CREF = 0.2, VIB_D0 = 0.1, VIB_D1 = 0.25;
const VIB_N = [0.015, 0.05], VIB_N_COOL = [0.08, 0.16], VIB_N_COOL_LIGHT = [0.05, 0.1], VIB_COOL_L = [0.4, 0.65];   // C / L ramps
const VIB_COOL_H = [195, 225, 300, 335];   // cool band, hue (deg): ramps in, full, ramps out
const VIB_SKIN = 0.85, VIB_SKIN_H = [-25, -5, 45, 65];   // hue (deg, -180..180): protection ramps in -25..-5, full -5..45, ramps out 45..65
export const VIB_CEIL = [0.1679, 0.1802, 0.1863, 0.1858, 0.1688, 0.1437, 0.1256, 0.1158, 0.1125, 0.1204, 0.1370, 0.1472, 0.1415, 0.1231,
  0.0997, 0.0813, 0.0755, 0.0792, 0.0841, 0.0849, 0.0806, 0.0737, 0.0678, 0.0677, 0.0754, 0.0822, 0.0762, 0.0608, 0.0492, 0.0443, 0.0414,
  0.0388, 0.0367, 0.0436, 0.0775, 0.1309];
export const VIB_FILM = [0.659, 0.660, 0.625, 0.599, 0.612, 0.642, 0.650, 0.636, 0.626, 0.623, 0.619, 0.630, 0.677, 0.756, 0.824, 0.831, 0.804, 0.825,
  0.884, 0.907, 0.886, 0.867, 0.868, 0.893, 0.939, 0.961, 0.923, 0.846, 0.789, 0.768, 0.765, 0.772, 0.762, 0.706, 0.642, 0.632];   // 9 DNG renders (samples/indigo, default sliders)
const VIB_MARGIN = 0.9;   // the film transfer varies from photo to photo (exposure, scene): aim below the ceiling, not at it
// Interno (2 EV under, its own toe / balance): the film lifts warm scene chroma more (transfer 0.30-0.45 at hue 20-70 vs 0.60-0.65,
// measured on cat2_interno with --film): the scene limit x VIB_INTERNO there (p.vib.z), a pure function of the switch.
const VIB_INTERNO = 0.6;
const VIB_SCENE_CEIL = VIB_CEIL.map((c, i) => +(c * VIB_FILM[i] * VIB_MARGIN).toFixed(5));
// Oklab (Ottosson): XYZ (D65) -> LMS, then cube root and LMS' -> Lab. Engine input RGB -> LMS from color.js's primaries.
const XYZ_TO_LMS = [[0.8189330101, 0.3618667424, -0.1288597137], [0.0329845436, 0.9293118715, 0.0361456387], [0.0482003018, 0.2643662691, 0.6338517070]];
const mul3 = (A, B) => A.map((r) => B[0].map((_, j) => r.reduce((s, v, k) => s + v * B[k][j], 0)));
const TO_LMS = { rec2020: mul3(XYZ_TO_LMS, RGB_TO_XYZ.rec2020), srgb: mul3(XYZ_TO_LMS, RGB_TO_XYZ.srgb) };
const FROM_LMS = { rec2020: inv3(TO_LMS.rec2020), srgb: inv3(TO_LMS.srgb) };
const rows3 = (m, v) => `vec3<f32>(dot(${wv3(m[0])}, ${v}), dot(${wv3(m[1])}, ${v}), dot(${wv3(m[2])}, ${v}))`;
const VIB_WGSL = /* wgsl */`
var<private> VIB_CEIL: array<f32, ${VIB_CEIL.length}> = array<f32, ${VIB_CEIL.length}>(${VIB_SCENE_CEIL.map(wf).join(', ')});   // scene limit
fn vibrance(c: vec3<f32>) -> vec3<f32> {        // c: linear engine input (p.vib.y = 1: sRGB primaries, else Rec.2020)
  let srgb = p.vib.y > 0.5;
  let lms = select(${rows3(TO_LMS.rec2020, 'c')}, ${rows3(TO_LMS.srgb, 'c')}, srgb);
  let q = sign(lms) * pow(max(abs(lms), vec3<f32>(1e-30)), vec3<f32>(1.0 / 3.0));
  let L = dot(vec3<f32>(0.2104542553, 0.7936177850, -0.0040720468), q);
  let a = dot(vec3<f32>(1.9779984951, -2.4285922050, 0.4505937099), q);
  let b = dot(vec3<f32>(0.0259040371, 0.7827717662, -0.8086757660), q);
  let C = length(vec2<f32>(a, b));
  if (C < 1e-6 || L <= 0.0) { return c; }
  let h = degrees(atan2(b, a)) + select(0.0, 360.0, b < 0.0);   // 0..360
  let x = h / ${wf(360 / VIB_CEIL.length)} - 0.5;
  let i0 = (i32(floor(x)) + ${VIB_CEIL.length}) % ${VIB_CEIL.length};
  let cmax = mix(VIB_CEIL[i0], VIB_CEIL[(i0 + 1) % ${VIB_CEIL.length}], x - floor(x)) * p.vib.z;
  let room = cmax - C;
  if (room <= 0.0) { return c; }
  let hs = select(h, h - 360.0, h > 180.0);
  let skin = smoothstep(${wf(VIB_SKIN_H[0])}, ${wf(VIB_SKIN_H[1])}, hs) * (1.0 - smoothstep(${wf(VIB_SKIN_H[2])}, ${wf(VIB_SKIN_H[3])}, hs));
  let cool = smoothstep(${wf(VIB_COOL_H[0])}, ${wf(VIB_COOL_H[1])}, h) * (1.0 - smoothstep(${wf(VIB_COOL_H[2])}, ${wf(VIB_COOL_H[3])}, h));
  let lit = smoothstep(${wf(VIB_COOL_L[0])}, ${wf(VIB_COOL_L[1])}, L);
  let dull = 1.0 - min(C / ${wf(VIB_CREF)}, 1.0);
  let add = p.vib.x * ${wf(VIB_K)} * C * dull * dull
    * smoothstep(mix(${wf(VIB_N[0])}, mix(${wf(VIB_N_COOL[0])}, ${wf(VIB_N_COOL_LIGHT[0])}, lit), cool), mix(${wf(VIB_N[1])}, mix(${wf(VIB_N_COOL[1])}, ${wf(VIB_N_COOL_LIGHT[1])}, lit), cool), C / L) * smoothstep(${wf(VIB_D0)}, ${wf(VIB_D1)}, L) * (1.0 - ${wf(VIB_SKIN)} * skin);
  let k = 1.0 + room * tanh(min(add / room, 10.0)) / C;   // min: tanh as (e^2x - 1) / (e^2x + 1) overflows
  let q2 = vec3<f32>(L + (0.3963377774 * a + 0.2158037573 * b) * k, L - (0.1055613458 * a + 0.0638541728 * b) * k,
                     L - (0.0894841775 * a + 1.2914855480 * b) * k);
  let lms2 = q2 * q2 * q2;
  let o = select(${rows3(FROM_LMS.rec2020, 'lms2')}, ${rows3(FROM_LMS.srgb, 'lms2')}, srgb);
  var t = 1.0;                                   // gamut: back towards c (>= 0) just enough to keep every channel >= 0
  for (var j = 0; j < 3; j++) { if (o[j] < 0.0 && c[j] >= 0.0) { t = min(t, c[j] / (c[j] - o[j])); } }
  return mix(c, o, t);
}`;


export const INPUT_WGSL = /* wgsl */`
struct P {
  frame: vec2<f32>, origin: vec2<f32>,      // frame size, region origin (frame px)
  axis: vec2<f32>, rMax: f32, falloff: f32,
  dR: f32, dB: f32, blur: f32, depth: f32,
  scale: f32, expo: f32, regionW: f32, regionH: f32,   // lens gain; scene exposure gain (Esposizione, Interno, DNG baseline)
  m0: vec4<f32>, m1: vec4<f32>, m2: vec4<f32>, // frame primaries → engine input primaries, rows (xyz)
  fx: vec4<f32>,                               // micro-contrast radius (px), Texture strength, Nitidezza gain, frame px per µm
  wb: vec4<f32>,                               // per-channel gains in the engine input space (Interno: real light colour); 1 otherwise; w: Chiarezza contrast
  luma: vec4<f32>,                             // luma weights of the frame's primaries; w = 1: JPEG, apply the display→scene inverse
  vib: vec4<f32>,                              // x: Vividezza 0..1 (0: stage skipped), y = 1: engine input in sRGB primaries (else Rec.2020), z: ceiling scale (Interno)
};
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> p: P;
@group(0) @binding(3) var<storage, read_write> outBuf: array<f32>;
@group(0) @binding(4) var<storage, read> inv: array<f32>;   // color.js DISPLAY_GAIN_LUT
${displayGainWGSL('inv')}
${VIB_WGSL}

fn at(pos: vec2<f32>) -> vec4<f32> {           // pos in frame pixel coords (pixel centres at integers)
  return textureSampleLevel(tex, smp, (pos + 0.5) / p.frame, 0.0);
}
fn box4(q: vec2<f32>, o: f32) -> vec3<f32> {   // four diagonal bilinear taps at ±o, averaged
  return 0.25 * (at(q + vec2<f32>(o, o)).rgb + at(q + vec2<f32>(-o, o)).rgb
               + at(q + vec2<f32>(o, -o)).rgb + at(q + vec2<f32>(-o, -o)).rgb);
}
fn coverage(u: f32) -> f32 {                   // 0 on the axis, 1 at the farthest corner
  let raw = pow(1.0 + (u * ${VIG_T}) * (u * ${VIG_T}), -2.0);
  let r1 = pow(1.0 + ${VIG_T} * ${VIG_T}, -2.0);
  let soft = (1.0 - raw) / (1.0 - r1);
  let t = clamp((u - ${VIG_KNEE}) / (1.0 - ${VIG_KNEE}), 0.0, 1.0);
  return soft + (t * t * (3.0 - 2.0 * t) - soft) * p.falloff;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (f32(id.x) >= p.regionW || f32(id.y) >= p.regionH) { return; }
  let pos = p.origin + vec2<f32>(f32(id.x), f32(id.y));
  let d = pos - p.axis;
  let r = length(d);
  let g = coverage(min(r / p.rMax, 1.0));      // one curve drives both effects
  var c: vec3<f32>;
  if (p.dR > 0.0 && r > 0.5) {
    let u = vec2<f32>(d.x / r, d.y / r * ${ANISO_Y});
    let oR = p.dR * g; let oB = p.dB * g; let L = p.blur * g;
    if (L < 0.5) {
      c = vec3<f32>(at(pos + u * oR).r, at(pos).g, at(pos + u * oB).b);
    } else {
      // Smear each channel along its own radial displacement (G too, at zero offset).
      let taps = i32(min(${CA_TAPS}.0, max(3.0, ceil(L) + 1.0)));
      let step = L / f32(taps - 1); let half = L * 0.5;
      var acc = vec3<f32>(0.0);
      for (var t = 0; t < taps; t++) {
        let o = f32(t) * step - half;
        acc += vec3<f32>(at(pos + u * (oR + o)).r, at(pos + u * o).g, at(pos + u * (oB + o)).b);
      }
      c = acc / f32(taps);
    }
  } else {
    c = at(pos).rgb;
  }
  // Colour-noise reduction: the phone's sensor chroma noise is invisible
  // in the photo, but the film's colour saturation amplifies it ~5× (measured: σC 0.6 → 2.9
  // with every look stage off) into digital-looking colour speckle; Gold scans show σC 0.4-0.9.
  // As a lab does: average the chroma (RGB / luminance) over two rings (CHROMA_R1/R2 px),
  // luminance-edge-aware, and keep this pixel's own luminance: detail and grain are untouched.
  {
    let y0 = max(dot(c, p.luma.xyz), 1e-5);
    var acc = c / y0; var wt = 1.0;
    for (var t = 0; t < 16; t++) {
      let ring = t / 8;
      let ang = f32(t) * 0.7853982 + f32(ring) * 0.3926991;
      let q = at(pos + vec2<f32>(cos(ang), sin(ang)) * select(${wf(CHROMA_R1)}, ${wf(CHROMA_R2)}, ring == 1)).rgb;
      let yq = max(dot(q, p.luma.xyz), 1e-5);
      let dl = log2(yq / y0);
      let w = exp(-dl * dl * ${wf(CHROMA_K)}) * select(1.0, 0.6, ring == 1);
      acc += w * q / yq; wt += w;
    }
    c = y0 * acc / wt;
  }
  // Nitidezza (SHARP_UM): see the constants. p.fx.z = gain (+ SHARP_MAX x slider / - SHARP_SOFT x slider).
  if (p.fx.z != 0.0) {
    let R = max(${wf(SHARP_UM)} * p.fx.w, 0.7);
    let lc = log2(max(dot(at(pos).rgb, p.luma.xyz), 1e-5));
    var s1 = 0.0; var s2 = 0.0; var lo = lc; var hi = lc;
    for (var t = 0; t < 8; t++) {
      let a1 = f32(t) * 0.7853982;
      let q1 = log2(max(dot(at(pos + vec2<f32>(cos(a1), sin(a1)) * R).rgb, p.luma.xyz), 1e-5));
      let q2 = log2(max(dot(at(pos + vec2<f32>(cos(a1 + 0.3926991), sin(a1 + 0.3926991)) * 2.0 * R).rgb, p.luma.xyz), 1e-5));
      s1 += q1; s2 += q2; lo = min(lo, q1); hi = max(hi, q1);
    }
    let d = lc - (lc + 0.6 * s1 + 0.25 * s2) / (1.0 + 0.6 * 8.0 + 0.25 * 8.0);
    var dl = p.fx.z * d;
    if (p.fx.z > 0.0) {
      let thr = ${wf(SHARP_T0)} * clamp(exp2(0.5 * (-2.47 - lc)), 1.0, 4.0) * max(p.fx.w / ${wf(SHARP_KPX_REF)}, 0.5);
      let gate = smoothstep(thr, 3.0 * thr, abs(d));
      dl = clamp(lc + dl * gate, lo - ${wf(SHARP_TOL)}, hi + ${wf(SHARP_TOL)}) - lc;
    }
    c *= exp2(dl);
  }
  // Texture = micro-contrast (MICRO_UM): local contrast in log luminance at the
  // scale of film adjacency (developer / DIR inhibitor diffusion at edges).
  // Edge-aware (taps over ~1 stop away barely count: no halos), midtone-weighted,
  // prefiltered taps (no aliasing at 48 MP). Bipolar: < 0 flattens micro-tones.
  if (p.fx.y != 0.0) {
    let l0 = log2(max(dot(c, p.luma.xyz), 1e-5));
    let o = max(0.35 * p.fx.x, 0.5);
    var sw = 1.0; var sl = l0;
    for (var t = 0; t < 24; t++) {                // 3 rings × 8, staggered
      let ring = t / 8;
      let ang = f32(t) * 0.7853982 + f32(ring) * 0.2617994;
      let q = pos + vec2<f32>(cos(ang), sin(ang)) * (0.5 + 0.65 * f32(ring)) * p.fx.x;
      let lq = log2(max(dot(box4(q, o), p.luma.xyz), 1e-5));
      let d = lq - l0;
      let w = exp(-d * d * ${wf(MICRO_K)});
      sw += w; sl += w * lq;
    }
    let mid = exp(-pow((l0 + 2.47) / ${wf(MICRO_MID_STOPS)}, 2.0));   // midtones (log2 0.18 = -2.47)
    c *= exp2(clamp((l0 - sl / sw) * p.fx.y * mid, -0.4, 0.4));
  }
  // Chiarezza = local midtone contrast (CLAR_UM): log luminance pushed away from (> 0) or towards (< 0) an edge-aware local base,
  // midtone-weighted, capped. > 0 only expands (slope >= 1 in the pixel's own level); < 0 keeps slope >= 1 - CLAR_DOWN > 0.
  if (p.wb.w != 0.0) {
    let l0 = log2(max(dot(c, p.luma.xyz), 1e-5));
    let R = ${wf(CLAR_UM)} * p.fx.w;
    let o = max(0.35 * R, 0.5);
    var sw = 1.0; var sl = l0;
    for (var t = 0; t < 24; t++) {                // 3 rings × 8, staggered
      let ring = t / 8;
      let ang = f32(t) * 0.7853982 + f32(ring) * 0.2617994;
      let q = pos + vec2<f32>(cos(ang), sin(ang)) * (0.5 + 0.65 * f32(ring)) * R;
      let lq = log2(max(dot(box4(q, o), p.luma.xyz), 1e-5));
      let d = lq - l0;
      let w = exp(-d * d * ${wf(CLAR_K)});
      sw += w; sl += w * lq;
    }
    let mid = exp(-pow((l0 + 2.47) / ${wf(CLAR_MID_STOPS)}, 2.0));
    c *= exp2(clamp((l0 - sl / sw) * p.wb.w * mid, -${wf(CLAR_CAP)}, ${wf(CLAR_CAP)}));
  }
  // JPEG: display → scene (color.js), a common gain on max(R,G,B). A raw frame is scene-linear already.
  if (p.luma.w > 0.5) { c *= displayGain(max(c.r, max(c.g, c.b))); }
  // Exposure: Esposizione, minus Interno's underexposure, plus the DNG baseline, as scene light before the film.
  c *= p.expo;
  var gainOut = p.scale;
  if (p.depth > 0.0) {
    let lost = p.depth * g;                    // fraction of light the lens loses here
    gainOut *= 1.0 - lost;
    c.r *= 1.0 + ${WARM_R} * lost;
    c.b *= 1.0 - ${WARM_B} * lost;
  }
  c = vec3<f32>(dot(p.m0.xyz, c), dot(p.m1.xyz, c), dot(p.m2.xyz, c));
  // Vividezza (VIB_*): on the light reaching the film (lens gain included), before the light gains wb.
  if (p.vib.x > 0.0 && gainOut > 0.0) { c = vibrance(c * gainOut) / gainOut; }
  let i = (id.y * u32(p.regionW) + id.x) * 3u;
  c *= p.wb.xyz;
  outBuf[i] = c.r * gainOut; outBuf[i + 1u] = c.g * gainOut; outBuf[i + 2u] = c.b * gainOut;
}`;

// Debug v3 (debugv3.html): the same pass with the automatic highlight dodging (dodge.js) before the
// exposure gain; its base map rides after DISPLAY_GAIN_LUT in the same storage array.
export const INPUT_WGSL_V3 = INPUT_WGSL
  .replace('fn at(pos', `${dodgeWGSL('inv', DISPLAY_GAIN_LUT.length)}\nfn at(pos`)
  .replace('\n  c *= p.expo;\n', '\n  c = dodge(c, pos);\n  c *= p.expo;\n');

const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const UNIFORM_FLOATS = 44;

/**
 * Uniforms of INPUT_WGSL for the region (x0, y0, w, h) of a W×H frame, scaled by `scale`
 * (lens gain); same contract as lens.js extractLens. `space`: primaries of the frame,
 * 'srgb' | 'p3' | 'rec2020' (a raw frame, already scene-linear: no display→scene inverse).
 * `expo`: scene exposure gain; `wb`: per-channel gains in the engine input space; `vibrance`: Vividezza 0..1; `interno`: the switch.
 */
export function inputUniform(W, H, space, x0, y0, w, h, scale, lens, expo, clarity = 0, texture = 0, wb = [1, 1, 1], sharp = 0, vibrance = 0, interno = false) {
  const kpx = Math.max(W, H) / FRAME_UM;   // frame px per µm
  const geo = lensGeometry(W, H, lens), M = space === 'p3' ? P3_TO_REC2020 : IDENTITY;
  const u = new Float32Array([
    W, H, x0, y0,
    geo.cx, geo.cy, geo.rMax, geo.falloff,
    geo.dR, geo.dB, geo.blur, geo.depth,
    scale, expo, w, h,
    ...M[0], 0, ...M[1], 0, ...M[2], 0,
    MICRO_UM * kpx, texture * MICRO_MAX, sharp * (sharp > 0 ? SHARP_MAX : SHARP_SOFT), kpx,
    ...wb, clarity * (clarity > 0 ? CLAR_UP : CLAR_DOWN),
    ...LUMA[space], space === 'rec2020' ? 0 : 1,
    Math.max(0, Math.min(1, vibrance)), space === 'srgb' ? 1 : 0, interno ? VIB_INTERNO : 1, 0,
  ]);
  if (u.length !== UNIFORM_FLOATS) throw new Error('inputUniform: layout drift');
  return u;
}
